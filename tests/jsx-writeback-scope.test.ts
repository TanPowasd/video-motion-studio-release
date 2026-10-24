import { describe, it, expect } from 'vitest';
import { newNode, type Node } from '../src/core/model.js';
import { writeBackScope } from '../src/editor/jsx-writeback-scope.js';

const owner = newNode({
  id: 'opener',
  type: 'component',
  name: '开场卡片',
  component: 'components/opener.tsx',
  overrides: { 'stage/title': { x: 248 }, 'stage/grid/t0/tile/label': { fill: '#fff' } },
} as never);
const plain = newNode({ id: 'box', type: 'rect' });
const legacy = newNode({ id: 'legacy', type: 'component', component: 'components/old.ts' } as never);
const roots: Node[] = [owner, plain, legacy];

describe('写回源码 scope (bug: hidden when a child of the JSX component is selected)', () => {
  it('shows for the component layer itself', () => {
    expect(writeBackScope(roots, [], owner, [])).toEqual({ owner });
    expect(writeBackScope(roots, [], plain, [])).toBeUndefined();
    expect(writeBackScope(roots, [], legacy, [])).toBeUndefined();
  });
  it('shows for a deep-selected generated child on the root canvas (no focus path)', () => {
    const scope = writeBackScope(roots, [], { id: 'opener/stage/title' }, ['opener']);
    expect(scope?.owner).toBe(owner);
    expect(scope?.localId).toBe('stage/title');
    expect(scope?.ids).toEqual(['stage/title']);
  });
  it('shows inside the entered component and nested groups, listing descendant overrides', () => {
    expect(writeBackScope(roots, ['opener'], { id: 'opener/stage/title' }, ['opener'])?.ids).toEqual([
      'stage/title',
    ]);
    expect(
      writeBackScope(roots, ['opener', 'opener/stage'], { id: 'opener/stage/grid' }, ['opener', 'opener/stage'])
        ?.ids,
    ).toEqual(['stage/grid/t0/tile/label']);
    // A child without overrides keeps the whole component list (scoped to the owner).
    const rule = writeBackScope(roots, ['opener'], { id: 'opener/stage/rule' }, ['opener']);
    expect(rule?.owner).toBe(owner);
    expect(rule?.ids).toBeUndefined();
    expect(writeBackScope(roots, ['legacy'], { id: 'legacy/x' }, ['legacy'])).toBeUndefined();
  });
});
