import { z } from 'zod';
const id = z.string().min(1).max(64),
  time = z.number().finite().nonnegative();
export const storyboardShotSchema = z
  .object({
    id,
    name: z.string().min(1).max(240),
    chapterId: id.optional(),
    source: z
      .object({ type: z.enum(['scene', 'asset', 'sequence']), id: z.string().min(1).max(200) })
      .strict(),
    duration: z.number().finite().positive().optional(),
    sourceIn: time.default(0),
    speed: z.number().finite().positive().max(100).default(1),
    audioEnabled: z.boolean().default(true),
    narration: z
      .array(
        z
          .object({
            id,
            assetId: z.string().min(1).max(200),
            trackId: z.string().min(1).max(200).optional(),
            offset: time.default(0),
            sourceIn: time.default(0),
            duration: z.number().finite().positive().optional(),
            volume: z.number().finite().min(0).max(4).default(1),
            fadeIn: time.default(0),
            fadeOut: time.default(0),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();
export const storyboardSchema = z
  .object({
    kind: z.literal('storyboard'),
    version: z.literal(1),
    id,
    name: z.string().min(1),
    unit: z.enum(['frames', 'seconds']).default('frames'),
    start: time.default(0),
    chapters: z
      .array(z.object({ id, name: z.string().min(1).max(240) }).strict())
      .max(200)
      .default([]),
    shots: z.array(storyboardShotSchema).min(1).max(250),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const [field, ids] of [
      ['shots', doc.shots.map((s) => s.id)],
      ['chapters', doc.chapters.map((c) => c.id)],
    ] as const)
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', message: 'Stable IDs must be unique', path: [field] });
    for (const [i, shot] of doc.shots.entries()) {
      if (shot.chapterId && !doc.chapters.some((c) => c.id === shot.chapterId))
        ctx.addIssue({
          code: 'custom',
          message: 'Chapter is missing',
          path: ['shots', i, 'chapterId'],
        });
      if (new Set(shot.narration.map((n) => n.id)).size !== shot.narration.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Narration IDs must be unique in a shot',
          path: ['shots', i, 'narration'],
        });
    }
  });
export type Storyboard = z.output<typeof storyboardSchema>;
export type StoryboardInput = z.input<typeof storyboardSchema>;
export function storyboardBoundary(
  value: number,
  unit: Storyboard['unit'],
  fps: { num: number; den: number },
) {
  return Math.round(unit === 'seconds' ? (value * fps.num) / fps.den : value);
}
