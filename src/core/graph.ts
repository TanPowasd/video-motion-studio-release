import { VmotionError, type Node } from './model.js';
export function indexGraph(nodes: Node[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length)
    throw new VmotionError('GRAPH_IDS', 'Generated node IDs must be unique');
  const masks = new Set(nodes.flatMap((n) => (n.maskId ? [n.maskId] : []))),
    byParent = new Map<string | undefined, Node[]>();
  for (const n of nodes) {
    if (n.parentId && !byId.has(n.parentId))
      throw new VmotionError('GRAPH_PARENT', `${n.id}: missing parent ${n.parentId}`);
    const seen = new Set([n.id]);
    let parent = n.parentId;
    while (parent) {
      if (seen.has(parent)) throw new VmotionError('GRAPH_CYCLE', `${n.id}: parent cycle`);
      seen.add(parent);
      if (seen.size > 33)
        throw new VmotionError('NESTING_DEPTH', 'Generated hierarchy exceeds 32 levels');
      parent = byId.get(parent)?.parentId;
    }
    if (n.maskId && (!byId.has(n.maskId) || n.maskId === n.id))
      throw new VmotionError('GRAPH_MASK', `${n.id}: invalid mask ${n.maskId}`);
    const chain = new Set([n.id]);
    let mask = n.maskId;
    while (mask) {
      if (chain.has(mask)) throw new VmotionError('GRAPH_MASK_CYCLE', `${n.id}: mask cycle`);
      chain.add(mask);
      mask = byId.get(mask)?.maskId;
    }
    if (n.maskId && byId.get(n.maskId)!.parentId !== n.parentId)
      throw new VmotionError(
        'GRAPH_MASK_SPACE',
        `${n.id}: mask and target must share a parent coordinate space`,
      );
    const siblings = byParent.get(n.parentId) ?? [];
    siblings.push(n);
    byParent.set(n.parentId, siblings);
  }
  return { byId, masks, byParent };
}
