import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { effectDefinitions, VmotionError, type Snapshot, type Effect } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
import { contextFramesSchema } from '../core/content-time.js';
import { effectActionSchema, editEffectStack } from '../core/effect-stack.js';
import type { Renderer } from '../core/renderer.js';
const spatial = new Set([
  'liquify',
  'meshWarp',
  'cornerPin',
  'waveWarp',
  'twirl',
  'bulge',
  'rgbSplit',
  'linearWipe',
  'radialWipe',
]);
export const effectGuideSchema = z
  .object({ types: z.array(z.string()).max(64).default([]), schema: z.boolean().default(false) })
  .strict();
export function effectGuide(raw: unknown = {}) {
  const request = effectGuideSchema.parse(raw),
    defs = effectDefinitions.filter(
      (d) => !request.types.length || request.types.includes(d.shape.type.value),
    );
  if (request.types.some((type) => !defs.some((d) => d.shape.type.value === type)))
    throw new VmotionError('EFFECT_TYPE', 'Unknown effect type');
  return {
    space:
      'Layer-local lengths/degrees and normalized centers. region overrides declared bounds; canvas uses the logical preview/export canvas.',
    effects: defs.map((d) => ({
      type: d.shape.type.value,
      fields: Object.keys(d.shape),
      ...(d.shape.type.value === 'effectGraph'
        ? {
            constraints:
              'Choose one inline graph or tracked components/effects/*.json source. Link exposed graph params to typed node fields; numeric params support native keys, colors/enums/boolean/structured values support direct connections. Bind named slots to same-parent layer IDs. Use effect_graph_inspect/plan for short stable-node-ID/resource edits and exact candidates.',
          }
        : {}),
      ...(d.shape.type.value === 'liquify'
        ? {
            constraints:
              'Up to 128 smooth localized inverse-sampling brush fields in layer/canvas coordinates, push/twirl/inflate; centers normalize within region, radius/dx/dy use local pixels. Numeric brushes.I.* channels can animate. Outside all footprints remains exact; nonphysical sampling field.',
          }
        : {}),
      ...(['motionBlur', 'echo'].includes(d.shape.type.value)
        ? {
            constraints:
              'Time-sampled same-owner layer graph, including generated TypeScript. Parent transforms/clips stay in the current owner coordinate system. Root opacity and its historical mask are sampled once. Effects after temporal sampling operate on that masked temporal result; stable IDs/stack topology are recommended.',
          }
        : {}),
      ...(d.shape.type.value === 'meshWarp'
        ? {
            constraints:
              'Row-major (columns+1)*(rows+1) normalized destination points; positive weights; points.I.x/y/weight can animate. Folded overlaps use later triangles.',
          }
        : {}),
      ...(d.shape.type.value === 'cornerPin'
        ? {
            constraints:
              'Four normalized corners in TL/TR/BR/BL order; convex and nondegenerate. Perspective-correct sampling; corners.I.x/y can animate.',
          }
        : {}),
      ...(request.schema ? { schema: zodToJsonSchema(d, { $refStrategy: 'none' }) } : {}),
    })),
    workflow:
      'Use effects_inspect for IDs/channels, effects_plan for append/update/copy/move/toggle/remove/keys, then preflight/apply the unchanged planId. SDK helpers create the same effect records.',
    limits:
      'CPU raster effects in stack order, up to 16 per layer. Temporal samples use linear-light premultiplied alpha, 512 source queries/256M sampled pixels/depth 8 per output frame. Temporary surfaces and temporal accumulators each have 256MiB bounds; budget failures do not shrink export resolution.',
  };
}
const scope = {
  sceneId: z.string(),
  path: z.array(z.string()).max(32).default([]),
  contextFrames: contextFramesSchema.default([]),
  frame: z.number().finite().nonnegative().default(0),
};
export const effectsInspectSchema = z
  .object({
    ...scope,
    nodeIds: z.array(z.string()).min(1).max(1000),
    revision: z.string().optional(),
  })
  .strict();
