import { z } from 'zod';
import { removeEmptyAnimationLayers } from './animation-layers.js';
import { randomUUID } from 'node:crypto';
import { keyframeSchema, nodeSchema, VmotionError, type Node } from './model.js';
import { editKeyframes } from './keyframes.js';
import { shapeOperatorSchema } from './shape-operator-schema.js';
import { textAnimatorSchema } from './typography-schema.js';
import { compileExpression } from './expressions.js';
export function expressionUsesGraphicsStack(source: string, field: GraphicsStack) {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if ('type' in value && value.type === 'get' && 'key' in value && value.key === field)
      return true;
    return Object.values(value).some(visit);
  };
  return visit(compileExpression(source).ast);
}
const target = z.union([
  z.object({ id: z.string() }).strict(),
  z.object({ index: z.number().int().nonnegative() }).strict(),
]);
export const graphicsActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('append'),
      item: z.union([shapeOperatorSchema, textAnimatorSchema]),
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('update'), target, patch: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('remove'), target }).strict(),
  z.object({ type: z.literal('move'), target, to: z.number().int().nonnegative() }).strict(),
  z
    .object({
      type: z.literal('copy'),
      target,
      id: z.string().min(1).max(200).optional(),
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('toggle'), target, enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('keys'),
      target,
      property: z.string().min(1),
      keys: z.array(keyframeSchema).min(1).max(10000),
    })
    .strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);
