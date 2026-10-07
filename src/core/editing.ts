import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  sequenceSchema,
  clipSchema,
  VmotionError,
  type Sequence,
  type Clip,
  type Snapshot,
} from './model.js';
import { clipWindow } from './clip-window.js';
const frame = z.number().int().nonnegative(),
  ids = z.array(z.string().min(1)).min(1).max(1000);
export const sequenceActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('split'),
      frame,
      clipIds: ids.optional(),
      linked: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('trim'),
      clipId: z.string(),
      edge: z.enum(['in', 'out']),
      frame,
      linked: z.boolean().default(true),
      fadePolicy: z.enum(['preserve', 'reset']).default('preserve'),
    })
    .strict(),
  z
    .object({
      type: z.literal('slip'),
      clipIds: ids,
      delta: z.number().finite(),
      linked: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('move'),
      clipIds: ids,
      delta: z.number().int(),
      linked: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('remove'),
      clipIds: ids,
      ripple: z.boolean().default(false),
      linked: z.boolean().default(true),
    })
    .strict(),
  z.object({ type: z.literal('deleteRange'), start: frame, end: frame }).strict(),
  z.object({ type: z.literal('link'), clipIds: ids, group: z.string().optional() }).strict(),
  z.object({ type: z.literal('unlink'), clipIds: ids }).strict(),
  z.object({ type: z.literal('trackLock'), trackId: z.string(), locked: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('marker'),
      frame,
      label: z.string().min(1).max(200),
      id: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('removeMarker'), id: z.string() }).strict(),
  z.object({ type: z.literal('workflow'), mode: z.enum(['general', 'remix', 'film']) }).strict(),
  z.object({ type: z.literal('rangeIn'), frame }).strict(),
  z.object({ type: z.literal('rangeOut'), frame }).strict(),
  z.object({ type: z.literal('clearRange') }).strict(),
  z
    .object({
      type: z.literal('beatGrid'),
      bpm: z.number().finite().min(20).max(400),
      start: frame.default(0),
      end: frame.optional(),
      subdivision: z.number().int().min(1).max(16).default(1),
      group: z.string().default('beat-grid'),
      replace: z.boolean().default(true),
    })
    .strict(),
]);
export type SequenceAction = z.input<typeof sequenceActionSchema>;
type Range = { start: number; end: number };
function mergeRanges(ranges: Range[]) {
  const sorted = ranges.sort((a, b) => a.start - b.start),
    merged: Range[] = [];
  for (const range of sorted) {
    if (range.end <= range.start)
      throw new VmotionError('EDIT_RANGE', 'Range must have positive duration');
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function sourceLength(snapshot: Snapshot, clip: Clip) {
  if (clip.sceneId) return snapshot.scenes.find((s) => s.id === clip.sceneId)?.duration;
  if (clip.sequenceId) return snapshot.sequences.find((s) => s.id === clip.sequenceId)?.duration;
  const asset = snapshot.project.assets.find((a) => a.id === clip.assetId),
    seconds = Number(asset?.metadata.duration);
  return Number.isFinite(seconds) && seconds > 0
    ? (seconds * snapshot.project.fps.num) / snapshot.project.fps.den
    : undefined;
}
function checkSource(snapshot: Snapshot, clip: Clip) {
  const length = sourceLength(snapshot, clip);
  if (
    clip.sourceIn < 0 ||
    (clip.sourceOut !== undefined &&
      (clip.sourceOut <= clip.sourceIn ||
        clip.sourceIn + (clip.duration - 1) * clip.speed >= clip.sourceOut)) ||
    (length !== undefined && clip.sourceIn + (clip.duration - 1) * clip.speed >= length + 1e-6)
  )
    throw new VmotionError('EDIT_HANDLES', 'The edit exceeds the available source frames');
}
export function clipPiece(original: Clip, start: number, end: number, id = original.id): Clip {
  const offset = start - original.start,
    window = clipWindow(original);
  return clipSchema.parse({
    ...original,
    id,
    start,
    duration: end - start,
    sourceIn: original.sourceIn + offset * original.speed,
    sourceWindow: original.sourceWindow ?? {
      sourceIn: original.sourceIn,
      duration: original.duration * original.speed,
    },
    fadeWindow: { offset: window.offset + offset, duration: window.duration },
  });
}
const piece = clipPiece;
export function editSequence(snapshot: Snapshot, input: Sequence, raw: SequenceAction[]) {
  if (!raw.length || raw.length > 1000)
    throw new VmotionError('EDIT_ACTIONS', 'Provide 1–1000 sequence actions');
  let sequence = structuredClone(input),
    selection: string[] = [],
    changes: Array<{ action: string; ids: string[] }> = [];
  const all = () =>
      sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))),
    find = (id: string) => {
      const item = all().find((n) => n.clip.id === id);
      if (!item) throw new VmotionError('NOT_FOUND', `Clip ${id} not found`);
      return item;
    },
    selected = (ids: string[], linked = false) => {
      const chosen = ids.map(find),
        groups = new Set(chosen.flatMap((n) => (n.clip.linkedGroup ? [n.clip.linkedGroup] : []))),
        set = new Set(ids);
      return all().filter(
        (n) =>
          set.has(n.clip.id) || (linked && n.clip.linkedGroup && groups.has(n.clip.linkedGroup)),
      );
    },
    unlocked = (items: ReturnType<typeof all>) => {
      if (items.some((n) => n.track.locked))
        throw new VmotionError('TRACK_LOCKED', 'Unlock affected tracks before editing');
    };
  const deleteRanges = (raw: Range[]) => {
    const ranges = mergeRanges(raw);
    if (ranges.some((r) => r.start < 0 || r.end > sequence.duration))
      throw new VmotionError('EDIT_RANGE', 'Delete range must be inside the sequence');
    const collapse = (time: number) =>
      time - ranges.reduce((sum, r) => sum + Math.max(0, Math.min(time, r.end) - r.start), 0);
    unlocked(all().filter((n) => ranges.some((r) => n.clip.start + n.clip.duration > r.start)));
    const touched: string[] = [],
      groups = new Map<string, string>();
    for (const track of sequence.tracks) {
      const result: Clip[] = [];
      for (const clip of track.clips) {
        let kept = [{ start: clip.start, end: clip.start + clip.duration }];
        for (const range of ranges)
          kept = kept.flatMap((part) =>
            range.end <= part.start || range.start >= part.end
              ? [part]
              : [
                  ...(part.start < range.start ? [{ start: part.start, end: range.start }] : []),
                  ...(part.end > range.end ? [{ start: range.end, end: part.end }] : []),
                ],
          );
        kept.forEach((part, index) => {
          const cut = piece(clip, part.start, part.end, index ? randomUUID() : clip.id);
          if (index && clip.linkedGroup) {
            const key = `${clip.linkedGroup}@${part.start}`;
            if (!groups.has(key)) groups.set(key, randomUUID());
            cut.linkedGroup = groups.get(key);
          }
          cut.start = collapse(part.start);
          result.push(cut);
        });
        if (
          kept.length !== 1 ||
          kept[0].start !== clip.start ||
          kept[0].end !== clip.start + clip.duration ||
          collapse(clip.start) !== clip.start
        )
          touched.push(clip.id);
      }
      track.clips = result;
    }
    sequence.markers = sequence.markers
      .filter((m) => !ranges.some((r) => m.frame >= r.start && m.frame < r.end))
      .map((m) => ({ ...m, frame: collapse(m.frame) }));
    if (sequence.workArea) {
      const start = collapse(sequence.workArea.start),
        end = collapse(sequence.workArea.end);
      sequence.workArea = end > start ? { start, end } : undefined;
    }
    sequence.duration = Math.max(
      1,
      sequence.duration - ranges.reduce((n, r) => n + r.end - r.start, 0),
    );
    return touched;
  };
  for (const rawAction of raw) {
    const action = sequenceActionSchema.parse(rawAction);
    let touched: string[] = [];
    if (action.type === 'split') {
      const items = action.clipIds
        ? selected(action.clipIds, action.linked)
        : all().filter(
            (n) => action.frame > n.clip.start && action.frame < n.clip.start + n.clip.duration,
          );
      if (!items.length) throw new VmotionError('EDIT_SPLIT', 'The playhead is not inside a clip');
      unlocked(items);
      const groups = new Map<string, string>();
      for (const { track, clip } of items) {
        if (action.frame <= clip.start || action.frame >= clip.start + clip.duration)
          throw new VmotionError('EDIT_SPLIT', 'Split must be strictly inside each linked clip');
        const at = track.clips.findIndex((c) => c.id === clip.id),
          left = piece(clip, clip.start, action.frame),
          right = piece(clip, action.frame, clip.start + clip.duration, randomUUID());
        if (clip.linkedGroup) {
          if (!groups.has(clip.linkedGroup)) groups.set(clip.linkedGroup, randomUUID());
          right.linkedGroup = groups.get(clip.linkedGroup);
        }
        track.clips.splice(at, 1, left, right);
        selection.push(right.id);
        touched.push(clip.id, right.id);
      }
    } else if (action.type === 'trim') {
      const base = find(action.clipId).clip,
        items = selected([action.clipId], action.linked),
        delta = action.frame - (action.edge === 'in' ? base.start : base.start + base.duration);
      unlocked(items);
      for (const item of items) {
        const { clip } = item,
          start = clip.start + (action.edge === 'in' ? delta : 0),
          end = clip.start + clip.duration + (action.edge === 'out' ? delta : 0);
        if (start < 0 || end <= start)
          throw new VmotionError(
            'EDIT_TRIM',
            'Trim would remove the entire clip or cross sequence start',
          );
        const cut = piece(clip, start, end);
        checkSource(snapshot, cut);
        if (action.fadePolicy === 'reset') delete cut.fadeWindow;
        Object.assign(clip, cut);
        touched.push(clip.id);
        selection.push(clip.id);
        sequence.duration = Math.max(sequence.duration, end);
      }
    } else if (action.type === 'move') {
      const items = selected(action.clipIds, action.linked);
      unlocked(items);
      if (items.some((n) => n.clip.start + action.delta < 0))
        throw new VmotionError('EDIT_RANGE', 'Move would cross sequence start');
      for (const { clip } of items) {
        clip.start += action.delta;
        sequence.duration = Math.max(sequence.duration, clip.start + clip.duration);
        touched.push(clip.id);
        selection.push(clip.id);
      }
    } else if (action.type === 'slip') {
      const items = selected(action.clipIds, action.linked);
      unlocked(items);
      for (const { clip } of items) {
        clip.sourceIn += action.delta;
        if (clip.sourceOut !== undefined) clip.sourceOut += action.delta;
        if (clip.sourceWindow) clip.sourceWindow.sourceIn += action.delta;
        checkSource(snapshot, clip);
        touched.push(clip.id);
        selection.push(clip.id);
      }
    } else if (action.type === 'remove') {
      const items = selected(action.clipIds, action.linked);
      unlocked(items);
      if (action.ripple)
        touched = deleteRanges(
          items.map(({ clip }) => ({ start: clip.start, end: clip.start + clip.duration })),
        );
      else {
        const ids = new Set(items.map(({ clip }) => clip.id));
        for (const track of sequence.tracks)
          track.clips = track.clips.filter((c) => !ids.has(c.id));
        touched = [...ids];
      }
    } else if (action.type === 'deleteRange')
      touched = deleteRanges([{ start: action.start, end: action.end }]);
    else if (action.type === 'link' || action.type === 'unlink') {
      const items = selected(action.clipIds);
      unlocked(items);
      const group = action.type === 'link' ? (action.group ?? randomUUID()) : undefined;
      for (const { clip } of items) {
        clip.linkedGroup = group;
        touched.push(clip.id);
        selection.push(clip.id);
      }
    } else if (action.type === 'trackLock') {
      const track = sequence.tracks.find((t) => t.id === action.trackId);
      if (!track) throw new VmotionError('NOT_FOUND', 'Track not found');
      track.locked = action.locked;
    } else if (action.type === 'marker') {
      if (action.frame >= sequence.duration)
        throw new VmotionError('EDIT_RANGE', 'Marker must be inside the sequence');
      const id = action.id ?? randomUUID(),
        existing = sequence.markers.find((m) => m.id === id);
      if (existing) Object.assign(existing, { frame: action.frame, label: action.label });
      else sequence.markers.push({ id, frame: action.frame, label: action.label });
    } else if (action.type === 'removeMarker')
      sequence.markers = sequence.markers.filter((m) => m.id !== action.id);
    else if (action.type === 'workflow') sequence.workflow = action.mode;
    else if (action.type === 'rangeIn') {
      if (action.frame >= sequence.duration)
        throw new VmotionError('EDIT_RANGE', 'In point must be inside the sequence');
      sequence.workArea = {
        start: action.frame,
        end:
          sequence.workArea?.end && sequence.workArea.end > action.frame
            ? sequence.workArea.end
            : sequence.duration,
      };
    } else if (action.type === 'rangeOut') {
      const end = action.frame + 1,
        start = sequence.workArea?.start ?? 0;
      if (end <= start || end > sequence.duration)
        throw new VmotionError(
          'EDIT_RANGE',
          'Out point must follow the in point and stay inside the sequence',
        );
      sequence.workArea = { start, end };
    } else if (action.type === 'clearRange') sequence.workArea = undefined;
    else if (action.type === 'beatGrid') {
      const end = action.end ?? sequence.duration;
      if (end <= action.start || end > sequence.duration)
        throw new VmotionError('EDIT_RANGE', 'Beat grid range must be inside the sequence');
      const step =
          (60 * snapshot.project.fps.num) /
          (snapshot.project.fps.den * action.bpm * action.subdivision),
        count = Math.ceil((end - action.start) / step);
      if (count > 5000)
        throw new VmotionError(
          'BEAT_GRID_LIMIT',
          'Generate at most 5000 beat markers per request; use a shorter time range',
        );
      if (action.replace)
        sequence.markers = sequence.markers.filter((m) => m.group !== action.group);
      const occupied = new Set<number>();
      for (let i = 0; i < count; i++) {
        const at = Math.round(action.start + i * step);
        if (at >= end || occupied.has(at)) continue;
        occupied.add(at);
        sequence.markers.push({
          id: randomUUID(),
          frame: at,
          label: `节拍 ${i + 1}`,
          kind: 'beat',
          group: action.group,
        });
      }
      sequence.markers.sort((a, b) => a.frame - b.frame);
    }
    changes.push({ action: action.type, ids: touched });
  }
  sequence = sequenceSchema.parse(sequence);
  return {
    sequence,
    selection: [...new Set(selection)].filter((id) => all().some((n) => n.clip.id === id)),
    changes,
  };
}
