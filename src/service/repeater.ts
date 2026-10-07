import { contextFramesSchema } from '../core/content-time-schema.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { newNode, VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { repeaterOptionsSchema, repeaterParameters } from '../core/repeater-schema.js';
import { repeatGraph } from '../sdk/repeater.js';
import { topLevel, descendants } from '../core/structure.js';
import { inverse, multiply, transform } from '../core/interaction.js';
import { indexGraph } from '../core/graph.js';
import { applyOperations } from './operations.js';
import { compositionStructure } from './structure.js';
import type { Renderer } from '../core/renderer.js';

export const repeatCreateSchema = z
  .object({
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeIds: z.array(z.string()).min(1).max(1000),
    parameters: repeaterOptionsSchema.partial().default({}),
    hideSources: z.boolean().default(false),
    name: z.string().default('重复器'),
    id: z.string().min(1).max(100).optional(),
    revision: z.string().optional(),
  })
  .strict();
export async function createRepeater(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = repeatCreateSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before repeater creation');
  const scope = await renderer.inspectComposition(
    snapshot,
    request.sceneId,
    request.frame,
    request.path,
    request.contextFrames,
  );
  if (new Set(request.nodeIds).size !== request.nodeIds.length)
    throw new VmotionError('REPEATER_SOURCE', 'Source IDs must be distinct');
  if (request.nodeIds.some((id) => !scope.scene.nodes.some((n) => n.id === id)))
    throw new VmotionError('NOT_FOUND', 'Source layer is outside the current composition');
  const roots = topLevel(scope.scene.nodes, request.nodeIds),
    parent = roots[0].parentId;
  if (roots.some((node) => node.parentId !== parent))
    throw new VmotionError('REPEATER_PARENT', 'Repeater sources must have the same parent');
  const included = descendants(
    scope.scene.nodes,
    roots.map((n) => n.id),
  );
  if (included.size > 2000)
    throw new VmotionError('REPEATER_LIMIT', 'A repeater source may contain up to 2000 nodes');
  const graph = await renderer.inspectInteractions(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      { includeEmpty: true, includeInactive: true, contextFrames: request.contextFrames },
    ),
    rootLayer = graph.layers.find((l) => l.node.id === roots[0].id),
    parentInverse = rootLayer && inverse(rootLayer.parentMatrix);
  if (!parentInverse)
    throw new VmotionError('REPEATER_TRANSFORM', 'Source parent has no invertible transform');
  const points = roots.flatMap((node) => {
    const layer = graph.layers.find((l) => l.node.id === node.id);
    if (!layer) return [];
    const b = layer.bounds,
      m = multiply(parentInverse, layer.matrix);
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ].map((p) => transform(m, p));
  });
  if (!points.length || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    throw new VmotionError('REPEATER_BOUNDS', 'Source geometry has no finite bounds');
  const left = Math.min(...points.map((p) => p.x)),
    top = Math.min(...points.map((p) => p.y)),
    width = Math.max(...points.map((p) => p.x)) - left,
    height = Math.max(...points.map((p) => p.y)) - top;
  const prefix = scope.componentPrefix ? scope.componentPrefix + '/' : '',
    local = (id: string) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id),
    selectedRoots = new Set(roots.map((n) => n.id));
  const source = scope.scene.nodes
    .filter((n) => included.has(n.id))
    .map((raw) => {
      if (raw.maskId && !included.has(raw.maskId))
        throw new VmotionError(
          'REPEATER_MASK',
          'Include the external mask layer in the source selection',
        );
      const node = structuredClone(raw);
      node.id = local(raw.id);
      node.maskId = raw.maskId ? local(raw.maskId) : undefined;
      node.parentId = raw.parentId && included.has(raw.parentId) ? local(raw.parentId) : undefined;
      if (selectedRoots.has(raw.id)) {
        node.x -= left;
        node.y -= top;
        for (const channel of node.animations)
          if (channel.property === 'x' || channel.property === 'y')
            for (const key of channel.keys) key.value -= channel.property === 'x' ? left : top;
      }
      return node;
    });
  indexGraph(source);
  const parameters = repeaterOptionsSchema.parse({
    count: Math.max(
      1,
      Math.min(6, Math.floor((scope.width - left + 24) / Math.max(1, width + 24))),
    ),
    position: { x: width + 24, y: 0 },
    gap: { x: width + 24, y: height + 24 },
    pivot: { x: width / 2, y: height / 2 },
    radius: Math.max(32, Math.max(width, height)),
    ...request.parameters,
  });
  // Validate expansion and transform ranges before creating any files/history.
  const generated = repeatGraph('copies', source, parameters);
  const id = request.id ?? randomUUID(),
    file = `components/repeater-${id.replace(/[^\w-]/g, '_')}.ts`;
  if (snapshot.files[file] !== undefined)
    throw new VmotionError('REPEATER_FILE', 'Repeater source file already exists');
  const provenance = {
    sceneId: request.sceneId,
    path: request.path,
    nodeIds: roots.map((n) => n.id),
    frame: request.frame,
    revision: snapshot.revision,
  };
  const maxCopies = Math.min(512, Math.floor(19999 / (source.length + 1)));
  const content = `import {defineComponent,repeatGraph,repeaterParameters,type Node} from '@vmotion/sdk';\n\n// Source graph copied from ${JSON.stringify(provenance)}\n// Source layers/code are retained. Edit this graph or use per-copy overrides.\nconst source: Node[] = ${JSON.stringify(source, null, 2)};\n\nexport default defineComponent({\n  name: ${JSON.stringify(request.name)},\n  parameters: {...repeaterParameters,count:{...repeaterParameters.count,max:${maxCopies}}},\n  render(_ctx, params) { return repeatGraph('copies', source, params); }\n});\n`;
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new VmotionError('REPEATER_LIMIT', 'Source module exceeds 8 MB');
  const operations: Operation[] = [{ type: 'writeSource', path: file, content }],
    candidate = applyOperations(root, snapshot, operations);
  const edit = await compositionStructure(
    renderer,
    candidate,
    request.sceneId,
    request.frame,
    request.path,
    {
      type: 'add',
      node: newNode({
        id,
        type: 'component',
        name: request.name,
        component: file,
        parentId: parent ? local(parent) : undefined,
        x: left,
        y: top,
        width: scope.width,
        height: scope.height,
        params: parameters,
      }),
    },
    request.contextFrames,
  );
  operations.push(...edit.operations);
  return {
    request,
    operations,
    selection: edit.selection,
    sourceFile: file,
    parameters,
    sourceIds: roots.map((n) => n.id),
    sourceNodes: source.length,
    generatedNodes: generated.length,
    parameterDefinitions: repeaterParameters,
  };
}
