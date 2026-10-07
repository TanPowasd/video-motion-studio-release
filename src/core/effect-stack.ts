import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { effectSchema, keyframeSchema, VmotionError, type Node, type Effect } from './model.js';
import { editKeyframes, type KeyframeAction } from './keyframes.js';
import { removeEmptyAnimationLayers } from './animation-layers.js';
const selector = z.union([
  z.object({ id: z.string() }).strict(),
  z.object({ index: z.number().int().nonnegative() }).strict(),
]);
type EffectSelector = z.infer<typeof selector>;
export const effectActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('append'),
      effect: effectSchema,
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('update'), target: selector, patch: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('remove'), target: selector }).strict(),
  z
    .object({ type: z.literal('move'), target: selector, to: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      type: z.literal('copy'),
      target: selector,
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('toggle'), target: selector, enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('keys'),
      target: selector,
      property: z.string().min(1),
      keys: z.array(keyframeSchema).min(1).max(10000),
    })
    .strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);
export type EffectAction = z.input<typeof effectActionSchema>;
export function editEffectStack(source: Node, raw: EffectAction[], frame = 0) {
  if (!raw.length || raw.length > 1000)
    throw new VmotionError('EFFECT_ACTIONS', 'Provide 1–1000 ordered effect actions');
  const node = structuredClone(source),
    entries = node.effects.map((effect, index) => ({
      effect: { ...effect, id: effect.id ?? randomUUID() } as Effect,
      layered: (node.animationLayers ?? []).map((layer) =>
        layer.channels
          .filter((c) => c.property.startsWith(`effects.${index}.`))
          .map((c) => ({ ...c, property: c.property.slice(`effects.${index}.`.length) })),
      ),
      channels: node.animations
        .filter((a) => a.property.startsWith(`effects.${index}.`))
        .map((a) => ({
          ...structuredClone(a),
          property: a.property.slice(`effects.${index}.`.length),
        })),
    }));
  const target = (selector: EffectSelector) => {
      const index =
        'id' in selector ? entries.findIndex((e) => e.effect.id === selector.id) : selector.index;
      if (index < 0 || index >= entries.length)
        throw new VmotionError('EFFECT_NOT_FOUND', 'Effect ID/index is not in this layer');
      return index;
    },
    insert = (index: number | undefined, entry: (typeof entries)[number]) => {
      const at = index ?? entries.length;
      if (at > entries.length)
        throw new VmotionError('EFFECT_INDEX', 'Insert position exceeds effect count');
      entries.splice(at, 0, entry);
    },
    setKeys = (
      entry: (typeof entries)[number],
      property: string,
      keys: z.infer<typeof keyframeSchema>[],
    ) => {
      const temp = {
          ...node,
          effects: [entry.effect],
          animations: entry.channels.map((a) => ({ ...a, property: 'effects.0.' + a.property })),
          animationLayers: undefined,
        },
        edited = editKeyframes(temp, [{ type: 'upsert', property: 'effects.0.' + property, keys }]);
      entry.channels = edited.animations.map((a) => ({
        ...a,
        property: a.property.slice('effects.0.'.length),
      }));
    },
    numbers = (value: unknown, prefix: string, into: Map<string, number>) => {
      if (typeof value === 'number') into.set(prefix, value);
      else if (value && typeof value === 'object')
        for (const [key, v] of Object.entries(value))
          numbers(v, prefix ? prefix + '.' + key : key, into);
    };
  for (const input of raw) {
    const action = effectActionSchema.parse(input);
    if (action.type === 'append')
      insert(action.index, {
        effect: { ...action.effect, id: action.effect.id ?? randomUUID() } as Effect,
        channels: [],
        layered: [],
      });
    else if (action.type === 'clear') entries.length = 0;
    else {
      const at = target(action.target),
        entry = entries[at];
      if (action.type === 'remove') entries.splice(at, 1);
      else if (action.type === 'move') {
        if (action.to >= entries.length)
          throw new VmotionError('EFFECT_INDEX', 'Move position exceeds effect count');
        entries.splice(at, 1);
        entries.splice(action.to, 0, entry);
      } else if (action.type === 'copy') {
        const copy = structuredClone(entry);
        copy.effect.id = randomUUID();
        insert(action.index, copy);
      } else if (action.type === 'toggle') entry.effect.enabled = action.enabled;
      else if (action.type === 'keys') setKeys(entry, action.property, action.keys);
      else {
        if ('id' in action.patch || 'type' in action.patch)
          throw new VmotionError('EFFECT_PATCH', 'Change fields without replacing effect ID/type');
        entry.effect = effectSchema.parse({ ...entry.effect, ...action.patch });
        const values = new Map<string, number>();
        numbers(action.patch, '', values);
        for (const [property, value] of values)
          if (entry.channels.some((a) => a.property === property))
            setKeys(entry, property, [
              keyframeSchema.parse({ frame: Math.round(frame), value, easing: 'linear' }),
            ]);
      }
    }
    if (entries.length > 16)
      throw new VmotionError('EFFECT_LIMIT', 'A layer supports at most 16 explicit effects');
    if (new Set(entries.map((e) => e.effect.id)).size !== entries.length)
      throw new VmotionError('EFFECT_ID', 'Effect IDs must be unique within a layer');
  }
  node.effects = entries.map((e) => e.effect);
  node.animations = [
    ...node.animations.filter((a) => !/^effects\.\d+\./.test(a.property)),
    ...entries.flatMap((entry, index) =>
      entry.channels.map((a) => ({ ...a, property: `effects.${index}.${a.property}` })),
    ),
  ];
  if (node.animationLayers)
    node.animationLayers = node.animationLayers.map((layer, at) => ({
      ...layer,
      channels: [
        ...layer.channels.filter((c) => !/^effects\.\d+\./.test(c.property)),
        ...entries.flatMap((entry, index) =>
          (entry.layered[at] ?? []).map((c) => ({
            ...c,
            property: `effects.${index}.${c.property}`,
          })),
        ),
      ],
    }));
  return removeEmptyAnimationLayers(node);
}
