import { contextFramesSchema } from '../core/content-time-schema.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  newNode,
  sceneSchema,
  VmotionError,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { topLevel, descendants } from '../core/structure.js';
import { indexGraph } from '../core/graph.js';
import { declaredSceneLinks } from '../core/scene-links.js';
import { compositionStructure } from './structure.js';
import { applyOperations } from './operations.js';
import type { Renderer } from '../core/renderer.js';
export const precomposeSchema = z
  .object({
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeIds: z.array(z.string()).min(1).max(1000),
    name: z.string().min(1).max(200).default('共享场景'),
    sourceId: z
      .string()
      .regex(/^[\w-]{1,100}$/)
      .optional(),
    id: z.string().min(1).max(100).optional(),
    allowReorder: z.boolean().default(false),
    revision: z.string().optional(),
  })
  .strict();
export const scenePlaceSchema = z
  .object({
    sceneId: z.string(),
    sourceId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    name: z.string().optional(),
    id: z.string().min(1).max(100).optional(),
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    width: z.number().finite().min(0).optional(),
    height: z.number().finite().min(0).optional(),
    revision: z.string().optional(),
  })
  .strict();
export const sceneResetSchema = z
  .object({
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    revision: z.string().optional(),
  })
  .strict();
export async function resetSceneInstance(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = sceneResetSchema.parse(raw),
    scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    node = scope.scene.nodes.find((n) => n.id === request.nodeId),
    target = scope.targets[request.nodeId];
  if (!node || node.type !== 'scene' || !target)
    throw new VmotionError('SCENE_REFERENCE', 'Select a shared scene reference');
  const scene = snapshot.scenes.find((s) => s.id === request.sceneId)!,
    root = structuredClone(
      scene.nodes.find(
        (n) => n.id === (target.kind === 'node' ? target.nodeId : target.rootNodeId),
      )!,
    );
  if (target.kind === 'node') {
    root.overrides = {};
    delete root.structure;
  } else {
    const prefix = target.relativeId + '/';
    root.overrides = Object.fromEntries(
      Object.entries(root.overrides).filter(([id]) => !id.startsWith(prefix)),
    );
    if (root.structure) {
      root.structure.nested = Object.fromEntries(
        Object.entries(root.structure.nested).filter(
          ([id]) => id !== target.relativeId && !id.startsWith(prefix),
        ),
      );
    }
  }
  return {
    request,
    operation: {
      type: 'updateNode',
      sceneId: request.sceneId,
      nodeId: root.id,
      patch: { ...root, structure: root.structure },
    } as Operation,
  };
}
export async function precompose(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = precomposeSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before precomposition');
  const scope = await renderer.inspectComposition(
    snapshot,
    request.sceneId,
    request.frame,
    request.path,
    request.contextFrames,
  );
  if (new Set(request.nodeIds).size !== request.nodeIds.length)
    throw new VmotionError('PRECOMPOSE_SOURCE', 'Select distinct layer IDs');
  if (request.nodeIds.some((id) => !scope.scene.nodes.some((n) => n.id === id)))
    throw new VmotionError('NOT_FOUND', 'Layer is outside the current composition');
  const roots = topLevel(scope.scene.nodes, request.nodeIds),
    parent = roots[0].parentId,
    selected = new Set(roots.map((n) => n.id)),
    included = descendants(scope.scene.nodes, [...selected]);
  if (roots.some((n) => n.parentId !== parent))
    throw new VmotionError('PRECOMPOSE_PARENT', 'Precompose layers with a shared parent');
  if (scope.scene.nodes.some((n) => !included.has(n.id) && n.maskId && included.has(n.maskId)))
    throw new VmotionError(
      'PRECOMPOSE_MASK',
      'Selected layers are used as masks outside the selection',
    );
  const siblings = scope.scene.nodes.filter((n) => n.parentId === parent),
    positions = siblings.flatMap((n, i) => (selected.has(n.id) ? [i] : [])),
    reorder = Math.max(...positions) - Math.min(...positions) + 1 !== positions.length;
  if (reorder && !request.allowReorder)
    throw new VmotionError(
      'PRECOMPOSE_ORDER',
      'Selection crosses unselected sibling layers; group adjacent layers or set allowReorder explicitly',
    );
  const local = (id: string) =>
    scope.componentPrefix ? id.slice(scope.componentPrefix.length + 1) : id;
  const nodes = scope.scene.nodes
    .filter((n) => included.has(n.id))
    .map((raw) => {
      if (raw.maskId && !included.has(raw.maskId))
        throw new VmotionError('PRECOMPOSE_MASK', 'Include the external mask in the selection');
      const node = structuredClone(raw);
      node.id = local(raw.id);
      node.parentId = raw.parentId && included.has(raw.parentId) ? local(raw.parentId) : undefined;
      node.maskId = raw.maskId ? local(raw.maskId) : undefined;
      return node;
    });
  indexGraph(nodes);
  const sourceId = request.sourceId ?? `scene-${randomUUID()}`;
  if (
    snapshot.scenes.some((s) => s.id === sourceId) ||
    snapshot.files[`scenes/${sourceId}.json`] !== undefined
  )
    throw new VmotionError('DUPLICATE_ID', 'Shared scene ID or source filename already exists');
  const scene = sceneSchema.parse({
      id: sourceId,
      name: request.name,
      width: scope.width,
      height: scope.height,
      duration: scope.scene.duration,
      background: 'transparent',
      nodes,
    }),
    operations: Operation[] = [{ type: 'addScene', scene }],
    candidate = applyOperations(root, snapshot, operations),
    edit = await compositionStructure(
      renderer,
      candidate,
      request.sceneId,
      request.frame,
      request.path,
      {
        type: 'replace',
        ids: [...selected],
        node: newNode({
          id: request.id ?? randomUUID(),
          type: 'scene',
          name: request.name,
          sceneId: sourceId,
          width: scope.width,
          height: scope.height,
        }),
      },
      request.contextFrames,
    );
  operations.push(...edit.operations);
  return {
    request,
    operations,
    selection: edit.selection,
    sourceId,
    sourceFile: `scenes/${sourceId}.json`,
    captureMode: scope.scope.ownerNodeId ? 'generated-graph' : 'native-graph',
    reordered: reorder,
    warnings: scope.scope.ownerNodeId
      ? [
          'Generated leaf geometry/content is captured at this frame. Native keyframes and nested component/source references remain editable; outer TypeScript code is preserved.',
        ]
      : [],
  };
}
export async function placeScene(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = scenePlaceSchema.parse(raw),
    source = snapshot.scenes.find((s) => s.id === request.sourceId);
  if (!source) throw new VmotionError('MISSING_SCENE', 'Source scene not found');
  const edit = await compositionStructure(
    renderer,
    snapshot,
    request.sceneId,
    request.frame,
    request.path,
    {
      type: 'add',
      node: newNode({
        id: request.id ?? randomUUID(),
        type: 'scene',
        name: request.name ?? source.name,
        sceneId: source.id,
        x: request.x,
        y: request.y,
        width: request.width ?? source.width ?? snapshot.project.width,
        height: request.height ?? source.height ?? snapshot.project.height,
      }),
    },
    request.contextFrames,
  );
  return { ...edit, request };
}
export function inspectSceneReferences(snapshot: Snapshot, sourceId: string) {
  const scene = snapshot.scenes.find((s) => s.id === sourceId);
  if (!scene) throw new VmotionError('NOT_FOUND', 'Source scene not found');
  const links = declaredSceneLinks(snapshot),
    incoming = links.filter((link) => link.sceneId === sourceId),
    outgoing = links.filter((link) => link.sourceSceneId === sourceId);
  return {
    revision: snapshot.revision,
    scene: {
      id: scene.id,
      name: scene.name,
      duration: scene.duration,
      width: scene.width ?? snapshot.project.width,
      height: scene.height ?? snapshot.project.height,
      nodes: scene.nodes.length,
    },
    incoming,
    outgoing,
    limitations: [
      'Declared JSON links are listed. TypeScript can generate additional scene references; inspect actual sampled frames for those dynamic references.',
    ],
  };
}