export type GraphicsAction = z.input<typeof graphicsActionSchema>;
export type GraphicsStack = 'shapeOperators' | 'textAnimators';
function merge(base: any, patch: any): any {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new VmotionError('GRAPHICS_PATCH', 'Unsafe field');
    result[key] = merge(base?.[key], value);
  }
  return result;
}
export function editGraphicsStack(
  source: Node,
  field: GraphicsStack,
  raw: GraphicsAction[],
  frame = 0,
) {
  if (
    field === 'textAnimators'
      ? source.type !== 'text'
      : !['rect', 'ellipse', 'path'].includes(source.type)
  )
    throw new VmotionError(
      'GRAPHICS_TYPE',
      'Text animators need text; shape operators need rect, ellipse or path',
    );
  const actions = z.array(graphicsActionSchema).min(1).max(256).parse(raw),
    node = structuredClone(source),
    prefix = field + '.',
    schema = field === 'textAnimators' ? textAnimatorSchema : shapeOperatorSchema,
    entries = node[field].map((item, index) => ({
      item: structuredClone(item),
      layered: (node.animationLayers ?? []).map((layer) =>
        layer.channels
          .filter((c) => c.property.startsWith(`${prefix}${index}.`))
          .map((c) => ({ ...c, property: c.property.slice(`${prefix}${index}.`.length) })),
      ),
      channels: node.animations
        .filter((a) => a.property.startsWith(`${prefix}${index}.`))
        .map((a) => ({
          ...structuredClone(a),
          property: a.property.slice(`${prefix}${index}.`.length),
        })),
      expressions: Object.fromEntries(
        Object.entries(node.expressions ?? {})
          .filter(([p]) => p.startsWith(`${prefix}${index}.`))
          .map(([p, s]) => [p.slice(`${prefix}${index}.`.length), s]),
      ),
    }));
  if (
    actions.some((a) => ['append', 'remove', 'move', 'copy', 'clear'].includes(a.type)) &&
    Object.values(node.expressions ?? {}).some((s) => expressionUsesGraphicsStack(s, field))
  )
    throw new VmotionError(
      'GRAPHICS_EXPRESSION_REFERENCE',
      'Index references inside expressions must be rewritten explicitly before changing stack topology',
    );
  const locate = (s: z.infer<typeof target>) => {
      const i = 'id' in s ? entries.findIndex((e) => e.item.id === s.id) : s.index;
      if (i < 0 || i >= entries.length)
        throw new VmotionError('GRAPHICS_NOT_FOUND', 'Stack ID/index not found');
      return i;
    },
    insert = (at: number | undefined, entry: (typeof entries)[number]) => {
      const i = at ?? entries.length;
      if (i > entries.length)
        throw new VmotionError('GRAPHICS_INDEX', 'Insert index exceeds stack length');
      entries.splice(i, 0, entry);
    },
    setKeys = (
      entry: (typeof entries)[number],
      property: string,
      keys: z.output<typeof keyframeSchema>[],
    ) => {
      const temp = nodeSchema.parse({
          ...node,
          [field]: [entry.item],
          animations: entry.channels.map((a) => ({ ...a, property: prefix + '0.' + a.property })),
          animationLayers: undefined,
        }),
        edited = editKeyframes(temp, [
          { type: 'upsert', property: prefix + '0.' + property, keys },
        ]);
      entry.channels = edited.animations
        .filter((a) => a.property.startsWith(prefix))
        .map((a) => ({ ...a, property: a.property.slice((prefix + '0.').length) }));
    };
  for (const action of actions) {
    if (action.type === 'append')
      insert(action.index, {
        item: schema.parse(action.item),
        channels: [],
        expressions: {},
        layered: [],
      });
    else if (action.type === 'clear') entries.length = 0;
    else {
      const at = locate(action.target),
        entry = entries[at];
      if (action.type === 'remove') entries.splice(at, 1);
      else if (action.type === 'move') {
        if (action.to >= entries.length)
          throw new VmotionError('GRAPHICS_INDEX', 'Move index exceeds stack length');
        entries.splice(at, 1);
        entries.splice(action.to, 0, entry);
      } else if (action.type === 'copy') {
        const copy = structuredClone(entry);
        copy.item.id = action.id ?? randomUUID();
        insert(action.index, copy);
      } else if (action.type === 'toggle') entry.item.enabled = action.enabled;
      else if (action.type === 'keys') setKeys(entry, action.property, action.keys);
      else {
        if ('id' in action.patch || 'type' in action.patch)
          throw new VmotionError('GRAPHICS_PATCH', 'ID/type cannot be replaced by update');
        entry.item = schema.parse(merge(entry.item, action.patch));
        const numeric = (v: unknown, p = '') => {
          if (typeof v === 'number' && entry.channels.some((a) => a.property === p))
            setKeys(entry, p, [keyframeSchema.parse({ frame: Math.round(frame), value: v })]);
          else if (v && typeof v === 'object')
            for (const [k, x] of Object.entries(v)) numeric(x, p ? p + '.' + k : k);
        };
        numeric(action.patch);
      }
    }
    if (entries.length > 32) throw new VmotionError('GRAPHICS_LIMIT', 'At most 32 items per stack');
    if (new Set(entries.map((e) => e.item.id)).size !== entries.length)
      throw new VmotionError('GRAPHICS_ID', 'Stack IDs must be unique');
  }
  return nodeSchema.parse(
    removeEmptyAnimationLayers({
      ...node,
      [field]: entries.map((e) => e.item),
      animations: [
        ...node.animations.filter((a) => !a.property.startsWith(prefix)),
        ...entries.flatMap((e, i) =>
          e.channels.map((a) => ({ ...a, property: `${prefix}${i}.${a.property}` })),
        ),
      ],
      ...(node.animationLayers
        ? {
            animationLayers: node.animationLayers.map((layer, at) => ({
              ...layer,
              channels: [
                ...layer.channels.filter((c) => !c.property.startsWith(prefix)),
                ...entries.flatMap((entry, index) =>
                  (entry.layered[at] ?? []).map((c) => ({
                    ...c,
                    property: `${prefix}${index}.${c.property}`,
                  })),
                ),
              ],
            })),
          }
        : {}),
      expressions: {
        ...Object.fromEntries(
          Object.entries(node.expressions ?? {}).filter(([p]) => !p.startsWith(prefix)),
        ),
        ...Object.fromEntries(
          entries.flatMap((e, i) =>
            Object.entries(e.expressions).map(([p, s]) => [`${prefix}${i}.${p}`, s]),
          ),
        ),
      },
    }),
  );
}
