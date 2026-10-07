import { z } from 'zod';
import {
  pathOperationSchema,
  pathTrimSchema,
  outlineOptionsSchema,
  vectorFields,
} from './vector-schema.js';
import { matrixSchema } from './repeater-schema.js';
const finite = z.number().finite(),
  meta = {
    id: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
  };
export const shapeOperatorSchema = z.discriminatedUnion('type', [
  z.object({ ...meta, type: z.literal('trim'), ...pathTrimSchema.shape }).strict(),
  z
    .object({ ...meta, type: z.literal('round'), radius: finite.min(0).max(4096).default(12) })
    .strict(),
  z.object({ ...meta, type: z.literal('outline'), ...outlineOptionsSchema.shape }).strict(),
  z
    .object({
      ...meta,
      type: z.literal('dash'),
      on: finite.positive().max(1e6),
      off: finite.positive().max(1e6),
      phase: finite.default(0),
    })
    .strict(),
  z
    .object({
      ...meta,
      type: z.literal('transform'),
      matrix: matrixSchema.default([1, 0, 0, 1, 0, 0]),
    })
    .strict(),
  z
    .object({
      ...meta,
      type: z.literal('offset'),
      amount: finite.min(-4096).max(4096).default(0),
      join: vectorFields.strokeJoin,
      miterLimit: vectorFields.strokeMiterLimit,
    })
    .strict(),
  z
    .object({
      ...meta,
      type: z.literal('boolean'),
      operation: pathOperationSchema,
      paths: z
        .array(
          z
            .object({
              path: z.string().max(65536),
              fillRule: vectorFields.fillRule,
              transform: matrixSchema.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
]);
export const shapeOperatorsSchema = z
  .array(shapeOperatorSchema)
  .max(32)
  .superRefine((items, ctx) => {
    if (new Set(items.map((v) => v.id)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'Shape operator IDs must be unique within a layer' });
  });
export type ShapeOperator = z.output<typeof shapeOperatorSchema>;
export type ShapeOperatorInput = z.input<typeof shapeOperatorSchema>;
