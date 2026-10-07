import { z } from 'zod';
import { parameterDefault, type Parameter } from '../core/parameters.js';
import type { PluginTool } from '../core/plugin-schema.js';
import { normalizeToolDefinition, type ToolDefinition } from './tool-definition.js';
import { pluginContextSchema, pluginToolName } from '../service/plugins.js';
export type PluginCatalog = {
  catalogHash: string;
  notModified?: boolean;
  plugins?: Array<{ id: string; version: string; hash: string; tools: PluginTool[] }>;
};
export function parameterZod(p: Parameter): z.ZodTypeAny {
  let result: z.ZodTypeAny;
  if (p.type === 'number') {
    let n = z.number().finite();
    if (p.min !== undefined) n = n.min(p.min);
    if (p.max !== undefined) n = n.max(p.max);
    if (p.integer) n = n.int();
    result = n;
  } else if (p.type === 'string' || p.type === 'color')
    result = z
      .string()
      .min(p.type === 'color' ? 1 : (p.minLength ?? 0))
      .max(p.type === 'color' ? 1000 : (p.maxLength ?? 1000000));
  else if (p.type === 'boolean') result = z.boolean();
  else if (p.type === 'enum')
    result =
      p.options.length === 1
        ? z.literal(p.options[0])
        : z.union(
            p.options.map((v) => z.literal(v)) as [
              z.ZodLiteral<any>,
              z.ZodLiteral<any>,
              ...z.ZodLiteral<any>[],
            ],
          );
  else if (p.type === 'array')
    result = z
      .array(parameterZod(p.items))
      .min(p.minLength ?? 0)
      .max(p.maxLength ?? 10000);
  else if (p.type === 'object')
    result = z
      .object(
        Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, parameterZod(v)])),
      )
      .strict();
  else {
    const axes = p.type === 'vec3' ? ['x', 'y', 'z'] : ['x', 'y'];
    result = z
      .object(
        Object.fromEntries(
          axes.map((k) => [k, parameterZod({ type: 'number', min: p.min, max: p.max })]),
        ),
      )
      .strict();
  }
  return result.default(parameterDefault(p));
}
export function projectPluginTools(catalog: PluginCatalog): ToolDefinition[] {
  return (catalog.plugins ?? []).flatMap((plugin) =>
    plugin.tools.map((tool) => normalizeToolDefinition({
      name: pluginToolName(plugin.id, tool.id),
      description: tool.description,
      method: 'plugin:' + plugin.id + ':' + tool.id,
      schema: {
        revision: z.string().optional(),
        expectedPluginHash: z.string().default(plugin.hash),
        _context: pluginContextSchema,
        ...Object.fromEntries(
          Object.entries(tool.parameters).map(([k, v]) => [k, parameterZod(v as Parameter)]),
        ),
      },
      plugin: {
        id: plugin.id,
        version: plugin.version,
        hash: plugin.hash,
        origin: 'project' as const,
      },
      categories: tool.categories,
      keywords: tool.keywords,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })),
  );
}
