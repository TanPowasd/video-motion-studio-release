import { z } from 'zod';
const finite = z.number().finite();
export const contextFramesSchema = z.array(finite.min(0).max(1e9)).max(32);
export const contentTimeSchema = z
  .object({
    mode: z.enum(['linear', 'remap']).default('linear'),
    anchor: finite.min(-1e9).max(1e9).default(0),
    offset: finite.min(-1e9).max(1e9).default(0),
    rate: finite.min(-1000).max(1000).default(1),
    frame: finite.min(-1e9).max(1e9).default(0),
    repeat: z.enum(['continue', 'clamp', 'loop', 'pingpong', 'blank']).default('continue'),
    duration: finite.positive().max(1e9).optional(),
  })
  .strict();
export type ContentTime = z.infer<typeof contentTimeSchema>;
