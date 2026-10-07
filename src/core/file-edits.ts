import { z } from 'zod';
const file = z.string().min(1).max(400),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const fileEditSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('replace'),
      path: file,
      content: z.string().max(8 * 1024 * 1024),
      expectedHash: hash.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      path: file,
      expectedHash: hash,
      replacements: z
        .array(z.object({ before: z.string().min(1), after: z.string() }).strict())
        .min(1)
        .max(1000),
    })
    .strict(),
  z.object({ type: z.literal('delete'), path: file, expectedHash: hash }).strict(),
]);
export type FileEdit = z.infer<typeof fileEditSchema>;
