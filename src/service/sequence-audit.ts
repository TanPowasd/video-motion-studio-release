import { z } from 'zod';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot, type Diagnostic } from '../core/model.js';
import {
  sequenceSourcesAt,
  sequenceSampleCandidates,
  stratifiedFrames,
} from '../core/sequence-inspection.js';
import { clipContentDuration } from '../core/clip-window.js';
import { auditFrame, visualOptionsSchema } from '../core/visual-audit.js';
import { safePath, hash, atomicWrite } from './project.js';
import { inspectMedia } from './media-evidence.js';
import { errorDiagnostics } from './agent.js';
export const sequenceAuditSchema = z
  .object({
    sequenceId: z.string().optional(),
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    frames: z.array(z.number().int().nonnegative()).min(1).max(120).optional(),
    maxFrames: z.number().int().min(2).max(120).default(24),
    maxFindings: z.number().int().min(1).max(300).default(80),
    images: z.boolean().default(true),
    width: z.number().int().min(160).max(800).default(320),
    maxImages: z.number().int().min(1).max(12).default(8),
    probeMedia: z.boolean().default(true),
    options: visualOptionsSchema.default({}),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
type Finding = {
  code: string;
  severity: 'error' | 'review';
  message?: string;
  sequenceId?: string;
  trackId?: string;
  clipId?: string;
  frame?: number;
  sourceFrame?: number;
  sceneId?: string;
  nodeId?: string;
  locator?: unknown;
  metrics?: Record<string, number>;
  bounds?: unknown;
};
export async function auditSequence(root: string, snapshot: Snapshot, raw: unknown) {
  const request = sequenceAuditSchema.parse(raw),
    sequenceId = request.sequenceId ?? snapshot.project.activeSequence,
    sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audit sequence is missing');
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before sequence audit');
  const proposed = request.frames
    ? [...new Set(request.frames)]
        .sort((a, b) => a - b)
        .map((frame) => ({ frame, reasons: ['explicit'] }))
    : sequenceSampleCandidates(snapshot, sequenceId);
  if (proposed.some((f) => f.frame >= sequence.duration))
    throw new VmotionError('FRAME_RANGE', 'Audit samples lie beyond sequence');
  const selected = request.frames ? proposed : stratifiedFrames(proposed, request.maxFrames),
    findings: Finding[] = [],
    diagnostics: Diagnostic[] = [],
    media = new Map<string, Awaited<ReturnType<typeof inspectMedia>>>(),
    structural = [];
  let omitted = 0;
  const add = (finding: Finding) => {
      if (findings.length < request.maxFindings) findings.push(finding);
      else omitted++;
    },
    visited = new Set<string>();
  const visit = async (id: string, ancestors: string[]) => {
    if (ancestors.includes(id) || ancestors.length > 32)
      throw new VmotionError('NESTING_DEPTH', 'Sequence audit nesting is cyclic or too deep');
    if (visited.has(id)) return;
    visited.add(id);
    const seq = snapshot.sequences.find((s) => s.id === id)!;
    for (const track of seq.tracks) {
      const intervals = track.clips
        .filter((c) => track.type === 'video' && !track.muted)
        .slice()
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < intervals.length; i++)
        if (intervals[i].start < intervals[i - 1].start + clipContentDuration(intervals[i - 1]))
          add({
            code: 'CLIP_OVERLAP',
            severity: 'review',
            sequenceId: id,
            trackId: track.id,
            clipId: intervals[i].id,
            message:
              'Same-track clips overlap; review intentional layering or transition placement.',
          });
      for (const clip of track.clips) {
        let length: number | undefined;
        if (clip.sceneId) length = snapshot.scenes.find((s) => s.id === clip.sceneId)?.duration;
        else if (clip.sequenceId) {
          length = snapshot.sequences.find((s) => s.id === clip.sequenceId)?.duration;
          await visit(clip.sequenceId, [...ancestors, id]);
        } else if (clip.assetId) {
          const asset = snapshot.project.assets.find((a) => a.id === clip.assetId);
          if (request.probeMedia) {
            try {
              if (!media.has(clip.assetId))
                media.set(
                  clip.assetId,
                  await inspectMedia(root, snapshot, { assetId: clip.assetId }),
                );
              length = media.get(clip.assetId)!.sourceEnd;
            } catch (e) {
              diagnostics.push(...errorDiagnostics(e));
              add({
                code: 'MEDIA_ERROR',
                severity: 'error',
                sequenceId: id,
                trackId: track.id,
                clipId: clip.id,
                message: (e as Error).message,
              });
            }
          } else if (asset && Number(asset.metadata.duration) > 0)
            length =
              (Number(asset.metadata.duration) * snapshot.project.fps.num) /
              snapshot.project.fps.den;
        }
        structural.push({
          sequenceId: id,
          trackId: track.id,
          clipId: clip.id,
          start: clip.start,
          end: clip.start + clipContentDuration(clip),
          sourceEnd: length,
        });
        if (clip.start + clipContentDuration(clip) > seq.duration + 1e-7)
          add({
            code: 'CLIP_OUTSIDE_SEQUENCE',
            severity: 'error',
            sequenceId: id,
            trackId: track.id,
            clipId: clip.id,
            message: 'Clip extends past its sequence output.',
          });
        if (
          length !== undefined &&
          clip.sourceIn + (Math.ceil(clipContentDuration(clip)) - 1) * clip.speed >= length + 1e-7
        )
          add({
            code: 'SOURCE_RANGE',
            severity: 'error',
            sequenceId: id,
            trackId: track.id,
            clipId: clip.id,
            message: 'Clip requires a source frame beyond available content.',
          });
      }
    }
  };
  await visit(sequenceId, []);
  const copy = structuredClone(snapshot);
  copy.project.activeSequence = sequenceId;
  const renderer = new Renderer(root),
    samples: Array<{
      frame: number;
      reasons: string[];
      sources: ReturnType<typeof sequenceSourcesAt>;
      pixelHash?: string;
      renderMs?: number;
      pixel?: { visibleRatio: number; meanLuma: number; variance: number };
      status: 'passed' | 'failed';
    }> = [],
    tiles: Array<{ frame: number; buffer: Buffer }> = [],
    evidenceFrames = new Set(stratifiedFrames(selected, request.maxImages).map((s) => s.frame)),
    height = Math.max(
      16,
      Math.round((request.width * snapshot.project.height) / snapshot.project.width),
    );
  try {
    for (const sample of selected) {
      const sources = sequenceSourcesAt(copy, sequenceId, sample.frame),
        entry: (typeof samples)[number] = { ...sample, sources, status: 'passed' };
      try {
        if (!sources.length)
          add({
            code: 'VISUAL_GAP',
            severity: 'review',
            frame: sample.frame,
            message:
              'No visible video-track source at this sampled frame; check intentional blank/fades.',
          });
        for (const source of sources.filter((s) => s.type === 'scene')) {
          const scene = copy.scenes.find((s) => s.id === source.id)!;
          const graph = await renderer.inspectInteractions(copy, source.id, source.frame, [], {
              includeEmpty: true,
            }),
            checked = auditFrame(
              graph.layers,
              scene.width ?? copy.project.width,
              scene.height ?? copy.project.height,
              source.frame,
              request.options,
            );
          for (const finding of checked.findings) {
            const layer = graph.layers.find((l) => l.node.id === finding.nodeId);
            add({
              ...finding,
              frame: sample.frame,
              sourceFrame: source.frame,
              sceneId: source.id,
              sequenceId: source.sequenceId,
              trackId: source.trackId,
              clipId: source.clipId,
              locator: {
                sceneId: source.id,
                nodeId: finding.nodeId,
                path: finding.path,
                frame: layer?.frame ?? source.frame,
                contextFrames: layer?.contextFrames ?? [],
              },
            });
          }
          omitted += checked.omitted;
        }
        const started = performance.now(),
          canvas = await renderer.render(copy, sample.frame, { width: request.width, height });
        try {
          const pixels = canvas.getContext('2d').getImageData(0, 0, request.width, height).data;
          let sum = 0,
            squared = 0,
            visible = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const value =
              (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
            sum += value;
            squared += value * value;
            if (pixels[i + 3] > 0) visible++;
          }
          const count = pixels.length / 4;
          entry.pixel = {
            visibleRatio: visible / count,
            meanLuma: sum / count,
            variance: Math.max(0, squared / count - (sum / count) ** 2),
          };
          entry.pixelHash = hash(Buffer.from(pixels));
          entry.renderMs = performance.now() - started;
          if (entry.pixel.variance < 1e-7)
            add({
              code: 'FLAT_FRAME',
              severity: 'review',
              frame: sample.frame,
              message: 'Rendered composite is nearly uniform; review intended solid/fade frames.',
              metrics: entry.pixel,
            });
          if (request.images && evidenceFrames.has(sample.frame))
            tiles.push({ frame: sample.frame, buffer: await canvas.encode('png') });
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      } catch (e) {
        entry.status = 'failed';
        diagnostics.push(...errorDiagnostics(e));
        add({
          code: 'FRAME_ERROR',
          severity: 'error',
          frame: sample.frame,
          message: (e as Error).message,
        });
      }
      samples.push(entry);
    }
    let output: string | undefined, data: string | undefined;
    if (request.images && tiles.length) {
      const { loadImage } = await import('@napi-rs/canvas'),
        columns = Math.min(4, tiles.length),
        sheet = createCanvas(
          columns * request.width,
          Math.ceil(tiles.length / columns) * (height + 28),
        ),
        ctx = sheet.getContext('2d');
      ctx.fillStyle = '#111b2c';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      for (const [i, tile] of tiles.entries()) {
        const x = (i % columns) * request.width,
          y = Math.floor(i / columns) * (height + 28);
        ctx.drawImage(await loadImage(tile.buffer), x, y);
        ctx.fillStyle = '#c4d7ed';
        ctx.font = '12px "Microsoft YaHei"';
        ctx.fillText(
          `${tile.frame}f / ${((tile.frame * snapshot.project.fps.den) / snapshot.project.fps.num).toFixed(2)}s`,
          x + 8,
          y + height + 19,
        );
      }
      const buffer = await sheet.encode('png');
      sheet.width = 1;
      output = path.resolve(
        request.output ??
          safePath(
            root,
            `.vmotion/sequence-audit/${snapshot.revision}-${hash(JSON.stringify(request)).slice(0, 16)}.png`,
          ),
      );
      await atomicWrite(output, buffer);
      if (request.inline) data = buffer.toString('base64');
    }
    const errors = findings.filter((f) => f.severity === 'error').length,
      reviews = findings.length - errors;
    return {
      revision: snapshot.revision,
      sequenceId,
      duration: sequence.duration,
      fps: snapshot.project.fps,
      summary: {
        errors,
        reviews,
        omitted,
        status:
          errors || diagnostics.length
            ? 'failed'
            : omitted || selected.length < proposed.length
              ? 'incomplete'
              : reviews
                ? 'review'
                : 'clear',
      },
      coverage: {
        structuralSequences: visited.size,
        structuralClips: structural.length,
        proposedFrames: proposed.length,
        sampledFrames: selected.length,
        omittedFrames: proposed.length - selected.length,
        fullFrameCoverage: selected.length === sequence.duration,
      },
      samples,
      evidenceFrames: tiles.map((tile) => tile.frame),
      findings: findings.map((f) => ({
        ...f,
        id: hash(JSON.stringify([snapshot.revision, sequenceId, f])).slice(0, 24),
      })),
      diagnostics,
      assetChecks: [...media.values()].flatMap((m) => m.assetChecks ?? [m.assetCheck]),
      limitations: [
        'Structural clip checks cover traversed sequences; visual evidence covers only selected output frames.',
        'Scene geometry findings locate source objects; final composite pixels include masks/effects but do not prove per-object visibility or artistic intent.',
        'Audio synchronization and sound quality require sample-based audio checks; clip/story bindings alone do not prove intelligibility.',
      ],
      ...(output ? { output, mimeType: 'image/png' } : {}),
      ...(data ? { data } : {}),
    };
  } finally {
    await renderer.close();
  }
}
