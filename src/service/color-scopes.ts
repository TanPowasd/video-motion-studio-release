import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { pixelEvidence, type PixelEvidenceOptions } from '../core/pixel-evidence.js';
import {
  pixelReviewContext,
  reviewAssets,
  reviewScopeSchema,
  reviewImageSize,
  pixelRegionSchema,
  planRef,
  drawReviewTile,
} from './pixel-review-context.js';
import { atomicWrite, safePath, hash } from './project.js';
export const colorScopesSchema = z
  .object({
    revision: z.string().optional(),
    planId: planRef,
    scope: reviewScopeSchema.default({}),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(12).default([0]),
    ...reviewImageSize,
    region: pixelRegionSchema.optional(),
    alpha: z.enum(['visible', 'weighted', 'black']).default('weighted'),
    analysis: z.enum(['full', 'sampled']).default('full'),
    maxSamples: z.number().int().min(256).max(1000000).default(65536),
    bins: z.number().int().min(8).max(256).default(64),
    columns: z.number().int().min(4).max(128).default(32),
    vectorSize: z.number().int().min(8).max(64).default(32),
    includeDistributions: z.boolean().default(false),
    images: z.boolean().default(true),
    output: z.string().optional(),
  })
  .strict();
function paintScopes(
  sheet: Canvas,
  y: number,
  image: Canvas,
  result: ReturnType<typeof pixelEvidence>,
  frame: number,
) {
  const ctx = sheet.getContext('2d'),
    tile = 256,
    h = 144;
  ctx.fillStyle = '#111c2c';
  ctx.fillRect(0, y, sheet.width, 174);
  drawReviewTile(sheet, image, 0, y + 24, tile, h);
  ctx.fillStyle = '#c4d3e6';
  ctx.font = '12px "Microsoft YaHei"';
  ctx.textBaseline = 'top';
  ctx.fillText(`${frame}f  /  画面 · RGB 分布 · 波形 · UV`, 10, y + 6);
  const histogram = result.histogram!,
    wave = result.waveform!,
    colors = ['#e88796', '#88dcb0', '#81adff'];
  for (let channel = 0; channel < 3; channel++) {
    const values = histogram.channels[channel].counts,
      max = Math.max(1, ...values);
    ctx.strokeStyle = colors[channel];
    ctx.beginPath();
    values.forEach((value, i) => {
      const x = tile + 12 + (i * (tile - 24)) / (values.length - 1),
        top = y + 166 - (value / max) * 132;
      i ? ctx.lineTo(x, top) : ctx.moveTo(x, top);
    });
    ctx.stroke();
  }
  const data = wave.channels[3].counts,
    max = Math.max(1, ...data);
  for (let col = 0; col < wave.columns; col++)
    for (let bin = 0; bin < wave.bins; bin++) {
      const value = data[col * wave.bins + bin];
      if (!value) continue;
      ctx.fillStyle = `rgba(150,222,197,${Math.min(1, 0.12 + 0.88 * Math.sqrt(value / max))})`;
      ctx.fillRect(
        tile * 2 + 8 + (col * (tile - 16)) / wave.columns,
        y + 166 - ((bin + 1) * 132) / wave.bins,
        (tile - 16) / wave.columns,
        Math.max(1, 132 / wave.bins),
      );
    }
  const vector = result.vectorscope!,
    maximum = Math.max(1, ...vector.counts);
  for (let row = 0; row < vector.size; row++)
    for (let col = 0; col < vector.size; col++) {
      const value = vector.counts[row * vector.size + col];
      if (!value) continue;
      ctx.fillStyle = `rgba(190,166,255,${Math.min(1, 0.15 + 0.85 * Math.sqrt(value / maximum))})`;
      ctx.fillRect(
        tile * 3 + 58 + (col * 132) / vector.size,
        y + 32 + (row * 132) / vector.size,
        Math.max(1, 132 / vector.size),
        Math.max(1, 132 / vector.size),
      );
    }
  ctx.strokeStyle = '#3c5270';
  ctx.strokeRect(tile * 3 + 58, y + 32, 132, 132);
}
export async function colorScopes(root: string, snapshot: Snapshot, raw: unknown, inline = false) {
  const p = colorScopesSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Scope review revision changed');
  const assets = await reviewAssets(root, snapshot),
    renderer = new Renderer(root),
    samples = [],
    sheet = p.images ? createCanvas(1024, p.frames.length * 174) : undefined;
  let pixels = 0;
  try {
    for (const [index, frame] of p.frames.entries()) {
      await assets.verify();
      const context = await pixelReviewContext(
        renderer,
        snapshot,
        p.scope,
        frame,
        p.width,
        p.height,
      );
      pixels += context.options.width * context.options.height;
      if (pixels > 64 * 1024 * 1024)
        throw new VmotionError('REVIEW_BUDGET', 'Color review exceeds 64M rendered pixels');
      const start = performance.now(),
        image = await renderer.render(context.snapshot, frame, context.options);
      try {
        const rgba = image.getContext('2d').getImageData(0, 0, image.width, image.height).data,
          options: PixelEvidenceOptions = {
            ...p,
            distributions: p.includeDistributions || p.images,
          },
          result = pixelEvidence(rgba, image.width, image.height, options),
          { histogram, waveform, vectorscope, ...summary } = result;
        samples.push({
          frame,
          width: image.width,
          height: image.height,
          pixelHash: hash(Buffer.from(rgba)),
          ...summary,
          ...(p.includeDistributions ? { histogram, waveform, vectorscope } : {}),
          elapsedMs: performance.now() - start,
        });
        if (sheet) paintScopes(sheet, index * 174, image, result, frame);
      } finally {
        image.width = 1;
        image.height = 1;
      }
    }
    await assets.verify();
    let output: string | undefined, data: string | undefined;
    if (sheet) {
      output = path.resolve(
        p.output ?? safePath(root, `.vmotion/pixel-review/scopes-${randomUUID()}.png`),
      );
      const buffer = await sheet.encode('png');
      await atomicWrite(output, buffer);
      if (inline) data = buffer.toString('base64');
    }
    return {
      revision: snapshot.revision,
      gpu: renderer.gpu.report(),
      scope: p.scope,
      samples,
      coverage: {
        requestedFrames: p.frames.length,
        sampledFrames: samples.length,
        renderedPixels: pixels,
        fullPixelCoverage:
          p.analysis === 'full' || samples.every((s: any) => s.coverage.fullPixelCoverage),
        completeTrajectory: false,
      },
      assets: { checked: assets.checks.length, fingerprintDigest: assets.digest },
      projection: { distributionsIncluded: p.includeDistributions },
      units:
        'Normalized encoded SDR sRGB channels and weighted Rec.709 luma/UV; percentile values are bin midpoints, not exact quantiles.',
      limitations: [
        'Final sampled native composites at explicit output dimensions; scope/ROI exclude unsampled frames and pixels.',
        'Visible ignores transparent pixels, weighted weights straight RGB by alpha, black composites straight RGB over black. Flat/clipped/highlight statistics are evidence, not artistic errors or HDR/OCIO color management.',
        'Sampling uses a raster stride and may miss patterns; image/hash media/metadata checks do not prove semantic content.',
      ],
      ...(output ? { output, mimeType: 'image/png' } : {}),
      ...(data ? { data } : {}),
    };
  } finally {
    if (sheet) {
      sheet.width = 1;
      sheet.height = 1;
    }
    await renderer.close();
  }
}
