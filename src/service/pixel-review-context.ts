import path from 'node:path';
import { z } from 'zod';
import type { Canvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import { checkAssets, type AssetCheck } from './media-evidence.js';
import { fingerprint } from '../media/ffmpeg.js';
import { soundResource } from '../media/sound-source.js';
import { hash } from './project.js';
export const reviewScopeSchema = z
  .object({
    sceneId: z.string().optional(),
    sequenceId: z.string().optional(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
  })
  .strict();
export const pixelRegionSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const reviewImageSize = {
  width: z.number().int().min(160).max(3840).default(640),
  height: z.number().int().min(16).max(2160).optional(),
};
export const planRef = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();
/** Keep scope evidence at its real aspect ratio inside contact-sheet cells. */
export function drawReviewTile(
  sheet: Canvas,
  image: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width / image.width, height / image.height),
    w = image.width * scale,
    h = image.height * scale;
  sheet.getContext('2d').drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}
export async function reviewAssets(root: string, snapshot: Snapshot) {
  const checks: AssetCheck[] = [];
  for (let at = 0; at < snapshot.project.assets.length; at += 16)
    checks.push(
      ...(await Promise.all(
        snapshot.project.assets.slice(at, at + 16).map(async (asset) => {
          try {
            return {
              assetId: asset.id,
              fingerprint: asset.soundSource
                ? `source:${soundResource(snapshot, asset).hash}`
                : await fingerprint(path.resolve(root, asset.path)),
            };
          } catch {
            throw new VmotionError('ASSET_CHANGED', 'Review asset is unavailable', {
              assetId: asset.id,
            });
          }
        }),
      )),
    );
  return {
    checks,
    digest: hash(JSON.stringify(checks)),
    verify: () => checkAssets(root, snapshot, checks),
  };
}
export async function pixelReviewContext(
  renderer: Renderer,
  snapshot: Snapshot,
  raw: z.output<typeof reviewScopeSchema>,
  frame: number,
  width: number,
  height?: number,
) {
  if (raw.sceneId && raw.sequenceId)
    throw new VmotionError('REVIEW_SCOPE', 'Choose a scene or a sequence');
  if (raw.path.length && !raw.sceneId)
    throw new VmotionError('REVIEW_SCOPE', 'Focused path requires a scene');
  if (!raw.path.length && raw.contextFrames.length)
    throw new VmotionError('REVIEW_SCOPE', 'Ancestor clocks require a focused path');
  const scope = raw.sceneId
      ? await renderer.inspectComposition(snapshot, raw.sceneId, frame, raw.path, raw.contextFrames)
      : undefined,
    sequenceId = raw.sequenceId ?? snapshot.project.activeSequence,
    sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Review sequence is missing');
  const duration = scope?.scene.duration ?? sequence.duration;
  if (!Number.isFinite(frame) || frame < 0 || frame >= duration)
    throw new VmotionError('FRAME_RANGE', 'Review sample lies beyond its local scope', {
      frame,
      duration,
    });
  const h =
    height ??
    Math.round(
      width *
        (scope ? scope.height / scope.width : snapshot.project.height / snapshot.project.width),
    );
  if (h < 16 || h > 2160)
    throw new VmotionError(
      'RESOLUTION',
      'Review aspect ratio exceeds supported height; supply explicit dimensions',
    );
  return {
    snapshot: raw.sceneId
      ? snapshot
      : { ...snapshot, project: { ...snapshot.project, activeSequence: sequenceId } },
    options: {
      width,
      height: h,
      sceneId: raw.sceneId,
      path: raw.path,
      contextFrames: raw.contextFrames,
    },
    duration,
    logicalSize: {
      width: scope?.width ?? snapshot.project.width,
      height: scope?.height ?? snapshot.project.height,
    },
    scope: {
      sceneId: raw.sceneId,
      sequenceId: raw.sceneId ? undefined : sequenceId,
      path: raw.path,
      contextFrames: raw.contextFrames,
    },
  };
}
