import { z } from 'zod';
import {
  VmotionError,
  nodeSchema,
  type Node,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { parentDelta, type CompositionDraft, type InteractionLayer } from '../core/interaction.js';
import { auditGeometry } from '../core/visual-audit.js';
import { evaluateNode } from '../core/time.js';
import { contextFramesSchema } from '../core/content-time.js';
import type { Renderer } from '../core/renderer.js';
import { applyOperations } from './operations.js';
import { visualAudit } from './visual-audit.js';

const finite = z.number().finite();
export const visualRepairSchema = z
  .object({
    sceneId: z.string(),
    revision: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: finite.nonnegative().default(0),
    frames: z.array(finite.nonnegative()).min(1).max(12).optional(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({
            nodeId: z.string(),
            mode: z.enum(['allKeys', 'currentKey']).default('allKeys'),
            actions: z
              .array(
                z.discriminatedUnion('type', [
                  z
                    .object({
                      type: z.literal('fitText'),
                      padding: finite.min(0).max(1000).default(2),
                      growOnly: z.boolean().default(true),
                      maxHeight: finite.positive().optional(),
                    })
                    .strict(),
                  z
                    .object({
                      type: z.literal('move'),
                      delta: z.object({ x: finite, y: finite }).strict(),
                      space: z.enum(['canvas', 'parent']).default('canvas'),
                    })
                    .strict(),
                  z
                    .object({
                      type: z.literal('insideCanvas'),
                      padding: finite.min(0).max(1000).default(16),
                    })
                    .strict(),
                ]),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

function numberPatch(
  node: Node,
  frame: number,
  values: Partial<Pick<Node, 'x' | 'y' | 'height'>>,
  mode: 'allKeys' | 'currentKey',
) {
  const evaluated = evaluateNode(node, frame),
    animations = structuredClone(node.animations),
    patch: Partial<Node> = {};
  let keyed = false;
  for (const [name, value] of Object.entries(values) as Array<['x' | 'y' | 'height', number]>) {
    if (value === evaluated[name]) continue;
    const channel = animations.find((channel) => channel.property === name),
      offset = value - evaluated[name];
    patch[name] = mode === 'allKeys' ? node[name] + offset : value;
    if (!channel) continue;
    keyed = true;
    if (mode === 'allKeys') for (const key of channel.keys) key.value += offset;
    else {
      const at = Math.round(frame),
        existing = channel.keys.find((key) => key.frame === at);
      channel.keys = channel.keys.filter((key) => key.frame !== at);
      channel.keys.push({ ...existing, frame: at, value, easing: existing?.easing ?? 'linear' });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
  }
  if (keyed) patch.animations = animations;
  nodeSchema.parse({ ...node, ...patch });
  return patch;
}
type ApplyDraft = (snapshot: Snapshot, edits: CompositionDraft[]) => Promise<Operation[]>;
/** Explicit layout intents, native measurements and exact candidate snapshots; no model calls. */
export async function planVisualRepair(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  applyDraft: ApplyDraft,
) {
  const request = visualRepairSchema.parse(raw);
  if (request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'The inspected project changed; audit again', {
      expected: request.revision,
      actual: snapshot.revision,
    });
  const scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    frames = [
      ...new Set(
        request.frames ?? [
          0,
          request.frame,
          Math.min(scope.scene.duration - 1, request.frame + 1),
          scope.scene.duration - 1,
        ],
      ),
    ].sort((a, b) => a - b);
  if (
    request.frame >= scope.scene.duration ||
    frames.some((frame) => frame >= scope.scene.duration)
  )
    throw new VmotionError(
      'FRAME_RANGE',
      'Repair and evidence frames must be within the composition',
    );
  const ids = request.targets.map((target) => target.nodeId);
  if (new Set(ids).size !== ids.length)
    throw new VmotionError('VISUAL_REPAIR_TARGET', 'Use one ordered action list per layer');
  const auditRequest = {
    sceneId: request.sceneId,
    path: request.path,
    contextFrames: request.contextFrames,
    frames,
    images: false,
  };
  const before = await visualAudit(root, snapshot, auditRequest),
    changes = [];
  let candidate = structuredClone(snapshot);
  const graphAt = (value: Snapshot, frame: number) =>
    renderer.inspectInteractions(value, request.sceneId, frame, request.path, {
      contextFrames: request.contextFrames,
      includeEmpty: true,
      includeInactive: true,
    });
  for (const target of request.targets)
    for (const action of target.actions) {
      const graph = await graphAt(candidate, request.frame),
        layer = graph.layers.find((layer) => layer.node.id === target.nodeId);
      if (!layer)
        throw new VmotionError('NOT_FOUND', 'Repair layer not found', { nodeId: target.nodeId });
      const localFrame = layer.frame ?? request.frame,
        evaluated = evaluateNode(layer.node, localFrame);
      let values: Partial<Pick<Node, 'x' | 'y' | 'height'>> = {};
      if (action.type === 'fitText') {
        if (layer.node.type !== 'text')
          throw new VmotionError('VISUAL_REPAIR_TEXT', 'fitText requires a text layer', {
            nodeId: target.nodeId,
          });
        let delta =
          (layer.textLayout?.requiredHeight ?? evaluated.height) +
          action.padding -
          evaluated.height;
        if (target.mode === 'allKeys')
          for (const frame of frames) {
            const sample = (await graphAt(candidate, frame)).layers.find(
              (layer) => layer.node.id === target.nodeId,
            );
            if (sample?.textLayout?.requiredHeight !== undefined) {
              const sampled = evaluateNode(sample.node, sample.frame ?? frame);
              delta = Math.max(
                delta,
                sample.textLayout.requiredHeight + action.padding - sampled.height,
              );
            }
          }
        if (action.growOnly) delta = Math.max(0, delta);
        values.height = evaluated.height + delta;
        if (action.maxHeight !== undefined && values.height > action.maxHeight)
          throw new VmotionError(
            'VISUAL_REPAIR_FIT',
            'Text requires more than maxHeight; choose width/font size explicitly',
            { nodeId: target.nodeId, requiredHeight: values.height, maxHeight: action.maxHeight },
          );
      } else {
        let delta: { x: number; y: number };
        if (action.type === 'move') delta = action.delta;
        else {
          const bounds = auditGeometry([layer], scope.width, scope.height)[0].bounds,
            right = scope.width - action.padding,
            bottom = scope.height - action.padding;
          if (
            bounds.width > scope.width - 2 * action.padding ||
            bounds.height > scope.height - 2 * action.padding
          )
            throw new VmotionError(
              'VISUAL_REPAIR_FIT',
              'The layer is larger than the padded canvas; resize explicitly',
              { nodeId: target.nodeId, bounds },
            );
          delta = {
            x:
              Math.min(0, right - bounds.x - bounds.width) + Math.max(0, action.padding - bounds.x),
            y:
              Math.min(0, bottom - bounds.y - bounds.height) +
              Math.max(0, action.padding - bounds.y),
          };
        }
        const parent =
          action.type === 'move' && action.space === 'parent' ? delta : parentDelta(layer, delta);
        if (!parent)
          throw new VmotionError(
            'VISUAL_REPAIR_TRANSFORM',
            'Cannot move through a singular parent transform',
            { nodeId: target.nodeId },
          );
        values = { x: evaluated.x + parent.x, y: evaluated.y + parent.y };
      }
      const patch = numberPatch(layer.node, localFrame, values, target.mode);
      if (!Object.keys(patch).length) continue;
      candidate = applyOperations(
        root,
        candidate,
        await applyDraft(candidate, [
          {
            nodeId: layer.node.id,
            path: layer.path,
            contextFrames: layer.contextFrames,
            frame: localFrame,
            patch,
          },
        ]),
      );
      changes.push({
        nodeId: layer.node.id,
        path: layer.path,
        contextFrames: layer.contextFrames,
        localFrame,
        action: action.type,
        mode: target.mode,
        before: { x: evaluated.x, y: evaluated.y, height: evaluated.height },
        values,
        uncertainty: layer.uncertainty ?? [],
      });
    }
  const scene = candidate.scenes.find((scene) => scene.id === request.sceneId)!,
    operations: Operation[] = changes.length
      ? [{ type: 'updateScene', sceneId: scene.id, patch: { nodes: scene.nodes } }]
      : [],
    after = await visualAudit(root, candidate, auditRequest);
  return {
    request,
    candidate,
    operations,
    changes,
    before,
    after,
    samples: frames.map((frame) => ({
      sceneId: request.sceneId,
      path: request.path,
      contextFrames: request.contextFrames,
      frame,
    })),
    limitations: [
      'Only the selected evidence frames are checked.',
      'Geometry bounds do not prove pixel visibility through masks or effects.',
      'Reviews about overlap, clipping and motion require explicit artistic decisions.',
    ],
  };
}
