import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { comparePixels } from '../core/pixel-evidence.js';
import {
  reviewScopeSchema,
  reviewImageSize,
  pixelRegionSchema,
  planRef,
  pixelReviewContext,
  reviewAssets,
  drawReviewTile,
} from './pixel-review-context.js';
import { atomicWrite, safePath, hash } from './project.js';
export const frameCompareSchema = z
  .object({
    revision: z.string().optional(),
    baselinePlanId: planRef,
    planId: planRef,
    scope: reviewScopeSchema.default({}),
    compareScope: reviewScopeSchema.optional(),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(6).default([0]),
    compareFrames: z.array(z.number().finite().nonnegative()).min(1).max(6).optional(),
    ...reviewImageSize,
    region: pixelRegionSchema.optional(),
    tolerance: z.number().int().min(0).max(255).default(0),
    determinism: z.boolean().default(true),
    images: z.boolean().default(true),
    output: z.string().optional(),
  })
  .strict();
export async function compareFrames(
  root: string,
  left: Snapshot,
  right: Snapshot,
  raw: unknown,
  inline = false,
) {
  const p = frameCompareSchema.parse(raw),
    otherFrames = p.compareFrames ?? p.frames;
  if (otherFrames.length !== p.frames.length)
    throw new VmotionError('REVIEW_FRAMES', 'Compare frame arrays must have equal length');
  const leftAssets = await reviewAssets(root, left),
    rightAssets = await reviewAssets(root, right),
    a = new Renderer(root),
    b = new Renderer(root),
    sheet = p.images ? createCanvas(960, p.frames.length * 210) : undefined,
    samples = [];
  let work = 0;
  const read = (image: Canvas) =>
    image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  try {
    for (const [index, frame] of p.frames.entries()) {
      await leftAssets.verify();
      await rightAssets.verify();
      const ca = await pixelReviewContext(a, left, p.scope, frame, p.width, p.height),
        cb = await pixelReviewContext(
          b,
          right,
          p.compareScope ?? p.scope,
          otherFrames[index],
          p.width,
          p.height,
        );
      if (ca.options.width !== cb.options.width || ca.options.height !== cb.options.height)
        throw new VmotionError(
          'REVIEW_DIMENSIONS',
          'Compare scopes have different aspect ratios; supply explicit width/height',
        );
      work += p.width * ca.options.height * (p.determinism ? 4 : 2);
      if (work > 64 * 1024 * 1024)
        throw new VmotionError('REVIEW_BUDGET', 'Frame comparison exceeds 64M rendered pixels');
      const start = performance.now();
      let ai: Canvas | undefined, bi: Canvas | undefined;
      try {
        ai = await a.render(ca.snapshot, frame, ca.options);
        bi = await b.render(cb.snapshot, otherFrames[index], cb.options);
        const ap = read(ai),
          bp = read(bi),
          beforeHash = hash(Buffer.from(ap)),
          afterHash = hash(Buffer.from(bp)),
          difference = comparePixels(ap, bp, ai.width, ai.height, {
            region: p.region,
            tolerance: p.tolerance,
            diff: !!sheet,
          }),
          { diff, ...metrics } = difference;
        let stableBefore: boolean | undefined, stableAfter: boolean | undefined;
        if (p.determinism) {
          const ar = await a.render(ca.snapshot, frame, ca.options);
          try {
            stableBefore = hash(Buffer.from(read(ar))) === beforeHash;
          } finally {
            ar.width = 1;
            ar.height = 1;
          }
          const br = await b.render(cb.snapshot, otherFrames[index], cb.options);
          try {
            stableAfter = hash(Buffer.from(read(br))) === afterHash;
          } finally {
            br.width = 1;
            br.height = 1;
          }
        }
        samples.push({
          frame,
          compareFrame: otherFrames[index],
          width: ai.width,
          height: ai.height,
          beforeHash,
          afterHash,
          ...metrics,
          determinism: { checked: p.determinism, before: stableBefore, after: stableAfter },
          result:
            p.determinism && (!stableBefore || !stableAfter)
              ? 'inconclusive'
              : metrics.changedPixels
                ? 'changes-composite'
                : 'no-sampled-pixel-change',
          elapsedMs: performance.now() - start,
        });
        if (sheet) {
          const ctx = sheet.getContext('2d'),
            y = index * 210,
            height = 180,
            tile = 320;
          ctx.fillStyle = '#101a2a';
          ctx.fillRect(0, y, 960, 210);
          drawReviewTile(sheet, ai, 0, y + 27, tile, height);
          drawReviewTile(sheet, bi, tile, y + 27, tile, height);
          const di = createCanvas(ai.width, ai.height);
          try {
            di.getContext('2d').putImageData(new ImageData(diff!, ai.width, ai.height), 0, 0);
            drawReviewTile(sheet, di, tile * 2, y + 27, tile, height);
          } finally {
            di.width = 1;
            di.height = 1;
          }
          ctx.fillStyle = '#ccd8eb';
          ctx.font = '12px "Microsoft YaHei"';
          ctx.textBaseline = 'top';
          ctx.fillText(`修改前 ${frame}f`, 10, y + 7);
          ctx.fillText(`修改后 ${otherFrames[index]}f`, tile + 10, y + 7);
          ctx.fillText(`差分 · ${(metrics.changedRatio * 100).toFixed(2)}%`, tile * 2 + 10, y + 7);
        }
      } finally {
        if (ai) {
          ai.width = 1;
          ai.height = 1;
        }
        if (bi) {
          bi.width = 1;
          bi.height = 1;
        }
      }
    }
    await leftAssets.verify();
    await rightAssets.verify();
    let output: string | undefined, data: string | undefined;
    if (sheet) {
      output = path.resolve(
        p.output ?? safePath(root, `.vmotion/pixel-review/compare-${randomUUID()}.png`),
      );
      const buffer = await sheet.encode('png');
      await atomicWrite(output, buffer);
      if (inline) data = buffer.toString('base64');
    }
    return {
      baseRevision: left.revision,
      gpu: { baseline: a.gpu.report(), candidate: b.gpu.report() },
      revision: right.revision,
      scope: p.scope,
      compareScope: p.compareScope ?? p.scope,
      samples,
      coverage: {
        comparedFrames: samples.length,
        renderedPixels: work,
        completeTrajectory: false,
        fullPixelCoverage: !p.region,
      },
      assets: {
        baseline: { checked: leftAssets.checks.length, fingerprintDigest: leftAssets.digest },
        candidate: { checked: rightAssets.checks.length, fingerprintDigest: rightAssets.digest },
      },
      summary: {
        changedFrames: samples.filter((s: any) => s.changedPixels > 0).length,
        nondeterministicFrames: samples.filter(
          (s: any) => s.determinism.checked && (!s.determinism.before || !s.determinism.after),
        ).length,
      },
      differenceMetric:
        'Absolute premultiplied SDR RGBA difference; alpha counts independently, fully transparent RGB does not create visual differences. RMS/means include all ROI pixels; changedBounds use tolerance.',
      limitations: [
        'Native sampled composites at explicit dimensions/ROI; difference size does not measure improvement, semantic correctness or perceptual quality.',
        'Repeated samples can expose stateful code but do not prove all frames deterministic. Registered media checked by size/mtime or editable sound source hash, not cryptographic file locking.',
        'Focused views exclude ancestor/output operations outside that scope. Compare frame arrays may use different times intentionally.',
      ],
      ...(output ? { output, mimeType: 'image/png' } : {}),
      ...(data ? { data } : {}),
    };
  } finally {
    if (sheet) {
      sheet.width = 1;
      sheet.height = 1;
    }
    await Promise.all([a.close(), b.close()]);
  }
}
