import { shapePath } from '../vector.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['rect', 'ellipse', 'path'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    const p = shapePath(n, services.geometry);
    if (n.fill !== 'transparent' || n.gradient) ctx.fill(p, n.fillRule);
    if (n.strokeWidth) ctx.stroke(p);
    return { target: ctx };
  },
}));
