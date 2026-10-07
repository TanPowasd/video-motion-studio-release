import { VmotionError } from './model.js';
export type WarpPoint = { x: number; y: number; weight?: number };
export function makeWarpGrid(
  columns: number,
  rows: number,
  fn: (u: number, v: number, index: number) => WarpPoint = (u, v) => ({ x: u, y: v }),
) {
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns > 32 ||
    rows > 32
  )
    throw new VmotionError('WARP_GRID', 'Grid dimensions must be integers 1–32');
  return Array.from({ length: (columns + 1) * (rows + 1) }, (_, i) => {
    const u = (i % (columns + 1)) / columns,
      v = Math.floor(i / (columns + 1)) / rows,
      p = fn(u, v, i),
      weight = p.weight ?? 1;
    if (
      ![p.x, p.y, weight].every(Number.isFinite) ||
      p.x < -4 ||
      p.x > 5 ||
      p.y < -4 ||
      p.y > 5 ||
      weight < 0.01 ||
      weight > 100
    )
      throw new VmotionError(
        'WARP_POINT',
        'Control point coordinates/weight are outside the supported range',
        { index: i },
      );
    return { x: p.x, y: p.y, weight };
  });
}
export function pinGrid(corners: readonly { x: number; y: number }[]) {
  if (corners.length !== 4 || corners.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    throw new VmotionError('CORNER_PIN', 'Provide four finite corners in TL/TR/BR/BL order');
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4],
      c = corners[(i + 2) % 4],
      cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-10 || (sign && Math.sign(cross) !== sign))
      throw new VmotionError(
        'CORNER_PIN',
        'Four corners must form a nondegenerate convex quadrilateral',
      );
    sign = Math.sign(cross);
  }
  const [a, b, c, d] = corners,
    dx1 = b.x - c.x,
    dx2 = d.x - c.x,
    dx3 = a.x - b.x + c.x - d.x,
    dy1 = b.y - c.y,
    dy2 = d.y - c.y,
    dy3 = a.y - b.y + c.y - d.y;
  let g = 0,
    h = 0;
  if (Math.abs(dx3) + Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12)
      throw new VmotionError('CORNER_PIN', 'Corner projection is singular');
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const weights = [1, 1 + g, 1 + g + h, 1 + h];
  if (weights.some((w) => !Number.isFinite(w) || w <= 1e-8))
    throw new VmotionError('CORNER_PIN', 'Corner projection crosses the perspective horizon');
  // Grid row order is TL, TR, BL, BR. The public corner order remains TL, TR, BR, BL.
  return [0, 1, 3, 2].map((i) => ({ ...corners[i], weight: weights[i] }));
}
