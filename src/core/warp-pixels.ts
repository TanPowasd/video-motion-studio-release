import { VmotionError } from './model.js';
import { inverse, transform, type Matrix, type Bounds } from './interaction.js';
import type { SpatialEffect } from './spatial-effect-schema.js';
import { pinGrid } from './warp-grid.js';

type WarpEffect = Extract<SpatialEffect, { type: 'meshWarp' | 'cornerPin' }>;
type Vertex = { x: number; y: number; u: number; v: number; q: number };
type Triangle = {
  a: Vertex;
  b: Vertex;
  c: Vertex;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
const edge = (a: Vertex, b: Vertex, x: number, y: number) =>
  (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
const topLeft = (a: Vertex, b: Vertex) => b.y < a.y || (b.y === a.y && b.x > a.x);
const accepts = (e: number, a: Vertex, b: Vertex) =>
  e > 1e-9 || (Math.abs(e) <= 1e-9 && topLeft(a, b));

/** Forward textured triangles. Tile-local sample buffers keep memory independent of grid density. */
export function applyWarpEffect(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  effect: WarpEffect,
  matrix: Matrix,
  bounds: Bounds,
) {
  const inv = inverse(matrix);
  if (!inv || !effect.amount) return new Uint8ClampedArray(source);
  const columns = effect.type === 'meshWarp' ? effect.columns : 1,
    rows = effect.type === 'meshWarp' ? effect.rows : 1;
  const regularCorners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const points =
    effect.type === 'meshWarp'
      ? effect.points
      : pinGrid(
          effect.corners.map((p, i) => ({
            x: regularCorners[i].x + (p.x - regularCorners[i].x) * effect.amount,
            y: regularCorners[i].y + (p.y - regularCorners[i].y) * effect.amount,
          })),
        );
  if (points.length !== (columns + 1) * (rows + 1))
    throw new VmotionError('WARP_GRID', 'Incorrect control point count');
  if (
    points.every(
      (p, i) =>
        p.x === (i % (columns + 1)) / columns &&
        p.y === Math.floor(i / (columns + 1)) / rows &&
        (p.weight ?? 1) === (points[0].weight ?? 1),
    )
  )
    return new Uint8ClampedArray(source);
  const vertices = points.map((p, i): Vertex => {
    const u = (i % (columns + 1)) / columns,
      v = Math.floor(i / (columns + 1)) / rows,
      amount = effect.type === 'cornerPin' ? 1 : effect.amount,
      dest = transform(matrix, {
        x: bounds.x + (u + (p.x - u) * amount) * bounds.width,
        y: bounds.y + (v + (p.y - v) * amount) * bounds.height,
      });
    return { ...dest, u, v, q: 1 / (1 + ((p.weight ?? 1) - 1) * amount) };
  });
  const triangles: Triangle[] = [];
  let budget = width * height * effect.samples;
  const add = (a: Vertex, b: Vertex, c: Vertex) => {
    let area = edge(a, b, c.x, c.y);
    if (Math.abs(area) < 1e-10) return;
    if (area < 0) {
      [b, c] = [c, b];
      area = -area;
    }
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))),
      y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))),
      x1 = Math.min(width, Math.ceil(Math.max(a.x, b.x, c.x))),
      y1 = Math.min(height, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (x1 <= x0 || y1 <= y0) return;
    budget += (x1 - x0) * (y1 - y0) * effect.samples;
    if (budget > 256 * 1024 * 1024)
      throw new VmotionError('WARP_BUDGET', 'Deformation exceeds the raster work budget', {
        budget,
        limit: 256 * 1024 * 1024,
      });
    triangles.push({ a, b, c, area, x0, y0, x1, y1 });
  };
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const i = row * (columns + 1) + col,
        a = vertices[i],
        b = vertices[i + 1],
        c = vertices[i + columns + 2],
        d = vertices[i + columns + 1];
      add(a, b, c);
      add(a, c, d);
    }
  const inside = (x: number, y: number) => {
    const lx = inv[0] * x + inv[2] * y + inv[4],
      ly = inv[1] * x + inv[3] * y + inv[5];
    return (
      lx >= bounds.x &&
      lx < bounds.x + bounds.width &&
      ly >= bounds.y &&
      ly < bounds.y + bounds.height
    );
  };
  const result = new Uint8ClampedArray(source),
    tileSize = 32,
    offsets =
      effect.samples === 4
        ? [
            [0.25, 0.25],
            [0.75, 0.25],
            [0.25, 0.75],
            [0.75, 0.75],
          ]
        : [[0.5, 0.5]],
    tileColumns = Math.ceil(width / tileSize),
    tiles = new Map<number, Triangle[]>();
  const touch = (x0: number, y0: number, x1: number, y1: number, triangle?: Triangle) => {
    for (
      let y = Math.max(0, Math.floor(y0 / tileSize));
      y < Math.min(Math.ceil(height / tileSize), Math.ceil(y1 / tileSize));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(x0 / tileSize));
        x < Math.min(tileColumns, Math.ceil(x1 / tileSize));
        x++
      ) {
        const key = y * tileColumns + x,
          list = tiles.get(key) ?? [];
        if (triangle) list.push(triangle);
        tiles.set(key, list);
      }
  };
  const original = regularCorners.map((p) =>
    transform(matrix, { x: bounds.x + p.x * bounds.width, y: bounds.y + p.y * bounds.height }),
  );
  touch(
    Math.floor(Math.min(...original.map((p) => p.x))),
    Math.floor(Math.min(...original.map((p) => p.y))),
    Math.ceil(Math.max(...original.map((p) => p.x))),
    Math.ceil(Math.max(...original.map((p) => p.y))),
  );
  for (const triangle of triangles)
    touch(triangle.x0, triangle.y0, triangle.x1, triangle.y1, triangle);
  const buffer = new Float32Array(tileSize * tileSize * effect.samples * 4);
  const sample = (u: number, v: number, index: number) => {
    const x =
        matrix[0] * (bounds.x + u * bounds.width) +
        matrix[2] * (bounds.y + v * bounds.height) +
        matrix[4] -
        0.5,
      y =
        matrix[1] * (bounds.x + u * bounds.width) +
        matrix[3] * (bounds.y + v * bounds.height) +
        matrix[5] -
        0.5,
      x0 = Math.floor(x),
      y0 = Math.floor(y),
      tx = x - x0,
      ty = y - y0;
    buffer.fill(0, index, index + 4);
    if (x < -0.5 || y < -0.5 || x >= width - 0.5 || y >= height - 0.5) return;
    let coverage = 0;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const px = Math.max(0, Math.min(width - 1, x0 + dx)),
          py = Math.max(0, Math.min(height - 1, y0 + dy));
        if (!inside(px + 0.5, py + 0.5)) continue;
        const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty),
          at = (py * width + px) * 4,
          alpha = (source[at + 3] / 255) * weight;
        coverage += weight;
        buffer[index] += source[at] * alpha;
        buffer[index + 1] += source[at + 1] * alpha;
        buffer[index + 2] += source[at + 2] * alpha;
        buffer[index + 3] += alpha;
      }
    if (coverage > 0 && coverage < 1) for (let c = 0; c < 4; c++) buffer[index + c] /= coverage;
  };
  for (const [key, list] of tiles) {
    const tileX = (key % tileColumns) * tileSize,
      tileY = Math.floor(key / tileColumns) * tileSize;
    buffer.fill(0);
    for (const { a, b, c, area, x0, y0, x1, y1 } of list)
      for (let y = Math.max(tileY, y0); y < Math.min(tileY + tileSize, y1); y++)
        for (let x = Math.max(tileX, x0); x < Math.min(tileX + tileSize, x1); x++)
          for (let s = 0; s < offsets.length; s++) {
            const px = x + offsets[s][0],
              py = y + offsets[s][1],
              ea = edge(b, c, px, py),
              eb = edge(c, a, px, py),
              ec = edge(a, b, px, py);
            if (!accepts(ea, b, c) || !accepts(eb, c, a) || !accepts(ec, a, b)) continue;
            const wa = (ea / area) * a.q,
              wb = (eb / area) * b.q,
              wc = (ec / area) * c.q,
              q = wa + wb + wc,
              index = ((y - tileY) * tileSize + (x - tileX)) * effect.samples * 4 + s * 4;
            sample(
              (wa * a.u + wb * b.u + wc * c.u) / q,
              (wa * a.v + wb * b.v + wc * c.v) / q,
              index,
            );
          }
    for (let y = tileY; y < Math.min(height, tileY + tileSize); y++)
      for (let x = tileX; x < Math.min(width, tileX + tileSize); x++) {
        const at = (y * width + x) * 4;
        let r = 0,
          g = 0,
          b = 0,
          alpha = 0,
          changed = false;
        for (let s = 0; s < offsets.length; s++) {
          const index = ((y - tileY) * tileSize + (x - tileX)) * effect.samples * 4 + s * 4,
            erase = inside(x + offsets[s][0], y + offsets[s][1]),
            a = buffer[index + 3],
            base = erase ? 0 : (source[at + 3] / 255) * (1 - a);
          changed ||= erase || a > 0;
          r += buffer[index] + source[at] * base;
          g += buffer[index + 1] + source[at + 1] * base;
          b += buffer[index + 2] + source[at + 2] * base;
          alpha += a + base;
        }
        if (!changed) continue;
        result[at] = alpha ? r / alpha : 0;
        result[at + 1] = alpha ? g / alpha : 0;
        result[at + 2] = alpha ? b / alpha : 0;
        result[at + 3] = (alpha / offsets.length) * 255;
      }
  }
  return result;
}
