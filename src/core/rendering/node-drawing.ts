import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDrawing, paintDrawing } from '../drawing-renderer.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['drawing'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    let resource: unknown = { points: n.points };
    let sourceWidth = snapshot.project.width,
      sourceHeight = snapshot.project.height;
    if (n.assetId) {
      const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
      if (asset) {
        resource = JSON.parse(await readFile(path.resolve(services.root, asset.path), 'utf8'));
        sourceWidth = Number(asset.metadata.width ?? sourceWidth);
        sourceHeight = Number(asset.metadata.height ?? sourceHeight);
      }
    }
    const original =
      n.assetId && n.strokeWidth === 0
        ? snapshot.scenes
            .flatMap((s) => s.nodes)
            .find(
              (layer) =>
                layer.type === 'drawing' && layer.assetId === n.assetId && layer.strokeWidth > 0,
            )
        : undefined;
    const doc = normalizeDrawing(resource, {
      ...n,
      ...(original ? { stroke: original.stroke, strokeWidth: original.strokeWidth } : {}),
      width: sourceWidth,
      height: sourceHeight,
    });
    ctx.scale(n.width / doc.width, n.height / doc.height);
    paintDrawing(ctx, doc);
    return { target: ctx };
  },
}));
