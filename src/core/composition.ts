import { nodeSchema, structureSchema, type Node, type ComponentStructure } from './model.js';
import { VmotionError } from './model.js';
import { indexGraph } from './graph.js';
export function applyOverrides(nodes: Array<Partial<Node>>, overrides: Node['overrides'] = {}) {
  return nodes.map((raw, index) => {
    const id = raw.id ?? String(index),
      generatedName =
        !raw.name || raw.name === 'Layer'
          ? raw.type === 'text' && raw.text
            ? raw.text.slice(0, 36)
            : (id.split('/').at(-1) ?? id)
          : raw.name,
      node = nodeSchema.parse({ ...raw, name: generatedName, ...overrides[id], id });
    if (node.type === 'component' || node.type === 'scene') {
      const nested = Object.fromEntries(
        Object.entries(overrides)
          .filter(([key]) => key.startsWith(id + '/'))
          .map(([key, value]) => [key.slice(id.length + 1), value]),
      );
      node.overrides = { ...node.overrides, ...nested };
    }
    return node;
  });
}
export function applyStructure(nodes: Node[], structure?: ComponentStructure): Node[] {
  if (!structure) return nodes;
  const edits = structureSchema.parse(structure),
    existing = new Set(nodes.map((n) => n.id));
  for (const added of edits.added) {
    if (existing.has(added.id))
      throw new VmotionError(
        'STRUCTURE_ID_COLLISION',
        `Added layer ${added.id} collides with a generated ID`,
      );
    existing.add(added.id);
  }
  const all = [...nodes, ...edits.added.map((n) => nodeSchema.parse(n))].map((n) => {
    const parent = edits.parents[n.id];
    return { ...n, parentId: parent === null ? undefined : (parent ?? n.parentId) };
  });
  const removed = new Set(edits.removed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of all)
      if (n.parentId && removed.has(n.parentId) && !removed.has(n.id)) {
        removed.add(n.id);
        changed = true;
      }
  }
  const result = all.filter((n) => !removed.has(n.id));
  for (const n of result) {
    if (n.maskId && removed.has(n.maskId)) n.maskId = undefined;
    if (n.type === 'component' || n.type === 'scene') {
      const exact = edits.nested[n.id],
        children = Object.fromEntries(
          Object.entries(edits.nested)
            .filter(([key]) => key.startsWith(n.id + '/'))
            .map(([key, value]) => [key.slice(n.id.length + 1), value]),
        );
      if (exact || Object.keys(children).length) {
        const own = structureSchema.parse(n.structure ?? {});
        n.structure = structureSchema.parse({
          ...own,
          ...exact,
          nested: { ...own.nested, ...children },
        });
      }
    }
  }
  if (edits.order.length) {
    const indexes = new Map(edits.order.map((id, i) => [id, i]));
    result.sort(
      (a, b) =>
        (indexes.get(a.id) ?? edits.order.length) - (indexes.get(b.id) ?? edits.order.length),
    );
  }
  return result;
}
export function composeGenerated(
  raw: Array<Partial<Node>>,
  owner: Pick<Node, 'overrides' | 'structure'>,
) {
  const nodes = applyOverrides(
    applyStructure(applyOverrides(raw), owner.structure),
    owner.overrides,
  );
  indexGraph(nodes);
  return nodes;
}
export function isolateGroup(nodes: Node[], id: string) {
  const root = nodes.find((n) => n.id === id);
  if (!root) throw new VmotionError('NOT_FOUND', `Group ${id} not found`);
  if (root.type !== 'group')
    throw new VmotionError('GROUP_TYPE', 'Only group layers can be opened as a group composition');
  const descendants = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes)
      if (n.parentId && descendants.has(n.parentId) && !descendants.has(n.id)) {
        descendants.add(n.id);
        changed = true;
      }
  }
  return nodes
    .filter((n) => n.id !== id && descendants.has(n.id))
    .map((n) => ({
      ...n,
      parentId: n.parentId === id ? undefined : n.parentId,
      maskId: n.maskId && descendants.has(n.maskId) ? n.maskId : undefined,
    }));
}
export const prefixNodes = (nodes: Node[], prefix: string) =>
  nodes.map((n) => ({
    ...n,
    id: `${prefix}/${n.id}`,
    parentId: n.parentId ? `${prefix}/${n.parentId}` : undefined,
    maskId: n.maskId ? `${prefix}/${n.maskId}` : undefined,
  }));
