import { z } from 'zod';
import {
  storyboardSchema,
  storyboardShotSchema,
  storyboardBoundary,
  type Storyboard,
} from '../core/storyboard.js';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { json, hash, safePath, validateSnapshot } from './project.js';
import { applyOperations } from './operations.js';
import { planSequence } from './sequence-plan.js';
import { inspectMedia } from './media-evidence.js';
import { storeAgentPlan } from './agent-plans.js';
const pathSchema = z.string().regex(/^components\/storyboards\/.+\.json$/);
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upsertShot'), shot: storyboardShotSchema }).strict(),
  z
    .object({
      type: z.literal('updateShot'),
      shotId: z.string(),
      patch: storyboardShotSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z
    .object({ type: z.literal('removeShots'), shotIds: z.array(z.string()).min(1).max(250) })
    .strict(),
  z.object({ type: z.literal('order'), shotIds: z.array(z.string()).min(1).max(250) }).strict(),
]);
export const storyboardPlanSchema = z
  .object({
    revision: z.string().optional(),
    source: pathSchema.optional(),
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    document: storyboardSchema.optional(),
    actions: z.array(actionSchema).max(500).default([]),
    sequenceId: z.string().optional(),
    videoTrackId: z.string(),
    audioTrackId: z.string().optional(),
    operations: z.array(z.record(z.unknown())).max(500).default([]),
    detail: z.boolean().default(false),
  })
  .strict();
export const storyboardInspectSchema = z
  .object({
    source: pathSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
    includeDocument: z.boolean().default(false),
  })
  .strict();
