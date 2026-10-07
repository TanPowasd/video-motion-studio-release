import { z } from 'zod';
const finite = z.number().finite(),
  frame = z.number().int().min(0).max(1e9),
  id = z.string().min(1).max(200);
export const trackingSettingsSchema = z
  .object({
    levels: z.number().int().min(1).max(5).default(4),
    radius: z.number().int().min(3).max(15).default(7),
    iterations: z.number().int().min(3).max(40).default(20),
    minFeature: finite.min(1e-8).max(0.1).default(0.00003),
    minCorrelation: finite.min(0).max(1).default(0.8),
    maxResidual: finite.min(0.001).max(1).default(0.15),
    maxForwardBackward: finite.min(0.05).max(10).default(1.5),
    maxDisplacement: finite.min(1).max(256).default(64),
  })
  .strict();
export const trackingSeedSchema = z.object({ frame, x: finite, y: finite }).strict();
export const trackingSampleSchema = z
  .object({
    frame,
    x: finite.nullable(),
    y: finite.nullable(),
    status: z.enum(['tracked', 'manual', 'lost']),
    confidence: finite.min(0).max(1),
    reason: z
      .enum([
        'noSeed',
        'bounds',
        'lowTexture',
        'photometric',
        'forwardBackward',
        'displacement',
        'stopped',
      ])
      .optional(),
    correlation: finite.min(-1).max(1).optional(),
    residual: finite.nonnegative().optional(),
    forwardBackward: finite.nonnegative().optional(),
  })
  .strict();
export const trackingDocumentSchema = z
  .object({
    kind: z.literal('tracking'),
    version: z.literal(1),
    id,
    name: z.string().min(1).max(200),
    source: z
      .object({
        assetId: id,
        fingerprint: z.string().min(1),
        contentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        width: z.number().int().positive().max(32768),
        height: z.number().int().positive().max(32768),
        fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
      })
      .strict(),
    range: z.object({ start: frame, end: frame }).strict(),
    analysis: z
      .object({
        width: z.number().int().min(32).max(1280),
        height: z.number().int().min(32).max(1280),
        algorithm: z.literal('pyramidal-lk-fb-1'),
        settings: trackingSettingsSchema,
        metrics: z.record(finite).default({}),
      })
      .strict(),
    points: z
      .array(
        z
          .object({
            id,
            name: z.string().max(200),
            seeds: z.array(trackingSeedSchema).min(1).max(256),
            samples: z.array(trackingSampleSchema).min(1).max(3600),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.range.end <= d.range.start || d.range.end - d.range.start > 3600)
      ctx.addIssue({
        code: 'custom',
        message: 'Tracking range uses 1–3600 source frames',
        path: ['range'],
      });
    if (new Set(d.points.map((p) => p.id)).size !== d.points.length)
      ctx.addIssue({ code: 'custom', message: 'Point IDs must be unique', path: ['points'] });
    for (const [pIndex, p] of d.points.entries()) {
      if (
        p.samples.length !== d.range.end - d.range.start ||
        p.samples.some((s, i) => s.frame !== d.range.start + i)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Samples must cover every ascending integer frame in the range',
          path: ['points', pIndex, 'samples'],
        });
      if (
        new Set(p.seeds.map((s) => s.frame)).size !== p.seeds.length ||
        p.seeds.some(
          (s) =>
            s.frame < d.range.start ||
            s.frame >= d.range.end ||
            s.x < 0 ||
            s.y < 0 ||
            s.x >= d.source.width ||
            s.y >= d.source.height,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Seeds must use unique in-range source frames and source pixel coordinates',
          path: ['points', pIndex, 'seeds'],
        });
      for (const [i, s] of p.samples.entries())
        if (
          s.status === 'lost'
            ? s.x !== null || s.y !== null || s.confidence !== 0
            : s.x === null ||
              s.y === null ||
              s.x < 0 ||
              s.y < 0 ||
              s.x >= d.source.width ||
              s.y >= d.source.height
        )
          ctx.addIssue({
            code: 'custom',
            message:
              'Lost samples have null coordinates/zero confidence; valid samples use source pixels',
            path: ['points', pIndex, 'samples', i],
          });
    }
  });
export type TrackingDocument = z.output<typeof trackingDocumentSchema>;
export type TrackingSample = z.output<typeof trackingSampleSchema>;
export type TrackingSettings = z.output<typeof trackingSettingsSchema>;
