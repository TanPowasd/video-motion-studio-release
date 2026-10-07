import { createCanvas, ImageData } from '@napi-rs/canvas';
import path from 'node:path';
import { fingerprint, VideoDecoder } from '../../media/ffmpeg.js';
import { useCacheFile, videoProxy } from '../../media/proxy-cache.js';
import { contentTiming } from '../content-time.js';
import { VmotionError } from '../model.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = ['image', 'video'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
    const file = asset
      ? path.resolve(services.root, asset.path)
      : n.source
        ? path.resolve(services.root, n.source)
        : undefined;
    if (!file) throw new VmotionError('MISSING_ASSET', `${n.id}: no source`);
    if (n.type === 'image') {
      const image = await services.image(file + ':' + (await fingerprint(file)), file);
      ctx.drawImage(image, 0, 0, n.width, n.height);
    } else {
      const proxy =
          services.mediaQuality === 'auto' && asset
            ? await videoProxy(services.root, snapshot, asset)
            : undefined,
        mediaFile = proxy?.output ?? file,
        matrix = ctx.getTransform(),
        previewScale =
          services.mediaQuality === 'auto'
            ? Math.min(1, Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)))
            : 1,
        factor = proxy
          ? Math.min(
              previewScale,
              proxy.width / Math.max(1, n.width),
              proxy.height / Math.max(1, n.height),
            )
          : previewScale,
        width = Math.max(16, Math.min(snapshot.project.width, Math.round(n.width * factor))),
        height = Math.max(16, Math.min(snapshot.project.height, Math.round(n.height * factor)));
      services.mediaUsed.push({
        assetId: asset?.id,
        proxy: !!proxy,
        decodeWidth: width,
        decodeHeight: height,
        path: mediaFile,
      });
      const key = `${mediaFile}:${await fingerprint(mediaFile)}:${width}:${height}:${snapshot.project.fps.num}/${snapshot.project.fps.den}`;
      let decoder = services.decoders.get(key);
      if (!decoder) {
        while (services.decoders.size >= 3) {
          const first = services.decoders.keys().next().value!;
          services.decoders.get(first)!.close();
          services.decoderLeases.get(first)?.();
          services.decoderLeases.delete(first);
          services.decoders.delete(first);
        }
        decoder = new VideoDecoder(mediaFile, width, height, snapshot.project.fps, {
          framing: services.mediaFraming,
        });
        services.decoders.set(key, decoder);
        services.decoderLeases.set(key, useCacheFile(mediaFile));
      }
      const timing = contentTiming(snapshot, n, frame, true);
      if (!timing.present) return { target: ctx, skipChildren: true };
      const pixels = await decoder.frame(timing.sourceFrame);
      const image = createCanvas(width, height);
      image
        .getContext('2d')
        .putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      ctx.drawImage(image, 0, 0, n.width, n.height);
      image.width = 1;
      image.height = 1;
    }
    return { target: ctx };
  },
}));
