import { renderers as group7 } from './node-chart.js';
import { renderers as group5 } from './node-component.js';
import { renderers as group8 } from './node-drawing.js';
import { renderers as group3 } from './node-formula.js';
import { renderers as group4 } from './node-image-video.js';
import { renderers as group0 } from './node-rect-ellipse-path.js';
import { renderers as group6 } from './node-scene.js';
import { renderers as group2 } from './node-scene3d.js';
import { renderers as group1 } from './node-text.js';
import { NodeRendererRegistry } from './registry.js';
import { renderers as programs } from './node-program.js';
export function builtinNodeRenderers() {
  const registry = new NodeRendererRegistry();
  for (const renderer of [
    ...programs,
    ...group0,
    ...group1,
    ...group2,
    ...group3,
    ...group4,
    ...group5,
    ...group6,
    ...group7,
    ...group8,
    {
      type: 'group' as const,
      async render(context: import('./registry.js').NodeRenderContext) {
        return { target: context.target };
      },
    },
  ])
    registry.register(renderer);
  return registry;
}
