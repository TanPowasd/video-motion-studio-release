import { prefixNodes } from '../composition.js';
import { contentTiming } from '../content-time.js';
import { VmotionError } from '../model.js';
import { evaluateNode } from '../time.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['component'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    const timing = contentTiming(snapshot, n, frame, true);
    if (!timing.present) return { target: ctx, skipChildren: true };
    const nodes = await services.generatedNodes(snapshot, n, timing.sourceFrame);
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Component nesting exceeds 32');
    const generated = prefixNodes(nodes, n.id);
    await services.graph(
      ctx,
      snapshot,
      generated,
      timing.sourceFrame,
      depth + 1,
      async (at) => {
        const parentFrame =
          n.timeMapping.mode === 'linear' && n.timeMapping.rate !== 0
            ? frame + (at - timing.sourceFrame) / n.timeMapping.rate
            : frame;
        const sampled =
          (await nodeSource?.(Math.max(0, parentFrame))) ??
          evaluateNode(n, Math.max(0, parentFrame));
        return prefixNodes(await services.generatedNodes(snapshot, sampled, at), n.id);
      },
      undefined,
      undefined,
      {
        width: n.width,
        height: n.height,
        duration: n.timeMapping.duration ?? snapshot.scenes[0].duration,
      },
    );
    return { target: ctx };
  },
}));
