import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['text'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    services.text(ctx, n, frame, snapshot);
    return { target: ctx };
  },
}));
