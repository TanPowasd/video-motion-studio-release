import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['chart'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    services.chart(ctx, n);
    return { target: ctx };
  },
}));
