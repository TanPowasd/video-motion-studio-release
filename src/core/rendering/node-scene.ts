import { composeGenerated, prefixNodes } from '../composition.js';
import { contentTiming } from '../content-time.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['scene'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    const timing = contentTiming(snapshot, n, frame, true);
    if (!timing.present) return { target: ctx, skipChildren: true };
    const scene = services.referencedScene(snapshot, n);
    ctx.scale(
      n.width / (scene.width ?? snapshot.project.width),
      n.height / (scene.height ?? snapshot.project.height),
    );
    await services.scene(
      ctx,
      snapshot,
      {
        ...scene,
        nodes: prefixNodes(
          composeGenerated(services.templates.apply(snapshot, n, scene.nodes), n),
          n.id,
        ),
      },
      timing.sourceFrame,
      depth + 1,
    );
    return { target: ctx };
  },
}));
