import { z } from 'zod';
import { numericPropertyPattern } from './numeric-properties.js';
export const themeFileSchema = z
  .string()
  .regex(/^components\/themes\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.json$/u)
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'));
export const tokenIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)*$/)
  .refine((s) => !s.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)));
const common = {
    id: tokenIdSchema,
    label: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    alias: tokenIdSchema.optional(),
  },
  finite = z.number().finite();
export const themeTokenSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('number'),
      value: finite.optional(),
      min: finite.optional(),
      max: finite.optional(),
      unit: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({ ...common, type: z.literal('color'), value: z.string().min(1).max(200).optional() })
    .strict(),
  z
    .object({ ...common, type: z.literal('font'), value: z.string().min(1).max(200).optional() })
    .strict(),
  z
    .object({ ...common, type: z.literal('string'), value: z.string().max(4000).optional() })
    .strict(),
  z.object({ ...common, type: z.literal('boolean'), value: z.boolean().optional() }).strict(),
  z
    .object({
      ...common,
      type: z.literal('vec2'),
      value: z.object({ x: finite, y: finite }).strict().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('vec3'),
      value: z.object({ x: finite, y: finite, z: finite }).strict().optional(),
    })
    .strict(),
]);
export const themeDocumentSchema = z
  .object({
    kind: z.literal('theme'),
    version: z.literal(1),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    parent: themeFileSchema.optional(),
    tokens: z.array(themeTokenSchema).max(1024),
  })
  .strict()
  .superRefine((d, c) => {
    if (new Set(d.tokens.map((t) => t.id)).size !== d.tokens.length)
      c.addIssue({ code: 'custom', message: 'Token IDs must be unique', path: ['tokens'] });
    d.tokens.forEach((t, i) => {
      if ((t.value === undefined) === !t.alias)
        c.addIssue({
          code: 'custom',
          message: 'Choose exactly one value or alias',
          path: ['tokens', i],
        });
      if (t.type === 'number' && t.min !== undefined && t.max !== undefined && t.min > t.max)
        c.addIssue({ code: 'custom', message: 'Minimum exceeds maximum', path: ['tokens', i] });
    });
  });
export const themePropertyPattern = new RegExp(
  `^(?:${numericPropertyPattern.source.slice(2, -2)}|fill|stroke|text|fontFamily|fontWeight|lineHeight|align|visible|shadow\\.color|gradient\\.stops\\.\\d+\\.color)$`,
);
export const themePropertySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(themePropertyPattern)
  .refine((s) => !s.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)));
export const themeBindingSchema = z
  .object({
    source: themeFileSchema,
    enabled: z.boolean().default(true),
    links: z.record(themePropertySchema, tokenIdSchema),
    baseline: z.record(themePropertySchema, z.unknown()),
    overrides: z.record(themePropertySchema, z.unknown()).default({}),
  })
  .strict()
  .superRefine((b, c) => {
    if (Object.keys(b.links).length > 128)
      c.addIssue({ code: 'custom', message: 'At most 128 token links per layer' });
    for (const field of Object.keys(b.links))
      if (!Object.hasOwn(b.baseline, field))
        c.addIssue({
          code: 'custom',
          message: 'Every link needs its captured literal baseline; use bindTheme/theme_plan',
          path: ['baseline', field],
        });
    for (const field of Object.keys(b.overrides))
      if (!Object.hasOwn(b.links, field))
        c.addIssue({
          code: 'custom',
          message: 'Local override must address a linked field',
          path: ['overrides', field],
        });
  });
export type ThemeDocument = z.output<typeof themeDocumentSchema>;
export type ThemeToken = z.output<typeof themeTokenSchema>;
export type ThemeBinding = z.output<typeof themeBindingSchema>;
