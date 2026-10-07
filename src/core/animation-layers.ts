import { z } from 'zod';
import { animationLayerSchema, animationLayersSchema } from './animation-schema.js';
import { nodeSchema, VmotionError, type Node } from './model.js';
import { editKeyframes, keyframeActionSchema } from './keyframes.js';
import { mergeMotionParameters } from './motion-template.js';
export const animationLayerActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('append'),
      layer: animationLayerSchema,
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('update'), id: z.string(), patch: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('remove'), id: z.string() }).strict(),
  z
    .object({ type: z.literal('move'), id: z.string(), index: z.number().int().nonnegative() })
    .strict(),
  z.object({ type: z.literal('toggle'), id: z.string(), enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('duplicate'),
      id: z.string(),
      newId: z.string().min(1).max(200),
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('channels'),
      id: z.string(),
      actions: z.array(keyframeActionSchema).min(1).max(1000),
    })
    .strict(),
]);
export type AnimationLayerAction = z.input<typeof animationLayerActionSchema>;
export function removeEmptyAnimationLayers(node: Node) {
  const empty = (node.animationLayers ?? []).filter((l) => !l.channels.length);
  return empty.length
    ? editAnimationLayers(
        node,
        empty.map((l) => ({ type: 'remove', id: l.id })),
      )
    : node;
}
export function editAnimationLayers(source: Node, raw: AnimationLayerAction[]) {
  if (!raw.length || raw.length > 1000)
    throw new VmotionError('ANIMATION_LAYER_ACTIONS', 'Expected 1–1000 layer edits');
  const node = structuredClone(source),
    entries = (node.animationLayers ?? []).map((layer, index) => ({
      layer,
      controls: node.animations
        .filter((c) => c.property.startsWith(`animationLayers.${index}.`))
        .map((c) => ({ ...c, property: c.property.slice(`animationLayers.${index}.`.length) })),
    }));
  const select = (id: string) => {
    const i = entries.findIndex((e) => e.layer.id === id);
    if (i < 0) throw new VmotionError('ANIMATION_LAYER_ID', 'Animation layer is missing', { id });
    return i;
  };
  const insert = (index: number | undefined, entry: (typeof entries)[number]) => {
    const at = index ?? entries.length;
    if (at > entries.length)
      throw new VmotionError('ANIMATION_LAYER_INDEX', 'Layer insertion is outside the stack');
    if (entries.some((e) => e.layer.id === entry.layer.id))
      throw new VmotionError('ANIMATION_LAYER_ID', 'Duplicate layer ID', { id: entry.layer.id });
    entries.splice(at, 0, entry);
  };
  for (const input of raw) {
    const action = animationLayerActionSchema.parse(input);
    if (action.type === 'append') insert(action.index, { layer: action.layer, controls: [] });
    else {
      const i = select(action.id),
        entry = entries[i];
      if (action.type === 'remove') entries.splice(i, 1);
      else if (action.type === 'move') {
        if (action.index >= entries.length)
          throw new VmotionError('ANIMATION_LAYER_INDEX', 'Layer move is outside the stack');
        entries.splice(i, 1);
        entries.splice(action.index, 0, entry);
      } else if (action.type === 'toggle') entry.layer.enabled = action.enabled;
      else if (action.type === 'duplicate') {
        const copy = structuredClone(entry);
        copy.layer.id = action.newId;
        insert(action.index, copy);
      } else if (action.type === 'channels') {
        const edited = editKeyframes(
          { ...node, animations: entry.layer.channels, animationLayers: undefined },
          action.actions,
        );
        entry.layer.channels = edited.animations;
      } else {
        if ('id' in action.patch)
          throw new VmotionError('ANIMATION_LAYER_ID', 'Updates preserve stable layer IDs');
        const patch = { ...action.patch };
        if (patch.end === null) patch.end = undefined;
        entry.layer = animationLayerSchema.parse(
          mergeMotionParameters(entry.layer as unknown as Record<string, unknown>, patch),
        );
      }
    }
  }
  node.animationLayers = animationLayersSchema.parse(entries.map((e) => e.layer));
  node.animations = [
    ...node.animations.filter((c) => !c.property.startsWith('animationLayers.')),
    ...entries.flatMap((e, index) =>
      e.controls.map((c) => ({ ...c, property: `animationLayers.${index}.${c.property}` })),
    ),
  ];
  return nodeSchema.parse(node);
}
