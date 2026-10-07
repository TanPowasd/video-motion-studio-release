import { z } from 'zod';
const finite = z.number().finite();
export const pathTextSchema = z
  .object({
    path: z.string().min(1).max(65536),
    offset: finite.default(0),
    normalOffset: finite.default(0),
    tracking: finite.default(0),
    align: z.enum(['start', 'center', 'end']).default('start'),
    reverse: z.boolean().default(false),
    tangent: z.boolean().default(true),
    overflow: z.enum(['hide', 'clamp', 'loop']).default('hide'),
  })
  .strict();
export const textSelectorSchema = z
  .object({
    unit: z.enum(['grapheme', 'word', 'line']).default('grapheme'),
    mode: z.enum(['percent', 'index']).default('percent'),
    start: finite.default(0),
    end: finite.default(100),
    offset: finite.default(0),
    shape: z.enum(['square', 'rampUp', 'rampDown', 'triangle', 'smooth']).default('square'),
    amount: finite.min(-1).max(1).default(1),
  })
  .strict();
export const textAnimatorSchema = z
  .object({
    id: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    selector: textSelectorSchema.default({}),
    values: z
      .object({
        x: finite.default(0),
        y: finite.default(0),
        rotation: finite.default(0),
        scaleX: finite.default(1),
        scaleY: finite.default(1),
        opacity: finite.min(0).max(1).default(1),
        tracking: finite.default(0),
        fill: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const textAnimatorsSchema = z
  .array(textAnimatorSchema)
  .max(32)
  .superRefine((items, ctx) => {
    if (new Set(items.map((v) => v.id)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'Text animator IDs must be unique within a layer' });
  });
export type PathTextInput = z.input<typeof pathTextSchema>;
export type TextAnimatorInput = z.input<typeof textAnimatorSchema>;
export type TextSelector = z.output<typeof textSelectorSchema>;