export const effectsPlanSchema = z
  .object({
    sceneId: z.string(),
    revision: z.string().optional(),
    frame: z.number().finite().nonnegative().default(0),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({
            nodeId: z.string(),
            path: scope.path,
            contextFrames: scope.contextFrames,
            frame: z.number().finite().nonnegative().optional(),
            fitToContent: z.boolean().default(true),
            actions: z.array(effectActionSchema).min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
const summarize = (node: Snapshot['scenes'][number]['nodes'][number], frame: number) => ({
  nodeId: node.id,
  effects: node.effects.map((effect, index) => ({
    index,
    id: effect.id,
    type: effect.type,
    enabled: effect.enabled !== false,
    values: effect,
    channels: node.animations
      .filter((a) => a.property.startsWith(`effects.${index}.`))
      .map((a) => ({ property: a.property, keys: a.keys.length })),
  })),
  evaluated: evaluateNode(node, frame).effects,
  declaredBounds: { x: 0, y: 0, width: node.width, height: node.height },
  legacyControls: {
    blur: node.blur,
    brightness: node.brightness,
    saturation: node.saturation,
    shadow: node.shadow,
  },
});
export async function inspectEffects(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = effectsInspectSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before effect inspection');
  const scoped = await renderer.inspectComposition(
    snapshot,
    request.sceneId,
    request.frame,
    request.path,
    request.contextFrames,
  );
  return {
    revision: snapshot.revision,
    sceneId: request.sceneId,
    path: request.path,
    frame: request.frame,
    layers: request.nodeIds.map((id) => {
      const node = scoped.scene.nodes.find((n) => n.id === id);
      if (!node) throw new VmotionError('NOT_FOUND', 'Layer not found');
      return summarize(node, request.frame);
    }),
  };
}
export async function planEffects(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = effectsPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before effect planning');
  const edits = [],
    reports = [],
    samples = [],
    seen = new Set<string>();
  for (const target of request.targets) {
    const frame = target.frame ?? request.frame,
      key = JSON.stringify([target.path, target.nodeId]);
    if (seen.has(key))
      throw new VmotionError('EFFECT_TARGET', 'Use one ordered action list per layer');
    seen.add(key);
    const scoped = await renderer.inspectComposition(
        snapshot,
        request.sceneId,
        frame,
        target.path,
        target.contextFrames,
      ),
      node = scoped.scene.nodes.find((n) => n.id === target.nodeId);
    if (!node) throw new VmotionError('NOT_FOUND', 'Layer not found');
    let actions = target.actions;
    if (
      target.fitToContent &&
      actions.some(
        (a) =>
          a.type === 'append' &&
          spatial.has(a.effect.type) &&
          !('region' in a.effect && a.effect.region) &&
          !('space' in a.effect && a.effect.space === 'canvas'),
      )
    ) {
      const graph = await renderer.inspectInteractions(
          snapshot,
          request.sceneId,
          frame,
          target.path,
          { contextFrames: target.contextFrames, includeInactive: true, includeEmpty: true },
        ),
        bounds = graph.layers.find((l) => l.node.id === target.nodeId)?.bounds;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0)
        throw new VmotionError(
          'EFFECT_REGION_EMPTY',
          'No content bounds for this layer; supply region or fitToContent=false',
        );
      actions = actions.map((a) =>
        a.type === 'append' &&
        spatial.has(a.effect.type) &&
        !('region' in a.effect && a.effect.region) &&
        !('space' in a.effect && a.effect.space === 'canvas')
          ? { ...a, effect: { ...a.effect, region: bounds } as Effect }
          : a,
      );
    }
    const edited = editEffectStack(node, actions, frame);
    edits.push({
      nodeId: target.nodeId,
      path: target.path,
      contextFrames: target.contextFrames,
      frame,
      patch: {
        effects: edited.effects,
        animations: edited.animations,
        ...(node.animationLayers ? { animationLayers: edited.animationLayers } : {}),
      },
    });
    reports.push(summarize(edited, frame));
    samples.push({
      sceneId: request.sceneId,
      path: target.path,
      contextFrames: target.contextFrames,
      frame,
    });
  }
  return {
    request,
    edits,
    layers: reports,
    samples: [...new Map(samples.map((s) => [JSON.stringify(s), s])).values()].slice(0, 12),
  };
}
