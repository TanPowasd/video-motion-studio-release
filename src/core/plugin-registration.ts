import { z } from 'zod';
export const pluginPathSchema = z
  .string()
  .max(400)
  .regex(/^components\/[\p{L}\p{N}_./-]+\.(?:json|ts|tsx)$/u)
  .refine((p) => !p.split('/').some((s) => !s || s === '.' || s === '..'));
export const pluginRegistrationSchema = z
  .object({
    source: pluginPathSchema.refine((p) => p.endsWith('.json')),
    enabled: z.boolean().default(true),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type PluginRegistration = z.output<typeof pluginRegistrationSchema>;
