import { it, expect } from 'vitest';
import { NodeRendererRegistry, type NodeRenderer } from '../src/core/rendering/registry.js';
import { builtinNodeRenderers } from '../src/core/rendering/builtin-renderers.js';
import { nodeBaseSchema } from '../src/core/model.js';
it('covers all supported node types once and rejects missing or duplicate dispatch', () => {
  const registry = builtinNodeRenderers();
  expect(
    registry
      .list()
      .map((renderer) => renderer.type)
      .sort(),
  ).toEqual([...nodeBaseSchema.shape.type.options].sort());
  const empty = new NodeRendererRegistry();
  expect(() => empty.get('text')).toThrow(/No renderer/);
  const renderer: NodeRenderer = {
    type: 'text',
    async render(context) {
      return { target: context.target };
    },
  };
  empty.register(renderer);
  expect(empty.get('text')).toBe(renderer);
  expect(() => empty.register(renderer)).toThrow(/Duplicate/);
});
