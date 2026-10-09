import { z } from 'zod';
import { contextFramesSchema } from '../core/content-time.js';
import { nodeSchema, VmotionError, type Snapshot } from '../core/model.js';
import { pathTextSchema } from '../core/typography-schema.js';
import {
  graphicsActionSchema,
  editGraphicsStack,
  expressionUsesGraphicsStack,
} from '../core/graphics-stack.js';
import { editKeyframes } from '../core/keyframes.js';
import { keyframeSchema, animationSchema } from '../core/model.js';
import { shapePath } from '../core/vector.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
const scope = {
  sceneId: z.string(),
  path: z.array(z.string()).max(32).default([]),
  contextFrames: contextFramesSchema.default([]),
  frame: z.number().finite().nonnegative().default(0),
};
export const graphicsInspectSchema = z
  .object({
    ...scope,
    nodeId: z.string(),
    revision: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(256).default(16),
    detail: z.boolean().default(false),
    includePath: z.boolean().default(false),
  })
  .strict();
export const graphicsPlanSchema = z
  .object({
    sceneId: z.string(),
    revision: z.string(),
    frame: scope.frame,
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({
            nodeId: z.string(),
            path: scope.path,
            contextFrames: scope.contextFrames,
            pathText: pathTextSchema.nullable().optional(),
            textActions: z.array(graphicsActionSchema).min(1).max(256).optional(),
            shapeActions: z.array(graphicsActionSchema).min(1).max(256).optional(),
            keys: z
              .array(
                z
                  .object({
                    property: animationSchema.shape.property,
                    keys: z.array(keyframeSchema).min(1).max(10000),
                  })
                  .strict(),
              )
              .max(256)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export async function inspectGraphics(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = graphicsInspectSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before graphics inspection');
  const graph = await renderer.inspectInteractions(snapshot, p.sceneId, p.frame, p.path, {
      contextFrames: p.contextFrames,
      includeInactive: true,
      includeEmpty: true,
      includeEvaluated: true,
    }),
    layer = graph.layers.find(
      (l) => l.node.id === p.nodeId && JSON.stringify(l.path) === JSON.stringify(p.path),
    );
  if (!layer) throw new VmotionError('NOT_FOUND', 'Graphics layer is outside this composition');
  const n = layer.evaluatedNode!;
  if (!['text', 'rect', 'ellipse', 'path'].includes(n.type))
    throw new VmotionError('GRAPHICS_TYPE', 'Expected text, rect, ellipse or path');
  const text = n.type === 'text' ? renderer.textGeometry(n, layer.frame ?? p.frame, snapshot) : undefined,
    nativePath = text ? undefined : shapePath(n, renderer.geometry),
    svg = nativePath?.toSVGString(),
    items = text ? n.textAnimators : n.shapeOperators;
  return {
    revision: snapshot.revision,
    sceneId: p.sceneId,
    path: p.path,
    nodeId: n.id,
    frame: p.frame,
    localBounds: layer.bounds,
    matrix: layer.matrix,
    stack: items.map((item, index) => ({
      id: item.id,
      index,
      enabled: item.enabled,
      ...('type' in item ? { type: item.type } : { selector: item.selector }),
      channels: n.animations
        .filter((a) =>
          a.property.startsWith(`${text ? 'textAnimators' : 'shapeOperators'}.${index}.`),
        )
        .map((a) => ({ property: a.property, keys: a.keys.length })),
      ...(p.detail ? { values: item } : {}),
    })),
    ...(text
      ? {
          metrics: text.metrics,
          pathText: n.pathText
            ? { ...n.pathText, path: p.includePath ? n.pathText.path : undefined }
            : undefined,
          units: {
            ...(p.detail
              ? {}
              : {
                  poseDefaults: {
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    alpha: 1,
                    lineIndex: 0,
                    wordIndex: -1,
                  },
                  coordinateDecimals: 4,
                }),
            total: text.runs.length,
            offset: p.offset,
            limit: p.limit,
            items: text.runs.slice(p.offset, p.offset + p.limit).map((r) => ({
              index: r.index,
              text: r.text,
              x: p.detail ? r.x : Number(r.x.toFixed(4)),
              y: p.detail ? r.y : Number(r.y.toFixed(4)),
              ...(p.detail || r.rotation !== 0
                ? { rotation: p.detail ? r.rotation : Number(r.rotation.toFixed(4)) }
                : {}),
              ...(p.detail || r.scaleX !== 1 ? { scaleX: r.scaleX } : {}),
              ...(p.detail || r.scaleY !== 1 ? { scaleY: r.scaleY } : {}),
              ...(p.detail || r.alpha !== 1 ? { alpha: r.alpha } : {}),
              ...(p.detail || r.wordIndex !== -1 ? { wordIndex: r.wordIndex } : {}),
              ...(p.detail || r.lineIndex !== 0 ? { lineIndex: r.lineIndex } : {}),
              ...(p.detail ? { box: r.box, baseline: r.baseline, fill: r.fill } : {}),
            })),
            nextOffset: p.offset + p.limit < text.runs.length ? p.offset + p.limit : null,
          },
        }
      : {
          geometry: {
            bounds: layer.bounds,
            empty: !svg,
            svgCharacters: svg!.length,
            ...(p.includePath ? { path: svg } : {}),
            fillRule: n.fillRule,
          },
        }),
    cache: text ? renderer.typography.report() : renderer.performanceInfo().geometry,
  };
}
export async function planGraphics(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = graphicsPlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before graphics planning');
  const edits: CompositionDraft[] = [],
    layers = [],
    sampleMap = new Map<
      string,
      { sceneId: string; path: string[]; contextFrames: number[]; frame: number }
    >(),
    seen = new Set<string>(),
    scopes = new Map<string, Awaited<ReturnType<Renderer['inspectComposition']>>>();
  const scoped = async (path: string[], contextFrames: number[]) => {
    const key = JSON.stringify([path, contextFrames]);
    if (!scopes.has(key))
      scopes.set(
        key,
        await renderer.inspectComposition(snapshot, p.sceneId, p.frame, path, contextFrames),
      );
    return scopes.get(key)!;
  };
  for (const target of p.targets) {
    const locator = JSON.stringify([target.path, target.nodeId]);
    if (seen.has(locator))
      throw new VmotionError('GRAPHICS_TARGET', 'Use one ordered edit per layer');
    seen.add(locator);
    const scope = await scoped(target.path, target.contextFrames);
    let node = scope.scene.nodes.find((n) => n.id === target.nodeId);
    if (!node) throw new VmotionError('NOT_FOUND', 'Graphics layer is outside this composition');
    if (!['text', 'rect', 'ellipse', 'path'].includes(node.type))
      throw new VmotionError('GRAPHICS_TYPE', 'Expected text, rect, ellipse or path');
    if (target.pathText !== undefined) {
      if (node.type !== 'text')
        throw new VmotionError('GRAPHICS_TYPE', 'Path text requires a text layer');
      if (
        !target.pathText &&
        (node.animations.some((a) => a.property.startsWith('pathText.')) ||
          Object.keys(node.expressions ?? {}).some((p) => p.startsWith('pathText.')))
      )
        throw new VmotionError(
          'GRAPHICS_CHANNEL',
          'Remove pathText animation/expression channels explicitly before disabling path text',
        );
      node = nodeSchema.parse({ ...node, pathText: target.pathText });
    }
    for (const [field, actions] of [
      ['textAnimators', target.textActions],
      ['shapeOperators', target.shapeActions],
    ] as const) {
      if (!actions) continue;
      if (actions.some((a) => ['append', 'remove', 'move', 'copy', 'clear'].includes(a.type))) {
        // Expressions can name numeric indices in other layers. Do not silently rebind them.
        const check = (value: unknown): boolean => {
          if (!value || typeof value !== 'object') return false;
          return Object.entries(value).some(([key, v]) =>
            key === 'expressions' && v && typeof v === 'object'
              ? Object.values(v).some(
                  (s) => typeof s === 'string' && expressionUsesGraphicsStack(s, field),
                )
              : check(v),
          );
        };
        if (check(snapshot.scenes) || check(scope.scene.nodes))
          throw new VmotionError(
            'GRAPHICS_EXPRESSION_REFERENCE',
            'Rewrite project expression index references before changing graphics stack topology',
          );
      }
      node = editGraphicsStack(node, field, actions, p.frame);
    }
    if (target.keys.length)
      node = editKeyframes(
        node,
        target.keys.map((k) => ({ type: 'upsert', ...k })),
      );
    if (
      !target.textActions &&
      !target.shapeActions &&
      target.pathText === undefined &&
      !target.keys.length
    )
      throw new VmotionError('GRAPHICS_EMPTY', 'Provide pathText, stack actions or keys');
    // Fail invalid native geometry before storing a candidate.
    if (['rect', 'ellipse', 'path'].includes(node.type)) shapePath(node, renderer.geometry);
    const patch = {
      pathText: node.pathText,
      textAnimators: node.textAnimators,
      shapeOperators: node.shapeOperators,
      animations: node.animations,
      ...(node.animationLayers ? { animationLayers: node.animationLayers } : {}),
      expressions: node.expressions,
    };
    edits.push({
      nodeId: target.nodeId,
      path: target.path,
      contextFrames: target.contextFrames,
      frame: p.frame,
      patch,
    });
    layers.push({
      nodeId: target.nodeId,
      path: target.path,
      textAnimators: node.textAnimators.map((v) => v.id),
      shapeOperators: node.shapeOperators.map((v) => v.id),
    });
    const frames = new Set([
      p.frame,
      ...node.animations
        .filter((a) => /^(pathText|textAnimators|shapeOperators)\./.test(a.property))
        .flatMap((a) => a.keys.map((k) => k.frame)),
    ]);
    for (const frame of frames) {
      const sample = {
        sceneId: p.sceneId,
        path: target.path,
        contextFrames: target.contextFrames,
        frame,
      };
      sampleMap.set(JSON.stringify(sample), sample);
    }
  }
  return {
    request: p,
    edits,
    layers,
    samples: [...sampleMap.values()].slice(0, 12),
    coverage: {
      included: Math.min(12, sampleMap.size),
      total: sampleMap.size,
      incomplete: sampleMap.size > 12,
    },
  };
}
