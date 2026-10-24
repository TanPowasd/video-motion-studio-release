import type { Node } from '../core/model.js';

/**
 * Which .tsx component layer owns the selection for "写回源码", and which of its overrides
 * the panel should list. Works when the component layer itself is selected, after entering
 * the component (focusPath), and when a generated child is selected directly on the canvas
 * (deep select: focusPath is empty but the interaction layer's path names the component).
 * Generated node ids are owner-prefixed ("opener/stage/title") while override keys are
 * local ("stage/title").
 */
export function writeBackScope(
  rootNodes: readonly Node[] | undefined,
  focusPath: readonly string[],
  selected: Pick<Node, 'id'> | undefined,
  layerPath: readonly string[] | undefined,
): { owner: Node; ids?: string[]; localId?: string } | undefined {
  if (!rootNodes || !selected) return undefined;
  const isTsx = (n?: Node) => n?.type === 'component' && !!n.component?.endsWith('.tsx');
  const direct = rootNodes.find((n) => n.id === selected.id);
  if (!focusPath.length && direct) return isTsx(direct) ? { owner: direct } : undefined;
  const ownerId = focusPath[0] ?? layerPath?.[0];
  const owner = rootNodes.find((n) => n.id === ownerId);
  if (!owner || !isTsx(owner)) return undefined;
  if (selected.id === owner.id) return { owner };
  const localId = selected.id.startsWith(owner.id + '/')
      ? selected.id.slice(owner.id.length + 1)
      : selected.id,
    keys = Object.keys(owner.overrides ?? {}),
    ids = keys.filter((key) => key === localId || key.startsWith(localId + '/'));
  // A child without overrides of its own still shows the component's list (scoped to the owner).
  return ids.length ? { owner, ids, localId } : { owner, localId };
}
