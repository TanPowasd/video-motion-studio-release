import { z } from 'zod';
import { contextFramesSchema } from '../core/content-time.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import {
  inspectComponentParameters,
  parameterChannels,
  parameterSpec,
} from './component-parameters.js';
import { parameterDefault, parameterJsonSchema } from '../core/parameters.js';

const relativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][\w-]*(?:\.(?:[a-zA-Z][\w-]*|\d+))*$/)
  .refine((p) => !p.split('.').some((s) => ['__proto__', 'prototype', 'constructor'].includes(s)));
export const parameterQuerySchema = z
  .object({
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().int().nonnegative().default(0),
    revision: z.string().optional(),
    paths: z.array(relativePath).min(1).max(64).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(64).default(16),
    channelOffset: z.number().int().nonnegative().default(0),
    channelLimit: z.number().int().min(1).max(200).default(32),
    previewItems: z.number().int().min(0).max(16).default(4),
    maxString: z.number().int().min(16).max(2000).default(160),
    includeSchema: z.boolean().default(false),
    fullValues: z.boolean().default(false),
  })
  .strict();

function valueAt(values: unknown, path: string) {
  let value: any = values;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new VmotionError('PARAMETER_PATH', 'Parameter value is missing', { path });
    value = value[part];
  }
  return value;
}
export async function queryParameters(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = parameterQuerySchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before parameter inspection');
  const inspected = await inspectComponentParameters(renderer, snapshot, p, {
      schema: false,
      channels: false,
    }),
    specs = inspected.metadata.parameters,
    paths = p.paths ? [...new Set(p.paths)] : Object.keys(specs),
    chosen = paths.slice(p.offset, p.offset + p.limit);
  // Validate the entire selection so a bad request cannot return a misleading partial success.
  for (const path of paths) {
    parameterSpec(specs, path);
    valueAt(inspected.values, path);
  }
  let remaining = 2048;
  const summary = (value: unknown, depth = 0): unknown => {
    if (--remaining < 0) return { kind: 'omitted', reason: 'preview-budget' };
    if (typeof value === 'string' && value.length > p.maxString)
      return {
        kind: 'string',
        length: value.length,
        preview: value.slice(0, p.maxString),
        truncated: true,
      };
    if (Array.isArray(value))
      return {
        kind: 'array',
        length: value.length,
        items: depth < 3 ? value.slice(0, p.previewItems).map((v) => summary(v, depth + 1)) : [],
        truncated: value.length > (depth < 3 ? p.previewItems : 0),
      };
    if (value && typeof value === 'object') {
      const keys = Object.keys(value),
        shown = depth < 3 ? keys.slice(0, p.previewItems) : [];
      return {
        kind: 'object',
        total: keys.length,
        values: Object.fromEntries(shown.map((k) => [k, summary((value as any)[k], depth + 1)])),
        truncated: shown.length < keys.length,
      };
    }
    return value;
  };
  const rows = chosen.map((path) => {
    const spec = parameterSpec(specs, path),
      value = valueAt(inspected.values, path),
      evaluated = valueAt(inspected.evaluated, path);
    let defaultValue: unknown;
    try {
      defaultValue = valueAt(inspected.metadata.defaults, path);
    } catch {
      defaultValue = parameterDefault(spec);
    }
    return {
      path,
      type: spec.type,
      label: spec.label,
      value: p.fullValues ? value : summary(value),
      evaluated: p.fullValues ? evaluated : summary(evaluated),
      ...(p.includeSchema
        ? { definition: spec, jsonSchema: { ...parameterJsonSchema(spec), default: defaultValue } }
        : {}),
      ...(spec.type === 'number'
        ? { min: spec.min, max: spec.max, integer: spec.integer, step: spec.step }
        : {}),
      animated: inspected.node.animations.some(
        (a) => a.property === 'params.' + path || a.property.startsWith('params.' + path + '.'),
      ),
      defaultValue: p.fullValues ? defaultValue : summary(defaultValue),
    };
  });
  const channels = parameterChannels(specs, inspected.values, {
    offset: p.channelOffset,
    limit: p.channelLimit,
    paths: p.paths,
  });
  return {
    revision: snapshot.revision,
    nodeId: inspected.node.id,
    name: inspected.metadata.name,
    source: inspected.node.component ?? inspected.node.templateInstance?.source,
    frame: p.frame,
    parameters: {
      total: paths.length,
      offset: p.offset,
      items: rows,
      nextOffset: p.offset + rows.length < paths.length ? p.offset + rows.length : undefined,
    },
    channels: {
      total: channels.total,
      offset: p.channelOffset,
      items: channels.channels,
      nextOffset:
        p.channelOffset + channels.channels.length < channels.total
          ? p.channelOffset + channels.channels.length
          : undefined,
    },
    projection: {
      partial: true,
      valueFormat: p.fullValues ? 'full' : 'preview',
      includeSchema: p.includeSchema,
      remainingPreviewItems: Math.max(0, remaining),
    },
    evaluation: 'theme-and-keyframes',
  };
}
