import { z } from 'zod';
import { numericPropertyPattern } from './numeric-properties.js';
const finite = z.number().finite();
export const keyframeSchema = z.object({
  frame: z.number().int().nonnegative(),
  value: finite,
  easing: z
    .enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'spring', 'bezier'])
    .default('linear'),
  bezier: z.tuple([finite.min(0).max(1), finite, finite.min(0).max(1), finite]).optional(),
});
export const extrapolationSchema = z.enum([
  'constant',
  'linear',
  'cycle',
  'cycleOffset',
  'pingpong',
]);
export const animationSchema = z.object({
  property: z.string().regex(numericPropertyPattern, 'Unsupported numeric animation target'),
  keys: z.array(keyframeSchema).min(1),
  before: extrapolationSchema.optional(),
  after: extrapolationSchema.optional(),
});
export const animationLayerSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    enabled: z.boolean().default(true),
    blend: z.enum(['add', 'multiply', 'replace']).default('add'),
    weight: finite.min(0).max(1).default(1),
    start: finite.nonnegative().default(0),
    end: finite.positive().optional(),
    offset: finite.default(0),
    rate: finite.min(-1000).max(1000).default(1),
    channels: z
      .array(
        animationSchema.extend({
          property: animationSchema.shape.property.refine(
            (p) => !p.startsWith('animationLayers.'),
            'Layer channels cannot control animation-layer metadata',
          ),
        }),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((layer, ctx) => {
    if (layer.end !== undefined && layer.end <= layer.start)
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'Layer end must follow start' });
    if (new Set(layer.channels.map((c) => c.property)).size !== layer.channels.length)
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message: 'A layer has one channel per property',
      });
    if (layer.channels.reduce((n, c) => n + c.keys.length, 0) > 100000)
      ctx.addIssue({ code: 'custom', message: 'Animation layer exceeds 100000 keys' });
  });
export const animationLayersSchema = z
  .array(animationLayerSchema)
  .max(32)
  .superRefine((layers, ctx) => {
    if (new Set(layers.map((l) => l.id)).size !== layers.length)
      ctx.addIssue({ code: 'custom', message: 'Animation layer IDs must be unique' });
    if (layers.reduce((n, l) => n + l.channels.reduce((m, c) => m + c.keys.length, 0), 0) > 100000)
      ctx.addIssue({ code: 'custom', message: 'Layer stack exceeds 100000 keys' });
  });
export type AnimationChannel = z.output<typeof animationSchema>;
export type AnimationLayer = z.output<typeof animationLayerSchema>;
export type AnimationLayerInput = z.input<typeof animationLayerSchema>;
