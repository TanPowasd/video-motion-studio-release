import { z } from 'zod';
import { nodeSchema } from './model.js';
import { numericPropertyPattern } from './numeric-properties.js';
const field = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][\w-]*(?:\.(?:[a-zA-Z][\w-]*|\d+))*$/)
  .refine((s) => !s.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)));
export const templatePortPropertySchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      numericPropertyPattern.test(p) ||
      /^(fill|stroke|text|fontFamily|fontWeight|lineHeight|align|visible|assetId|shadow\.color|gradient\.stops\.\d+\.color)$/.test(
        p,
      ),
  )
  .refine((s) => !s.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)));
export const templatePortSchema = z
  .object({
    parameter: field,
    nodeId: z.string().min(1).max(200),
    property: templatePortPropertySchema,
  })
  .strict();
export const templateDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z][\w-]*$/),
    name: z.string().min(1).max(200),
    version: z.number().int().min(1).max(1000000),
    width: z.number().int().min(16).max(3840),
    height: z.number().int().min(16).max(2160),
    duration: z.number().int().positive().max(1e9),
    parameters: z.record(z.unknown()).default({}),
    ports: z.array(templatePortSchema).max(256).default([]),
  })
  .strict();
export const templateDocumentSchema = templateDefinitionSchema
  .extend({
    kind: z.literal('scene-template'),
    formatVersion: z.literal(1),
    sceneId: z.string().min(1),
    fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
    files: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
    shared: z.array(z.string()).max(1024).default([]),
    migrations: z
      .object({
        parameters: z.record(field, field).default({}),
        layers: z.record(z.string().min(1)).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();
export const templateAuthorSchema = templateDefinitionSchema
  .extend({ nodes: z.array(nodeSchema).min(1).max(4000) })
  .strict();
export type TemplateDocument = z.output<typeof templateDocumentSchema>;
export type TemplateAuthor = z.input<typeof templateAuthorSchema>;
