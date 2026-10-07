import { z } from 'zod';
import { spatialEffectSchema } from './spatial-effect-schema.js';
import { renderProgramPathSchema } from './programs/render-program-schema.js';
const finite = z.number().finite(),
  color = z.string().min(1),
  pointSchema = z.object({ x: finite, y: finite });
const curveSchema = z
  .array(z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }))
  .min(2)
  .max(32)
  .refine(
    (points) => points.every((p, i) => i === 0 || p.x > points[i - 1].x),
    'Curve input positions must increase',
  );
export const rasterEffectSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('program'),
      source: renderProgramPathSchema,
      params: z.record(z.unknown()).default({}),
    })
    .strict(),
  z.object({
    type: z.literal('gradientMap'),
    stops: z
      .array(z.object({ offset: finite.min(0).max(1), color: z.string().regex(/^#[0-9a-f]{6}$/i) }))
      .min(2)
      .max(16),
    intensity: finite.min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('radialRays'),
    center: pointSchema.default({ x: 0.5, y: 0.5 }),
    length: finite.min(0).max(4).default(0.5),
    samples: z.number().int().min(2).max(64).default(16),
    intensity: finite.min(0).max(8).default(1),
    decay: finite.min(0.01).max(1).default(0.92),
    threshold: finite.min(0).max(1).default(0.5),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default('#dcecff'),
    mix: z.enum(['screen', 'add']).default('screen'),
  }),
  z.object({
    type: z.literal('bloom'),
    radius: finite.min(0).max(300).default(30),
    threshold: finite.min(0).max(1).default(0.65),
    intensity: finite.min(0).max(8).default(1),
    levels: z.number().int().min(1).max(6).default(4),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default('#ffffff'),
  }),
  z.object({ type: z.literal('blur'), radius: finite.min(0).max(300) }),
  z.object({
    type: z.literal('glow'),
    color,
    radius: finite.min(0).max(300),
    intensity: finite.min(0).max(4).default(1),
    threshold: finite.min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('color'),
    brightness: finite.min(0).max(4).default(1),
    contrast: finite.min(0).max(4).default(1),
    saturation: finite.min(0).max(4).default(1),
    hue: finite.default(0),
  }),
  z.object({
    type: z.literal('shadow'),
    color,
    blur: finite.min(0).max(300),
    x: finite,
    y: finite,
  }),
  z.object({
    type: z.literal('chromaKey'),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    tolerance: finite.min(0).max(1).default(0.12),
    softness: finite.min(0.001).max(1).default(0.15),
    despill: finite.min(0).max(1).default(0.8),
  }),
  z.object({
    type: z.literal('levels'),
    inputBlack: finite.min(0).max(0.999).default(0),
    inputWhite: finite.min(0.001).max(1).default(1),
    gamma: finite.min(0.05).max(20).default(1),
    outputBlack: finite.min(0).max(1).default(0),
    outputWhite: finite.min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('curves'),
    master: curveSchema.optional(),
    red: curveSchema.optional(),
    green: curveSchema.optional(),
    blue: curveSchema.optional(),
  }),
  z.object({
    type: z.literal('lut3d'),
    size: z.number().int().min(2).max(33),
    data: z
      .array(finite)
      .min(24)
      .max(33 ** 3 * 3),
    domainMin: z.tuple([finite, finite, finite]).default([0, 0, 0]),
    domainMax: z.tuple([finite, finite, finite]).default([1, 1, 1]),
    intensity: finite.min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('vignette'),
    amount: finite.min(0).max(1).default(0.5),
    radius: finite.min(0.05).max(2).default(0.75),
    softness: finite.min(0.01).max(2).default(0.6),
    center: pointSchema.default({ x: 0.5, y: 0.5 }),
  }),
  z.object({
    type: z.literal('grain'),
    amount: finite.min(0).max(1).default(0.08),
    seed: z.number().int().default(1),
    monochrome: z.boolean().default(true),
    animated: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('displacement'),
    amountX: finite.min(-500).max(500).default(20),
    amountY: finite.min(-500).max(500).default(20),
    scale: finite.min(1).max(2000).default(100),
    seed: z.number().int().default(1),
    evolution: finite.default(0),
    octaves: z.number().int().min(1).max(6).default(3),
    edge: z.enum(['transparent', 'clamp', 'wrap']).default('transparent'),
  }),
  z.object({ type: z.literal('pixelate'), size: finite.min(1).max(500).default(12) }),
  ...spatialEffectSchema.options,
]);
