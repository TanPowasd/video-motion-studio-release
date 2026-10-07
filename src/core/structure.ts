import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { newNode, nodeSchema, VmotionError, type Node } from './model.js';

const ids = z.array(z.string().min(1)).min(1).max(1000);
export const structureActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), node: nodeSchema }),
  z.object({ type: z.literal('delete'), ids }),
  z.object({ type: z.literal('replace'), ids, node: nodeSchema }),
  z.object({
    type: z.literal('duplicate'),
    ids,
    offset: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 24, y: 24 }),
  }),
  z.object({
    type: z.literal('group'),
    ids,
    id: z.string().optional(),
    name: z.string().default('图层组'),
  }),
  z.object({ type: z.literal('ungroup'), ids }),
  z.object({ type: z.literal('order'), ids, direction: z.enum(['front', 'back', 'up', 'down']) }),
]);
export type StructureAction = z.infer<typeof structureActionSchema>;
export function descendants(nodes: Node[], ids: string[]) {
  const result = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes)
      if (n.parentId && result.has(n.parentId) && !result.has(n.id)) {
        result.add(n.id);
        changed = true;
      }
  }
  return result;
}
export function topLevel(nodes: Node[], ids: string[]) {
  const selected = new Set(ids),
    byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((n) => {
    if (!selected.has(n.id)) return false;
    let parent = n.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (selected.has(parent)) return false;
      visited.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
}
export function editStructure(
  input: Node[],
  action: StructureAction,
  width: number,
  height: number,
  prefix = '',
) {
  let nodes = structuredClone(input);
  const fullId = (id: string) => (prefix ? `${prefix}/${id}` : id);
  let selection: string[] = [];
  if (action.type === 'add') {
    const node = nodeSchema.parse({ ...action.node, id: fullId(action.node.id) });
    if (nodes.some((n) => n.id === node.id))
      throw new VmotionError('DUPLICATE_ID', '图层 ID 已存在');
    nodes.push(node);
    return { nodes, selection: [node.id] };
  }
  const selected = topLevel(nodes, action.ids);
  if (action.ids.some((id) => !nodes.some((n) => n.id === id)))
    throw new VmotionError('NOT_FOUND', '选中的图层已不存在，请刷新合成');
  selection = selected.map((n) => n.id);
  if (action.type === 'replace') {
    const parent = selected[0]?.parentId;
    if (selected.some((n) => n.parentId !== parent))
      throw new VmotionError('REPLACE_PARENT', 'Replacement sources must share a parent');
    const removed = descendants(nodes, selection);
    if (nodes.some((n) => !removed.has(n.id) && n.maskId && removed.has(n.maskId)))
      throw new VmotionError(
        'REPLACE_MASK',
        'Selected content is used as an external mask; include its dependent layers',
      );
    const node = nodeSchema.parse({ ...action.node, id: fullId(action.node.id), parentId: parent });
    if (nodes.some((n) => n.id === node.id))
      throw new VmotionError('DUPLICATE_ID', 'Replacement ID already exists');
    const last = Math.max(...selected.map((n) => nodes.findIndex((v) => v.id === n.id))),
      slot = nodes.slice(0, last + 1).filter((n) => !removed.has(n.id)).length;
    nodes = nodes.filter((n) => !removed.has(n.id));
    nodes.splice(slot, 0, node);
    selection = [node.id];
  } else if (action.type === 'delete') {
    const removed = descendants(nodes, selection);
    nodes = nodes
      .filter((n) => !removed.has(n.id))
      .map((n) => ({ ...n, maskId: n.maskId && removed.has(n.maskId) ? undefined : n.maskId }));
    selection = [];
  } else if (action.type === 'duplicate') {
    const copying = descendants(nodes, selection),
      map = new Map(
        nodes.filter((n) => copying.has(n.id)).map((n) => [n.id, fullId(randomUUID())]),
      );
    const clones = nodes
      .filter((n) => copying.has(n.id))
      .map((n) => {
        const clone = structuredClone(n);
        clone.id = map.get(n.id)!;
        clone.name = `${n.name} 副本`;
        if (n.parentId && map.has(n.parentId)) clone.parentId = map.get(n.parentId);
        if (n.maskId && map.has(n.maskId)) clone.maskId = map.get(n.maskId);
        if (selection.includes(n.id)) {
          clone.x += action.offset.x;
          clone.y += action.offset.y;
          for (const channel of clone.animations)
            if (channel.property === 'x' || channel.property === 'y')
              for (const key of channel.keys)
                key.value += channel.property === 'x' ? action.offset.x : action.offset.y;
        }
        return clone;
      });
    nodes.push(...clones);
    selection = selection.map((id) => map.get(id)!);
  } else if (action.type === 'group') {
    const parent = selected[0]?.parentId;
    if (selected.some((n) => n.parentId !== parent))
      throw new VmotionError('GROUP_PARENT', '编组需要同一父级的图层；请进入对应合成后选择图层');
    const id = fullId(action.id ?? randomUUID());
    if (nodes.some((n) => n.id === id)) throw new VmotionError('DUPLICATE_ID', '图层组 ID 已存在');
    const group = newNode({
      id,
      type: 'group',
      name: action.name,
      parentId: parent,
      width,
      height,
    });
    const index = Math.max(...selected.map((n) => nodes.findIndex((v) => v.id === n.id)));
    nodes = nodes.map((n) => (selection.includes(n.id) ? { ...n, parentId: id } : n));
    nodes.splice(index + 1, 0, group);
    selection = [id];
  } else if (action.type === 'ungroup') {
    for (const group of selected) {
      if (group.type !== 'group') throw new VmotionError('GROUP_TYPE', '只能解散图层组');
      if (
        group.x ||
        group.y ||
        group.rotation ||
        group.scaleX !== 1 ||
        group.scaleY !== 1 ||
        group.matrix.some((value, index) => value !== [1, 0, 0, 1, 0, 0][index]) ||
        group.opacity !== 1 ||
        group.animations.length ||
        group.effects.length ||
        group.clip ||
        group.maskId ||
        group.blur ||
        group.shadow ||
        group.blend !== 'source-over' ||
        group.brightness !== 1 ||
        group.saturation !== 1
      )
        throw new VmotionError(
          'GROUP_APPEARANCE',
          '此组已有变换、动画或合成效果；为保留画面，请先移除这些组级属性再解组',
        );
      const children = nodes.filter((n) => n.parentId === group.id);
      if (nodes.some((n) => n.maskId === group.id))
        throw new VmotionError('GROUP_MASK', '此组被用作遮罩，暂不能解组');
      const remaining = nodes.filter((n) => n.id !== group.id && n.parentId !== group.id),
        index = nodes.findIndex((n) => n.id === group.id),
        at = nodes
          .slice(0, index)
          .filter((n) => n.id !== group.id && n.parentId !== group.id).length;
      remaining.splice(at, 0, ...children.map((n) => ({ ...n, parentId: group.parentId })));
      nodes = remaining;
    }
    selection = input
      .filter((n) => n.parentId && selected.some((g) => g.id === n.parentId))
      .map((n) => n.id);
  } else {
    const parents = new Set(selected.map((n) => n.parentId));
    for (const parent of parents) {
      const indexes = nodes.flatMap((n, i) => (n.parentId === parent ? [i] : [])),
        siblings = indexes.map((i) => nodes[i]),
        chosen = new Set(selection);
      if (action.direction === 'front' || action.direction === 'back') {
        const a = siblings.filter((n) => chosen.has(n.id)),
          b = siblings.filter((n) => !chosen.has(n.id));
        const order = action.direction === 'front' ? [...b, ...a] : [...a, ...b];
        indexes.forEach((idx, i) => (nodes[idx] = order[i]));
      } else if (action.direction === 'up') {
        for (let i = siblings.length - 2; i >= 0; i--)
          if (chosen.has(siblings[i].id) && !chosen.has(siblings[i + 1].id))
            [siblings[i], siblings[i + 1]] = [siblings[i + 1], siblings[i]];
        indexes.forEach((idx, i) => (nodes[idx] = siblings[i]));
      } else {
        for (let i = 1; i < siblings.length; i++)
          if (chosen.has(siblings[i].id) && !chosen.has(siblings[i - 1].id))
            [siblings[i - 1], siblings[i]] = [siblings[i], siblings[i - 1]];
        indexes.forEach((idx, i) => (nodes[idx] = siblings[i]));
      }
    }
  }
  return { nodes, selection };
}
