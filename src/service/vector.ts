import { contextFramesSchema } from '../core/content-time-schema.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { newNode, VmotionError, type Snapshot } from '../core/model.js';
import { pathOperationSchema } from '../core/vector-schema.js';
import { shapePath, pathGeometry, outlineNativePath } from '../core/vector.js';
import { nodeMatrix } from '../core/interaction.js';
import { evaluateNode } from '../core/time.js';
import type { Renderer } from '../core/renderer.js';

export const vectorBakeSchema = z
  .object({
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeIds: z.array(z.string()).min(1).max(32),
    operation: z.enum([...pathOperationSchema.options, 'simplify', 'round', 'outline']),
    radius: z.number().finite().min(0).max(1e6).default(12),
    hideSources: z.boolean().default(false),
    id: z.string().min(1).max(200).optional(),
    name: z.string().optional(),
    revision: z.string().optional(),
  })
  .strict();
export async function bakeVector(
  renderer: Renderer,
  snapshot: Snapshot,
  raw: z.input<typeof vectorBakeSchema>,
) {
  const request = vectorBakeSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before path baking');
  const scope = await renderer.inspectComposition(
    snapshot,
    request.sceneId,
    request.frame,
    request.path,
    request.contextFrames,
  );
  const nodes = request.nodeIds.map((id) => {
    const node = scope.scene.nodes.find((n) => n.id === id);
    if (!node)
      throw new VmotionError('NOT_FOUND', `Path operand ${id} is outside this composition`);
    if (!['rect', 'ellipse', 'path'].includes(node.type))
      throw new VmotionError('VECTOR_TYPE', 'Only rect, ellipse and path layers can be baked');
    return evaluateNode(node, request.frame);
  });
  if (new Set(request.nodeIds).size !== nodes.length)
    throw new VmotionError('VECTOR_OPERANDS', 'Path operands must be distinct');
  if (nodes.some((n) => n.parentId !== nodes[0].parentId))
    throw new VmotionError(
      'VECTOR_PARENT',
      'Enter the shared parent composition before baking paths',
    );
  const unary = ['outline', 'round', 'simplify'].includes(request.operation);
  if (unary ? nodes.length !== 1 : nodes.length < 2)
    throw new VmotionError(
      'VECTOR_OPERANDS',
      unary ? 'Select exactly one vector layer' : 'Select at least two vector layers',
    );
  const outline = request.operation === 'outline';
  const paths = nodes.map((node) => {
    let shape = shapePath(node);
    if (outline) {
      if (!node.strokeWidth || !node.stroke)
        throw new VmotionError('VECTOR_STROKE', 'The source layer needs a visible stroke');
      if (node.strokeDash.length)
        throw new VmotionError(
          'VECTOR_DASH_OUTLINE',
          'Dashed strokes remain editable; solid strokes can be outlined',
        );
      shape = outlineNativePath(shape, {
        width: node.strokeWidth,
        cap: node.strokeCap,
        join: node.strokeJoin,
        miterLimit: node.strokeMiterLimit,
      });
    }
    const [a, b, c, d, e, f] = nodeMatrix(node);
    shape.transform({ a, b, c, d, e, f });
    return { path: shape.toSVGString(), fillRule: outline ? ('nonzero' as const) : node.fillRule };
  });
  const geometry = pathGeometry({
    paths,
    operation: outline ? 'inspect' : request.operation,
    radius: request.radius,
  });
  const parentId = nodes[0].parentId,
    localParent =
      parentId && scope.componentPrefix
        ? parentId.slice(scope.componentPrefix.length + 1)
        : parentId;
  const node = newNode({
    id: request.id ?? randomUUID(),
    type: 'path',
    name: request.name ?? `${request.operation} · ${request.frame}f 路径快照`,
    parentId: localParent,
    path: geometry.path,
    fillRule: geometry.fillRule,
    fill: outline ? nodes[0].stroke : nodes[0].fill,
    opacity: nodes[0].opacity,
    width: geometry.bounds.width,
    height: geometry.bounds.height,
  });
  return {
    request,
    node,
    geometry,
    warnings: [
      'This is a static geometry snapshot at the requested frame. Original layers and source code are preserved.',
      'The new path uses the first operand solid fill/opacity; gradients, masks, effects and source animation are not baked.',
    ],
  };
}
