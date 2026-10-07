import { parsePath } from './vector.js';
import { VmotionError } from './model.js';
export type CurvePoint = { x: number; y: number };
type Curve = {
  a: CurvePoint;
  b: CurvePoint;
  c: CurvePoint;
  d: CurvePoint;
  line: boolean;
  table: number[];
  length: number;
  end: number;
};
export type PreparedCurvePath = { length: number; curves: Curve[]; first: CurvePoint; svg: string };
const cache = new Map<string, PreparedCurvePath>(),
  nodes = [0, 0.5384693101056831, -0.5384693101056831, 0.906179845938664, -0.906179845938664],
  weights = [
    0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891,
    0.2369268850561891,
  ];
const point = (curve: Curve, t: number): CurvePoint => {
  if (curve.line)
    return {
      x: curve.a.x + (curve.d.x - curve.a.x) * t,
      y: curve.a.y + (curve.d.y - curve.a.y) * t,
    };
  const q = 1 - t;
  return {
    x:
      q ** 3 * curve.a.x +
      3 * q * q * t * curve.b.x +
      3 * q * t * t * curve.c.x +
      t ** 3 * curve.d.x,
    y:
      q ** 3 * curve.a.y +
      3 * q * q * t * curve.b.y +
      3 * q * t * t * curve.c.y +
      t ** 3 * curve.d.y,
  };
};
const tangent = (curve: Curve, t: number): CurvePoint =>
  curve.line
    ? { x: curve.d.x - curve.a.x, y: curve.d.y - curve.a.y }
    : {
        x:
          3 * (1 - t) ** 2 * (curve.b.x - curve.a.x) +
          6 * (1 - t) * t * (curve.c.x - curve.b.x) +
          3 * t * t * (curve.d.x - curve.c.x),
        y:
          3 * (1 - t) ** 2 * (curve.b.y - curve.a.y) +
          6 * (1 - t) * t * (curve.c.y - curve.b.y) +
          3 * t * t * (curve.d.y - curve.c.y),
      };