export function inspectStoryboard(snapshot: Snapshot, raw: unknown) {
  const request = storyboardInspectSchema.parse(raw),
    text = snapshot.files[request.source];
  if (text === undefined)
    throw new VmotionError('STORYBOARD_SOURCE', 'Storyboard resource is missing');
  const document = storyboardSchema.parse(JSON.parse(text)),
    sequenceUses = snapshot.sequences.flatMap((sequence) =>
      sequence.tracks.flatMap((track) =>
        track.clips
          .filter((c) => c.id.startsWith(`sb/${document.id}/`))
          .map((c) => ({
            sequenceId: sequence.id,
            trackId: track.id,
            clipId: c.id,
            start: c.start,
            duration: c.duration,
            sourceIn: c.sourceIn,
            sourceOut: c.sourceOut,
            linkedGroup: c.linkedGroup,
          })),
      ),
    );
  return {
    revision: snapshot.revision,
    source: request.source,
    hash: hash(text),
    id: document.id,
    name: document.name,
    unit: document.unit,
    start: document.start,
    chapters: document.chapters,
    shots: {
      total: document.shots.length,
      offset: request.offset,
      items: document.shots.slice(request.offset, request.offset + request.limit),
      hasMore: request.offset + request.limit < document.shots.length,
    },
    placements: sequenceUses.filter((c) =>
      document.shots
        .slice(request.offset, request.offset + request.limit)
        .some((s) => c.clipId.startsWith(`sb/${document.id}/${s.id}/`)),
    ),
    ...(request.includeDocument ? { document } : {}),
  };
}
export async function planStoryboard(root: string, snapshot: Snapshot, raw: unknown) {
  const request = storyboardPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before storyboard planning');
  const operations: Operation[] = [...request.operations] as Operation[];
  let base = operations.length
      ? applyOperations(root, snapshot, operations)
      : structuredClone(snapshot),
    document: Storyboard | undefined = request.document
      ? structuredClone(request.document)
      : request.source && base.files[request.source]
        ? storyboardSchema.parse(JSON.parse(base.files[request.source]))
        : undefined;
  if (!document)
    throw new VmotionError('STORYBOARD_DOCUMENT', 'Provide a new document or an existing source');
  for (const action of request.actions)
    switch (action.type) {
      case 'upsertShot': {
        const index = document.shots.findIndex((s) => s.id === action.shot.id);
        if (index < 0) document.shots.push(action.shot);
        else document.shots[index] = action.shot;
        break;
      }
      case 'updateShot': {
        const index = document.shots.findIndex((s) => s.id === action.shotId);
        if (index < 0) throw new VmotionError('STORYBOARD_SHOT', 'Shot not found');
        document.shots[index] = storyboardShotSchema.parse({
          ...document.shots[index],
          ...action.patch,
          id: action.shotId,
        });
        break;
      }
      case 'removeShots':
        if (action.shotIds.some((id) => !document!.shots.some((s) => s.id === id)))
          throw new VmotionError('STORYBOARD_SHOT', 'Shot not found');
        document.shots = document.shots.filter((s) => !action.shotIds.includes(s.id));
        break;
      case 'order':
        if (
          action.shotIds.length !== document.shots.length ||
          new Set(action.shotIds).size !== action.shotIds.length ||
          action.shotIds.some((id) => !document!.shots.some((s) => s.id === id))
        )
          throw new VmotionError(
            'STORYBOARD_ORDER',
            'Order must contain every shot ID exactly once',
          );
        document.shots = action.shotIds.map((id) => document!.shots.find((s) => s.id === id)!);
        break;
    }
  document = storyboardSchema.parse(document);
  const source = request.source ?? `components/storyboards/${encodeURIComponent(document.id)}.json`;
  safePath(root, source);
  const old = base.files[source];
  if (request.expectedHash && hash(old ?? '') !== request.expectedHash)
    throw new VmotionError('FILE_HASH_CONFLICT', 'Storyboard source changed');
  if (old !== undefined && storyboardSchema.parse(JSON.parse(old)).id !== document.id)
    throw new VmotionError('STORYBOARD_ID', 'Resource ID must remain stable');
  const sequenceId = request.sequenceId ?? base.project.activeSequence,
    sequence = base.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Storyboard sequence not found');
  const video = sequence.tracks.find((t) => t.id === request.videoTrackId),
    audio = request.audioTrackId
      ? sequence.tracks.find((t) => t.id === request.audioTrackId)
      : undefined;
  if (
    !video ||
    video.type !== 'video' ||
    (request.audioTrackId && (!audio || audio.type !== 'audio'))
  )
    throw new VmotionError('STORYBOARD_TRACK', 'Choose existing video/audio tracks');
  const prefix = `sb/${document.id}/`,
    clean = structuredClone(sequence);
  for (const track of clean.tracks) {
    if (track.locked && track.clips.some((c) => c.id.startsWith(prefix)))
      throw new VmotionError('TRACK_LOCKED', 'Storyboard clips belong to a locked track');
    track.clips = track.clips.filter((c) => !c.id.startsWith(prefix));
  }
  clean.markers = clean.markers.filter((m) => m.group !== `sb/${document.id}`);
  const cleanup: Operation = { type: 'updateSequence', sequenceId, patch: clean };
  base = applyOperations(root, base, [cleanup]);
  const fps = base.project.fps,
    factor = document.unit === 'seconds' ? fps.num / fps.den : 1,
    media = new Map<string, Awaited<ReturnType<typeof inspectMedia>>>(),
    inspect = async (id: string) => {
      if (!media.has(id)) media.set(id, await inspectMedia(root, base, { assetId: id }));
      return media.get(id)!;
    },
    items: any[] = [],
    mapping: Array<{ shotId: string; kind: string; at: number; end: number }> = [],
    shots = [];
  let cursor = document.start;
  for (const shot of document.shots) {
    let duration = shot.duration;
    if (duration === undefined) {
      const length =
        shot.source.type === 'scene'
          ? base.scenes.find((s) => s.id === shot.source.id)?.duration
          : shot.source.type === 'sequence'
            ? base.sequences.find((s) => s.id === shot.source.id)?.duration
            : (await inspect(shot.source.id)).sourceEnd;
      if (length === undefined)
        throw new VmotionError('STORYBOARD_DURATION', 'Still sources require explicit duration');
      duration = (length - shot.sourceIn * factor) / shot.speed / factor;
    }
    const at = storyboardBoundary(cursor, document.unit, fps),
      end = storyboardBoundary(cursor + duration, document.unit, fps);
    if (end <= at)
      throw new VmotionError('STORYBOARD_TIME', 'Shot duration maps to zero video frames', {
        shotId: shot.id,
      });
    items.push({
      source: shot.source,
      trackId: video.id,
      mode: 'append',
      at,
      duration: end - at,
      sourceIn: shot.sourceIn * factor,
      speed: shot.speed,
      audioEnabled: shot.audioEnabled,
      name: shot.name,
    });
    mapping.push({ shotId: shot.id, kind: 'visual', at, end });
    for (const narration of shot.narration) {
      const voiceTrack = narration.trackId
        ? sequence.tracks.find((t) => t.id === narration.trackId)
        : audio;
      if (!voiceTrack || voiceTrack.type !== 'audio')
        throw new VmotionError(
          'STORYBOARD_AUDIO_TRACK',
          'Narration requires an explicit audio track',
        );
      const info = await inspect(narration.assetId),
        start = storyboardBoundary(cursor + narration.offset, document.unit, fps),
        available =
          info.sourceEnd === undefined ? undefined : info.sourceEnd - narration.sourceIn * factor,
        length =
          narration.duration === undefined
            ? Math.ceil(available ?? NaN)
            : storyboardBoundary(
                cursor + narration.offset + narration.duration,
                document.unit,
                fps,
              ) - start;
      if (!Number.isSafeInteger(length) || length <= 0 || start + length > end)
        throw new VmotionError(
          'STORYBOARD_NARRATION_RANGE',
          'Narration must fit its shot; choose duration/source range or extend the shot explicitly',
          { shotId: shot.id, narrationId: narration.id, availableFrames: available, shotEnd: end },
        );
      items.push({
        source: { type: 'asset', id: narration.assetId },
        trackId: voiceTrack.id,
        mode: 'append',
        at: start,
        duration: length,
        sourceIn: narration.sourceIn * factor,
        volume: narration.volume,
        fadeIn: storyboardBoundary(narration.fadeIn, document.unit, fps),
        fadeOut: storyboardBoundary(narration.fadeOut, document.unit, fps),
        name: `${shot.name} / ${narration.id}`,
      });
      mapping.push({
        shotId: shot.id,
        kind: `audio-${narration.id}`,
        at: start,
        end: start + length,
      });
    }
    shots.push({
      id: shot.id,
      name: shot.name,
      chapterId: shot.chapterId,
      source: shot.source,
      at,
      end,
      duration: end - at,
    });
    cursor += duration;
  }
  if (items.length > 500)
    throw new VmotionError(
      'STORYBOARD_BUDGET',
      'A storyboard batch is limited to 500 visual/audio placements',
    );
  const planned = await planSequence(root, base, { sequenceId, revision: base.revision, items }),
    candidate = applyOperations(root, base, planned.candidate.operations),
    resultSequence = candidate.sequences.find((s) => s.id === sequenceId)!;
  for (const [index, placement] of planned.placements.entries()) {
    const metadata = mapping[index],
      clip = resultSequence.tracks.flatMap((t) => t.clips).find((c) => c.id === placement.clipId)!;
    clip.id = `${prefix}${metadata.shotId}/${metadata.kind}`;
    clip.linkedGroup = `${prefix}${metadata.shotId}`;
  }
  for (const chapter of document.chapters) {
    const shot = shots.find((s) => s.chapterId === chapter.id);
    if (shot)
      resultSequence.markers.push({
        id: `sb/${document.id}/chapter/${chapter.id}`,
        frame: shot.at,
        label: chapter.name,
        kind: 'chapter',
        group: `sb/${document.id}`,
      });
  }
  const finalOps: Operation[] = [
      ...operations,
      ...planned.candidate.operations.filter((op) => op.type !== 'updateSequence'),
      { type: 'updateSequence', sequenceId, patch: resultSequence },
      {
        type: 'editFiles',
        edits: [
          {
            type: 'replace',
            path: source,
            content: json(document),
            expectedHash: old === undefined ? null : hash(old),
          },
        ],
      },
    ],
    final = applyOperations(root, snapshot, finalOps),
    diagnostics = await validateSnapshot(root, final);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Storyboard candidate is invalid', diagnostics);
  const samples = [
      ...new Set(shots.flatMap((s) => [s.at, Math.floor((s.at + s.end - 1) / 2), s.end - 1])),
    ].map((frame) => ({ sequenceId, frame })),
    input = {
      revision: snapshot.revision,
      operations: finalOps,
      assetChecks: planned.candidate.assetChecks,
      samples: samples.slice(0, 12),
      width: 320,
      determinism: true,
    },
    plan = await storeAgentPlan(root, input);
  return {
    baseRevision: snapshot.revision,
    candidateRevision: final.revision,
    source,
    documentId: document.id,
    sequenceId,
    shots: request.detail ? shots : shots.slice(0, 30),
    shotCount: shots.length,
    omittedShots: request.detail ? 0 : Math.max(0, shots.length - 30),
    chapters: resultSequence.markers.filter((m) => m.group === `sb/${document.id}`),
    duration: resultSequence.duration,
    assetChecks: request.detail ? planned.candidate.assetChecks : undefined,
    assetCheckCount: planned.candidate.assetChecks.length,
    coverage: {
      proposed: samples.length,
      selected: Math.min(12, samples.length),
      incomplete: samples.length > 12,
    },
    plan,
    candidate: { planId: plan.planId },
    apply: { planId: plan.planId, expectedCandidateRevision: final.revision },
  };
}
