import type { Keyframe } from './model.js';
import { keyframeSchema, extrapolationSchema } from './animation-schema.js';
import { GeometryCache } from './geometry-cache.js';
function sameKeys(a: readonly Keyframe[], b: readonly Keyframe[]) {
  return (
    a.length === b.length &&
    a.every((key, i) => {
      const other = b[i];
      if (
        !Object.is(key.frame, other.frame) ||
        !Object.is(key.value, other.value) ||
        key.easing !== other.easing
      )
        return false;
      if (key.bezier === undefined || other.bezier === undefined)
        return key.bezier === other.bezier;
      return (
        key.bezier.length === other.bezier.length &&
        key.bezier.every((value, j) => Object.is(value, other.bezier![j]))
      );
    })
  );
}
type Mode = ReturnType<typeof extrapolationSchema.parse>;
export type PreparedKeyframes = { readonly keys: readonly Readonly<Keyframe>[] };
const cache = new GeometryCache<{ raw: readonly Keyframe[]; prepared: PreparedKeyframes }>(
  8 * 1024 * 1024,
  128,
);
export function prepareKeyframes(keys: readonly Keyframe[]): PreparedKeyframes {
  const signature = JSON.stringify(keys),
    existing = cache.get(signature);
  if (existing && sameKeys(existing.raw, keys)) return existing.prepared;
  if (!keys.length || keys.length > 100000) throw new Error('Expected 1–100000 keyframes');
  const sorted = keys.map((k) => keyframeSchema.parse(k)).sort((a, b) => a.frame - b.frame);
  if (sorted.some((k, i) => i > 0 && k.frame === sorted[i - 1].frame))
    throw new Error('Duplicate keyframe times');
  for (const key of sorted) {
    if (key.bezier) Object.freeze(key.bezier);
    Object.freeze(key);
  }
  const prepared = Object.freeze({ keys: Object.freeze(sorted) });
  cache.put(
    signature,
    { raw: structuredClone(keys), prepared },
    signature.length * 2 + sorted.length * 160,
  );
  return prepared;
}
/** Map outside time independently; linear uses the nearest two-key secant. */
export function mapKeyframeTime(
  keys: PreparedKeyframes['keys'],
  frame: number,
  before: Mode = 'constant',
  after: Mode = 'constant',
) {
  if (!Number.isFinite(frame)) throw new Error('Keyframe sample must be finite');
  extrapolationSchema.parse(before);
  extrapolationSchema.parse(after);
  const first = keys[0],
    last = keys.at(-1)!,
    duration = last.frame - first.frame;
  if (!duration || (frame >= first.frame && frame <= last.frame)) return { frame, offset: 0 };
  const mode = frame < first.frame ? before : after;
  if (mode === 'constant')
    return { value: frame < first.frame ? first.value : last.value, frame, offset: 0 };
  if (mode === 'linear') {
    const a = frame < first.frame ? first : keys[keys.length - 2],
      b = frame < first.frame ? keys[1] : last;
    return {
      value: a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame),
      frame,
      offset: 0,
    };
  }
  const phase = (frame - first.frame) / duration,
    cycles = Math.floor(phase),
    fraction = phase - cycles;
  if (mode === 'pingpong')
    return {
      frame: first.frame + (((cycles % 2) + 2) % 2 ? 1 - fraction : fraction) * duration,
      offset: 0,
    };
  return {
    frame: first.frame + fraction * duration,
    offset: mode === 'cycleOffset' ? cycles * (last.value - first.value) : 0,
  };
}
export const keyframeIndexInfo = () => cache.report();
