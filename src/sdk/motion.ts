import type { ComponentContext } from './index.js';
import { bezierEase } from '../core/time.js';
export type Clock = Pick<ComponentContext, 'frame' | 'fps'>;
export type Easing = (progress: number) => number;
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const easings = {
  linear: (t: number) => t,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
};
export const cubicEasing = (x1: number, y1: number, x2: number, y2: number): Easing => {
  if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v)) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
    throw new Error('Invalid cubic Bezier easing');
  return (t) => bezierEase(clamp(t), [x1, y1, x2, y2]);
};
export function resamplePath(points: Vec2[], count: number, closed = false) {
  if (!Number.isInteger(count) || count < 2 || count > 10000 || points.length < 2)
    throw new Error('Path resampling needs 2–10000 samples and at least two points');
  const source = closed ? [...points, points[0]] : points;
  return Array.from({ length: count }, (_, i) => {
    const p = followPath(source, i / (closed ? count : count - 1));
    return { x: p.x, y: p.y };
  });
}
export function morphPaths(
  from: Vec2[],
  to: Vec2[],
  t: number,
  options: { samples?: number; closed?: boolean } = {},
) {
  const count = options.samples ?? Math.max(from.length, to.length);
  return morphPoints(
    resamplePath(from, count, options.closed),
    resamplePath(to, count, options.closed),
    clamp(t),
  );
}
export function progress(
  clock: Clock,
  options: { start?: number; duration: number; easing?: Easing; loop?: boolean; yoyo?: boolean },
) {
  if (!Number.isFinite(options.duration) || options.duration <= 0)
    throw new Error('Animation duration must be positive');
  const elapsed = clock.frame - (options.start ?? 0);
  if (elapsed < 0) return 0;
  let value = elapsed / options.duration;
  if (options.loop) {
    const cycle = Math.floor(value);
    value -= cycle;
    if (options.yoyo && cycle % 2) value = 1 - value;
  } else value = clamp(value);
  return (options.easing ?? easings.inOutCubic)(value);
}
export function tween(
  clock: Clock,
  from: number,
  to: number,
  options: { start?: number; duration: number; easing?: Easing; loop?: boolean; yoyo?: boolean },
) {
  return lerp(from, to, progress(clock, options));
}
export function spring(
  clock: Clock,
  options: {
    start?: number;
    mass?: number;
    stiffness?: number;
    damping?: number;
    velocity?: number;
  } = {},
) {
  const t = Math.max(0, (clock.frame - (options.start ?? 0)) / clock.fps),
    mass = options.mass ?? 1,
    k = options.stiffness ?? 170,
    c = options.damping ?? 24,
    v = options.velocity ?? 0;
  if (mass <= 0 || k <= 0 || c < 0 || !Number.isFinite(t))
    throw new Error('Invalid spring parameters');
  const w = Math.sqrt(k / mass),
    z = c / (2 * Math.sqrt(k * mass));
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w - v) / wd) * Math.sin(wd * t));
  }
  if (Math.abs(z - 1) < 1e-6) return 1 - Math.exp(-w * t) * (1 + (w - v) * t);
  const r1 = -w * (z - Math.sqrt(z * z - 1)),
    r2 = -w * (z + Math.sqrt(z * z - 1)),
    a = (-v - r2) / (r1 - r2),
    b = 1 - a;
  return 1 - a * Math.exp(r1 * t) - b * Math.exp(r2 * t);
}
export function stagger(
  clock: Clock,
  index: number,
  options: { start?: number; duration: number; delay: number; easing?: Easing },
) {
  return progress(clock, { ...options, start: (options.start ?? 0) + index * options.delay });
}
export function localClock<T extends Clock>(clock: T, start: number): T {
  return {
    ...clock,
    frame: clock.frame - start,
    ...('seconds' in clock ? { seconds: (clock.frame - start) / clock.fps } : {}),
  };
}
export interface Vec2 {
  x: number;
  y: number;
}
export function followPath(points: Vec2[], t: number) {
  if (points.length < 2) throw new Error('A motion path needs at least two points');
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(
      lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    );
  const distance = clamp(t) * lengths.at(-1)!;
  for (let i = 1; i < points.length; i++)
    if (distance <= lengths[i] || i === points.length - 1) {
      const q =
          lengths[i] === lengths[i - 1]
            ? 0
            : (distance - lengths[i - 1]) / (lengths[i] - lengths[i - 1]),
        a = points[i - 1],
        b = points[i];
      return {
        x: lerp(a.x, b.x, q),
        y: lerp(a.y, b.y, q),
        rotation: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
  return { ...points[0], rotation: 0 };
}
export function morphPoints(from: Vec2[], to: Vec2[], t: number) {
  if (from.length !== to.length || from.length < 2)
    throw new Error('Morph point lists must have equal lengths of at least two');
  return from.map((p, i) => ({ x: lerp(p.x, to[i].x, t), y: lerp(p.y, to[i].y, t) }));
}
export const pointsPath = (points: Vec2[], closed = false) =>
  points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') + (closed ? ' Z' : '');
