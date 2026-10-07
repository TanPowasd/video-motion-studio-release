import { z } from 'zod';

const finite = z.number().finite();
export const pathTrimSchema = z
  .object({
    start: finite.min(0).max(1).default(0),
    end: finite.min(0).max(1).default(1),
    // Turns along the total length of all contours, rather than degrees.
    offset: finite.min(-1e6).max(1e6).default(0),
  })
  .strict();
export const strokeDashSchema = z
  .array(finite.min(0).max(1e6))
  .max(32)
  .refine(
    (dash) => !dash.length || dash.some((value) => value > 0),
    'Dash pattern must have a positive interval',
  );
export const vectorFields = {
  strokeDash: strokeDashSchema.default([]),
  strokeDashOffset: finite.min(-1e6).max(1e6).default(0),
  strokeCap: z.enum(['butt', 'round', 'square']).default('butt'),
  strokeJoin: z.enum(['miter', 'round', 'bevel']).default('miter'),
  strokeMiterLimit: finite.min(1).max(1000).default(10),
  fillRule: z.enum(['nonzero', 'evenodd']).default('nonzero'),
  pathTrim: pathTrimSchema.default({}),
};
export const pathOperationSchema = z.enum([
  'union',
  'difference',
  'intersect',
  'xor',
  'reverseDifference',
]);
export const outlineOptionsSchema = z
  .object({
    width: finite.positive().max(1e6).default(1),
    cap: vectorFields.strokeCap,
    join: vectorFields.strokeJoin,
    miterLimit: vectorFields.strokeMiterLimit,
  })
  .strict();
export const pathGeometrySchema = z
  .object({
    paths: z
      .array(
        z
          .object({
            path: z.string().max(1_000_000),
            fillRule: vectorFields.fillRule,
            transform: z.tuple([finite, finite, finite, finite, finite, finite]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    operation: z
      .enum([
        'union',
        'difference',
        'intersect',
        'xor',
        'reverseDifference',
        'simplify',
        'round',
        'outline',
        'trim',
        'inspect',
      ])
      .default('inspect'),
    radius: finite.min(0).max(1e6).default(0),
    stroke: outlineOptionsSchema.default({}),
    trim: pathTrimSchema.default({}),
  })
  .strict();
export type PathTrim = z.infer<typeof pathTrimSchema>;
export type PathOperation = z.infer<typeof pathOperationSchema>;
export type OutlineOptions = z.input<typeof outlineOptionsSchema>;
export type PathGeometryRequest = z.input<typeof pathGeometrySchema>;
