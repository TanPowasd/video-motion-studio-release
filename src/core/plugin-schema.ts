import { z } from 'zod';
import { valid, validRange } from 'semver';
import { pluginPathSchema } from './plugin-registration.js';
export { pluginPathSchema, pluginRegistrationSchema } from './plugin-registration.js';
export type { PluginRegistration } from './plugin-registration.js';
export const pluginIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/);
export const pluginVersionSchema = z
  .string()
  .max(100)
  .refine((v) => valid(v) !== null, 'Use a valid semantic version');
export const pluginCategorySchema = z.enum([
  'core',
  'animation',
  'composition',
  'effects',
  'vector',
  'drawing',
  'media',
  'editing',
  'audio',
  '3d',
  'math',
  'render',
  'recovery',
]);
const contribution = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string().min(1).max(200),
    kind: z.enum(['component', 'effectGraph', 'motion', 'theme', 'sound', 'sceneTemplate']),
    source: pluginPathSchema,
    description: z.string().max(1000).default(''),
  })
  .strict();
export const pluginFileSchema = z
  .object({
    path: pluginPathSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const pluginToolSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1).max(2000),
    mode: z.enum(['query', 'plan']),
    parameters: z.record(z.unknown()).default({}),
    categories: z.array(pluginCategorySchema).min(1).max(13).default(['composition']),
    keywords: z.string().max(1000).default(''),
    reads: z
      .object({
        scenes: z.boolean().default(false),
        sequences: z.boolean().default(false),
        assets: z.boolean().default(false),
        files: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();
export const pluginManifestSchema = z
  .object({
    kind: z.literal('vmotion-plugin'),
    apiVersion: z.literal(1),
    id: pluginIdSchema,
    name: z.string().min(1).max(200),
    version: pluginVersionSchema,
    description: z.string().max(2000).default(''),
    dependencies: z
      .record(
        pluginIdSchema,
        z
          .string()
          .min(1)
          .max(100)
          .refine((v) => validRange(v) !== null, 'Invalid semantic version range'),
      )
      .default({}),
    entry: pluginPathSchema.optional(),
    files: z.array(pluginFileSchema).max(1024).default([]),
    tools: z.array(pluginToolSchema).max(64).default([]),
    contributions: z.array(contribution).max(128).default([]),
  })
  .strict()
  .superRefine((d, c) => {
    if (d.tools.length && !d.entry)
      c.addIssue({ code: 'custom', message: 'Tools need a TypeScript entry', path: ['entry'] });
    if (d.entry && !/\.tsx?$/.test(d.entry))
      c.addIssue({ code: 'custom', message: 'Entry must be TypeScript', path: ['entry'] });
    for (const key of ['tools', 'contributions'] as const)
      if (new Set(d[key].map((v) => v.id)).size !== d[key].length)
        c.addIssue({ code: 'custom', message: 'Contribution IDs must be unique', path: [key] });
    d.contributions.forEach((resource, index) => {
      if (
        resource.kind === 'component'
          ? !/\.tsx?$/.test(resource.source)
          : !resource.source.endsWith('.json')
      )
        c.addIssue({
          code: 'custom',
          message: 'Components use TypeScript; other resource contributions use JSON',
          path: ['contributions', index, 'source'],
        });
    });
    if (new Set(d.files.map((file) => file.path)).size !== d.files.length)
      c.addIssue({ code: 'custom', message: 'Plugin file paths must be unique', path: ['files'] });
  });
export type PluginManifest = z.output<typeof pluginManifestSchema>;
export type PluginTool = z.output<typeof pluginToolSchema>;
/** vmplugin.json inside a portable .vmplugin bundle (format 1). */
export const PLUGIN_BUNDLE_FORMAT = 1;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const pluginBundleManifestSchema = z
  .object({
    kind: z.literal('vmotion-plugin-bundle'),
    formatVersion: z.literal(PLUGIN_BUNDLE_FORMAT),
    root: pluginIdSchema,
    plugins: z
      .array(
        z
          .object({
            id: pluginIdSchema,
            name: z.string().min(1).max(200),
            version: pluginVersionSchema,
            source: pluginPathSchema,
            contentHash: sha256,
            dependencies: z.record(z.string()).default({}),
            files: z
              .array(
                z
                  .object({
                    path: pluginPathSchema,
                    sha256,
                    bytes: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .min(1)
              .max(1024),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    digest: sha256,
  })
  .strict();
export type PluginBundleManifest = z.output<typeof pluginBundleManifestSchema>;
