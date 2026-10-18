/* Frame/time helpers for JSX (and plain .ts) components. Pure functions of the supplied clock. */
import { clamp, easings, spring, type Clock, type Easing } from './motion.js';

export type EasingName = keyof typeof easings;
export type EasingInput = Easing | EasingName;
const easingOf = (value: EasingInput | undefined): Easing => {
  if (value === undefined) return easings.linear;
  if (typeof value === 'function') return value;
  const found = easings[value];
  if (!found)
    throw new Error(
      `Unknown easing "${String(value)}"; use one of ${Object.keys(easings).join(', ')} or cubicEasing()`,
    );
  return found;
};

export interface RemapOptions {
  /** Easing applied inside every segment (or one per segment). Default linear. */
  easing?: EasingInput | EasingInput[];
  /**
   * Clamp to the first/last output value outside the input range. Default true;
   * false extrapolates the edge segments linearly; 'start'/'end' clamps one side only.
   */
  clamp?: boolean | 'start' | 'end';
}

/**
 * Piecewise mapping of `value` from input stops to output stops.
 * `remap(frame, [0, 30], [0, 1])`; `remap(frame, [0, 10, 40], [0, 120, 80], { easing: 'outCubic' })`.
 */
export function remap(
  value: number,
  input: readonly number[],
  output: readonly number[],
  options: RemapOptions = {},
): number {
  if (input.length < 2 || input.length !== output.length)
    throw new Error('remap() needs input and output stop lists of equal length (at least 2)');
  for (let i = 0; i < input.length; i++) {
    if (!Number.isFinite(input[i]) || !Number.isFinite(output[i]))
      throw new Error('remap() stops must be finite numbers');
    if (i && input[i] <= input[i - 1])
      throw new Error('remap() input stops must strictly increase');
  }
  if (!Number.isFinite(value)) throw new Error('remap() value must be finite');
  const mode = options.clamp ?? true,
    clampStart = mode === true || mode === 'start',
    clampEnd = mode === true || mode === 'end',
    last = input.length - 1;
  if (value <= input[0] && clampStart) return output[0];
  if (value >= input[last] && clampEnd) return output[last];
  let segment = 0;
  while (segment < last - 1 && value > input[segment + 1]) segment++;
  const span = input[segment + 1] - input[segment],
    raw = (value - input[segment]) / span,
    eased =
      raw < 0 || raw > 1
        ? raw
        : easingOf(
            Array.isArray(options.easing)
              ? options.easing[Math.min(segment, options.easing.length - 1)]
              : (options.easing as EasingInput | undefined),
          )(raw);
  return output[segment] + (output[segment + 1] - output[segment]) * eased;
}

export interface SpringOptions {
  /** Local frame where the spring is released. */
  start?: number;
  from?: number;
  to?: number;
  mass?: number;
  stiffness?: number;
  damping?: number;
  /** Initial velocity in progress units per second. */
  velocity?: number;
}
/** Damped harmonic oscillator from `from` to `to` (closed form; seekable, no state). */
export function springTo(clock: Clock, options: SpringOptions = {}) {
  const from = options.from ?? 0,
    to = options.to ?? 1;
  return from + (to - from) * spring(clock, options);
}
/** Frames until a spring stays within `threshold` of its target (searches up to 20 s). */
export function springSettle(
  fps: number,
  options: Omit<SpringOptions, 'start' | 'from' | 'to'> & { threshold?: number } = {},
) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('springSettle() needs a positive fps');
  const threshold = options.threshold ?? 0.001,
    limit = Math.ceil(fps * 20);
  let settled = limit;
  for (let frame = limit; frame >= 0; frame--) {
    if (Math.abs(1 - spring({ frame, fps }, options)) > threshold) break;
    settled = frame;
  }
  return settled;
}

export interface BeatInfo {
  /** Continuous beat count since `offset` (negative before it). */
  beat: number;
  /** Integer beat index (floor). */
  index: number;
  /** 0..1 position inside the current beat. */
  phase: number;
  /** Bar index and beat inside the bar. */
  bar: number;
  beatInBar: number;
  framesPerBeat: number;
  /** 1 exactly on the beat, decaying exponentially (decay = beats to fall to ~5%). */
  pulse: number;
  /** Local frame of the given beat index; handy for cuts: frameOfBeat(index + 1). */
  frameOfBeat: (index: number) => number;
}
/** Musical clock for visual beat sync (constant BPM). Use sound tempoClock() for tempo maps. */
export function beatClock(
  clock: Clock,
  bpm: number,
  options: { offset?: number; beatsPerBar?: number; decay?: number } = {},
): BeatInfo {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400)
    throw new Error('beatClock() bpm must be between 20 and 400');
  const framesPerBeat = (clock.fps * 60) / bpm,
    offset = options.offset ?? 0,
    perBar = Math.max(1, Math.floor(options.beatsPerBar ?? 4)),
    beat = (clock.frame - offset) / framesPerBeat,
    index = Math.floor(beat),
    phase = beat - index,
    decay = options.decay ?? 0.5;
  return {
    beat,
    index,
    phase,
    bar: Math.floor(index / perBar),
    beatInBar: ((index % perBar) + perBar) % perBar,
    framesPerBeat,
    pulse: Math.exp((-3 * phase) / Math.max(1e-6, decay)),
    frameOfBeat: (i: number) => offset + i * framesPerBeat,
  };
}

export const toFrames = (seconds: number, clock: Pick<Clock, 'fps'>) => seconds * clock.fps;

const parseHex = (value: string) => {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) throw new Error(`mixColor() accepts #rgb/#rgba/#rrggbb/#rrggbbaa colors, got "${value}"`);
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
};
/** Linear blend of two hex colors; t is clamped to 0..1. */
export function mixColor(from: string, to: string, t: number) {
  const a = parseHex(from),
    b = parseHex(to),
    k = clamp(t),
    c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** Deterministic pick from a list by an integer index (wraps negatives), e.g. per-beat styles. */
export function cycle<T>(list: readonly T[], index: number): T {
  if (!list.length) throw new Error('cycle() needs a non-empty list');
  const i = Math.floor(index);
  return list[((i % list.length) + list.length) % list.length];
}
