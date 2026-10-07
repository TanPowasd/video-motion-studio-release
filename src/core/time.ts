import type { Keyframe, Node, Project } from './model.js';
import { prepareKeyframes, mapKeyframeTime, type PreparedKeyframes } from './keyframe-index.js';
import type { AnimationChannel } from './animation-schema.js';
export { prepareKeyframes, type PreparedKeyframes } from './keyframe-index.js';
export const frameSeconds = (frame: number, fps: Project['fps']) => (frame * fps.den) / fps.num;
export const frameSample = (frame: number, fps: Project['fps'], sampleRate = 48000) =>
  Number((BigInt(Math.trunc(frame)) * BigInt(fps.den) * BigInt(sampleRate)) / BigInt(fps.num));
export function ease(t: number, easing: Keyframe['easing']) {
  if (easing === 'hold') return t >= 1 ? 1 : 0;
  if (easing === 'easeIn') return t * t * t;
  if (easing === 'easeOut') return 1 - (1 - t) ** 3;
  if (easing === 'easeInOut') return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  if (easing === 'spring') return t === 0 || t === 1 ? t : 1 - Math.exp(-7 * t) * Math.cos(12 * t);
  return t;
}
export function sampleKeyframes(
  prepared: PreparedKeyframes,
  frame: number,
  options: Pick<AnimationChannel, 'before' | 'after'> = {},
): number {
  const sorted = prepared.keys,
    mapped = mapKeyframeTime(sorted, frame, options.before, options.after);
  if (mapped.value !== undefined) return mapped.value;
  frame = mapped.frame;
  if (frame <= sorted[0].frame) return mapped.offset + sorted[0].value;
  let low = 1,
    high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frame < sorted[mid].frame) high = mid;
    else low = mid + 1;
  }
  const i = low;
  if (i < sorted.length) {
    const a = sorted[i - 1],
      b = sorted[i];
    return (
      mapped.offset +
      a.value +
      (b.value - a.value) *
        (a.easing === 'bezier'
          ? bezierEase((frame - a.frame) / (b.frame - a.frame), a.bezier ?? [0.25, 0.1, 0.25, 1])
          : ease((frame - a.frame) / (b.frame - a.frame), a.easing))
    );
  }
  return mapped.offset + sorted.at(-1)!.value;
}
export function interpolate(
  keys: Keyframe[],
  frame: number,
  options: Pick<AnimationChannel, 'before' | 'after'> = {},
): number {
  return sampleKeyframes(prepareKeyframes(keys), frame, options);
}
export function evaluateNode(node: Node, frame: number): Node {
  if (new Set(node.animations.map((c) => c.property)).size !== node.animations.length)
    throw new Error('Duplicate animation properties');
  const result =
    node.animations.length || node.animationLayers?.length ? structuredClone(node) : { ...node };
  for (const animation of node.animations)
    setNumericPath(result, animation.property, interpolate(animation.keys, frame, animation));
  result.opacity = Math.min(1, Math.max(0, result.opacity));
  result.reveal = Math.min(1, Math.max(0, result.reveal));
  for (const layer of result.animationLayers ?? []) {
    const prepared = layer.channels.map((channel) => {
      getNumericPath(result, channel.property);
      return prepareKeyframes(channel.keys);
    });
    layer.weight = Math.min(1, Math.max(0, layer.weight));
    if (
      !layer.enabled ||
      frame < layer.start ||
      (layer.end !== undefined && frame >= layer.end) ||
      !layer.weight
    )
      continue;
    const local = (frame - layer.start) * layer.rate + layer.offset;
    if (Math.abs(layer.rate) > 1000 || !Number.isFinite(local))
      throw new Error('Animation layer clock is outside its finite rate bounds');
    for (const [index, channel] of layer.channels.entries()) {
      const value = sampleKeyframes(prepared[index], local, channel),
        base = getNumericPath(result, channel.property);
      setNumericPath(
        result,
        channel.property,
        layer.blend === 'add'
          ? base + layer.weight * value
          : layer.blend === 'multiply'
            ? base * (1 + layer.weight * (value - 1))
            : base + layer.weight * (value - base),
      );
    }
  }
  result.opacity = Math.min(1, Math.max(0, result.opacity));
  result.reveal = Math.min(1, Math.max(0, result.reveal));
  return result;
}
export function bezierEase(t: number, control: [number, number, number, number]) {
  const curve = (q: number, a: number, b: number) =>
    3 * (1 - q) ** 2 * q * a + 3 * (1 - q) * q * q * b + q * q * q;
  let low = 0,
    high = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2;
    if (curve(mid, control[0], control[2]) < t) low = mid;
    else high = mid;
  }
  return t <= 0 ? 0 : t >= 1 ? 1 : curve((low + high) / 2, control[1], control[3]);
}
export function getNumericPath(value: unknown, property: string): number {
  let current: any = value;
  for (const part of property.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      current === null ||
      typeof current !== 'object'
    )
      throw new Error(`Invalid animation path ${property}`);
    current = current[part];
  }
  if (typeof current !== 'number' || !Number.isFinite(current))
    throw new Error(`Animation target ${property} is not numeric`);
  return current;
}
export function setNumericPath(value: unknown, property: string, number: number) {
  if (!Number.isFinite(number)) throw new Error(`Animation value for ${property} is not finite`);
  getNumericPath(value, property);
  const parts = property.split('.');
  let current: any = value;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)!] = number;
}
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
