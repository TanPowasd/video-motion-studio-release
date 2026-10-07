import { z } from 'zod';
import { rasterEffectSchema } from './raster-effect-schema.js';
import { textureSettingsSchema } from './texture-schema.js';
import { validateParameterDefinitions, type ParameterDefinitions } from './parameters.js';
const finite = z.number().finite(),
  id = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\p{L}\p{N}_-]+$/u)
    .refine(
      (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
      'Reserved graph identifier',
    ),
  ref = z.string().min(1).max(200),
  region = z
    .object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() })
    .strict(),
  hex = z.string().regex(/^#[0-9a-f]{6}$/i);
export const graphChannelSchema = z.enum(['red', 'green', 'blue', 'alpha', 'luma']);
const channelSource = z.union([
  finite.min(0).max(1),
  z.object({ input: ref, channel: graphChannelSchema }).strict(),
]);
export const effectGraphPathSchema = z
  .string()
  .regex(/^components\/effects\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.json$/u);
export const effectGraphNodeSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('input'), slot: id.default('source') }).strict(),
  z
    .object({
      id,
      type: z.literal('keyer'),
      input: ref,
      mode: z.enum(['chroma', 'luma']).default('chroma'),
      color: hex.default('#00ff00'),
      threshold: finite.min(0).max(1).default(0.12),
      softness: finite.min(0).max(1).default(0.08),
      spill: finite.min(0).max(1).default(0),
      invert: z.boolean().default(false),
      view: z.enum(['color', 'matte']).default('color'),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('channels'),
      red: channelSource,
      green: channelSource,
      blue: channelSource,
      alpha: channelSource,
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('colorMatrix'),
      input: ref,
      matrix: z
        .array(finite.min(-100).max(100))
        .length(20)
        .default([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]),
      colorSpace: z.enum(['srgb', 'linear']).default('srgb'),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('texture'),
      settings: textureSettingsSchema.default({}),
      opacity: finite.min(0).max(1).default(1),
      space: z.enum(['layer', 'canvas']).default('layer'),
      region: region.optional(),
    })
    .strict(),
  z.object({ id, type: z.literal('pass'), input: ref, effect: rasterEffectSchema }).strict(),
  z
    .object({
      id,
      type: z.literal('blend'),
      foreground: ref,
      background: ref,
      mode: z
        .enum([
          'source-over',
          'screen',
          'multiply',
          'overlay',
          'difference',
          'lighter',
          'darken',
          'lighten',
        ])
        .default('source-over'),
      opacity: finite.min(0).max(1).default(1),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('mask'),
      input: ref,
      matte: ref,
      mode: z.enum(['alpha', 'alphaInverted', 'luma', 'lumaInverted']).default('alpha'),
      feather: finite.min(0).max(300).default(0),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('transform'),
      input: ref,
      matrix: z.tuple([finite, finite, finite, finite, finite, finite]).default([1, 0, 0, 1, 0, 0]),
      space: z.enum(['layer', 'canvas']).default('layer'),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('displace'),
      input: ref,
      map: ref,
      amountX: finite.min(-1000).max(1000).default(20),
      amountY: finite.min(-1000).max(1000).default(20),
      channelX: z.enum(['red', 'green', 'blue', 'alpha', 'luma']).default('red'),
      channelY: z.enum(['red', 'green', 'blue', 'alpha', 'luma']).default('green'),
      midpointX: finite.min(0).max(1).default(0.5),
      midpointY: finite.min(0).max(1).default(0.5),
      mapAlpha: z.enum(['multiply', 'ignore']).default('multiply'),
      space: z.enum(['layer', 'canvas']).default('layer'),
      edge: z.enum(['transparent', 'clamp', 'wrap']).default('transparent'),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('noise'),
      seed: z.number().int().default(1),
      scale: finite.min(1).max(4000).default(100),
      octaves: z.number().int().min(1).max(6).default(3),
      evolution: finite.default(0),
      low: hex.default('#000000'),
      high: hex.default('#ffffff'),
      opacity: finite.min(0).max(1).default(1),
      space: z.enum(['layer', 'canvas']).default('layer'),
      region: region.optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('solid'),
      color: hex,
      opacity: finite.min(0).max(1).default(1),
      space: z.enum(['layer', 'canvas']).default('layer'),
      region: region.optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('subgraph'),
      source: effectGraphPathSchema,
      output: id.optional(),
      inputs: z.record(ref).default({}),
      params: z.record(z.unknown()).default({}),
    })
    .strict(),
]);
export const effectGraphLinkSchema = z
  .object({
    nodeId: ref,
    property: z.string().min(1).max(200),
    parameter: z.string().min(1).max(200),
    mode: z.enum(['direct', 'number']).default('direct'),
    scale: finite.default(1),
    offset: finite.default(0),
  })
  .strict();
export const effectGraphSchema = z
  .object({
    kind: z.literal('effect-graph'),
    version: z.literal(1),
    name: z.string().min(1).max(200),
    parameters: z.record(z.unknown()).default({}),
    nodes: z.array(effectGraphNodeSchema).min(1).max(128),
    output: ref,
    outputs: z.record(id, ref).optional(),
    links: z.array(effectGraphLinkSchema).max(512).default([]),
  })
  .strict()
  .superRefine((graph, ctx) => {
    if (Object.keys(graph.outputs ?? {}).length > 32)
      ctx.addIssue({
        code: 'custom',
        message: 'Graph supports up to 32 named outputs',
        path: ['outputs'],
      });
    if (new TextEncoder().encode(JSON.stringify(graph)).byteLength > 8 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Graph definition exceeds 8MiB' });
    try {
      validateParameterDefinitions(graph.parameters as ParameterDefinitions);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['parameters'] });
    }
    const ids = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (ids.has(node.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Graph node IDs must be unique',
          path: ['nodes', index, 'id'],
        });
      ids.add(node.id);
    }
  });
export const graphEffectDefinition = z
  .object({
    type: z.literal('effectGraph'),
    source: effectGraphPathSchema.optional(),
    graph: effectGraphSchema.optional(),
    output: id.optional(),
    params: z.record(z.unknown()).default({}),
    bindings: z.record(z.string().min(1).max(400)).default({}),
  })
  .strict();
export type EffectGraph = z.output<typeof effectGraphSchema>;
export type EffectGraphInput = z.input<typeof effectGraphSchema>;
export type EffectGraphNode = z.output<typeof effectGraphNodeSchema>;
export type GraphEffect = z.output<typeof graphEffectDefinition>;
