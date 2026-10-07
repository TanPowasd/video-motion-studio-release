import { z } from 'zod';
import { validateParameterDefinitions, type ParameterDefinitions } from '../parameters.js';
const file = z
  .string()
  .regex(/^components\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.(?:py|wgsl|json)$/u);
export const renderProgramPathSchema = z
  .string()
  .regex(/^components\/renderers\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.json$/u);
export const renderProgramSchema = z
  .object({
    kind: z.literal('render-program'),
    version: z.literal(1),
    name: z.string().min(1).max(200),
    backend: z.enum(['python', 'wgsl']),
    entry: file,
    files: z.array(file).max(64).default([]),
    parameters: z.record(z.unknown()).default({}),
    uniforms: z.array(z.string().min(1).max(200)).max(64).default([]),
    assets: z.array(z.string().min(1).max(200)).max(32).default([]),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    workgroup: z
      .tuple([z.number().int().min(1).max(256), z.number().int().min(1).max(256)])
      .default([8, 8])
      .refine(([x, y]) => x * y <= 256, 'Workgroup exceeds 256 invocations'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.entry.endsWith(value.backend === 'python' ? '.py' : '.wgsl'))
      ctx.addIssue({
        code: 'custom',
        path: ['entry'],
        message: 'Entry extension must match backend',
      });
    try {
      validateParameterDefinitions(value.parameters as ParameterDefinitions);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['parameters'], message: (error as Error).message });
    }
    if (new Set(value.files).size !== value.files.length)
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'Dependencies must be unique' });
  });
export type RenderProgram = z.output<typeof renderProgramSchema>;