function gauss(curve: Curve, a: number, b: number) {
  const m = (a + b) / 2,
    h = (b - a) / 2;
  let result = 0;
  for (let i = 0; i < 5; i++) {
    const v = tangent(curve, m + h * nodes[i]);
    result += weights[i] * Math.hypot(v.x, v.y);
  }
  return result * h;
}
function length(curve: Curve, a: number, b: number, budget: { left: number }, depth = 0): number {
  if (--budget.left < 0)
    throw new VmotionError(
      'MOTION_PATH_BUDGET',
      'Curve length integration exceeded its work budget',
    );
  if (curve.line) return Math.hypot(curve.d.x - curve.a.x, curve.d.y - curve.a.y) * (b - a);
  const m = (a + b) / 2,
    whole = gauss(curve, a, b),
    half = gauss(curve, a, m) + gauss(curve, m, b);
  if (Math.abs(whole - half) < 0.00005 || depth >= 16) return half;
  return length(curve, a, m, budget, depth + 1) + length(curve, m, b, budget, depth + 1);
}
export function prepareCurvePath(svg: string): PreparedCurvePath {
  if (cache.has(svg)) {
    const value = cache.get(svg)!;
    cache.delete(svg);
    cache.set(svg, value);
    return value;
  }
  if (svg.length > 1e6)
    throw new VmotionError('MOTION_PATH_BUDGET', 'Path source exceeds one million characters');
  const normalized = parsePath(svg).toSVGString(),
    tokens = normalized.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [],
    curves: Curve[] = [],
    budget = { left: 50000 };
  let i = 0,
    current: CurvePoint = { x: 0, y: 0 },
    start = { ...current },
    first: CurvePoint | undefined,
    total = 0;
  const pair = () => {
    const x = Number(tokens[i++]),
      y = Number(tokens[i++]);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new VmotionError('MOTION_PATH_SOURCE', 'Invalid normalized path coordinates');
    return { x, y };
  };
  const add = (b: CurvePoint, c: CurvePoint, d: CurvePoint, line = false) => {
    if (curves.length >= 4096)
      throw new VmotionError(
        'MOTION_PATH_BUDGET',
        'Path contains more than 4096 normalized segments',
      );
    const curve: Curve = { a: current, b, c, d, line, table: [0], length: 0, end: 0 };
    for (let step = 0; step < 16; step++)
      curve.table.push(curve.table.at(-1)! + length(curve, step / 16, (step + 1) / 16, budget));
    curve.length = curve.table.at(-1)!;
    total += curve.length;
    curve.end = total;
    if (curve.length > 1e-9) curves.push(curve);
    current = d;
  };
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') {
      current = pair();
      start = current;
      first ??= current;
    } else if (command === 'L') {
      const d = pair();
      add(current, d, d, true);
    } else if (command === 'C') add(pair(), pair(), pair());
    else if (command === 'Q') {
      const q = pair(),
        d = pair();
      add(
        { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) },
        { x: d.x + (2 / 3) * (q.x - d.x), y: d.y + (2 / 3) * (q.y - d.y) },
        d,
      );
    } else if (command === 'Z') {
      if (current.x !== start.x || current.y !== start.y) add(current, start, start, true);
    } else
      throw new VmotionError('MOTION_PATH_SOURCE', 'Unsupported normalized path command', {
        command,
      });
  }
  if (!first) throw new VmotionError('MOTION_PATH_SOURCE', 'Motion path contains no contour');
  const result = { svg, length: total, curves, first };
  for (const curve of curves) {
    Object.freeze(curve.a);
    Object.freeze(curve.b);
    Object.freeze(curve.c);
    Object.freeze(curve.d);
    Object.freeze(curve.table);
    Object.freeze(curve);
  }
  Object.freeze(curves);
  Object.freeze(first);
  Object.freeze(result);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  if (svg.length <= 65536) cache.set(svg, result);
  return result;
}
export function sampleCurvePath(
  path: PreparedCurvePath | string,
  progress: number,
  repeat: 'clamp' | 'loop' | 'pingpong' = 'clamp',
) {
  const prepared = typeof path === 'string' ? prepareCurvePath(path) : path;
  if (!Number.isFinite(progress))
    throw new VmotionError('MOTION_PATH_PROGRESS', 'Progress must be finite');
  let u = Math.max(0, Math.min(1, progress)),
    direction = 1;
  if (repeat === 'loop') u = ((progress % 1) + 1) % 1;
  else if (repeat === 'pingpong') {
    const phase = ((progress % 2) + 2) % 2;
    u = phase <= 1 ? phase : 2 - phase;
    direction = phase <= 1 ? 1 : -1;
  }
  if (!prepared.length)
    return {
      ...prepared.first,
      tangentX: 1,
      tangentY: 0,
      rotation: 0,
      progress: u,
      length: 0,
      contourJump: false,
    };
  const distance = u * prepared.length;
  let low = 0,
    high = prepared.curves.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (prepared.curves[mid].end < distance) low = mid + 1;
    else high = mid;
  }
  const curve = prepared.curves[low],
    local = distance - (curve.end - curve.length);
  let segment = 0;
  while (segment < 15 && curve.table[segment + 1] < local) segment++;
  let a = segment / 16,
    b = (segment + 1) / 16,
    t =
      a +
      ((b - a) * (local - curve.table[segment])) /
        (curve.table[segment + 1] - curve.table[segment]);
  if (curve.line) t = curve.length ? local / curve.length : 0;
  else
    for (let iteration = 0; iteration < 14; iteration++) {
      const reached = curve.table[segment] + length(curve, segment / 16, t, { left: 1000 });
      if (Math.abs(reached - local) < 0.0001) break;
      if (reached < local) a = t;
      else b = t;
      t = (a + b) / 2;
    }
  const p = point(curve, t);
  let v = tangent(curve, t);
  if (Math.hypot(v.x, v.y) < 1e-9) {
    const before = point(curve, Math.max(0, t - 0.0001)),
      after = point(curve, Math.min(1, t + 0.0001));
    v = { x: after.x - before.x, y: after.y - before.y };
  }
  const norm = Math.hypot(v.x, v.y) || 1,
    tangentX = (v.x / norm) * direction,
    tangentY = (v.y / norm) * direction;
  return {
    ...p,
    tangentX,
    tangentY,
    rotation: (Math.atan2(tangentY, tangentX) * 180) / Math.PI,
    progress: u,
    length: prepared.length,
    contourJump:
      low > 0 &&
      (curve.a.x !== prepared.curves[low - 1].d.x || curve.a.y !== prepared.curves[low - 1].d.y),
  };
}
