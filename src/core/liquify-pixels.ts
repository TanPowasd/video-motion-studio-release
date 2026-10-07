import { VmotionError } from './model.js';
import { samplePremultiplied } from './pixels.js';
import { inverse, transform, type Matrix, type Bounds } from './interaction.js';
import type { SpatialEffect } from './spatial-effect-schema.js';
export function applyLiquify(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<SpatialEffect, { type: 'liquify' }>,
  matrix: Matrix,
  bounds: Bounds,
) {
  const result = new Uint8ClampedArray(source),
    inv = inverse(matrix);
  if (!inv || effect.amount === 0 || !effect.brushes.length) return result;
  const brushes = effect.brushes
    .filter(
      (brush) => brush.amount !== 0 && (brush.mode !== 'push' || brush.dx !== 0 || brush.dy !== 0),
    )
    .map((brush) => ({
      ...brush,
      x: bounds.x + brush.center.x * bounds.width,
      y: bounds.y + brush.center.y * bounds.height,
    }))
    .reverse();
  if (!brushes.length) return result;
  let x0 = width,
    y0 = height,
    x1 = 0,
    y1 = 0;
  for (const brush of brushes) {
    const center = transform(matrix, { x: brush.x, y: brush.y }),
      rx = brush.radius * Math.hypot(matrix[0], matrix[2]),
      ry = brush.radius * Math.hypot(matrix[1], matrix[3]);
    x0 = Math.min(x0, Math.floor(center.x - rx - 1));
    y0 = Math.min(y0, Math.floor(center.y - ry - 1));
    x1 = Math.max(x1, Math.ceil(center.x + rx + 1));
    y1 = Math.max(y1, Math.ceil(center.y + ry + 1));
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  if (Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * brushes.length > 256 * 1024 * 1024)
    throw new VmotionError('LIQUIFY_BUDGET', 'Brush field exceeds 256M pixel/brush evaluations');
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const lx = inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4],
        ly = inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5];
      let sx = lx,
        sy = ly,
        changed = false;
      for (const brush of brushes) {
        const dx = sx - brush.x,
          dy = sy - brush.y,
          distance = Math.hypot(dx, dy);
        if (distance >= brush.radius) continue;
        const t = 1 - distance / brush.radius,
          falloff = t * t * (3 - 2 * t),
          amount = brush.amount * effect.amount * falloff;
        if (brush.mode === 'push') {
          sx -= brush.dx * amount;
          sy -= brush.dy * amount;
        } else if (brush.mode === 'twirl') {
          const angle = (-brush.angle * amount * Math.PI) / 180,
            c = Math.cos(angle),
            s = Math.sin(angle);
          sx = brush.x + dx * c - dy * s;
          sy = brush.y + dx * s + dy * c;
        } else {
          const factor = 1 - 0.75 * amount;
          sx = brush.x + dx * factor;
          sy = brush.y + dy * factor;
        }
        changed ||= sx !== lx || sy !== ly;
      }
      if (!changed || (sx === lx && sy === ly)) continue;
      const at = (y * width + x) * 4;
      result.fill(0, at, at + 4);
      samplePremultiplied(
        source,
        width,
        height,
        matrix[0] * sx + matrix[2] * sy + matrix[4] - 0.5,
        matrix[1] * sx + matrix[3] * sy + matrix[5] - 0.5,
        result,
        at,
        effect.edge,
      );
    }
  return result;
}
