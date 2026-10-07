import path from 'node:path';
import { z } from 'zod';
import { soundResource, soundDependencies } from '../media/sound-source.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { newNode, VmotionError, type Snapshot } from '../core/model.js';
import { probe, fingerprint, videoDisplayDimensions } from '../media/ffmpeg.js';
import { atomicWrite, hash, safePath } from './project.js';

export const assetCheckSchema = z
  .object({
    assetId: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict();
export type AssetCheck = z.infer<typeof assetCheckSchema>;
export async function checkAssets(root: string, snapshot: Snapshot, checks: AssetCheck[]) {
  const assets = new Map(snapshot.project.assets.map((asset) => [asset.id, asset]));
  for (const check of checks) {
    const asset = assets.get(check.assetId);
    if (!asset)
      throw new VmotionError('MISSING_ASSET', `Evidence asset ${check.assetId} is missing`);
    let actual: string;
    try {
      actual =
        asset.soundSource && check.fingerprint.startsWith('source:')
          ? `source:${soundResource(snapshot, asset).hash}`
          : await fingerprint(path.resolve(root, asset.path));
    } catch {
      throw new VmotionError('ASSET_CHANGED', `Evidence asset ${asset.id} is unavailable`, check);
    }
    if (actual !== check.fingerprint)
      throw new VmotionError(
        'ASSET_CHANGED',
        `Asset ${asset.id} changed; sample it again before committing`,
        { ...check, actual },
      );
  }
}
export const mediaInspectSchema = z
  .object({
    assetId: z.string().min(1),
    fingerprint: z.string().optional(),
  })
  .strict();
export async function inspectMedia(root: string, snapshot: Snapshot, raw: unknown) {
  const request = mediaInspectSchema.parse(raw),
    asset = snapshot.project.assets.find((a) => a.id === request.assetId);
  if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
  const file = path.resolve(root, asset.path),
    before = asset.soundSource
      ? `source:${soundResource(snapshot, asset).hash}`
      : await fingerprint(file);
  if (request.fingerprint && request.fingerprint !== before)
    throw new VmotionError('ASSET_CHANGED', 'Source evidence is stale', {
      assetId: asset.id,
      expected: request.fingerprint,
      actual: before,
    });
  let metadata: Record<string, unknown> = { ...asset.metadata };
  if (asset.soundSource) {
    const sound = soundResource(snapshot, asset);
    metadata = {
      duration: sound.duration,
      sampleRate: 48000,
      channels: 2,
      hasAudio: true,
      hasVideo: false,
      soundSource: asset.soundSource,
    };
  } else if (asset.type === 'video' || asset.type === 'audio') {
    const info = await probe(file),
      video = info.streams.find((s) => s.codec_type === 'video'),
      audio = info.streams.find((s) => s.codec_type === 'audio'),
      duration = Number(info.format.duration ?? video?.duration ?? audio?.duration);
    metadata = {
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      hasAudio: !!audio,
      hasVideo: !!video,
      ...(video ? { ...videoDisplayDimensions(video) } : {}),
      ...(audio ? { sampleRate: Number(audio.sample_rate), channels: audio.channels } : {}),
    };
  } else if (asset.type === 'image') {
    const image = await loadImage(file);
    metadata = { width: image.width, height: image.height };
  }
  await checkAssets(root, snapshot, [{ assetId: asset.id, fingerprint: before }]);
  const duration = Number(metadata.duration),
    fps = snapshot.project.fps;
  return {
    revision: snapshot.revision,
    asset: { id: asset.id, name: asset.name, type: asset.type, path: asset.path },
    fingerprint: before,
    fingerprintKind: asset.soundSource ? 'project-source-sha256' : 'size:mtimeMs',
    metadata,
    timebase: { unit: 'project-source-frame', fps, secondsPerFrame: fps.den / fps.num },
    ...(Number.isFinite(duration) && duration > 0
      ? { sourceEnd: (duration * fps.num) / fps.den }
      : {}),
    assetCheck: { assetId: asset.id, fingerprint: before },
    ...(asset.soundSource
      ? {
          assetChecks: [
            { assetId: asset.id, fingerprint: before },
            ...(await soundDependencies(root, snapshot, asset)).checks,
          ],
        }
      : {}),
  };
}
export const mediaSampleSchema = z
  .object({
    ...mediaInspectSchema.shape,
    frames: z.array(z.number().finite().nonnegative()).min(1).max(24).optional(),
    count: z.number().int().min(1).max(24).default(8),
    width: z.number().int().min(160).max(640).default(320),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export async function sampleMedia(root: string, snapshot: Snapshot, raw: unknown) {
  const request = mediaSampleSchema.parse(raw),
    info = await inspectMedia(root, snapshot, {
      assetId: request.assetId,
      fingerprint: request.fingerprint,
    });
  if (!['video', 'image', 'drawing'].includes(info.asset.type))
    throw new VmotionError(
      'MEDIA_SAMPLE_TYPE',
      'Visual sampling supports video, image and drawing assets; use audio_preview for sound',
    );
  if (info.asset.type === 'video' && !info.sourceEnd)
    throw new VmotionError('MEDIA_DURATION', 'Source duration is required for video sampling');
  const frames =
    request.frames ??
    (info.asset.type === 'video'
      ? Array.from({ length: request.count }, (_, i) =>
          Math.floor(((info.sourceEnd! - 1e-7) * (i + 0.5)) / request.count),
        )
      : [0]);
  if (info.sourceEnd && frames.some((f) => f >= info.sourceEnd!))
    throw new VmotionError('FRAME_RANGE', 'Source frames must be before sourceEnd (exclusive)', {
      sourceEnd: info.sourceEnd,
    });
  const ratio = Number(info.metadata.width) / Number(info.metadata.height),
    tileHeight = Math.max(
      90,
      Math.min(
        480,
        Math.round(request.width / (Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9)),
      ),
    ),
    columns = Math.min(4, frames.length),
    sheet = createCanvas(
      columns * request.width,
      Math.ceil(frames.length / columns) * (tileHeight + 28),
    ),
    ctx = sheet.getContext('2d'),
    renderer = new Renderer(root);
  // Decode at the evidence size; each request owns its decoder and cannot race live preview.
  const source: Snapshot = structuredClone(snapshot);
  source.project.width = request.width;
  source.project.height = tileHeight;
  source.scenes = [
    {
      id: '__media_evidence',
      name: 'Source evidence',
      duration: Math.max(1, Math.ceil(info.sourceEnd ?? 1)),
      background: '#101826',
      nodes: [
        newNode({
          id: '__source',
          type:
            info.asset.type === 'video'
              ? 'video'
              : info.asset.type === 'drawing'
                ? 'drawing'
                : 'image',
          assetId: info.asset.id,
          width: request.width,
          height: tileHeight,
        }),
      ],
    },
  ];
  // The renderer uses metadata to bound video content clocks; use freshly probed values.
  source.project.assets = source.project.assets.map((a) =>
    a.id === info.asset.id ? { ...a, metadata: info.metadata } : a,
  );
  const samples: Array<{ frame: number; seconds: number; pixelHash: string }> = [];
  ctx.fillStyle = '#101826';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  try {
    for (const [i, frame] of frames.entries()) {
      const x = (i % columns) * request.width,
        y = Math.floor(i / columns) * (tileHeight + 28),
        seconds = (frame * snapshot.project.fps.den) / snapshot.project.fps.num,
        image = await renderer.render(source, frame, {
          sceneId: '__media_evidence',
          width: request.width,
          height: tileHeight,
        });
      ctx.fillStyle = '#dde8f8';
      ctx.font = '13px "Microsoft YaHei"';
      ctx.fillText(`${frame}f · ${seconds.toFixed(3)}s`, x + 8, y + 19);
      ctx.drawImage(image, x, y + 28);
      samples.push({
        frame,
        seconds,
        pixelHash: hash(
          Buffer.from(image.getContext('2d').getImageData(0, 0, image.width, image.height).data),
        ),
      });
      image.width = 1;
      image.height = 1;
    }
    await checkAssets(root, snapshot, [info.assetCheck]);
    const buffer = await sheet.encode('png'),
      key = hash(JSON.stringify([info.assetCheck, frames, request.width, tileHeight])).slice(0, 24),
      output = path.resolve(request.output ?? safePath(root, `.vmotion/media-evidence/${key}.png`));
    await atomicWrite(output, buffer);
    return {
      ...info,
      samples,
      output,
      width: sheet.width,
      height: sheet.height,
      mimeType: 'image/png',
      ...(request.inline ? { data: buffer.toString('base64') } : {}),
    };
  } finally {
    sheet.width = 1;
    sheet.height = 1;
    await renderer.close();
  }
}
