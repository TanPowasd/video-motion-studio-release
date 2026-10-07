import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { comparePixels } from '../core/pixel-evidence.js';
import { applyOperations } from './operations.js';
import {
  reviewImageSize,
  planRef,
  pixelRegionSchema,
  pixelReviewContext,
  reviewAssets,
  reviewScopeSchema,
  drawReviewTile,
} from './pixel-review-context.js';
import { atomicWrite, safePath, hash } from './project.js';
import type { CompositionDraft } from '../core/interaction.js';
export const layerImpactSchema = z
  .object({
    revision: z.string().optional(),
    planId: planRef,
    sceneId: z.string(),
    nodeIds: z.array(z.string().min(1)).min(1).max(12),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(8).default([0]),
    ...reviewImageSize,
    region: pixelRegionSchema.optional(),
    tolerance: z.number().int().min(0).max(255).default(0),
    determinism: z.boolean().default(true),
    images: z.boolean().default(true),
    maxImages: z.number().int().min(1).max(12).default(4),
    output: z.string().optional(),
  })
  .strict();
export async function layerImpact(
  root: string,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>,
  inline = false,
) {
  const p = layerImpactSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Impact review revision changed');
  if (p.nodeIds.length * p.frames.length > 24)
    throw new VmotionError('IMPACT_BUDGET', 'Impact review is limited to 24 object/frame pairs');
  if (new Set(p.nodeIds).size !== p.nodeIds.length)
    throw new VmotionError('IMPACT_SELECTION', 'Select distinct stable object IDs');
  const assets = await reviewAssets(root, snapshot),
    before = new Renderer(root),
    after = new Renderer(root),
    sheet = p.images
      ? createCanvas(960, Math.min(p.maxImages, p.nodeIds.length * p.frames.length) * 210)
      : undefined,
    samples = [];
  let work = 0,
    images = 0;
  const read = (image: Canvas) =>
    image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  try {
    for (const frame of p.frames) {
      await assets.verify();
      const context = await pixelReviewContext(
          before,
          snapshot,
          reviewScopeSchema.parse({ sceneId: p.sceneId }),
          frame,
          p.width,
          p.height,
        ),
        graph = await before.inspectInteractions(snapshot, p.sceneId, frame, [], {
          includeInactive: true,
          includeEmpty: true,
          includeEvaluated: true,
        });
      const selected = p.nodeIds.map((id) => {
        const layer = graph.layers.find((l) => l.node.id === id);
        if (!layer)
          throw new VmotionError('NOT_FOUND', 'Impact object is missing at sampled frame', {
            nodeId: id,
            frame,
          });
        return layer;
      });
      work += p.width * context.options.height * (p.determinism ? 2 : 1);
      if (work > 64 * 1024 * 1024)
        throw new VmotionError('IMPACT_BUDGET', 'Impact review exceeds 64M rendered pixels');
      const image = await before.render(snapshot, frame, context.options);
      try {
        const pixels = read(image),
          pixelHash = hash(Buffer.from(pixels));
        let stable = true;
        if (p.determinism) {
          const again = await before.render(snapshot, frame, context.options);
          try {
            stable = hash(Buffer.from(read(again))) === pixelHash;
          } finally {
            again.width = 1;
            again.height = 1;
          }
        }
        for (const layer of selected) {
          const start = performance.now(),
            localFrame = layer.frame ?? frame,
            path = layer.path,
            contextFrames = layer.contextFrames ?? [],
            scope = await before.inspectComposition(
              snapshot,
              p.sceneId,
              localFrame,
              path,
              contextFrames,
            );
          if (!scope.targets[layer.node.id])
            throw new VmotionError('IMPACT_SELECTION', 'Object has no persistent edit locator', {
              nodeId: layer.node.id,
            });
          const operations = await edit(snapshot, p.sceneId, localFrame, [
              {
                nodeId: layer.node.id,
                path,
                contextFrames,
                frame: localFrame,
                patch: { visible: false },
              },
            ]),
            hidden = applyOperations(root, snapshot, operations);
          work += p.width * context.options.height * (p.determinism ? 2 : 1);
          if (work > 64 * 1024 * 1024)
            throw new VmotionError('IMPACT_BUDGET', 'Impact review exceeds 64M rendered pixels');
          let without: Canvas | undefined;
          try {
            without = await after.render(hidden, frame, context.options);
            const difference = comparePixels(pixels, read(without), image.width, image.height, {
                region: p.region,
                tolerance: p.tolerance,
                diff: !!sheet && images < p.maxImages,
              }),
              { diff, ...metrics } = difference;
            let stableHidden = true;
            if (p.determinism) {
              const repeat = await after.render(hidden, frame, context.options);
              try {
                stableHidden = hash(Buffer.from(read(repeat))) === hash(Buffer.from(read(without)));
              } finally {
                repeat.width = 1;
                repeat.height = 1;
              }
            }
            const dependencySensitive = graph.layers.some(
                (other) =>
                  other.node.maskId === layer.node.id ||
                  other.node.motionPath?.nodeId === layer.node.id ||
                  other.node.effects.some(
                    (e) =>
                      e.type === 'effectGraph' &&
                      Object.values(e.bindings).some(
                        (id) => id === layer.node.id || layer.node.id.endsWith('/' + id),
                      ),
                  ),
              ),
              locator = {
                sceneId: p.sceneId,
                nodeId: layer.node.id,
                path,
                frame: localFrame,
                contextFrames,
              };
            samples.push({
              frame,
              nodeId: layer.node.id,
              locator,
              width: image.width,
              height: image.height,
              ...metrics,
              sourcePixelHash: pixelHash,
              determinism: {
                checked: p.determinism,
                before: p.determinism ? stable : undefined,
                hidden: p.determinism ? stableHidden : undefined,
              },
              dependencySensitive,
              result:
                !stable || !stableHidden
                  ? 'inconclusive'
                  : metrics.changedPixels
                    ? 'changes-composite'
                    : 'no-sampled-pixel-change',
              elapsedMs: performance.now() - start,
            });
            if (sheet && images < p.maxImages) {
              const ctx = sheet.getContext('2d'),
                y = images++ * 210;
              ctx.fillStyle = '#101a2a';
              ctx.fillRect(0, y, 960, 210);
              drawReviewTile(sheet, image, 0, y + 27, 320, 180);
              drawReviewTile(sheet, without, 320, y + 27, 320, 180);
              const di = createCanvas(image.width, image.height);
              try {
                di.getContext('2d').putImageData(
                  new ImageData(diff!, image.width, image.height),
                  0,
                  0,
                );
                drawReviewTile(sheet, di, 640, y + 27, 320, 180);
              } finally {
                di.width = 1;
                di.height = 1;
              }
              ctx.fillStyle = '#ccd8eb';
              ctx.font = '12px "Microsoft YaHei"';
              ctx.textBaseline = 'top';
              ctx.fillText(`${frame}f 原图`, 10, y + 7);
              ctx.fillText(`隐藏 ${layer.node.id.slice(0, 38)}`, 330, y + 7);
              ctx.fillText(`影响 ${(metrics.changedRatio * 100).toFixed(2)}%`, 650, y + 7);
            }
          } finally {
            if (without) {
              without.width = 1;
              without.height = 1;
            }
          }
        }
      } finally {
        image.width = 1;
        image.height = 1;
      }
    }
    await assets.verify();
    let output: string | undefined, data: string | undefined;
    if (sheet) {
      output = path.resolve(
        p.output ?? safePath(root, `.vmotion/pixel-review/impact-${randomUUID()}.png`),
      );
      const buffer = await sheet.encode('png');
      await atomicWrite(output, buffer);
      if (inline) data = buffer.toString('base64');
    }
    return {
      revision: snapshot.revision,
      gpu: { baseline: before.gpu.report(), hidden: after.gpu.report() },
      sceneId: p.sceneId,
      samples,
      coverage: {
        requestedPairs: p.nodeIds.length * p.frames.length,
        sampledPairs: samples.length,
        evidenceImages: images,
        omittedImages: Math.max(0, samples.length - images),
        renderedPixels: work,
        completeTrajectory: false,
      },
      assets: { checked: assets.checks.length, fingerprintDigest: assets.digest },
      limitations: [
        'Measured impact of a temporary visible:false override on the final sampled scene composite. This is not object deletion or an isolated visibility percentage. Occlusion/masks/effects/cameras follow native renderer semantics.',
        'Mask/map/group/driver dependencies follow their native capture rules; hidden sources can remain available to dependencies. dependencySensitive is only a static hint; arbitrary code/expressions may add dependencies.',
        'No sampled pixel change can mean covered/offscreen/transparent, same-color output or an inactive clock; it is a review fact, not an artistic error. Stateful code marks results inconclusive.',
        'Preview dimensions/tolerance/ROI and chosen frames limit evidence. This creates temporary snapshots without saving source/history or generating a commit candidate.',
      ],
      ...(output ? { output, mimeType: 'image/png' } : {}),
      ...(data ? { data } : {}),
    };
  } finally {
    if (sheet) {
      sheet.width = 1;
      sheet.height = 1;
    }
    await Promise.all([before.close(), after.close()]);
  }
}
