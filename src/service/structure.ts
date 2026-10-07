import {
  newNode,
  nodeBaseSchema,
  nodeSchema,
  structureSchema,
  VmotionError,
  type Node,
  type Operation,
  type Snapshot,
} from '../core/model.js';
import { editStructure, structureActionSchema, type StructureAction } from '../core/structure.js';
import { indexGraph } from '../core/graph.js';
import type { Renderer } from '../core/renderer.js';

export async function compositionStructure(
  renderer: Renderer,
  snapshot: Snapshot,
  sceneId: string,
  frame: number,
  path: string[],
  input: StructureAction,
  contextFrames: number[] = [],
) {
  const action = structureActionSchema.parse(input),
    scope = await renderer.inspectComposition(snapshot, sceneId, frame, path, contextFrames),
    edited = editStructure(
      scope.scene.nodes,
      action,
      scope.width,
      scope.height,
      scope.componentPrefix,
    );
  indexGraph(edited.nodes);
  for (const node of edited.nodes) {
    if (
      node.type === 'scene' &&
      (!node.sceneId || !snapshot.scenes.some((s) => s.id === node.sceneId))
    )
      throw new VmotionError('MISSING_SCENE', `Source scene not found: ${node.sceneId ?? node.id}`);
    if (
      node.type === 'component' &&
      (!node.component || snapshot.files[node.component] === undefined)
    )
      throw new VmotionError('MISSING_COMPONENT', `组件源码不存在：${node.component ?? node.id}`);
    if (node.assetId) {
      const asset = snapshot.project.assets.find((a) => a.id === node.assetId);
      if (!asset) throw new VmotionError('MISSING_ASSET', `素材不存在：${node.assetId}`);
      if (['image', 'video', 'drawing'].includes(node.type) && asset.type !== node.type)
        throw new VmotionError('ASSET_TYPE', `素材 ${asset.name} 应使用 ${asset.type} 图层`);
    }
  }
  const scene = snapshot.scenes.find((s) => s.id === sceneId)!;
  const operations: Operation[] = [];
  if (!scope.scope.ownerNodeId) {
    const before = new Set(scope.scene.nodes.map((n) => n.id)),
      after = new Map(edited.nodes.map((n) => [n.id, n]));
    const additions = edited.nodes
      .filter((n) => !before.has(n.id))
      .map((n) => ({ ...n, parentId: n.parentId ?? scope.scope.parentId }));
    const nodes = scene.nodes
      .filter((n) => !before.has(n.id) || after.has(n.id))
      .map((n) =>
        before.has(n.id)
          ? nodeSchema.parse({
              ...after.get(n.id)!,
              parentId: after.get(n.id)!.parentId ?? scope.scope.parentId,
            })
          : n,
      );
    // Apply the edited order at the old scope's first slot while retaining outside content.
    const scopeNodes = [...nodes.filter((n) => before.has(n.id)), ...additions],
      byId = new Map(scopeNodes.map((n) => [n.id, n]));
    const ordered = edited.nodes.map((n) => byId.get(n.id)!),
      outside = nodes.filter((n) => !before.has(n.id)),
      slot = scene.nodes
        .slice(
          0,
          Math.max(
            0,
            scene.nodes.findIndex((n) => before.has(n.id)),
          ),
        )
        .filter((n) => !before.has(n.id)).length;
    outside.splice(before.size ? slot : outside.length, 0, ...ordered);
    indexGraph(outside);
    operations.push({ type: 'updateScene', sceneId, patch: { nodes: outside } });
  } else {
    const owner = scene.nodes.find((n) => n.id === scope.scope.ownerNodeId);
    if (!owner) throw new VmotionError('NOT_FOUND', 'Source component not found');
    const structure = structureSchema.parse(owner.structure ?? {}),
      componentPath = scope.scope.componentPath ?? '',
      active = componentPath
        ? structureSchema.parse(structure.nested[componentPath] ?? {})
        : structure,
      relative = (id: string) => {
        const prefix = scope.componentPrefix + '/';
        if (!id.startsWith(prefix))
          throw new VmotionError('STRUCTURE_SCOPE', 'Layer ID leaves the component scope');
        return id.slice(prefix.length);
      },
      before = new Map(scope.scene.nodes.map((n) => [n.id, n])),
      after = new Set(edited.nodes.map((n) => n.id));
    const lastComponent = scope.breadcrumbs
        .map((n) => n.type === 'component' || n.type === 'scene')
        .lastIndexOf(true),
      base = await renderer.inspectComposition(
        snapshot,
        sceneId,
        frame,
        path.slice(0, lastComponent + 1),
        contextFrames.slice(0, lastComponent + 1),
      );
    for (const old of before.values())
      if (!after.has(old.id) && !active.removed.includes(relative(old.id)))
        active.removed.push(relative(old.id));
    for (const node of edited.nodes) {
      const parent = node.parentId ? relative(node.parentId) : scope.scope.parentId;
      if (before.has(node.id)) {
        if (node.parentId !== before.get(node.id)!.parentId)
          active.parents[relative(node.id)] = parent ?? null;
      } else {
        const local = {
          ...node,
          id: relative(node.id),
          parentId: parent,
          maskId: node.maskId ? relative(node.maskId) : undefined,
        };
        const { structure: own, ...plain } = local;
        active.added.push(nodeBaseSchema.parse(plain));
        if (own) {
          const { nested, ...baseEdit } = own,
            key = [componentPath, local.id].filter(Boolean).join('/');
          structure.nested[key] = baseEdit;
          for (const [sub, value] of Object.entries(nested))
            structure.nested[`${key}/${sub}`] = value;
        }
      }
    }
    const beforeIds = new Set(before.keys()),
      oldOrder = base.scene.nodes.map((n) => n.id),
      first = oldOrder.findIndex((id) => beforeIds.has(id)),
      remaining = oldOrder.filter((id) => !beforeIds.has(id)),
      slot =
        first < 0
          ? remaining.length
          : oldOrder.slice(0, first).filter((id) => !beforeIds.has(id)).length;
    remaining.splice(slot, 0, ...edited.nodes.map((n) => n.id));
    active.order = remaining.map(relative);
    if (componentPath) {
      const { nested, ...edit } = active;
      structure.nested[componentPath] = edit;
    }
    operations.push({ type: 'updateNode', sceneId, nodeId: owner.id, patch: { structure } });
  }
  return { operations, selection: edited.selection };
}
