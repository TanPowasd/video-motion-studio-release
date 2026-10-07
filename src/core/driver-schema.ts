import { z } from 'zod';
import { numericPropertyPattern } from './numeric-properties.js';
const finite = z.number().finite(),
  size = z
    .object({
      value: finite.nonnegative(),
      unit: z.enum(['pixels', 'fraction']).default('fraction'),
      min: finite.nonnegative().default(0),
      max: finite.positive().optional(),
    })
    .strict(),
  anchor = z
    .object({
      at: z.enum(['start', 'center', 'end']).default('center'),
      self: z.enum(['start', 'center', 'end']).default('center'),
      offset: finite.default(0),
    })
    .strict();
export const layoutSchema = z
  .object({
    reference: z
      .union([
        z.enum(['parent', 'scene']),
        z.object({ nodeId: z.string().min(1).max(200) }).strict(),
      ])
      .default('parent'),
    x: anchor.optional(),
    y: anchor.optional(),
    width: size.optional(),
    height: size.optional(),
    aspectRatio: finite.positive().optional(),
    insets: z
      .object({
        left: finite.optional(),
        right: finite.optional(),
        top: finite.optional(),
        bottom: finite.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const axis of ['width', 'height'] as const)
      if (value[axis]?.max !== undefined && value[axis]!.max! < value[axis]!.min)
        ctx.addIssue({ code: 'custom', message: 'Layout max must not precede min', path: [axis] });
    if (value.aspectRatio && value.width && value.height)
      ctx.addIssue({ code: 'custom', message: 'Aspect ratio needs one unconstrained size axis' });
  });
export const motionPathSchema = z
  .object({
    path: z.string().max(1e6).optional(),
    nodeId: z.string().min(1).max(200).optional(),
    useRendered: z.boolean().default(false),
    progress: finite.default(0),
    repeat: z.enum(['clamp', 'loop', 'pingpong']).default('clamp'),
    autoRotate: z.boolean().default(false),
    rotationOffset: finite.default(0),
    anchor: z.enum(['origin', 'center', 'topLeft']).default('origin'),
    offsetX: finite.default(0),
    offsetY: finite.default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!!value.path === !!value.nodeId)
      ctx.addIssue({ code: 'custom', message: 'Choose exactly one SVG path or path layer nodeId' });
  });
export const expressionsSchema = z
  .record(z.string().min(1).max(200).regex(numericPropertyPattern), z.string().min(1).max(4000))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 64)
      ctx.addIssue({ code: 'custom', message: 'Up to 64 property expressions per layer' });
  });
export type Layout = z.output<typeof layoutSchema>;
export type LayoutInput = z.input<typeof layoutSchema>;
export type MotionPath = z.output<typeof motionPathSchema>;
export type MotionPathInput = z.input<typeof motionPathSchema>;
