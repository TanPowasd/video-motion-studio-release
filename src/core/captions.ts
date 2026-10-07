import { z } from 'zod';
import { VmotionError } from './model.js';
export const captionCueSchema = z
  .object({
    id: z.string().min(1).max(100),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1).max(10000),
  })
  .strict()
  .refine((c) => c.end > c.start, 'Caption must have positive duration');
export const captionsSchema = z
  .object({
    version: z.literal(1),
    fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
    cues: z
      .array(captionCueSchema)
      .max(5000)
      .refine(
        (cues) => new Set(cues.map((c) => c.id)).size === cues.length,
        'Caption IDs must be unique',
      )
      .refine(
        (cues) => cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end),
        'Captions must be ordered without overlap',
      ),
  })
  .strict();
export type CaptionDocument = z.infer<typeof captionsSchema>;
export function parseCaptions(
  content: string,
  fps: { num: number; den: number },
  format: 'srt' | 'vtt' = 'srt',
): CaptionDocument {
  if (content.length > 5 * 1024 * 1024)
    throw new VmotionError('CAPTION_SIZE', 'Subtitle file exceeds 5 MB');
  const blocks = content
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/),
    cues: CaptionDocument['cues'] = [];
  const seconds = (stamp: string) => {
    const parts = stamp.replace(',', '.').split(':').map(Number);
    if (
      parts.some((n) => !Number.isFinite(n)) ||
      parts.length < 2 ||
      parts.length > 3 ||
      parts.at(-1)! >= 60 ||
      parts.at(-2)! >= 60
    )
      throw new VmotionError('CAPTION_TIME', 'Invalid subtitle timestamp');
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  };
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (
      !lines.length ||
      !block.trim() ||
      (format === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]))
    )
      continue;
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0)
      throw new VmotionError(
        'CAPTION_PARSE',
        `Missing timestamp in subtitle block ${cues.length + 1}`,
      );
    const match =
      /^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/.exec(
        lines[at],
      );
    if (!match)
      throw new VmotionError(
        'CAPTION_TIME',
        `Invalid timestamp in subtitle block ${cues.length + 1}`,
      );
    const start = Math.round((seconds(match[1]) * fps.num) / fps.den),
      end = Math.round((seconds(match[2]) * fps.num) / fps.den),
      text = lines
        .slice(at + 1)
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();
    if (!text || end <= start)
      throw new VmotionError('CAPTION_PARSE', `Empty or zero-duration cue ${cues.length + 1}`);
    cues.push({ id: `cue-${String(cues.length + 1).padStart(4, '0')}`, start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 1; i < cues.length; i++)
    if (cues[i].start < cues[i - 1].end)
      throw new VmotionError(
        'CAPTION_OVERLAP',
        'Subtitle cues overlap; separate speakers/languages into different tracks',
      );
  return captionsSchema.parse({ version: 1, fps, cues });
}
