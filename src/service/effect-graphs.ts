import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  effectGraphSchema,
  effectGraphPathSchema,
  type GraphEffect,
} from '../core/effect-graph-schema.js';
import {
  compileEffectGraph,
  effectGraphResource,
  resolveEffectGraph,
  graphDependencies,
} from '../core/effect-graph.js';
import { keyframeSchema, VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
import { editEffectStack, type EffectAction } from '../core/effect-stack.js';
import { mergeMotionParameters } from '../core/motion-template.js';
import { parameterJsonSchema, type ParameterDefinitions } from '../core/parameters.js';
import { contextFramesSchema } from '../core/content-time.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { Renderer } from '../core/renderer.js';
import { applyOperations } from './operations.js';
import { hash } from './project.js';
import { effectGraphActionSchema, editEffectGraph } from '../core/effect-graph-edit.js';
const scope = {
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
  },
  sha = z.string().regex(/^[a-f0-9]{64}$/);
export const effectGraphInspectSchema = z
  .object({
    source: z.union([
      z.object({ file: effectGraphPathSchema }).strict(),
      z
        .object({
          ...scope,
          effectId: z.string().optional(),
          index: z.number().int().min(0).optional(),
        })
        .strict(),
    ]),
    params: z.record(z.unknown()).optional(),
    output: z.string().min(1).max(100).optional(),
    revision: z.string().optional(),
    includeGraph: z.boolean().default(false),
    nodeIds: z.array(z.string()).max(256).default([]),
    includeValues: z.boolean().default(false),
  })
  .strict();
export const effectGraphPlanSchema = z
  .object({
    revision: z.string(),
    source: effectGraphPathSchema.optional(),
    graph: effectGraphSchema.optional(),
    actions: z.array(effectGraphActionSchema).max(256).default([]),
    expectedHash: sha.nullable().default(null),
    resources: z
      .array(
        z
          .object({
            file: effectGraphPathSchema,
            graph: effectGraphSchema,
            expectedHash: sha.nullable().default(null),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({
            ...scope,
            action: z.enum(['append', 'update']).default('append'),
            resetParams: z.boolean().default(false),
            resetKeys: z.boolean().default(false),
            effectId: z.string().min(1).optional(),
            params: z.record(z.unknown()).default({}),
            bindings: z.record(z.string().min(1)).default({}),
            output: z.string().min(1).max(100).nullable().optional(),
            keys: z
              .array(
                z
                  .object({
                    parameter: z.string().min(1),
                    keys: z.array(keyframeSchema).min(1).max(10000),
                  })
                  .strict(),
              )
              .max(256)
              .default([]),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
function summarize(snapshot: Snapshot, effect: GraphEffect) {
  const graph = effect.graph ?? effectGraphResource(snapshot, effect.source!),
    compiled = resolveEffectGraph(snapshot, effect);
  return {
    name: compiled.name,
    parameters: compiled.parameters,
    parameterDefinitions: graph.parameters,
    parameterSchema: parameterJsonSchema({
      type: 'object',
      properties: graph.parameters as ParameterDefinitions,
    }),
    inputs: compiled.inputs,
    resources: [...(effect.source ? [effect.source] : []), ...compiled.resources].map((file) => ({
      file,
      hash: hash(snapshot.files[file]),
    })),
    nodes: compiled.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      inputs: graphDependencies(node),
      fields: Object.keys(node),
    })),
    output: compiled.output,
    outputs: compiled.outputs,
    selectedOutput: compiled.selectedOutput,
    unused: compiled.unused,
    liveNodeImagesEstimate: compiled.peakSurfaces,
    memoryEstimateScope:
      'Graph node values; aliases may share storage. Pass/mask scratch, owning stack surfaces and source layer capture work are additional and enforced by the renderer budget.',
    links: graph.links,
    limits: { maxExpandedNodes: 256, subgraphDepth: 8 },
  };
}
export async function graphInspectionSource(
  renderer: Renderer,
  snapshot: Snapshot,
  request: z.output<typeof effectGraphInspectSchema>,
) {
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before graph inspection');
  let effect: GraphEffect, locator: unknown;
  if ('file' in request.source)
    effect = {
      type: 'effectGraph',
      source: request.source.file,
      params: request.params ?? {},
      bindings: {},
      ...(request.output === undefined ? {} : { output: request.output }),
    };
  else {
    const source = request.source,
      scope = await renderer.inspectComposition(
        snapshot,
        source.sceneId,
        source.frame,
        source.path,
        source.contextFrames,
      ),
      node = scope.scene.nodes.find((node) => node.id === source.nodeId);
    if (!node) throw new VmotionError('NOT_FOUND', 'Effect graph owner is missing');
    const evaluated = evaluateNode(node, source.frame),
      index = source.effectId
        ? node.effects.findIndex((effect) => effect.id === source.effectId)
        : (source.index ?? node.effects.findIndex((effect) => effect.type === 'effectGraph'));
    const found = evaluated.effects[index];
    if (found?.type !== 'effectGraph')
      throw new VmotionError('EFFECT_NOT_FOUND', 'Selected effect is not a graph');
    effect = {
      ...found,
      ...(request.params ? { params: mergeMotionParameters(found.params, request.params) } : {}),
      ...(request.output === undefined ? {} : { output: request.output }),
    };
    locator = { ...source, index, effectId: found.id, bindings: found.bindings };
  }
  return { effect, locator };
}
export async function inspectEffectGraph(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = effectGraphInspectSchema.parse(raw),
    { effect, locator } = await graphInspectionSource(renderer, snapshot, request),
    summary = summarize(snapshot, effect),
    compiled = resolveEffectGraph(snapshot, effect);
  if (request.nodeIds.some((id) => !compiled.nodes.some((node) => node.id === id)))
    throw new VmotionError('EFFECT_GRAPH_INPUT', 'Requested graph node ID is missing');
  return {
    revision: snapshot.revision,
    locator,
    ...summary,
    nodes: summary.nodes
      .filter((node) => !request.nodeIds.length || request.nodeIds.includes(node.id))
      .map((node) => ({
        ...node,
        ...(request.includeValues
          ? { values: compiled.nodes.find((value) => value.id === node.id) }
          : {}),
      })),
    ...(request.includeGraph
      ? { graph: effect.graph ?? effectGraphResource(snapshot, effect.source!) }
      : {}),
  };
}
export async function planEffectGraph(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>,
) {
  const request = effectGraphPlanSchema.parse(raw);
  if (request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before graph planning');
  if (!request.source && !request.graph)
    throw new VmotionError(
      'EFFECT_GRAPH_SOURCE',
      'Provide an existing source or a graph definition',
    );
  const source = request.source ?? `components/effects/${randomUUID()}.json`,
    editedDefinition = request.actions.length
      ? editEffectGraph(request.graph ?? effectGraphResource(snapshot, source), request.actions)
      : request.graph,
    files = [
      ...request.resources.map((resource) => ({
        type: 'replace' as const,
        path: resource.file,
        content: JSON.stringify(resource.graph, null, 2) + '\n',
        expectedHash: resource.expectedHash,
      })),
      ...(editedDefinition
        ? [
            {
              type: 'replace' as const,
              path: source,
              content: JSON.stringify(editedDefinition, null, 2) + '\n',
              expectedHash: request.expectedHash,
            },
          ]
        : []),
    ];
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new VmotionError('EFFECT_GRAPH_FILES', 'Each graph resource may be saved once');
  let candidate = structuredClone(snapshot);
  if (files.length)
    candidate = applyOperations(root, candidate, [{ type: 'editFiles', edits: files }]);
  const definition = effectGraphResource(candidate, source);
  compileEffectGraph(definition, {}, (file) => effectGraphResource(candidate, file));
  const seen = new Set<string>(),
    layers = [],
    samples: Array<{ sceneId: string; path: string[]; contextFrames: number[]; frame: number }> =
      [];
  for (const target of request.targets) {
    const key = JSON.stringify([target.sceneId, target.path, target.nodeId]);
    if (seen.has(key))
      throw new VmotionError('EFFECT_TARGET', 'Use one graph target edit per owner');
    seen.add(key);
    const scope = await renderer.inspectComposition(
        candidate,
        target.sceneId,
        target.frame,
        target.path,
        target.contextFrames,
      ),
      node = scope.scene.nodes.find((node) => node.id === target.nodeId);
    if (!node) throw new VmotionError('NOT_FOUND', 'Graph target layer not found');
    if (target.frame >= scope.scene.duration)
      throw new VmotionError(
        'FRAME_RANGE',
        'Graph target frame is beyond local composition duration',
      );
    const previous =
      target.action === 'update'
        ? node.effects.find((effect) => effect.id === target.effectId)
        : undefined;
    if (target.action === 'update' && previous?.type !== 'effectGraph')
      throw new VmotionError('EFFECT_NOT_FOUND', 'Update requires an existing graph effect ID');
    const id = target.effectId ?? randomUUID(),
      params = mergeMotionParameters(
        previous?.type === 'effectGraph' && !target.resetParams ? previous.params : {},
        target.params,
      ),
      bindings = {
        ...(previous?.type === 'effectGraph' ? previous.bindings : {}),
        ...target.bindings,
      },
      output =
        target.output === undefined && previous?.type === 'effectGraph'
          ? previous.output
          : (target.output ?? undefined),
      effect: GraphEffect & { id: string } = {
        type: 'effectGraph',
        source,
        params,
        bindings,
        id,
        ...(output === undefined ? {} : { output }),
      };
    effect.params = resolveEffectGraph(candidate, effect).parameters;
    for (const slot of resolveEffectGraph(candidate, effect).inputs)
      if (slot !== 'source' && !bindings[slot])
        throw new VmotionError(
          'EFFECT_GRAPH_BINDING',
          'Named graph input requires a layer binding',
          { nodeId: target.nodeId, slot },
        );
    const action: EffectAction = previous
        ? {
            type: 'update',
            target: { id },
            patch: { source, graph: undefined, params: effect.params, bindings, output },
          }
        : { type: 'append', effect },
      edited = editEffectStack(
        target.resetKeys && previous
          ? {
              ...node,
              animations: node.animations.filter(
                (channel) =>
                  !channel.property.startsWith(`effects.${node.effects.indexOf(previous)}.`),
              ),
            }
          : node,
        [
          action,
          ...target.keys.map((channel) => ({
            type: 'keys' as const,
            target: { id },
            property: 'params.' + channel.parameter,
            keys: channel.keys,
          })),
        ],
        target.frame,
      );
    const index = edited.effects.findIndex((effect) => effect.id === id),
      sampleFrames = [
        ...new Set([
          target.frame,
          ...target.keys.flatMap((channel) => {
            const keys = [...channel.keys].sort((a, b) => a.frame - b.frame);
            return [
              ...keys.map((key) => key.frame),
              ...keys.slice(1).map((key, index) => Math.floor((key.frame + keys[index].frame) / 2)),
            ];
          }),
        ]),
      ];
    for (const frame of sampleFrames) {
      if (frame >= scope.scene.duration)
        throw new VmotionError(
          'FRAME_RANGE',
          'Graph parameter key is beyond local composition duration',
        );
      resolveEffectGraph(candidate, evaluateNode(edited, frame).effects[index] as GraphEffect);
      samples.push({
        sceneId: target.sceneId,
        path: target.path,
        contextFrames: target.contextFrames,
        frame,
      });
    }
    candidate = applyOperations(
      root,
      candidate,
      await edit(candidate, target.sceneId, target.frame, [
        {
          nodeId: target.nodeId,
          path: target.path,
          contextFrames: target.contextFrames,
          frame: target.frame,
          patch: {
            effects: edited.effects,
            animations: edited.animations,
            ...(node.animationLayers ? { animationLayers: edited.animationLayers } : {}),
          },
        },
      ]),
    );
    layers.push({
      sceneId: target.sceneId,
      nodeId: target.nodeId,
      path: target.path,
      effectId: id,
      params: effect.params,
      bindings,
      output,
      channels: edited.animations
        .filter((channel) => channel.property.startsWith(`effects.${index}.`))
        .map((channel) => ({ property: channel.property, keys: channel.keys.length })),
    });
  }
  const sceneIds = [...new Set(request.targets.map((target) => target.sceneId))],
    operations: Operation[] = [
      ...(files.length ? [{ type: 'editFiles' as const, edits: files }] : []),
      ...sceneIds.map((sceneId) => ({
        type: 'updateScene' as const,
        sceneId,
        patch: { nodes: candidate.scenes.find((scene) => scene.id === sceneId)!.nodes },
      })),
    ];
  const unique = [...new Map(samples.map((sample) => [JSON.stringify(sample), sample])).values()];
  return {
    request,
    candidate,
    operations,
    source,
    layers,
    samples: unique.slice(0, 12),
    coverage: {
      proposed: unique.length,
      omitted: Math.max(0, unique.length - 12),
      incomplete: unique.length > 12,
    },
    summary: summarize(candidate, { type: 'effectGraph', source, params: {}, bindings: {} }),
  };
}
