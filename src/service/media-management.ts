import { z } from 'zod';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { loadImage } from '@napi-rs/canvas';
import { VmotionError, type Snapshot, type Operation, type Asset } from '../core/model.js';
import { probe, fingerprint } from '../media/ffmpeg.js';
import { videoProxy, type ProxyManager } from '../media/proxy-cache.js';
import { applyOperations } from './operations.js';
import { validateSnapshot } from './project.js';
import { storeAgentPlan } from './agent-plans.js';
import { clipContentDuration } from '../core/clip-window.js';
const id = z.string().min(1).max(200);
export const mediaStatusSchema = z
  .object({
    assetIds: z.array(id).max(500).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
    probe: z.boolean().default(false),
  })
  .strict();
export const mediaProxySchema = z
  .object({
    action: z.enum(['start', 'status', 'cancel', 'inspect', 'release']),
    assetIds: z.array(id).min(1).max(8).optional(),
    jobId: z.string().optional(),
    width: z.number().int().min(128).max(1920).default(960),
    revision: z.string().optional(),
  })
  .strict();
export const mediaRelinkSchema = z
  .object({
    revision: z.string().optional(),
    items: z
      .array(
        z
          .object({
            assetId: id,
            path: z.string().min(1),
            policy: z.enum(['compatible', 'replace']).default('compatible'),
            expectedPath: z.string().optional(),
            expectedFingerprint: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
async function mediaMetadata(file: string, type: Asset['type']): Promise<Record<string, unknown>> {
  if (type === 'image') {
    const image = await loadImage(file);
    return { width: image.width, height: image.height };
  }
  if (type === 'video' || type === 'audio') {
    const info = await probe(file),
      video = info.streams.find((s) => s.codec_type === 'video'),
      audio = info.streams.find((s) => s.codec_type === 'audio'),
      duration = Number(info.format.duration ?? video?.duration ?? audio?.duration);
    if ((type === 'video' && !video) || (type === 'audio' && !audio))
      throw new VmotionError('MEDIA_TYPE', 'Replacement has no required stream');
    if (!Number.isFinite(duration) || duration <= 0)
      throw new VmotionError('MEDIA_DURATION', 'Replacement has no finite duration');
    return {
      duration,
      hasVideo: !!video,
      hasAudio: !!audio,
      ...(video ? { width: video.width, height: video.height } : {}),
      ...(audio ? { sampleRate: Number(audio.sample_rate), channels: audio.channels } : {}),
    };
  }
  throw new VmotionError(
    'MEDIA_RELINK_TYPE',
    'Relink supports image/video/audio files; editable drawing/sound/font documents use their own authoring flow',
  );
}
export async function mediaStatus(root: string, snapshot: Snapshot, raw: unknown) {
  const request = mediaStatusSchema.parse(raw),
    assets = snapshot.project.assets.filter(
      (a) => !request.assetIds || request.assetIds.includes(a.id),
    );
  if (request.assetIds?.some((id) => !assets.some((a) => a.id === id)))
    throw new VmotionError('MISSING_ASSET', 'Selected asset does not exist');
  const page = assets.slice(request.offset, request.offset + request.limit),
    items = [];
  for (const asset of page) {
    const file = path.resolve(root, asset.path);
    let status = 'ready',
      stamp: string | undefined,
      error: string | undefined,
      metadata = asset.metadata,
      proxy;
    try {
      if (!(await stat(file)).isFile()) throw new Error('Not a regular file');
      stamp = await fingerprint(file);
      if (request.probe && !asset.soundSource && ['image', 'video', 'audio'].includes(asset.type))
        metadata = await mediaMetadata(file, asset.type);
      if (asset.type === 'video') proxy = await videoProxy(root, snapshot, asset);
    } catch (e) {
      status = 'missing-or-invalid';
      error = (e as Error).message;
    }
    items.push({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      path: asset.path,
      status,
      fingerprint: stamp,
      metadata,
      proxy: proxy
        ? {
            status: 'ready',
            width: proxy.width,
            height: proxy.height,
            fps: proxy.fps,
            path: proxy.output,
          }
        : { status: 'none-or-stale' },
      ...(error ? { error } : {}),
    });
  }
  return {
    revision: snapshot.revision,
    assets: {
      total: assets.length,
      offset: request.offset,
      items,
      hasMore: request.offset + page.length < assets.length,
    },
    units: { timeline: 'rational project frames', mediaDuration: 'seconds' },
    workflow:
      'Create/inspect proxy tasks without changing the project. Relink explicit paths through media_relink_plan, preflight/apply the fixed candidate with source checks for one undo.',
  };
}
export async function proxyOperation(
  root: string,
  snapshot: Snapshot,
  manager: ProxyManager,
  raw: unknown,
) {
  const request = mediaProxySchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before proxy operation');
  switch (request.action) {
    case 'release':
      throw new VmotionError(
        'PROXY_RELEASE',
        'Release preview readers through the project application',
      );
    case 'status':
      return manager.status(request.jobId);
    case 'cancel':
      if (!request.jobId) throw new VmotionError('PROXY_JOB', 'Choose a proxy job to cancel');
      return manager.cancel(request.jobId);
    case 'inspect':
      return mediaStatus(root, snapshot, { assetIds: request.assetIds, limit: 100 });
    case 'start':
      if (!request.assetIds) throw new VmotionError('PROXY_SOURCE', 'Choose video asset IDs');
      if (new Set(request.assetIds).size !== request.assetIds.length)
        throw new VmotionError('PROXY_SOURCE', 'Proxy asset IDs must be unique');
      for (const id of request.assetIds)
        if (!snapshot.project.assets.some((a) => a.id === id && a.type === 'video'))
          throw new VmotionError('PROXY_SOURCE', 'Proxy inputs must be video assets');
      if (
        manager.active + request.assetIds.length > 8 ||
        request.assetIds.some((id) =>
          [...manager.jobs.values()].some(
            (j) => j.assetId === id && ['queued', 'running'].includes(j.status),
          ),
        )
      )
        throw new VmotionError(
          'PROXY_BUSY',
          'Proxy batch would exceed the queue or duplicate active tasks',
        );
      return {
        revision: snapshot.revision,
        jobs: request.assetIds.map((id) => manager.start(snapshot, id, request.width)),
      };
  }
}
export async function planMediaRelink(root: string, snapshot: Snapshot, raw: unknown) {
  const request = mediaRelinkSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before relinking');
  if (new Set(request.items.map((i) => i.assetId)).size !== request.items.length)
    throw new VmotionError('MEDIA_RELINK_ID', 'Use one replacement per stable asset ID');
  const assets = structuredClone(snapshot.project.assets),
    changes = [],
    checks = [];
  for (const item of request.items) {
    const asset = assets.find((a) => a.id === item.assetId);
    if (!asset) throw new VmotionError('MISSING_ASSET', 'Asset not found');
    if (asset.soundSource || !['image', 'audio', 'video'].includes(asset.type))
      throw new VmotionError('MEDIA_RELINK_TYPE', 'Relink regular image/video/audio assets');
    if (item.expectedPath && item.expectedPath !== asset.path)
      throw new VmotionError('MEDIA_RELINK_STALE', 'Asset path changed since inspection');
    if (item.expectedFingerprint) {
      let actual;
      try {
        actual = await fingerprint(path.resolve(root, asset.path));
      } catch {
        actual = asset.fingerprint;
      }
      if (actual !== item.expectedFingerprint)
        throw new VmotionError('ASSET_CHANGED', 'Previous media evidence no longer matches');
    }
    const replacement = path.resolve(root, item.path),
      before = await fingerprint(replacement);
    if (!(await stat(replacement)).isFile())
      throw new VmotionError('MEDIA_RELINK_TYPE', 'Replacement is not a regular file');
    const metadata = await mediaMetadata(replacement, asset.type),
      original = asset.metadata,
      frameSeconds = snapshot.project.fps.den / snapshot.project.fps.num;
    if (item.policy === 'compatible') {
      for (const field of ['width', 'height', 'hasAudio', 'hasVideo', 'channels'] as const)
        if (
          original[field] !== undefined &&
          metadata[field] !== undefined &&
          metadata[field] !== original[field]
        )
          throw new VmotionError(
            'MEDIA_RELINK_COMPATIBILITY',
            'Replacement differs from registered stream/layout metadata',
            {
              assetId: asset.id,
              field,
              original: original[field],
              replacement: metadata[field],
              recovery: 'Choose an explicit replace policy if changing media is intentional.',
            },
          );
      if (
        original.duration !== undefined &&
        Math.abs(Number(original.duration) - Number(metadata.duration)) > frameSeconds
      )
        throw new VmotionError(
          'MEDIA_RELINK_COMPATIBILITY',
          'Replacement duration differs by more than one project frame',
        );
    }
    if ((await fingerprint(replacement)) !== before)
      throw new VmotionError('ASSET_CHANGED', 'Replacement changed during probing');
    const relative = path.relative(root, replacement),
      nextPath =
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
          ? relative.split(path.sep).join('/')
          : replacement;
    changes.push({
      assetId: asset.id,
      from: asset.path,
      to: nextPath,
      policy: item.policy,
      previous: original,
      metadata,
    });
    asset.path = nextPath;
    asset.managed = asset.managed && !path.isAbsolute(nextPath);
    asset.metadata = { ...original, ...metadata };
    asset.fingerprint = before;
    checks.push({ assetId: asset.id, fingerprint: before });
    if (Number(metadata.duration) > 0) {
      const end = (Number(metadata.duration) * snapshot.project.fps.num) / snapshot.project.fps.den;
      for (const sequence of snapshot.sequences)
        for (const track of sequence.tracks)
          for (const clip of track.clips.filter((c) => c.assetId === asset.id))
            if (clip.sourceIn + (Math.ceil(clipContentDuration(clip)) - 1) * clip.speed >= end)
              throw new VmotionError(
                'MEDIA_RELINK_RANGE',
                'Replacement is shorter than an existing timeline use',
                { assetId: asset.id, sequenceId: sequence.id, clipId: clip.id, sourceEnd: end },
              );
    }
  }
  const operations: Operation[] = [{ type: 'updateProject', patch: { assets } }],
    candidate = applyOperations(root, snapshot, operations),
    diagnostics = await validateSnapshot(root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError(
      'VALIDATION_FAILED',
      'Relink candidate has unresolved project errors',
      diagnostics,
    );
  const samples = [
    ...new Set(
      snapshot.sequences
        .find((s) => s.id === snapshot.project.activeSequence)!
        .tracks.flatMap((t) =>
          t.clips
            .filter((c) => request.items.some((i) => i.assetId === c.assetId))
            .flatMap((c) => [
              c.start,
              Math.floor(c.start + c.duration / 2),
              c.start + c.duration - 1,
            ]),
        ),
    ),
  ]
    .filter(
      (f) => f < snapshot.sequences.find((s) => s.id === snapshot.project.activeSequence)!.duration,
    )
    .slice(0, 12)
    .map((frame) => ({ frame }));
  const input = {
      revision: snapshot.revision,
      operations,
      assetChecks: checks,
      samples,
      width: 320,
      determinism: true,
    },
    plan = request.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    changes,
    assetCheckCount: checks.length,
    ...(plan ? { plan } : {}),
    candidate: plan ? { planId: plan.planId } : input,
    apply: {
      ...(plan ? { planId: plan.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
    limitations: [
      'Compatibility compares registered metadata, not historical file content or scene-code artistic intent.',
      'Paths use existing files by reference; files are not moved or overwritten. Asset IDs and all references stay stable.',
    ],
  };
}
