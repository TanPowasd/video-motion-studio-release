import { z } from 'zod';
export const templateFileSchema = z
  .string()
  .regex(/^components\/templates\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.json$/u)
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'));
export const templateInstanceSchema = z
  .object({
    source: templateFileSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['linked', 'local']).default('linked'),
  })
  .strict();
