import { z } from 'zod';
import { keyframeActionSchema, editKeyframes, sampleAnimation } from '../core/keyframes.js';
import { animationSchema, VmotionError, type Snapshot, type Node } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { resolveParameters, ParameterError } from '../core/parameters.js';
import { evaluateNode, getNumericPath } from '../core/time.js';
import { hasDrivers } from '../core/drivers.js';
import { contextFramesSchema } from '../core/content-time.js';
export const animationEditSchema = z
  .object({
    sceneId: z.string(),
    frame: z.number().finite().nonnegative().default(0),
    revision: z.string().optional(),
    edits: z
      .array(
        z
          .object({
            nodeId: z.string(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: contextFramesSchema.default([]),
            frame: z.number().finite().nonnegative().optional(),
            actions: z.array(keyframeActionSchema).min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export const animationInspectSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        'Keys per channel with nodeId (default 200); animated nodes per page without it (default 30, max 200)',
      ),
    sceneId: z.string(),
    nodeId: z
      .string()
      .optional()
      .describe(
        'Omit for a paged scene-wide overview of animated layers (channels, key counts, frame ranges)',
      ),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    frames: z.array(z.number().finite().nonnegative()).max(120).default([]),
    properties: z.array(animationSchema.shape.property).max(1000).optional(),
  })
  .strict();
export async function animationNode(
  renderer: Renderer,
  snapshot: Snapshot,
  sceneId: string,
  path: string[],
  nodeId: string,
  frame: number,
  contextFrames: number[] = [],
) {
  const scope = await renderer.inspectComposition(snapshot, sceneId, frame, path, contextFrames),
    node = scope.scene.nodes.find((n) => n.id === nodeId);
  if (!node) throw new VmotionError('NOT_FOUND', 'Animation layer not found');
  if (node.type === 'component' && node.component) {
    const metadata = await renderer.components.describe(snapshot, node.component);
    return { ...node, params: resolveParameters(metadata.parameters, node.params) };
  }
  if (node.templateInstance) {
    const metadata = renderer.templates.metadata(snapshot, node);
    return { ...node, params: resolveParameters(metadata.parameters, node.params) };
  }
  return node;
}
export async function animationEdits(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = animationEditSchema.parse(raw),
    seen = new Set<string>(),
    edits = [];
  for (const edit of request.edits) {
    const key = JSON.stringify([edit.path, edit.nodeId]);
    if (seen.has(key))
      throw new VmotionError('KEYFRAME_BATCH', 'Put all actions for a layer in one edit');
    seen.add(key);
    const original = await animationNode(
        renderer,
        snapshot,
        request.sceneId,
        edit.path,
        edit.nodeId,
        edit.frame ?? request.frame,
        edit.contextFrames,
      ),
      node = editKeyframes(original, edit.actions);
    if ((node.type === 'component' && node.component) || node.templateInstance) {
      const metadata = node.templateInstance
        ? renderer.templates.metadata(snapshot, node)
        : await renderer.components.describe(snapshot, node.component!);
      for (const frame of new Set([
        request.frame,
        ...node.animations.flatMap((a) =>
          a.property.startsWith('params.') ? a.keys.map((k) => k.frame) : [],
        ),
      ]))
        try {
          resolveParameters(metadata.parameters, evaluateNode(node, frame).params);
        } catch (e) {
          if (e instanceof ParameterError)
            throw new VmotionError(e.code, e.message, { file: node.component, path: e.path });
          throw e;
        }
    }
    edits.push({
      path: edit.path,
      frame: edit.frame ?? request.frame,
      contextFrames: edit.contextFrames,
      nodeId: edit.nodeId,
      patch: {
        animations: node.animations,
        ...(node.type === 'component' || node.templateInstance ? { params: node.params } : {}),
      },
    });
  }
  return { request, edits };
}
/** Scene/scope-wide overview: which layers animate what, without key arrays. */
async function animationOverview(
  renderer: Renderer,
  snapshot: Snapshot,
  request: z.infer<typeof animationInspectSchema>,
) {
  const scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    limit = Math.min(request.limit ?? 30, 200),
    range = (frames: number[]) =>
      frames.length ? [Math.min(...frames), Math.max(...frames)] : undefined,
    animated = scope.scene.nodes
      .map((node) => {
        const channels = (node.animations ?? [])
            .filter((a) => !request.properties || request.properties.includes(a.property))
            .map((a) => ({
              property: a.property,
              keyCount: a.keys.length,
              frameRange: range(a.keys.map((k) => k.frame)),
            })),
          layers = node.animationLayers?.length ?? 0,
          expressions = Object.keys(node.expressions ?? {}).length,
          frames = (node.animations ?? []).flatMap((a) => a.keys.map((k) => k.frame));
        return {
          id: node.id,
          name: node.name,
          type: node.type,
          channels,
          ...(layers ? { animationLayers: layers } : {}),
          ...(expressions ? { expressions } : {}),
          ...(node.motionPath ? { motionPath: true } : {}),
          frameRange: range(frames),
        };
      })
      .filter(
        (node) =>
          node.channels.length ||
          (!request.properties && (node.animationLayers || node.expressions || node.motionPath)),
      ),
    page = animated.slice(request.offset, request.offset + limit);
  return {
    revision: snapshot.revision,
    sceneId: request.sceneId,
    path: request.path,
    frame: request.frame,
    fps: snapshot.project.fps.num / snapshot.project.fps.den,
    layersInScope: scope.scene.nodes.length,
    total: animated.length,
    offset: request.offset,
    limit,
    nodes: page,
    truncated: request.offset + limit < animated.length,
    ...(request.offset + limit < animated.length ? { nextOffset: request.offset + limit } : {}),
    next: 'Pass nodeId (and frames/properties) for keys and sampled values of one layer; animation_edit changes keys.',
  };
}
/** animation_inspect: one layer with nodeId, otherwise the scope overview. */
export type AnimationOverview = Awaited<ReturnType<typeof animationOverview>>;
export async function inspectAnimationRequest(
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
): Promise<Awaited<ReturnType<typeof inspectAnimation>>> {
  const parsed = animationInspectSchema.parse(raw);
  // Typed RPC callers always pass nodeId; agents omitting it get the overview shape at runtime.
  return parsed.nodeId === undefined
    ? ((await animationOverview(renderer, snapshot, parsed)) as unknown as Awaited<
        ReturnType<typeof inspectAnimation>
      >)
    : inspectAnimation(renderer, snapshot, parsed);
}
export async function inspectAnimation(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const parsed = animationInspectSchema.parse(raw);
  if (parsed.nodeId === undefined)
    throw new VmotionError(
      'NOT_FOUND',
      'nodeId is required for one layer; omit it for the overview',
    );
  const request = { ...parsed, nodeId: parsed.nodeId, limit: parsed.limit ?? 200 },
    node = await animationNode(
      renderer,
      snapshot,
      request.sceneId,
      request.path,
      request.nodeId,
      request.frame,
      request.contextFrames,
    ),
    fps = snapshot.project.fps.num / snapshot.project.fps.den;
  const times = request.frames.length ? request.frames : [request.frame],
    scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    );
  let driverSamples:
    | Array<{
        frame: number;
        seconds: number;
        values: Record<string, number>;
        velocityPerSecond: Record<string, number>;
      }>
    | undefined;
  if (hasDrivers(scope.scene.nodes)) {
    driverSamples = [];
    const properties = request.properties ?? [
        ...new Set([
          ...node.animations.map((channel) => channel.property),
          ...(node.animationLayers ?? []).flatMap((l) => l.channels.map((c) => c.property)),
          ...Object.keys(node.expressions ?? {}),
          ...(node.layout ? ['x', 'y', 'width', 'height'] : []),
          ...(node.motionPath
            ? ['x', 'y', ...(node.motionPath.autoRotate ? ['rotation'] : [])]
            : []),
        ]),
      ],
      at = async (frame: number) => {
        const scoped = await renderer.inspectComposition(
          snapshot,
          request.sceneId,
          frame,
          request.path,
          request.contextFrames,
        );
        return (
          await renderer.driven(scoped.scene.nodes, frame, snapshot, scoped.driverContext)
        ).find((value) => value.id === request.nodeId)!;
      };
    for (const frame of times) {
      const current = await at(frame),
        before = await at(Math.max(0, frame - 0.25)),
        after = await at(frame + 0.25),
        interval = frame < 0.25 ? frame + 0.25 : 0.5;
      driverSamples.push({
        frame,
        seconds: frame / fps,
        values: Object.fromEntries(
          properties.map((property) => [property, getNumericPath(current, property)]),
        ),
        velocityPerSecond: Object.fromEntries(
          properties.map((property) => [
            property,
            ((getNumericPath(after, property) - getNumericPath(before, property)) * fps) / interval,
          ]),
        ),
      });
    }
  }
  return {
    revision: snapshot.revision,
    sceneId: request.sceneId,
    nodeId: node.id,
    name: node.name,
    frame: request.frame,
    fps,
    channels: node.animations
      .filter((a) => !request.properties || request.properties.includes(a.property))
      .map((channel) => ({
        ...channel,
        keys: channel.keys.slice(request.offset, request.offset + request.limit),
        keyCount: channel.keys.length,
        offset: request.offset,
        truncated: request.offset + request.limit < channel.keys.length,
      })),
    sampleSource: driverSamples
      ? 'keys-and-drivers'
      : node.animationLayers?.length
        ? 'keys-and-layers'
        : 'keys',
    samples:
      driverSamples ??
      sampleAnimation(
        node,
        request.frames.length ? request.frames : [request.frame],
        fps,
        request.properties,
      ),
  };
}
