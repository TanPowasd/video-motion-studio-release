import { evaluateScene3D, type MeshInstance3D } from '../sdk/matrix3d.js';
import { VmotionError } from './model.js';
import type { Scene3DData } from './scene3d-schema.js';
import {
  rasterMaterial,
  rasterLighting,
  shadeFragment,
  validateShading,
  type RasterMaterial,
  type RasterLighting,
} from './shading3d.js';

export type RasterVertex = [number, number, number, number, number]; // screen X/Y, NDC Z, inverse W, eye depth
export interface RasterTriangle {
  vertices: [RasterVertex, RasterVertex, RasterVertex];
  color: [number, number, number];
  faceId: number;
  attributes?: [number[], number[], number[]];
  material?: RasterMaterial;
}
export interface RasterRequest {
  width: number;
  height: number;
  samples: 1 | 4;
  triangles: RasterTriangle[];
  inspection?: boolean;
  lighting?: RasterLighting;
}
export interface RasterResult {
  pixels: Buffer;
  depth?: Float32Array;
  faceIds?: Int32Array;
  backend: 'rust' | 'typescript';
  triangles: number;
}
export function prepareRasterScene(
  id: string,
  data: Scene3DData,
  width: number,
  height: number,
  inspection = false,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 3840 ||
    height > 2160
  )
    throw new VmotionError(
      'RASTER3D_RESOLUTION',
      'Raster dimensions must be integer pixels within UHD 4K',
    );
  const evaluated = evaluateScene3D(
      id,
      data.instances as unknown as MeshInstance3D[],
      data.camera,
      data.options,
    ),
    labels = [...evaluated.faces]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f, index) => ({ index, id: f.id, instanceId: f.instanceId, face: f.face })),
    indices = new Map(labels.map((l) => [l.id, l.index])),
    triangles: RasterTriangle[] = [],
    sx = width / data.camera.width,
    sy = height / data.camera.height;
  for (const face of evaluated.faces) {
    const vertices = face.vertices.map(
        (p) => [p.x * sx, p.y * sy, p.z, p.inverseW, p.depth] as RasterVertex,
      ),
      color = [1, 3, 5].map((i) => parseInt(face.fill.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
    for (let i = 1; i + 1 < vertices.length; i++)
      triangles.push({
        vertices: [vertices[0], vertices[i], vertices[i + 1]],
        color,
        faceId: indices.get(face.id)!,
        ...(face.material
          ? {
              material: rasterMaterial(face.material, face.baseColor),
              attributes: [face.vertices[0], face.vertices[i], face.vertices[i + 1]].map((v) => [
                v.world!.x,
                v.world!.y,
                v.world!.z,
                v.normal!.x,
                v.normal!.y,
                v.normal!.z,
              ]) as [number[], number[], number[]],
            }
          : {}),
      });
  }
  return {
    request: {
      width,
      height,
      samples: data.samples,
      triangles,
      inspection,
      ...(triangles.some((t) => t.material) ? { lighting: rasterLighting(data) } : {}),
    } satisfies RasterRequest,
    labels,
    matrices: evaluated.matrices,
    stats: evaluated.stats,
    bounds: evaluated.bounds,
  };
}
const edge = (a: RasterVertex, b: RasterVertex, x: number, y: number) =>
  (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
const offsets = {
  1: [[0.5, 0.5]],
  4: [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ],
} as const;
/** Tile-local sample/depth storage stays bounded even at 4K with four antialias samples. */
export function rasterize3D(request: RasterRequest): RasterResult {
  const { width, height, samples, inspection } = request;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 3840 ||
    height > 2160 ||
    ![1, 4].includes(samples) ||
    request.triangles.length > 100000
  )
    throw new VmotionError(
      'RASTER3D_LIMIT',
      'Invalid raster dimensions, sample count or triangle budget',
    );
  const tileSize = 16,
    columns = Math.ceil(width / tileSize),
    rows = Math.ceil(height / tileSize),
    bins = Array.from({ length: columns * rows }, () => [] as number[]),
    prepared: Array<{
      a: RasterVertex;
      b: RasterVertex;
      c: RasterVertex;
      area: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      top: boolean[];
      triangle: RasterTriangle;
    }> = [];
  let work = 0;
  for (const triangle of request.triangles) {
    if (triangle.material) {
      if (!triangle.attributes || !request.lighting)
        throw new VmotionError(
          'MATERIAL3D_INPUT',
          'Material rendering requires attributes and lighting',
        );
      validateShading(triangle.material, request.lighting, triangle.attributes);
    }
    if (
      triangle.vertices.some(
        (v) => v.length !== 5 || !v.every(Number.isFinite) || v[3] <= 0 || v[4] <= 0,
      ) ||
      triangle.color.some((c) => !Number.isInteger(c) || c < 0 || c > 255) ||
      !Number.isInteger(triangle.faceId) ||
      triangle.faceId < 0 ||
      triangle.faceId > 2147483647
    )
      throw new VmotionError('RASTER3D_TRIANGLE', 'Invalid clipped triangle');
    let [a, b, c] = triangle.vertices,
      area = edge(a, b, c[0], c[1]);
    if (!Number.isFinite(area)) throw new VmotionError('RASTER3D_TRIANGLE', 'Raster area overflow');
    if (Math.abs(area) < 1e-12) continue;
    if (area < 0) {
      [b, c] = [c, b];
      area = -area;
    }
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
      y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
      x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])) - 1),
      y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])) - 1);
    if (x1 < x0 || y1 < y0) continue;
    work += (x1 - x0 + 1) * (y1 - y0 + 1) * samples;
    if (work > 256_000_000)
      throw new VmotionError(
        'RASTER3D_WORK_LIMIT',
        'Raster coverage budget exceeded; lower preview resolution or simplify overlapping geometry',
      );
    const top = [
        [b, c],
        [c, a],
        [a, b],
      ].map(([u, v]) => v[1] < u[1] || (v[1] === u[1] && v[0] > u[0])),
      index = prepared.length;
    prepared.push({ a, b, c, area, x0, y0, x1, y1, top, triangle });
    for (let ty = Math.floor(y0 / tileSize); ty <= Math.floor(y1 / tileSize); ty++)
      for (let tx = Math.floor(x0 / tileSize); tx <= Math.floor(x1 / tileSize); tx++)
        bins[ty * columns + tx].push(index);
  }
  const pixels = Buffer.alloc(width * height * 4),
    depth = inspection ? new Float32Array(width * height).fill(Infinity) : undefined,
    faceIds = inspection ? new Int32Array(width * height).fill(-1) : undefined,
    size = tileSize * tileSize * samples,
    z = new Float64Array(size),
    eye = new Float64Array(size),
    ids = new Int32Array(size),
    rgb = new Uint32Array(size);
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < columns; tx++) {
      const left = tx * tileSize,
        top = ty * tileSize,
        w = Math.min(tileSize, width - left),
        h = Math.min(tileSize, height - top);
      z.fill(Infinity);
      eye.fill(Infinity);
      ids.fill(-1);
      rgb.fill(0);
      for (const index of bins[ty * columns + tx]) {
        const t = prepared[index],
          color = t.triangle.color[0] | (t.triangle.color[1] << 8) | (t.triangle.color[2] << 16);
        for (let y = Math.max(top, t.y0); y <= Math.min(top + h - 1, t.y1); y++)
          for (let x = Math.max(left, t.x0); x <= Math.min(left + w - 1, t.x1); x++)
            for (let s = 0; s < samples; s++) {
              const px = x + offsets[samples][s][0],
                py = y + offsets[samples][s][1],
                ea = edge(t.b, t.c, px, py),
                eb = edge(t.c, t.a, px, py),
                ec = edge(t.a, t.b, px, py);
              if (
                ea < 0 ||
                eb < 0 ||
                ec < 0 ||
                (ea === 0 && !t.top[0]) ||
                (eb === 0 && !t.top[1]) ||
                (ec === 0 && !t.top[2])
              )
                continue;
              const a = ea / t.area,
                b = eb / t.area,
                c = ec / t.area,
                ndc = a * t.a[2] + b * t.b[2] + c * t.c[2],
                at = ((y - top) * tileSize + x - left) * samples + s;
              if (ndc < z[at] || (ndc === z[at] && (ids[at] < 0 || t.triangle.faceId < ids[at]))) {
                z[at] = ndc;
                ids[at] = t.triangle.faceId;
                if (t.triangle.material && t.triangle.attributes && request.lighting) {
                  const attrs = t.triangle.attributes,
                    ordered =
                      t.a === t.triangle.vertices[0] && t.b === t.triangle.vertices[1]
                        ? attrs
                        : [attrs[0], attrs[2], attrs[1]],
                    den = a * t.a[3] + b * t.b[3] + c * t.c[3],
                    values = Array.from(
                      { length: 6 },
                      (_, i) =>
                        (a * t.a[3] * ordered[0][i] +
                          b * t.b[3] * ordered[1][i] +
                          c * t.c[3] * ordered[2][i]) /
                        den,
                    ),
                    shaded = shadeFragment(
                      t.triangle.material,
                      request.lighting,
                      [values[0], values[1], values[2]],
                      [values[3], values[4], values[5]],
                    );
                  rgb[at] = shaded[0] | (shaded[1] << 8) | (shaded[2] << 16);
                } else rgb[at] = color;
                eye[at] =
                  (a * t.a[4] * t.a[3] + b * t.b[4] * t.b[3] + c * t.c[4] * t.c[3]) /
                  (a * t.a[3] + b * t.b[3] + c * t.c[3]);
              }
            }
      }
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let count = 0,
            r = 0,
            g = 0,
            b = 0,
            best = Infinity,
            bestId = -1;
          for (let s = 0; s < samples; s++) {
            const at = (y * tileSize + x) * samples + s;
            if (ids[at] < 0) continue;
            count++;
            r += rgb[at] & 255;
            g += (rgb[at] >> 8) & 255;
            b += (rgb[at] >> 16) & 255;
            if (eye[at] < best || (eye[at] === best && ids[at] < bestId)) {
              best = eye[at];
              bestId = ids[at];
            }
          }
          const at = (top + y) * width + left + x;
          if (count) {
            pixels[at * 4] = Math.round(r / count);
            pixels[at * 4 + 1] = Math.round(g / count);
            pixels[at * 4 + 2] = Math.round(b / count);
            pixels[at * 4 + 3] = Math.round((255 * count) / samples);
          }
          if (depth) depth[at] = best;
          if (faceIds) faceIds[at] = bestId;
        }
    }
  return { pixels, depth, faceIds, backend: 'typescript', triangles: prepared.length };
}
