import { z } from 'zod';

const n = z.number().finite(),
  hex = z.string().regex(/^#[0-9a-f]{6}$/i);
export const textureSettingsSchema = z
  .object({
    pattern: z
      .enum(['fbm', 'turbulence', 'ridged', 'cellular', 'marble', 'waves', 'checker'])
      .default('fbm'),
    seed: z.number().int().default(1),
    scale: n.min(1).max(4000).default(100),
    octaves: z.number().int().min(1).max(6).default(3),
    evolution: n.default(0),
    angle: n.default(0),
    contrast: n.min(0.01).max(10).default(1),
    bias: n.min(-1).max(1).default(0),
    warp: n.min(0).max(8).default(0),
    stops: z
      .array(
        z
          .object({ offset: n.min(0).max(1), color: hex, alpha: n.min(0).max(1).default(1) })
          .strict(),
      )
      .min(2)
      .max(16)
      .default([
        { offset: 0, color: '#10243a' },
        { offset: 1, color: '#91d9da' },
      ]),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (settings.stops.some((s, i) => i > 0 && s.offset <= settings.stops[i - 1].offset))
      ctx.addIssue({
        code: 'custom',
        message: 'Texture color stop offsets must increase',
        path: ['stops'],
      });
  });
export type TextureSettings = z.output<typeof textureSettingsSchema>;
