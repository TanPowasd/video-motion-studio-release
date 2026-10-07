import { z } from 'zod';
import { VmotionError, type Snapshot } from '../core/model.js';
import { clipContentDuration } from '../core/clip-window.js';
export const sequenceQuerySchema = z
  .object({
    sequenceId: z.string().optional(),
    revision: z.string().optional(),
    trackIds: z.array(z.string()).min(1).max(100).optional(),
    clipIds: z.array(z.string()).min(1).max(200).optional(),
    source: z
      .object({ kind: z.enum(['asset', 'scene', 'sequence']), id: z.string() })
      .strict()
      .optional(),
    range: z.tuple([z.number().finite().nonnegative(), z.number().finite().positive()]).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(24),
    detail: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.range && p.range[1] <= p.range[0])
      ctx.addIssue({ code: 'custom', path: ['range'], message: 'Range end must follow start' });
  });
export function querySequence(snapshot: Snapshot, raw: unknown) {
  const p = sequenceQuerySchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Sequence query revision changed');
  const sequence = snapshot.sequences.find(
    (s) => s.id === (p.sequenceId ?? snapshot.project.activeSequence),
  );
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Sequence is missing');
  if (p.source) {
    const known =
      p.source.kind === 'asset'
        ? snapshot.project.assets
        : snapshot[p.source.kind === 'scene' ? 'scenes' : 'sequences'];
    if (!known.some((e) => e.id === p.source!.id))
      throw new VmotionError('REFERENCE_ENTITY', 'Requested clip source is missing', {
        source: p.source,
      });
  }
  const knownTracks = new Set(sequence.tracks.map((t) => t.id));
  for (const id of p.trackIds ?? [])
    if (!knownTracks.has(id))
      throw new VmotionError('TRACK_NOT_FOUND', 'Requested track is missing', { id });
  const tracks = p.trackIds ? new Set(p.trackIds) : undefined,
    rows = sequence.tracks
      .filter((t) => !tracks || tracks.has(t.id))
      .flatMap((track) => track.clips.map((clip) => ({ track, clip }))),
    known = new Set(rows.map((r) => r.clip.id));
  for (const id of p.clipIds ?? [])
    if (!known.has(id))
      throw new VmotionError('CLIP_NOT_FOUND', 'Requested clip is missing from selected tracks', {
        id,
      });
  const selected = rows
      .filter(
        ({ clip }) =>
          (!p.clipIds || p.clipIds.includes(clip.id)) &&
          (!p.source || clip[(p.source.kind + 'Id') as 'assetId'] === p.source.id) &&
          (!p.range || (clip.start < p.range[1] && clip.start + clip.duration > p.range[0])),
      )
      .sort(
        (a, b) =>
          a.clip.start - b.clip.start ||
          a.track.id.localeCompare(b.track.id, 'en') ||
          a.clip.id.localeCompare(b.clip.id, 'en'),
      ),
    page = selected.slice(p.offset, p.offset + p.limit);
  return {
    revision: snapshot.revision,
    sequence: {
      id: sequence.id,
      name: sequence.name,
      duration: sequence.duration,
      workflow: sequence.workflow,
    },
    timebase: { unit: 'project frames; ranges are end-exclusive', fps: snapshot.project.fps },
    tracks: sequence.tracks
      .filter((t) => !tracks || tracks.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        locked: !!t.locked,
        muted: t.muted,
        clips: t.clips.length,
      })),
    total: selected.length,
    offset: p.offset,
    ...(p.offset + page.length < selected.length ? { nextOffset: p.offset + page.length } : {}),
    coverage: {
      available: rows.length,
      returned: page.length,
      omitted: selected.length - page.length,
      filteredOut: rows.length - selected.length,
    },
    items: page.map(({ track, clip }) => ({
      id: clip.id,
      trackId: track.id,
      trackType: track.type,
      locked: !!track.locked,
      muted: track.muted,
      start: clip.start,
      end: clip.start + clip.duration,
      duration: clip.duration,
      source: {
        kind: clip.assetId ? 'asset' : clip.sceneId ? 'scene' : 'sequence',
        id: clip.assetId ?? clip.sceneId ?? clip.sequenceId,
      },
      sourceIn: clip.sourceIn,
      sourceLast:
        clip.sourceIn + Math.max(0, Math.ceil(clipContentDuration(clip)) - 1) * clip.speed,
      speed: clip.speed,
      linkedGroup: clip.linkedGroup,
      ...(p.detail ? { clip } : {}),
    })),
    projection: { partial: !p.detail, recursive: false },
    interpretation:
      'Stored sequence clip windows and track locks; nested timelines are explicit references, not flattened here. Use sequence_audit/render evidence for actual composite and timing boundaries.',
  };
}
