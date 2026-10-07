import { z } from 'zod';
const n = z.number().finite(),
  id = z.string().min(1).max(160);
export const soundNoteSchema = z.union([
  n.min(0).max(127),
  z.string().regex(/^[A-Ga-g](?:#|b)?-?\d{1,2}$/),
]);
export const audioPluginSchema = z
  .object({
    format: z.enum(['vst3', 'au']),
    path: z.string().min(1).max(1024),
    classId: z.string().min(1).max(128),
    name: z.string().max(200).optional(),
    fingerprint: z.string().max(300).optional(),
    parameters: z.record(z.string().regex(/^\d+$/), n.min(0).max(1)).default({}),
    state: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    controllerState: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
  })
  .strict();
export const builtinSoundEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gain'), db: n.min(-80).max(24) }).strict(),
  z
    .object({
      type: z.literal('filter'),
      mode: z.enum(['lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf']),
      frequency: n.min(10).max(22000),
      q: n.min(0.1).max(20).default(0.707),
      db: n.min(-24).max(24).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('distortion'),
      drive: n.min(1).max(30).default(3),
      mix: n.min(0).max(1).default(0.5),
    })
    .strict(),
  z
    .object({
      type: z.literal('delay'),
      seconds: n.min(0.001).max(3).default(0.25),
      rightSeconds: n.min(0.001).max(3).optional(),
      feedback: n.min(0).max(0.9).default(0.3),
      mix: n.min(0).max(1).default(0.25),
    })
    .strict(),
  z
    .object({
      type: z.literal('chorus'),
      rate: n.min(0.01).max(10).default(0.8),
      depth: n.min(0).max(0.015).default(0.003),
      delay: n.min(0.016).max(0.05).default(0.02),
      mix: n.min(0).max(1).default(0.3),
    })
    .strict(),
  z
    .object({
      type: z.literal('reverb'),
      seconds: n.min(0.1).max(8).default(1.5),
      damping: n.min(0).max(0.95).default(0.4),
      mix: n.min(0).max(1).default(0.2),
    })
    .strict(),
  z
    .object({
      type: z.literal('compressor'),
      thresholdDb: n.min(-60).max(0).default(-18),
      ratio: n.min(1).max(30).default(4),
      kneeDb: n.min(0).max(24).default(6),
      attack: n.min(0.0001).max(0.5).default(0.01),
      release: n.min(0.001).max(3).default(0.15),
      makeupDb: n.min(0).max(24).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('limiter'),
      ceilingDb: n.min(-24).max(0).default(-1),
      release: n.min(0.001).max(3).default(0.1),
    })
    .strict(),
]);
export const soundEffectSchema = z.discriminatedUnion('type', [
  ...builtinSoundEffectSchema.options,
  audioPluginSchema.extend({ type: z.literal('plugin') }),
]);
export const soundInstrumentSchema = z.discriminatedUnion('type', [
  audioPluginSchema.extend({ type: z.literal('plugin'), release: n.min(0).max(10).default(0) }),
  z
    .object({
      type: z.literal('synth'),
      wave: z.enum(['sine', 'triangle', 'saw', 'square', 'noise']).default('sine'),
      gain: n.min(0).max(2).default(0.3),
      attack: n.min(0).max(10).default(0.008),
      decay: n.min(0).max(10).default(0.15),
      sustain: n.min(0).max(1).default(0.6),
      release: n.min(0).max(10).default(0.2),
      fmRatio: n.min(0).max(20).default(0),
      fmIndex: n.min(0).max(20).default(0),
      detune: n.min(-100).max(100).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('drum'),
      voice: z.enum(['kick', 'snare', 'hat', 'tom', 'clap']),
      gain: n.min(0).max(2).default(0.5),
      release: n.min(0.01).max(3).default(0.3),
    })
    .strict(),
  z
    .object({
      type: z.literal('sample'),
      assetId: id,
      sourceIn: n.nonnegative().default(0),
      sourceDuration: n.positive().max(1800),
      rootNote: soundNoteSchema.default(60),
      loop: z.boolean().default(false),
      attack: n.min(0).max(10).default(0.005),
      release: n.min(0).max(10).default(0.05),
      gain: n.min(0).max(2).default(1),
    })
    .strict(),
]);
export const soundEventSchema = z
  .object({
    id,
    at: n.nonnegative(),
    duration: n.positive(),
    note: soundNoteSchema.default(60),
    endNote: soundNoteSchema.optional(),
    velocity: n.min(0).max(1).default(0.8),
    pan: n.min(-1).max(1).default(0),
  })
  .strict();
