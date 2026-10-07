import { z } from 'zod';
import { animationLayerActionSchema, editAnimationLayers } from '../core/animation-layers.js';
import { animationNode } from './animation.js';
import { evaluateNode, getNumericPath } from '../core/time.js';
import { nodeSchema, VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import { applyOperations } from './operations.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
import { resolveParameters } from '../core/parameters.js';
const scope = {
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeId: z.string().min(1),
  },
  property = z.string().min(1).max(200),
  offset = z.number().int().nonnegative().default(0);
export const animationLayersInspectSchema = z
  .object({
    ...scope,
    revision: z.string().optional(),
    layerIds: z.array(z.string()).min(1).max(32).optional(),
    properties: z.array(property).min(1).max(64).optional(),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(12).optional(),
    offset,
    limit: z.number().int().min(1).max(32).default(8),
    channelOffset: offset,
    channelLimit: z.number().int().min(1).max(64).default(16),
    includeKeys: z.boolean().default(false),
    keyOffset: offset,
    keyLimit: z.number().int().min(1).max(1000).default(32),
  })
  .strict();
export const animationLayersPlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({ ...scope, actions: z.array(animationLayerActionSchema).min(1).max(1000) })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export async function inspectAnimationLayers(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = animationLayersInspectSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before layer-stack inspection');
  const node = await animationNode(
      renderer,
      snapshot,
      p.sceneId,
      p.path,
      p.nodeId,
      p.frame,
      p.contextFrames,
    ),
    stack = node.animationLayers ?? [],
    known = new Set(stack.map((l) => l.id));
  for (const id of p.layerIds ?? [])
    if (!known.has(id))
      throw new VmotionError('ANIMATION_LAYER_ID', 'Requested layer is missing', { id });
  const wanted = p.layerIds ? new Set(p.layerIds) : undefined,
    selected = stack.filter((l) => !wanted || wanted.has(l.id)),
    page = selected.slice(p.offset, p.offset + p.limit),
    properties =
      p.properties ??
      [...new Set(page.flatMap((l) => l.channels.map((c) => c.property)))].slice(0, 64),
    frames = p.frames ?? [p.frame];
  for (const property of properties) getNumericPath(node, property);
  return {
    revision: snapshot.revision,
    sceneId: p.sceneId,
    nodeId: p.nodeId,
    path: p.path,
    contextFrames: p.contextFrames,
    total: selected.length,
    offset: p.offset,
    ...(p.offset + page.length < selected.length ? { nextOffset: p.offset + page.length } : {}),
    coverage: {
      available: stack.length,
      returned: page.length,
      omitted: selected.length - page.length,
      filteredOut: stack.length - selected.length,
    },
    layers: page.map((layer) => {
      const channels = layer.channels.filter(
          (c) => !p.properties || p.properties.includes(c.property),
        ),
        shown = channels.slice(p.channelOffset, p.channelOffset + p.channelLimit);
      return {
        id: layer.id,
        name: layer.name,
        blend: layer.blend,
        enabled: layer.enabled,
        weight: layer.weight,
        start: layer.start,
        end: layer.end,
        rate: layer.rate,
        offset: layer.offset,
        totalChannels: channels.length,
        channelOffset: p.channelOffset,
        ...(p.channelOffset + shown.length < channels.length
          ? { nextChannelOffset: p.channelOffset + shown.length }
          : {}),
        channels: shown.map((c) => ({
          property: c.property,
          keyCount: c.keys.length,
          before: c.before ?? 'constant',
          after: c.after ?? 'constant',
          ...(p.includeKeys
            ? {
                keys: c.keys.slice(p.keyOffset, p.keyOffset + p.keyLimit),
                keyOffset: p.keyOffset,
                ...(p.keyOffset + p.keyLimit < c.keys.length
                  ? { nextKeyOffset: p.keyOffset + p.keyLimit }
                  : {}),
              }
            : {}),
        })),
      };
    }),
    samples: frames.map((frame) => {
      const evaluated = evaluateNode(node, frame);
      return {
        frame,
        values: Object.fromEntries(
          properties.map((property) => [property, getNumericPath(evaluated, property)]),
        ),
        layers: page.map((layer) => {
          const active = evaluated.animationLayers!.find((l) => l.id === layer.id)!;
          return {
            id: layer.id,
            active:
              active.enabled &&
              frame >= active.start &&
              (active.end === undefined || frame < active.end) &&
              active.weight !== 0,
            weight: active.weight,
            localFrame: (frame - active.start) * active.rate + active.offset,
          };
        }),
      };
    }),
    interpretation:
      'Ordinary keys then ordered animation stack; values precede layout/path/expressions. Layer local keys use parent-frame start/rate/offset. Default channel/key pages are bounded; unsampled frames are not verified.',
  };
}
export async function planAnimationLayers(
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
  const p = animationLayersPlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before animation-layer planning');
  let candidate = structuredClone(snapshot);
  const seen = new Set<string>(),
    layers = [],
    samples: Array<{ sceneId: string; path: string[]; contextFrames: number[]; frame: number }> =
      [];
  for (const target of p.targets) {
    const key = JSON.stringify([target.sceneId, target.path, target.nodeId]);
    if (seen.has(key))
      throw new VmotionError('ANIMATION_LAYER_TARGET', 'Edit a target once per batch');
    seen.add(key);
    const scope = await renderer.inspectComposition(
        candidate,
        target.sceneId,
        target.frame,
        target.path,
        target.contextFrames,
      ),
      original = await animationNode(
        renderer,
        candidate,
        target.sceneId,
        target.path,
        target.nodeId,
        target.frame,
        target.contextFrames,
      ),
      node = editAnimationLayers(original, target.actions),
      proposed = [
        ...new Set([
          target.frame,
          ...(node.animationLayers ?? []).flatMap((layer) => [
            layer.start,
            ...(layer.end !== undefined ? [layer.end - 1, layer.end] : []),
            ...layer.channels.flatMap((c) =>
              c.keys.map((k) =>
                layer.rate ? (k.frame - layer.offset) / layer.rate + layer.start : layer.start,
              ),
            ),
          ]),
          ...node.animations.flatMap((c) => c.keys.map((k) => k.frame)),
        ]),
      ]
        .filter((f) => Number.isFinite(f) && f >= 0 && f < scope.scene.duration)
        .sort((a, b) => a - b);
    if (target.frame >= scope.scene.duration)
      throw new VmotionError('FRAME_RANGE', 'Layer edit is outside composition');
    const checks =
      proposed.length > 128
        ? Array.from(
            { length: 128 },
            (_, i) => proposed[Math.round((i * (proposed.length - 1)) / 127)],
          )
        : proposed;
    const metadata = node.templateInstance
      ? renderer.templates.metadata(candidate, node)
      : node.type === 'component' && node.component
        ? await renderer.components.describe(candidate, node.component)
        : undefined;
    for (const frame of checks) {
      const evaluated = nodeSchema.parse(evaluateNode(node, frame));
      if (metadata) resolveParameters(metadata.parameters, evaluated.params);
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
            animationLayers: node.animationLayers,
            animations: node.animations,
            ...(node.type === 'component' || node.templateInstance ? { params: node.params } : {}),
          },
        },
      ]),
    );
    layers.push({
      sceneId: target.sceneId,
      nodeId: target.nodeId,
      path: target.path,
      layerIds: (node.animationLayers ?? []).map((l) => l.id),
      channels: (node.animationLayers ?? []).reduce((n, l) => n + l.channels.length, 0),
      poseChecks: {
        proposed: proposed.length,
        checked: checks.length,
        incomplete: checks.length < proposed.length,
      },
    });
    for (const frame of checks)
      samples.push({
        sceneId: target.sceneId,
        path: target.path,
        contextFrames: target.contextFrames,
        frame,
      });
  }
  const ids = [...new Set(p.targets.map((t) => t.sceneId))],
    operations: Operation[] = ids.map((sceneId) => ({
      type: 'updateScene',
      sceneId,
      patch: { nodes: candidate.scenes.find((s) => s.id === sceneId)!.nodes },
    })),
    unique = [...new Map(samples.map((sample) => [JSON.stringify(sample), sample])).values()],
    selected = [
      ...new Map(
        unique.map((sample) => [
          JSON.stringify([sample.sceneId, sample.path, sample.contextFrames]),
          sample,
        ]),
      ).values(),
      ...unique,
    ]
      .filter(
        (sample, i, all) =>
          all.findIndex((other) => JSON.stringify(sample) === JSON.stringify(other)) === i,
      )
      .slice(0, 12);
  return {
    request: p,
    candidate,
    operations,
    layers,
    samples: selected,
    coverage: {
      proposed: unique.length,
      selected: selected.length,
      omitted: unique.length - selected.length,
      incomplete: selected.length < unique.length,
    },
  };
}
