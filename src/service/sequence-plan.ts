import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  clipSchema,
  sequenceSchema,
  VmotionError,
  type Snapshot,
  type Clip,
  type Operation,
  type Sequence,
} from '../core/model.js';
import { clipPiece } from '../core/editing.js';
import { inspectMedia, checkAssets, assetCheckSchema } from './media-evidence.js';
import { applyOperations } from './operations.js';
import { validateSnapshot } from './project.js';

const frame = z.number().int().nonnegative();
export const sequencePlanSchema = z
  .object({
    revision: z.string().optional(),
    sequenceId: z.string().optional(),
    assetChecks: z.array(assetCheckSchema).max(1000).default([]),
    items: z
      .array(
        z
          .object({
            source: z
              .object({ type: z.enum(['asset', 'scene', 'sequence']), id: z.string().min(1) })
              .strict(),
            trackId: z.string().min(1),
            mode: z.enum(['append', 'insert', 'overwrite']).default('append'),
            at: frame.optional(),
            sourceIn: z.number().finite().nonnegative().default(0),
            sourceOut: z.number().finite().positive().optional(),
            duration: z.number().int().positive().optional(),
            speed: z.number().finite().positive().max(100).default(1),
            audioTrackId: z.string().optional(),
            audioEnabled: z.boolean().default(true),
            volume: z.number().finite().min(0).max(4).default(1),
            fadeIn: frame.default(0),
            fadeOut: frame.default(0),
            name: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

function insertTime(sequence: Sequence, at: number, duration: number) {
  if (at > sequence.duration)
    throw new VmotionError('EDIT_RANGE', 'Insert must be within the sequence');
  const groups = new Map<string, string>();
  for (const track of sequence.tracks) {
    if (track.locked && track.clips.some((c) => c.start + c.duration > at))
      throw new VmotionError('TRACK_LOCKED', 'Insert would shift or split a locked track');
    track.clips = track.clips.flatMap((clip) => {
      if (clip.start >= at) return [{ ...clip, start: clip.start + duration }];
      if (clip.start + clip.duration <= at) return [clip];
      const left = clipPiece(clip, clip.start, at),
        right = clipPiece(clip, at, clip.start + clip.duration, randomUUID());
      right.start += duration;
      if (clip.linkedGroup) {
        if (!groups.has(clip.linkedGroup)) groups.set(clip.linkedGroup, randomUUID());
        right.linkedGroup = groups.get(clip.linkedGroup);
      }
      return [left, right];
    });
  }
  sequence.markers = sequence.markers.map((m) => ({
    ...m,
    frame: m.frame >= at ? m.frame + duration : m.frame,
  }));
  if (sequence.workArea)
    sequence.workArea = {
      start:
        sequence.workArea.start >= at
          ? sequence.workArea.start + duration
          : sequence.workArea.start,
      end: sequence.workArea.end > at ? sequence.workArea.end + duration : sequence.workArea.end,
    };
  sequence.duration += duration;
}
function overwriteTime(sequence: Sequence, trackIds: string[], at: number, duration: number) {
  const ids = new Set(trackIds),
    end = at + duration,
    overlaps = (c: Clip) => c.start < end && c.start + c.duration > at,
    groups = new Set(
      sequence.tracks
        .filter((t) => ids.has(t.id))
        .flatMap((t) =>
          t.clips.filter(overlaps).flatMap((c) => (c.linkedGroup ? [c.linkedGroup] : [])),
        ),
    );
  if (
    sequence.tracks.some(
      (t) => !ids.has(t.id) && t.clips.some((c) => c.linkedGroup && groups.has(c.linkedGroup)),
    )
  )
    throw new VmotionError(
      'LINKED_OVERWRITE',
      'Overwrite would desynchronize a linked partner; include its audio track or unlink first',
    );
  const rightGroups = new Map<string, string>();
  for (const track of sequence.tracks.filter((t) => ids.has(t.id))) {
    if (track.locked) throw new VmotionError('TRACK_LOCKED', 'Cannot overwrite a locked track');
    track.clips = track.clips.flatMap((clip) => {
      if (!overlaps(clip)) return [clip];
      const parts: Clip[] = [];
      if (clip.start < at) parts.push(clipPiece(clip, clip.start, at));
      if (clip.start + clip.duration > end) {
        const right = clipPiece(
          clip,
          end,
          clip.start + clip.duration,
          parts.length ? randomUUID() : clip.id,
        );
        if (parts.length && clip.linkedGroup) {
          if (!rightGroups.has(clip.linkedGroup)) rightGroups.set(clip.linkedGroup, randomUUID());
          right.linkedGroup = rightGroups.get(clip.linkedGroup);
        }
        parts.push(right);
      }
      return parts;
    });
  }
}

/** Exact operations are returned once; apply never regenerates IDs or reinterprets the plan. */
export async function planSequence(root: string, snapshot: Snapshot, raw: unknown) {
  const request = sequencePlanSchema.parse(raw),
    id = request.sequenceId ?? snapshot.project.activeSequence,
    original = snapshot.sequences.find((s) => s.id === id);
  if (!original) throw new VmotionError('NOT_FOUND', 'Sequence not found');
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Inspect the current revision before planning');
  await checkAssets(root, snapshot, request.assetChecks);
  const sequence = structuredClone(original),
    media = new Map<string, Awaited<ReturnType<typeof inspectMedia>>>(),
    inspect = async (assetId: string) => {
      if (!media.has(assetId)) media.set(assetId, await inspectMedia(root, snapshot, { assetId }));
      return media.get(assetId)!;
    },
    placements: Array<{
      clipId: string;
      audioClipId?: string;
      trackId: string;
      at: number;
      end: number;
      sourceIn: number;
      sourceOut?: number;
      speed: number;
      mode: string;
    }> = [];
  for (const item of request.items) {
    const track = sequence.tracks.find((t) => t.id === item.trackId),
      audioTrack = item.audioTrackId
        ? sequence.tracks.find((t) => t.id === item.audioTrackId)
        : undefined;
    if (!track || (item.audioTrackId && !audioTrack))
      throw new VmotionError('NOT_FOUND', 'Target track not found');
    if (track.locked || audioTrack?.locked)
      throw new VmotionError('TRACK_LOCKED', 'Target track is locked');
    let length: number | undefined;
    if (item.source.type === 'asset') {
      const info = await inspect(item.source.id);
      if (info.asset.type === 'font')
        throw new VmotionError('CLIP_SOURCE', 'Fonts are not clip sources');
      if (
        (track.type === 'audio' && !['audio', 'video'].includes(info.asset.type)) ||
        (track.type === 'video' && info.asset.type === 'audio')
      )
        throw new VmotionError('TRACK_TYPE', 'Source does not match the target track');
      if (track.type === 'audio' && !info.metadata.hasAudio)
        throw new VmotionError('NO_AUDIO', 'Source has no audio stream');
      length = info.sourceEnd;
      if (
        audioTrack &&
        (info.asset.type !== 'video' ||
          !info.metadata.hasAudio ||
          track.type !== 'video' ||
          audioTrack.type !== 'audio' ||
          !item.audioEnabled)
      )
        throw new VmotionError(
          'SEPARATE_AUDIO',
          'Separate sound requires a video source with audio, a video track, and a distinct audio track',
        );
    } else {
      length =
        item.source.type === 'scene'
          ? snapshot.scenes.find((s) => s.id === item.source.id)?.duration
          : snapshot.sequences.find((s) => s.id === item.source.id)?.duration;
      if (length === undefined)
        throw new VmotionError('NOT_FOUND', 'Scene or sequence source not found');
      if (audioTrack || (item.source.type === 'scene' && track.type !== 'video'))
        throw new VmotionError(
          'TRACK_TYPE',
          'Scene sources require video tracks; separate audio is only supported for media assets',
        );
    }
    let sourceOut = item.sourceOut;
    const duration =
      item.duration ??
      Math.ceil(((sourceOut ?? length ?? NaN) - item.sourceIn) / item.speed - 1e-9);
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw new VmotionError(
        'SOURCE_RANGE',
        'Provide duration for still assets, or a valid source range',
      );
    if (length !== undefined || sourceOut !== undefined) {
      sourceOut ??= Math.min(length ?? Infinity, item.sourceIn + duration * item.speed);
      if (
        sourceOut <= item.sourceIn ||
        (length !== undefined && sourceOut > length + 1e-7) ||
        item.sourceIn + (duration - 1) * item.speed >= sourceOut
      )
        throw new VmotionError(
          'SOURCE_RANGE',
          'Selected range and timeline duration disagree or exceed the source',
        );
      if (
        item.duration &&
        item.sourceOut &&
        duration !== Math.ceil((sourceOut - item.sourceIn) / item.speed - 1e-9)
      )
        throw new VmotionError(
          'SOURCE_RANGE',
          'Explicit duration must cover exactly the selected source range',
        );
    }
    const at =
      item.at ??
      (item.mode === 'append' ? Math.max(0, ...track.clips.map((c) => c.start + c.duration)) : NaN);
    if (!Number.isSafeInteger(at) || at < 0)
      throw new VmotionError('EDIT_RANGE', 'Insert and overwrite require an explicit at frame');
    if (
      item.mode === 'append' &&
      [track, ...(audioTrack ? [audioTrack] : [])].some((t) =>
        t.clips.some((c) => c.start < at + duration && c.start + c.duration > at),
      )
    )
      throw new VmotionError(
        'CLIP_OVERLAP',
        'Append overlaps an existing clip; use insert or overwrite',
      );
    if (item.mode === 'insert') insertTime(sequence, at, duration);
    if (item.mode === 'overwrite')
      overwriteTime(sequence, [track.id, ...(audioTrack ? [audioTrack.id] : [])], at, duration);
    const group = audioTrack ? randomUUID() : undefined,
      clip = clipSchema.parse({
        id: randomUUID(),
        [`${item.source.type}Id`]: item.source.id,
        start: at,
        duration,
        sourceIn: item.sourceIn,
        sourceOut,
        speed: item.speed,
        volume: item.volume,
        fadeIn: item.fadeIn,
        fadeOut: item.fadeOut,
        name: item.name,
        audioEnabled: audioTrack ? false : item.audioEnabled,
        linkedGroup: group,
        ...(sourceOut !== undefined
          ? { sourceWindow: { sourceIn: item.sourceIn, duration: sourceOut - item.sourceIn } }
          : {}),
      });
    track.clips.push(clip);
    let audioClipId: string | undefined;
    if (audioTrack) {
      audioClipId = randomUUID();
      audioTrack.clips.push({ ...structuredClone(clip), id: audioClipId, audioEnabled: true });
    }
    sequence.duration = Math.max(sequence.duration, at + duration);
    placements.push({
      clipId: clip.id,
      audioClipId,
      trackId: track.id,
      at,
      end: at + duration,
      sourceIn: clip.sourceIn,
      sourceOut,
      speed: clip.speed,
      mode: item.mode,
    });
  }
  for (const track of sequence.tracks) track.clips.sort((a, b) => a.start - b.start);
  const operations: Operation[] = [
      { type: 'updateSequence', sequenceId: sequence.id, patch: sequenceSchema.parse(sequence) },
    ],
    draft = applyOperations(root, snapshot, operations),
    diagnostics = await validateSnapshot(root, draft);
  let candidate = draft;
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError(
      'VALIDATION_FAILED',
      'The plan is invalid; no changes saved',
      diagnostics,
    );
  // Pin media used by the resulting sequence, including nested sources and registered fonts.
  const scenes = new Set<string>(),
    sequences = new Set<string>(),
    assets = new Set<string>();
  const visitScene = (sceneId: string) => {
    if (scenes.has(sceneId)) return;
    scenes.add(sceneId);
    for (const n of candidate.scenes.find((s) => s.id === sceneId)!.nodes) {
      if (n.assetId) assets.add(n.assetId);
      if (n.audioAssetId) assets.add(n.audioAssetId);
      if (n.sceneId) visitScene(n.sceneId);
      if (n.type === 'component') candidate.project.assets.forEach((a) => assets.add(a.id));
    }
  };
  const visitSequence = (sequenceId: string) => {
    if (sequences.has(sequenceId)) return;
    sequences.add(sequenceId);
    for (const c of candidate.sequences
      .find((s) => s.id === sequenceId)!
      .tracks.flatMap((t) => t.clips)) {
      if (c.assetId) assets.add(c.assetId);
      if (c.sceneId) visitScene(c.sceneId);
      if (c.sequenceId) visitSequence(c.sequenceId);
    }
  };
  visitSequence(sequence.id);
  candidate.project.assets.filter((a) => a.type === 'font').forEach((a) => assets.add(a.id));
  for (const assetId of assets) await inspect(assetId);
  // Replaced/reprobed media may have a new duration. Pin its metadata as well as its file stamp,
  // otherwise visual content clocks could still clamp at the previously imported duration.
  const refreshed = candidate.project.assets.map((asset) => {
    const info = media.get(asset.id);
    return info
      ? {
          ...asset,
          fingerprint: info.fingerprint,
          metadata: { ...asset.metadata, ...info.metadata },
        }
      : asset;
  });
  if (JSON.stringify(refreshed) !== JSON.stringify(candidate.project.assets)) {
    operations.push({ type: 'updateProject', patch: { assets: refreshed } });
    candidate = applyOperations(root, snapshot, operations);
  }
  const assetChecks = [
    ...new Map(
      [
        ...request.assetChecks,
        ...[...media.values()].flatMap((m) => m.assetChecks ?? [m.assetCheck]),
      ].map((c) => [c.assetId, c]),
    ).values(),
  ];
  // The caller's original evidence must still match after probing; never replace it with a newer stamp silently.
  await checkAssets(root, candidate, [...request.assetChecks, ...assetChecks]);
  const sampleFrames = [
    ...new Set(placements.flatMap((p) => [p.at, Math.floor((p.at + p.end - 1) / 2), p.end - 1])),
  ].slice(0, 12);
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    sequenceId: sequence.id,
    duration: sequence.duration,
    placements,
    diagnostics,
    affectedTracks: sequence.tracks
      .filter((t, i) => JSON.stringify(t) !== JSON.stringify(original.tracks[i]))
      .map((t) => t.id),
    candidate: {
      revision: snapshot.revision,
      operations,
      assetChecks,
      samples: sampleFrames.map((frame) => ({ frame, sequenceId: sequence.id })),
      width: 320,
      determinism: true,
    },
    apply: {
      revision: snapshot.revision,
      operations,
      assetChecks,
      samples: sampleFrames.map((frame) => ({ frame, sequenceId: sequence.id })),
      width: 320,
      determinism: true,
      expectedCandidateRevision: candidate.revision,
    },
  };
}
