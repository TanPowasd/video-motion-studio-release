import { z } from 'zod';
import { builtinSoundEffectSchema as soundEffectSchema } from './sound-schema.js';
const n = z.number().finite(),
  id = z.string().min(1).max(200);
export const duckingSchema = z
  .object({
    source: z.object({ type: z.enum(['track', 'bus']), id }).strict(),
    thresholdDb: n.min(-60).max(0).default(-24),
    ratio: n.min(1).max(20).default(4),
    kneeDb: n.min(0).max(24).default(6),
    attack: n.min(0.0001).max(2).default(0.01),
    release: n.min(0.001).max(9).default(0.25),
    maxReductionDb: n.min(0).max(60).default(24),
  })
  .strict();
export const audioNormalizationSchema = z
  .object({
    targetLufs: n.min(-36).max(-5).default(-16),
    targetLra: n.min(1).max(50).default(11),
    truePeakDb: n.min(-9).max(0).default(-1),
    mode: z.enum(['auto', 'linear', 'dynamic']).default('auto'),
  })
  .strict();
const processor = {
  gainDb: n.min(-80).max(24).default(0),
  pan: n.min(-1).max(1).default(0),
  effects: z.array(soundEffectSchema).max(12).default([]),
  ducking: duckingSchema.nullable().optional(),
};
export const audioTrackMixSchema = z
  .object({
    ...processor,
    busId: id.default('master'),
    sends: z
      .array(z.object({ busId: id, db: n.min(-80).max(12).default(-12) }).strict())
      .max(8)
      .default([]),
    solo: z.boolean().default(false),
    automation: z
      .array(
        z
          .object({
            property: z.enum(['gainDb', 'pan']),
            keys: z
              .array(
                z
                  .object({
                    at: n.nonnegative(),
                    value: n,
                    easing: z.enum(['linear', 'hold']).default('linear'),
                  })
                  .strict(),
              )
              .min(1)
              .max(2000),
          })
          .strict(),
      )
      .max(2)
      .default([]),
  })
  .strict();
export const audioMixBusSchema = audioTrackMixSchema
  .omit({ solo: true })
  .extend({ id, name: z.string().default('Bus') });
export const audioMixSchema = z
  .object({
    tracks: z.record(audioTrackMixSchema).default({}),
    buses: z.array(audioMixBusSchema).max(16).default([]),
    master: z
      .object({ ...processor, normalization: audioNormalizationSchema.nullable().optional() })
      .strict()
      .default({}),
    scratchBudgetMb: z.number().int().min(64).max(131072).default(20480),
  })
  .strict();
export type AudioMix = z.output<typeof audioMixSchema>;
export type AudioMixInput = z.input<typeof audioMixSchema>;
export type AudioDucking = z.output<typeof duckingSchema>;
export type AudioNormalization = z.output<typeof audioNormalizationSchema>;
