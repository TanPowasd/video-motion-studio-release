import { createCanvas, ImageData } from '@napi-rs/canvas';
import { resolveSceneMeshes } from '../mesh-resources.js';
import { VmotionError } from '../model.js';
import { prepareRasterScene } from '../raster3d.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['scene3d'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    if (!n.scene3d) throw new VmotionError('SCENE3D_SOURCE', `${n.id}: missing 3D scene data`);
    if (n.width === 0 || n.height === 0) return { target: ctx, skipChildren: true };
    const m = ctx.getTransform(),
      factor = Math.min(
        1,
        3840 / Math.max(1, n.width * Math.hypot(m.a, m.b)),
        2160 / Math.max(1, n.height * Math.hypot(m.c, m.d)),
      ),
      width = Math.max(1, Math.min(3840, Math.ceil(n.width * Math.hypot(m.a, m.b) * factor))),
      height = Math.max(1, Math.min(2160, Math.ceil(n.height * Math.hypot(m.c, m.d) * factor))),
      prepared = prepareRasterScene(n.id, resolveSceneMeshes(snapshot, n.scene3d), width, height),
      result = await services.native.raster3D(prepared.request),
      image = createCanvas(width, height);
    image
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(result.pixels), width, height), 0, 0);
    ctx.drawImage(image, 0, 0, n.width, n.height);
    image.width = 1;
    image.height = 1;
    return { target: ctx };
  },
}));
