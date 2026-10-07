import type { SpatialEffect } from './spatial-effect-schema.js';
import { samplePremultiplied } from './pixels.js';
import { inverse, transform, type Matrix, type Bounds } from './interaction.js';
import { applyWarpEffect } from './warp-pixels.js';
import { applyLiquify } from './liquify-pixels.js';
export type SpatialOptions = {
  scale?: number;
  matrix?: Matrix;
  bounds?: Bounds;
  canvasMatrix?: Matrix;
};
export function applySpatialEffect(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  effect: SpatialEffect,
  options: SpatialOptions,
) {
  const result = new Uint8ClampedArray(source.length),
    scale = options.scale ?? 1,
    matrix =
      effect.space === 'canvas'
        ? (options.canvasMatrix ?? [scale, 0, 0, scale, 0, 0])
        : (options.matrix ?? [scale, 0, 0, scale, 0, 0]),
    inv = inverse(matrix as Matrix);
  if (!inv) return new Uint8ClampedArray(source);
  const bounds =
      effect.region ??
      (effect.space === 'canvas'
        ? {
            x: 0,
            y: 0,
            width: width / Math.max(1e-9, Math.abs(matrix[0])),
            height: height / Math.max(1e-9, Math.abs(matrix[3])),
          }
        : (options.bounds ?? { x: 0, y: 0, width: width / scale, height: height / scale })),
    angle = 'angle' in effect ? (effect.angle * Math.PI) / 180 : 0,
    sin = Math.sin(angle),
    cos = Math.cos(angle),
    center =
      'center' in effect
        ? {
            x: bounds.x + effect.center.x * bounds.width,
            y: bounds.y + effect.center.y * bounds.height,
          }
        : { x: 0, y: 0 };
  if (effect.type === 'meshWarp' || effect.type === 'cornerPin')
    return applyWarpEffect(source, width, height, effect, matrix as Matrix, bounds);
  if (effect.type === 'liquify')
    return applyLiquify(source, width, height, effect, matrix as Matrix, bounds);
  if ((effect.type === 'linearWipe' || effect.type === 'radialWipe') && effect.progress >= 1)
    return new Uint8ClampedArray(source);
  if ((effect.type === 'linearWipe' || effect.type === 'radialWipe') && effect.progress <= 0)
    return result;
  if (
    ((effect.type === 'waveWarp' || effect.type === 'rgbSplit') &&
      effect.amountX === 0 &&
      effect.amountY === 0) ||
    (effect.type === 'rgbSplit' && effect.intensity === 0) ||
    ((effect.type === 'twirl' || effect.type === 'bulge') && effect.amount === 0)
  )
    return new Uint8ClampedArray(source);
  let min = 0,
    max = 0;
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  if (effect.type === 'linearWipe') {
    const projections = corners.map((p) => p.x * cos + p.y * sin);
    min = Math.min(...projections);
    max = Math.max(...projections);
  }
  if (effect.type === 'radialWipe')
    max = Math.max(...corners.map((p) => Math.hypot(p.x - center.x, p.y - center.y)));
  const r = new Uint8ClampedArray(4),
    g = new Uint8ClampedArray(4),
    b = new Uint8ClampedArray(4),
    smooth = (t: number) => {
      const p = Math.max(0, Math.min(1, t));
      return p * p * (3 - 2 * p);
    };
  const sample = (
    x: number,
    y: number,
    out: Uint8ClampedArray,
    index: number,
    edge: 'transparent' | 'clamp' | 'wrap',
  ) => {
    const px = matrix[0] * x + matrix[2] * y + matrix[4] - 0.5,
      py = matrix[1] * x + matrix[3] * y + matrix[5] - 0.5;
    samplePremultiplied(source, width, height, px, py, out, index, edge);
  };
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  if (effect.type === 'twirl' || effect.type === 'bulge') {
    result.set(source);
    const pixelCenter = transform(matrix as Matrix, center),
      rx = effect.radius * Math.hypot(matrix[0], matrix[2]),
      ry = effect.radius * Math.hypot(matrix[1], matrix[3]);
    x0 = Math.max(0, Math.floor(pixelCenter.x - rx - 1));
    x1 = Math.min(width - 1, Math.ceil(pixelCenter.x + rx + 1));
    y0 = Math.max(0, Math.floor(pixelCenter.y - ry - 1));
    y1 = Math.min(height - 1, Math.ceil(pixelCenter.y + ry + 1));
  } else {
    for (let i = 3; i < source.length; i += 4)
      if (source[i]) {
        const p = (i - 3) / 4,
          x = p % width,
          y = Math.floor(p / width);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    if (x1 < 0) return result;
    if (effect.type === 'waveWarp' || effect.type === 'rgbSplit') {
      const dx = Math.abs(matrix[0] * effect.amountX) + Math.abs(matrix[2] * effect.amountY) + 1,
        dy = Math.abs(matrix[1] * effect.amountX) + Math.abs(matrix[3] * effect.amountY) + 1;
      if (effect.edge === 'wrap' && (x0 - dx < 0 || x1 + dx >= width)) {
        x0 = 0;
        x1 = width - 1;
      } else {
        x0 = Math.max(0, Math.floor(x0 - dx));
        x1 = Math.min(width - 1, Math.ceil(x1 + dx));
      }
      if (effect.edge === 'wrap' && (y0 - dy < 0 || y1 + dy >= height)) {
        y0 = 0;
        y1 = height - 1;
      } else {
        y0 = Math.max(0, Math.floor(y0 - dy));
        y1 = Math.min(height - 1, Math.ceil(y1 + dy));
      }
    }
  }
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4,
        lx = inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4],
        ly = inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5];
      if (effect.type === 'linearWipe' || effect.type === 'radialWipe') {
        if (!source[i + 3]) continue;
        const position =
            effect.type === 'linearWipe'
              ? lx * cos + ly * sin
              : Math.hypot(lx - center.x, ly - center.y),
          edge = min + (max - min) * effect.progress,
          coverage = effect.feather
            ? smooth((edge - position) / effect.feather + 0.5)
            : position <= edge
              ? 1
              : 0;
        result[i] = source[i];
        result[i + 1] = source[i + 1];
        result[i + 2] = source[i + 2];
        result[i + 3] = Math.round(source[i + 3] * coverage);
        if (!result[i + 3]) result[i] = result[i + 1] = result[i + 2] = 0;
        continue;
      }
      if (effect.type === 'rgbSplit') {
        r.fill(0);
        g.fill(0);
        b.fill(0);
        sample(lx + effect.amountX, ly + effect.amountY, r, 0, effect.edge);
        sample(lx, ly, g, 0, effect.edge);
        sample(lx - effect.amountX, ly - effect.amountY, b, 0, effect.edge);
        const alpha = Math.max(r[3], g[3], b[3]),
          mix = effect.intensity,
          outputAlpha = source[i + 3] * (1 - mix) + alpha * mix;
        if (outputAlpha) {
          result[i] = (source[i] * source[i + 3] * (1 - mix) + r[0] * r[3] * mix) / outputAlpha;
          result[i + 1] =
            (source[i + 1] * source[i + 3] * (1 - mix) + g[1] * g[3] * mix) / outputAlpha;
          result[i + 2] =
            (source[i + 2] * source[i + 3] * (1 - mix) + b[2] * b[3] * mix) / outputAlpha;
          result[i + 3] = outputAlpha;
        }
        continue;
      }
      let sx = lx,
        sy = ly;
      if (effect.type === 'waveWarp') {
        const phase =
            2 *
            Math.PI *
            (((lx - bounds.x) * sin + (ly - bounds.y) * cos) / effect.wavelength + effect.phase),
          amount = Math.sin(phase);
        sx += amount * effect.amountX;
        sy += amount * effect.amountY;
      } else {
        const dx = lx - center.x,
          dy = ly - center.y,
          distance = Math.hypot(dx, dy),
          falloff = Math.max(0, 1 - distance / effect.radius) ** 2;
        if (distance >= effect.radius) continue;
        if (effect.type === 'twirl') {
          const t = ((-effect.amount * Math.PI) / 180) * falloff,
            c = Math.cos(t),
            s = Math.sin(t);
          sx = center.x + dx * c - dy * s;
          sy = center.y + dx * s + dy * c;
        } else {
          const factor = 1 - effect.amount * falloff;
          sx = center.x + dx * factor;
          sy = center.y + dy * factor;
        }
      }
      result[i] = result[i + 1] = result[i + 2] = result[i + 3] = 0;
      sample(sx, sy, result, i, effect.edge);
    }
  return result;
}
