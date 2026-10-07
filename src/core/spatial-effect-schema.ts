import { z } from 'zod';
const finite = z.number().finite(),
  controlPoint = z
    .object({
      x: finite.min(-4).max(5),
      y: finite.min(-4).max(5),
      weight: finite.min(0.01).max(100).default(1),
    })
    .strict(),
  pinPoint = z.object({ x: finite.min(-4).max(5), y: finite.min(-4).max(5) }).strict(),
  center = z.object({ x: finite.min(-2).max(3), y: finite.min(-2).max(3) }).strict(),
  common = {
    space: z.enum(['layer', 'canvas']).default('layer'),
    region: z
      .object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() })
      .strict()
      .optional(),
  },
  edge = z.enum(['transparent', 'clamp', 'wrap']).default('transparent');
export const spatialEffectSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('liquify'),
      ...common,
      amount: finite.min(0).max(1).default(1),
      edge,
      brushes: z
        .array(
          z
            .object({
              mode: z.enum(['push', 'twirl', 'inflate']).default('push'),
              center: center.default({ x: 0.5, y: 0.5 }),
              radius: finite.min(0.1).max(4000).default(100),
              dx: finite.min(-1000).max(1000).default(0),
              dy: finite.min(-1000).max(1000).default(0),
              angle: finite.min(-1440).max(1440).default(90),
              amount: finite.min(-1).max(1).default(1),
            })
            .strict(),
        )
        .max(128)
        .default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal('meshWarp'),
      ...common,
      columns: z.number().int().min(1).max(32),
      rows: z.number().int().min(1).max(32),
      points: z.array(controlPoint).min(4).max(1089),
      amount: finite.min(0).max(1).default(1),
      samples: z.union([z.literal(1), z.literal(4)]).default(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('cornerPin'),
      ...common,
      corners: z.array(pinPoint).length(4),
      amount: finite.min(0).max(1).default(1),
      samples: z.union([z.literal(1), z.literal(4)]).default(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('waveWarp'),
      ...common,
      amountX: finite.min(-1000).max(1000).default(20),
      amountY: finite.min(-1000).max(1000).default(0),
      wavelength: finite.min(1).max(4000).default(120),
      angle: finite.default(0),
      phase: finite.default(0),
      edge,
    })
    .strict(),
  z
    .object({
      type: z.literal('twirl'),
      ...common,
      center: center.default({ x: 0.5, y: 0.5 }),
      radius: finite.min(0.1).max(4000).default(150),
      amount: finite.min(-1440).max(1440).default(90),
      edge,
    })
    .strict(),
  z
    .object({
      type: z.literal('bulge'),
      ...common,
      center: center.default({ x: 0.5, y: 0.5 }),
      radius: finite.min(0.1).max(4000).default(150),
      amount: finite.min(-1).max(1).default(0.5),
      edge,
    })
    .strict(),
  z
    .object({
      type: z.literal('rgbSplit'),
      ...common,
      amountX: finite.min(-1000).max(1000).default(6),
      amountY: finite.min(-1000).max(1000).default(0),
      intensity: finite.min(0).max(1).default(1),
      edge,
    })
    .strict(),
  z
    .object({
      type: z.literal('linearWipe'),
      ...common,
      progress: finite.min(0).max(1).default(1),
      angle: finite.default(0),
      feather: finite.min(0).max(2000).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('radialWipe'),
      ...common,
      progress: finite.min(0).max(1).default(1),
      center: center.default({ x: 0.5, y: 0.5 }),
      feather: finite.min(0).max(2000).default(0),
    })
    .strict(),
]);
export type SpatialEffect = z.infer<typeof spatialEffectSchema>;
