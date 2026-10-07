import { z } from 'zod';
import {
  animationSchema,
  keyframeSchema,
  VmotionError,
  type Node,
  type Keyframe,
} from './model.js';
import { getNumericPath, evaluateNode } from './time.js';
import { extrapolationSchema } from './animation-schema.js';
const property = animationSchema.shape.property,
  frame = z.number().int().nonnegative(),
  finite = z.number().finite(),
  selector = {
    properties: z.array(property).min(1).max(1000).optional(),
    frames: z.array(frame).min(1).max(10000).optional(),
    range: z.tuple([frame, frame]).optional(),
  };
export const keyframeActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('extrapolate'),
      properties: z.array(property).min(1).max(1000),
      before: extrapolationSchema.nullable().optional(),
      after: extrapolationSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('upsert'),
      property,
      keys: z.array(keyframeSchema).min(1).max(10000),
      collision: z.enum(['error', 'replace']).default('replace'),
    })
    .strict(),
  z.object({ type: z.literal('remove'), ...selector }).strict(),
  z
    .object({
      type: z.literal('ease'),
      ...selector,
      easing: keyframeSchema.shape.easing,
      bezier: keyframeSchema.shape.bezier,
    })
    .strict(),
  z
    .object({
      type: z.literal('transform'),
      ...selector,
      timeScale: finite.positive().default(1),
      timeOffset: finite.default(0),
      pivotFrame: finite.default(0),
      valueScale: finite.default(1),
      valueOffset: finite.default(0),
      pivotValue: finite.default(0),
      copy: z.boolean().default(false),
      collision: z.enum(['error', 'replace']).default('error'),
    })
    .strict(),
]);
export type KeyframeAction = z.input<typeof keyframeActionSchema>;
export function editKeyframes(source: Node, raw: KeyframeAction[]): Node {
  if (!raw.length || raw.length > 1000)
    throw new VmotionError('KEYFRAME_ACTIONS', 'Expected 1–1000 keyframe actions');
  const node = structuredClone(source);
  if (new Set(node.animations.map((a) => a.property)).size !== node.animations.length)
    throw new VmotionError(
      'DUPLICATE_ANIMATION',
      'A layer must have a single animation channel per property',
    );
  for (const input of raw) {
    const action = keyframeActionSchema.parse(input);
    if (action.type === 'extrapolate') {
      for (const property of action.properties) {
        const channel = node.animations.find((c) => c.property === property);
        if (!channel)
          throw new VmotionError('ANIMATION_CHANNEL', 'Extrapolation channel is missing', {
            property,
          });
        for (const side of ['before', 'after'] as const)
          if (action[side] !== undefined) {
            if (action[side] === null) delete channel[side];
            else channel[side] = action[side]!;
          }
      }
      continue;
    }
    if ('range' in action && action.range && action.range[0] > action.range[1])
      throw new VmotionError('KEYFRAME_RANGE', 'Range start must not exceed range end');
    if (action.type === 'upsert') {
      getNumericPath(node, action.property);
      const channel = node.animations.find((a) => a.property === action.property) ?? {
        property: action.property,
        keys: [],
      };
      const values = new Map(channel.keys.map((k) => [k.frame, k])),
        seen = new Set<number>();
      for (const key of action.keys) {
        if (seen.has(key.frame))
          throw new VmotionError(
            'DUPLICATE_KEYFRAME',
            'Keyframe request contains duplicate times',
            { property: action.property, frame: key.frame },
          );
        seen.add(key.frame);
        if (action.collision === 'error' && values.has(key.frame))
          throw new VmotionError('KEYFRAME_COLLISION', 'A key already exists at this frame', {
            property: action.property,
            frame: key.frame,
          });
        values.set(key.frame, key);
      }
      channel.keys = [...values.values()].sort((a, b) => a.frame - b.frame);
      if (!node.animations.includes(channel)) node.animations.push(channel);
      continue;
    }
    if (
      action.properties?.some((property) => !node.animations.some((a) => a.property === property))
    )
      throw new VmotionError('KEYFRAME_CHANNEL', 'Requested animation channel does not exist');
    if (
      action.frames?.some(
        (frame) =>
          !node.animations.some(
            (channel) =>
              (!action.properties || action.properties.includes(channel.property)) &&
              channel.keys.some((key) => key.frame === frame),
          ),
      )
    )
      throw new VmotionError(
        'KEYFRAME_NOT_FOUND',
        'One or more selected keyframe times no longer exist',
      );
    const selected = (channel: string, key: Keyframe) =>
      (!action.properties || action.properties.includes(channel)) &&
      (!action.frames || action.frames.includes(key.frame)) &&
      (!action.range || (key.frame >= action.range[0] && key.frame <= action.range[1]));
    for (const channel of node.animations) {
      const keys = channel.keys.filter((k) => selected(channel.property, k));
      if (!keys.length) continue;
      if (action.type === 'remove') {
        channel.keys = channel.keys.filter((k) => !selected(channel.property, k));
        continue;
      }
      if (action.type === 'ease') {
        channel.keys = channel.keys.map((key) =>
          selected(channel.property, key)
            ? {
                ...key,
                easing: action.easing,
                bezier:
                  action.easing === 'bezier' ? (action.bezier ?? [0.25, 0.1, 0.25, 1]) : undefined,
              }
            : key,
        );
        continue;
      }
      const moved = keys.map((key) => {
          const frame = Math.round(
              action.pivotFrame +
                (key.frame - action.pivotFrame) * action.timeScale +
                action.timeOffset,
            ),
            value =
              action.pivotValue +
              (key.value - action.pivotValue) * action.valueScale +
              action.valueOffset;
          if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(value))
            throw new VmotionError(
              'KEYFRAME_TRANSFORM',
              'Transformed keys require nonnegative safe integer times and finite values',
              { property: channel.property, frame },
            );
          return { ...key, frame, value };
        }),
        seen = new Set<number>();
      for (const key of moved) {
        if (seen.has(key.frame))
          throw new VmotionError(
            'KEYFRAME_COLLISION',
            'Time scaling merged multiple selected keys into one frame',
            { property: channel.property, frame: key.frame },
          );
        seen.add(key.frame);
      }
      const remaining = action.copy
          ? channel.keys
          : channel.keys.filter((k) => !selected(channel.property, k)),
        values = new Map(remaining.map((k) => [k.frame, k]));
      for (const key of moved) {
        if (values.has(key.frame) && action.collision === 'error')
          throw new VmotionError(
            'KEYFRAME_COLLISION',
            'Transformed keys collide with existing keys',
            { property: channel.property, frame: key.frame },
          );
        values.set(key.frame, key);
      }
      channel.keys = [...values.values()].sort((a, b) => a.frame - b.frame);
    }
    node.animations = node.animations.filter((a) => a.keys.length);
  }
  if (node.animations.reduce((total, a) => total + a.keys.length, 0) > 100000)
    throw new VmotionError('KEYFRAME_LIMIT', 'A layer may have at most 100000 keyframes');
  return node;
}
export function sampleAnimation(node: Node, frames: number[], fps: number, properties?: string[]) {
  if (!Number.isFinite(fps) || fps <= 0)
    throw new VmotionError('ANIMATION_FPS', 'FPS must be finite and positive');
  const channels = properties ?? [
    ...new Set([
      ...node.animations.map((a) => a.property),
      ...(node.animationLayers ?? []).flatMap((l) => l.channels.map((c) => c.property)),
    ]),
  ];
  return frames.map((frame) => {
    const evaluated = evaluateNode(node, frame),
      before = evaluateNode(node, Math.max(0, frame - 0.25)),
      after = evaluateNode(node, frame + 0.25),
      interval = frame < 0.25 ? frame + 0.25 : 0.5;
    return {
      frame,
      seconds: frame / fps,
      values: Object.fromEntries(
        channels.map((property) => [property, getNumericPath(evaluated, property)]),
      ),
      velocityPerSecond: Object.fromEntries(
        channels.map((property) => [
          property,
          ((getNumericPath(after, property) - getNumericPath(before, property)) * fps) / interval,
        ]),
      ),
    };
  });
}