const effects = z.array(soundEffectSchema).max(12).default([]),
  sends = z
    .array(z.object({ busId: id, db: n.min(-80).max(12).default(-12) }).strict())
    .max(8)
    .default([]);
export const soundTrackSchema = z
  .object({
    id,
    name: z.string().default('Track'),
    instrument: soundInstrumentSchema,
    events: z.array(soundEventSchema).max(20000).default([]),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false),
    gainDb: n.min(-80).max(24).default(0),
    pan: n.min(-1).max(1).default(0),
    busId: id.default('master'),
    sends,
    effects,
    automation: z
      .array(
        z
          .object({
            property: z.enum(['gainDb', 'pan']),
            keys: z
              .array(z.object({ at: n.nonnegative(), value: n }).strict())
              .min(1)
              .max(2000),
          })
          .strict(),
      )
      .max(2)
      .default([]),
  })
  .strict();
export const soundBusSchema = z
  .object({
    id,
    name: z.string().default('Bus'),
    busId: id.default('master'),
    gainDb: n.min(-80).max(24).default(0),
    pan: n.min(-1).max(1).default(0),
    sends,
    effects,
  })
  .strict();
export const soundDocumentSchema = z
  .object({
    kind: z.literal('sound'),
    version: z.literal(1),
    id,
    name: z.string().min(1),
    unit: z.enum(['beats', 'seconds']).default('beats'),
    duration: n.positive().max(14400),
    tail: n.min(0).max(20).default(1),
    seed: z.number().int().min(0).max(0xffffffff).default(1),
    tempo: z
      .array(z.object({ beat: n.nonnegative(), bpm: n.min(20).max(400) }).strict())
      .min(1)
      .max(1000)
      .default([{ beat: 0, bpm: 120 }]),
    timeSignature: z
      .tuple([
        z.number().int().min(1).max(32),
        z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
      ])
      .default([4, 4]),
    tracks: z.array(soundTrackSchema).max(64).default([]),
    patterns: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1),
            length: n.positive().max(14400),
            channels: z
              .array(
                z
                  .object({ trackId: id, events: z.array(soundEventSchema).max(20000).default([]) })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    arrangement: z
      .array(
        z
          .object({
            id,
            patternId: id,
            at: n.nonnegative(),
            repeats: z.number().int().min(1).max(1024).default(1),
          })
          .strict(),
      )
      .max(2000)
      .optional(),
    buses: z.array(soundBusSchema).max(16).default([]),
    master: z
      .object({ gainDb: n.min(-80).max(24).default(0), effects })
      .strict()
      .default({}),
  })
  .strict();
export type SoundDocument = z.output<typeof soundDocumentSchema>;
export type SoundInput = z.input<typeof soundDocumentSchema>;
export type SoundInstrument = z.output<typeof soundInstrumentSchema>;
export type SoundEffect = z.output<typeof soundEffectSchema>;
export type AudioPluginConfig = z.output<typeof audioPluginSchema>;
export type SoundTrack = z.output<typeof soundTrackSchema>;
export type SoundEvent = z.output<typeof soundEventSchema>;
export type SoundPattern = NonNullable<SoundDocument['patterns']>[number];
