import { z } from 'zod';
import {
  animationSchema,
  keyframeSchema,
  nodeSchema,
  VmotionError,
  type Node,
  type Keyframe,
} from './model.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  type ParameterDefinitions,
} from './parameters.js';
import { evaluateNode, getNumericPath, setNumericPath } from './time.js';
import { animationLayerSchema, type AnimationLayer } from './animation-schema.js';
const finite = z.number().finite();
const valueSchema = z.union([
  finite,
  z
    .object({
      base: z.union([finite, z.object({ parameter: z.string().min(1) }).strict()]).default(0),
      offset: finite.default(0),
      parameters: z.record(finite).default({}),
    })
    .strict(),
]);
export const motionTemplateSchema = z
  .object({
    kind: z.literal('motion-template'),
    version: z.literal(1),
    name: z.string().min(1).max(200),
    parameters: z.record(z.unknown()).default({}),
    types: z
      .array(
        z.enum([
          'group',
          'text',
          'rect',
          'ellipse',
          'path',
          'image',
          'video',
          'formula',
          'chart',
          'component',
          'program',
          'drawing',
          'scene3d',
          'scene',
        ]),
      )
      .min(1)
      .optional(),
    channels: z
      .array(
        z
          .object({
            property: animationSchema.shape.property,
            keys: z
              .array(
                z
                  .object({
                    at: finite.min(0).max(1),
                    value: valueSchema,
                    easing: keyframeSchema.shape.easing,
                    bezier: keyframeSchema.shape.bezier,
                  })
                  .strict(),
              )
              .min(1)
              .max(512),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((template, ctx) => {
    try {
      validateParameterDefinitions(template.parameters as ParameterDefinitions);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['parameters'] });
    }
    const seen = new Set<string>();
    for (const [index, channel] of template.channels.entries()) {
      if (seen.has(channel.property))
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate motion property',
          path: ['channels', index, 'property'],
        });
      seen.add(channel.property);
      if (new Set(channel.keys.map((key) => key.at)).size !== channel.keys.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate normalized key times',
          path: ['channels', index, 'keys'],
        });
    }
  });
export type MotionTemplateInput = z.input<typeof motionTemplateSchema>;
export type MotionTemplate = z.output<typeof motionTemplateSchema>;
export const parseMotionTemplate = (input: unknown) => motionTemplateSchema.parse(input);
const base = (
  factor: number | { parameter: string } = 1,
  parameters: Record<string, number> = {},
) => ({ base: factor, parameters });
const key = (
  at: number,
  value: z.input<typeof valueSchema>,
  easing: Keyframe['easing'] = 'easeOut',
) => ({ at, value, easing });
const number = (value: number, min: number, max: number, label: string) => ({
  type: 'number',
  default: value,
  min,
  max,
  label,
});
const make = (
  name: string,
  parameters: Record<string, unknown>,
  channels: MotionTemplateInput['channels'],
  types?: MotionTemplateInput['types'],
) =>
  parseMotionTemplate({
    kind: 'motion-template',
    version: 1,
    name,
    parameters,
    channels,
    ...(types ? { types } : {}),
  });
export const builtinMotions = {
  fadeSlide: make(
    '淡入与位移',
    { dx: number(0, -2000, 2000, '水平距离'), dy: number(48, -2000, 2000, '垂直距离') },
    [
      { property: 'opacity', keys: [key(0, 0), key(1, base())] },
      { property: 'x', keys: [key(0, base(1, { dx: 1 })), key(1, base())] },
      { property: 'y', keys: [key(0, base(1, { dy: 1 })), key(1, base())] },
    ],
  ),
  fadeOut: make(
    '淡出与位移',
    { dx: number(0, -2000, 2000, '水平距离'), dy: number(-24, -2000, 2000, '垂直距离') },
    [
      { property: 'opacity', keys: [key(0, base(), 'easeIn'), key(1, 0)] },
      { property: 'x', keys: [key(0, base(), 'easeIn'), key(1, base(1, { dx: 1 }))] },
      { property: 'y', keys: [key(0, base(), 'easeIn'), key(1, base(1, { dy: 1 }))] },
    ],
  ),
  pop: make('弹性出现', { startScale: number(0.85, 0, 4, '起始缩放') }, [
    { property: 'opacity', keys: [key(0, 0), key(0.35, base()), key(1, base())] },
    {
      property: 'scaleX',
      keys: [key(0, base({ parameter: 'startScale' }), 'spring'), key(1, base())],
    },
    {
      property: 'scaleY',
      keys: [key(0, base({ parameter: 'startScale' }), 'spring'), key(1, base())],
    },
  ]),
  pulse: make(
    '呼吸强调',
    { peakScale: number(1.06, 0, 4, '峰值缩放') },
    ['scaleX', 'scaleY'].map((property) => ({
      property,
      keys: [
        key(0, base(), 'easeInOut'),
        key(0.5, base({ parameter: 'peakScale' }), 'easeInOut'),
        key(1, base()),
      ],
    })),
  ),
  wipeText: make(
    '逐字显露',
    {},
    [{ property: 'reveal', keys: [key(0, 0, 'linear'), key(1, base(), 'linear')] }],
    ['text'],
  ),
};
export type BuiltinMotion = keyof typeof builtinMotions;
function freeze(value: object) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}
freeze(builtinMotions);
export function mergeMotionParameters(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
) {
  let remaining = 10000;
  const merge = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    depth: number,
  ): Record<string, unknown> => {
    if (depth > 16 || --remaining < 0)
      throw new VmotionError('MOTION_BINDING', 'Parameter bindings exceed nesting/size limits');
    return Object.fromEntries(
      [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new VmotionError('MOTION_BINDING', 'Invalid binding key', { key });
        const left = a[key],
          right = b[key];
        return [
          key,
          !Object.hasOwn(b, key)
            ? left
            : left &&
                right &&
                typeof left === 'object' &&
                typeof right === 'object' &&
                !Array.isArray(left) &&
                !Array.isArray(right)
              ? merge(left as Record<string, unknown>, right as Record<string, unknown>, depth + 1)
              : right,
        ];
      }),
    );
  };
  return merge(base, overrides, 0);
}
export type MotionCue = {
  id: string;
  template: MotionTemplateInput | MotionTemplate;
  parameters?: Record<string, unknown>;
  start: number;
  duration: number;
  blend?: 'add' | 'multiply' | 'replace';
  weight?: number;
  window?: boolean;
  valueBasis?: 'source' | 'neutral';
  before?: 'constant' | 'linear' | 'cycle' | 'cycleOffset' | 'pingpong';
  after?: 'constant' | 'linear' | 'cycle' | 'cycleOffset' | 'pingpong';
};
export function applyMotionLayers(source: Node, cues: MotionCue[], options: MotionOptions = {}) {
  if (!cues.length || cues.length > 32)
    throw new VmotionError('MOTION_CUE', 'Expected 1–32 motion layer cues');
  const node = structuredClone(source),
    layers: AnimationLayer[] = [],
    reports: Array<{
      id: string;
      start: number;
      end: number;
      name: string;
      parameters: Record<string, unknown>;
    }> = [];
  const basis =
    options.basis === 'evaluated' ? evaluateNode(source, options.referenceFrame ?? 0) : source;
  for (const cue of cues) {
    const template = parseMotionTemplate(cue.template),
      blend = cue.blend ?? 'replace',
      neutral =
        cue.valueBasis === 'neutral' || (cue.valueBasis === undefined && blend !== 'replace'),
      material = structuredClone(basis);
    material.animations = [];
    material.animationLayers = undefined;
    if (neutral)
      for (const channel of template.channels)
        setNumericPath(material, channel.property, blend === 'multiply' ? 1 : 0);
    const compiled = applyMotionCues(material, [cue], {
        ...options,
        basis: 'static',
        collision: 'replaceChannels',
      }),
      timing = compiled.cues[0];
    const layer = animationLayerSchema.parse({
      id: cue.id,
      name: timing.name,
      blend,
      weight: cue.weight ?? 1,
      start: timing.start,
      ...(cue.window ? { end: timing.end + 1 } : {}),
      channels: compiled.node.animations.map((c) => ({
        ...c,
        keys: c.keys.map((k) => ({ ...k, frame: k.frame - timing.start })),
        ...(cue.before ? { before: cue.before } : {}),
        ...(cue.after ? { after: cue.after } : {}),
      })),
    });
    if (
      (node.animationLayers ?? []).some((l) => l.id === layer.id) ||
      layers.some((l) => l.id === layer.id)
    )
      throw new VmotionError('ANIMATION_LAYER_ID', 'Motion layer cue ID already exists', {
        id: layer.id,
      });
    layers.push(layer);
    reports.push(timing);
  }
  node.animationLayers = [...(node.animationLayers ?? []), ...layers];
  return {
    node: nodeSchema.parse(node),
    cues: reports,
    channels: [...new Set(layers.flatMap((l) => l.channels.map((c) => c.property)))],
    poseChecks: {
      frames: [
        ...new Set(reports.flatMap((c) => [c.start, Math.floor((c.start + c.end) / 2), c.end])),
      ].slice(0, 128),
      incomplete: reports.length * 3 > 128,
    },
  };
}
export type MotionOptions = {
  fps?: number;
  units?: 'frames' | 'seconds';
  collision?: 'error' | 'replaceChannels' | 'merge';
  referenceFrame?: number;
  basis?: 'static' | 'evaluated';
};
/** Compile pure parameterized cues into editable native channels, without changing the source node. */
export function applyMotionCues(source: Node, cues: MotionCue[], options: MotionOptions = {}) {
  const fps = options.fps ?? 30,
    units = options.units ?? 'frames',
    collision = options.collision ?? 'error',
    referenceFrame = options.referenceFrame ?? 0,
    basis = options.basis === 'evaluated' ? evaluateNode(source, referenceFrame) : source,
    tracks = new Map<
      string,
      { keys: Keyframe[]; ranges: Array<[number, number]>; frames: Map<number, Keyframe> }
    >();
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isFinite(referenceFrame) ||
    referenceFrame < 0 ||
    !cues.length ||
    cues.length > 32
  )
    throw new VmotionError('MOTION_TIMING', 'Invalid FPS/reference frame or cue count');
  if (
    !['frames', 'seconds'].includes(units) ||
    !['error', 'replaceChannels', 'merge'].includes(collision) ||
    (options.basis !== undefined && !['static', 'evaluated'].includes(options.basis))
  )
    throw new VmotionError('MOTION_OPTIONS', 'Invalid motion options');
  if (new Set(cues.map((cue) => cue.id)).size !== cues.length)
    throw new VmotionError('MOTION_CUE', 'Cue IDs must be unique');
  const resolved = [];
  let generatedKeys = 0;
  for (const cue of cues) {
    if (
      !Number.isFinite(cue.start) ||
      cue.start < 0 ||
      !Number.isFinite(cue.duration) ||
      cue.duration <= 0
    )
      throw new VmotionError('MOTION_TIMING', 'Cue start/duration must be finite and valid', {
        cue: cue.id,
      });
    const template = parseMotionTemplate(cue.template);
    let parameters: Record<string, unknown>;
    try {
      parameters = resolveParameters(
        template.parameters as ParameterDefinitions,
        cue.parameters ?? {},
      );
    } catch (error) {
      throw new VmotionError('MOTION_BINDING', (error as Error).message, {
        cue: cue.id,
        path: (error as { path?: string }).path,
      });
    }
    const multiplier = units === 'seconds' ? fps : 1,
      start = Math.round(cue.start * multiplier),
      end = Math.round((cue.start + cue.duration) * multiplier);
    if (end <= start || end > 1e9)
      throw new VmotionError(
        'MOTION_TIMING',
        'Cue duration rounds to no video frames or exceeds the supported clock',
        { cue: cue.id },
      );
    if (template.types && !template.types.includes(source.type))
      throw new VmotionError('MOTION_TYPE', 'Motion template is not compatible with this layer', {
        cue: cue.id,
        nodeId: source.id,
        type: source.type,
      });
    const value = (raw: z.output<typeof valueSchema>, property: string) => {
      if (typeof raw === 'number') return raw;
      const parameter = (path: string) => {
        try {
          return getNumericPath(parameters, path);
        } catch (error) {
          throw new VmotionError('MOTION_BINDING', (error as Error).message, { cue: cue.id, path });
        }
      };
      const factor = typeof raw.base === 'number' ? raw.base : parameter(raw.base.parameter);
      let result = getNumericPath(basis, property) * factor + raw.offset;
      for (const [name, weight] of Object.entries(raw.parameters))
        result += parameter(name) * weight;
      if (!Number.isFinite(result))
        throw new VmotionError('MOTION_VALUE', 'Motion produced a nonfinite value', {
          cue: cue.id,
          property,
        });
      return result;
    };
    for (const channel of template.channels) {
      getNumericPath(source, channel.property);
      const track = tracks.get(channel.property) ?? {
        keys: [],
        ranges: [],
        frames: new Map<number, Keyframe>(),
      };
      if (track.ranges.some(([a, b]) => start < b && end > a))
        throw new VmotionError(
          'MOTION_OVERLAP',
          'Cues overlap on the same property; sequence or separate their channels',
          { cue: cue.id, property: channel.property },
        );
      const seen = new Set<number>();
      for (const key of channel.keys) {
        const frame = Math.round((cue.start + key.at * cue.duration) * multiplier);
        if (seen.has(frame))
          throw new VmotionError(
            'MOTION_TIME_COLLISION',
            'Normalized keys round to the same frame; increase duration or simplify the template',
            { cue: cue.id, property: channel.property, frame },
          );
        seen.add(frame);
        const existing = track.frames.get(frame),
          compiled = {
            frame,
            value: value(key.value, channel.property),
            easing: key.easing,
            ...(key.bezier ? { bezier: key.bezier } : {}),
          };
        if (existing) {
          if (existing.value !== compiled.value)
            throw new VmotionError(
              'MOTION_BOUNDARY',
              'Touching cues disagree at a shared boundary',
              { property: channel.property, frame },
            );
          Object.assign(existing, compiled);
        } else {
          if (++generatedKeys > 100000)
            throw new VmotionError('KEYFRAME_LIMIT', 'Motion exceeds 100000 generated keys');
          track.keys.push(compiled);
          track.frames.set(frame, compiled);
        }
      }
      track.ranges.push([start, end]);
      tracks.set(channel.property, track);
    }
    resolved.push({ id: cue.id, name: template.name, parameters, start, end });
  }
  const node = structuredClone(source);
  for (const [property, track] of tracks) {
    const channel = node.animations.find((channel) => channel.property === property);
    if (
      collision === 'merge' &&
      node.animations.filter((channel) => channel.property === property).length > 1
    )
      throw new VmotionError(
        'DUPLICATE_ANIMATION',
        'Merge needs one source channel per property; replace explicitly',
        { property },
      );
    if (channel && collision === 'error')
      throw new VmotionError(
        'MOTION_CHANNEL_EXISTS',
        'Motion would replace an existing animation; choose collision explicitly',
        { property, nodeId: node.id },
      );
    const keys = collision === 'merge' && channel ? [...channel.keys] : [];
    const times = new Set(keys.map((key) => key.frame));
    for (const key of track.keys) {
      if (times.has(key.frame))
        throw new VmotionError('KEYFRAME_COLLISION', 'Merge would overwrite an existing key', {
          property,
          frame: key.frame,
        });
      keys.push(key);
    }
    keys.sort((a, b) => a.frame - b.frame);
    if (channel) {
      channel.keys = keys;
      node.animations = node.animations.filter(
        (other) => other.property !== property || other === channel,
      );
    } else node.animations.push({ property, keys });
  }
  if (node.animations.reduce((sum, channel) => sum + channel.keys.length, 0) > 100000)
    throw new VmotionError('KEYFRAME_LIMIT', 'Motion exceeds 100000 keys for one layer');
  nodeSchema.parse(node);
  const endpoints = [
      ...new Set([...tracks.values()].flatMap((track) => track.keys.map((key) => key.frame))),
    ].sort((a, b) => a - b),
    checked =
      endpoints.length <= 128
        ? endpoints
        : Array.from(
            { length: 128 },
            (_, index) => endpoints[Math.floor((index * (endpoints.length - 1)) / 127)],
          );
  for (const frame of checked) nodeSchema.parse(evaluateNode(node, frame));
  return {
    node,
    cues: resolved,
    channels: [...tracks.keys()],
    poseChecks: {
      total: endpoints.length,
      checked: checked.length,
      incomplete: endpoints.length > checked.length,
      frames: checked,
    },
  };
}
