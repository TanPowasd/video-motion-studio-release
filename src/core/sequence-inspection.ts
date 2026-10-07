import { VmotionError, type Snapshot, type Clip } from './model.js';
import { clipContentDuration, clipGain, clipSourceFrame } from './clip-window.js';
export type SequenceSource = {
  type: 'scene' | 'asset';
  id: string;
  frame: number;
  opacity: number;
  sequenceId: string;
  trackId: string;
  clipId: string;
  path: string[];
};
export function sequenceSourcesAt(snapshot: Snapshot, sequenceId: string, frame: number) {
  const sources: SequenceSource[] = [];
  const visit = (id: string, at: number, opacity: number, path: string[]) => {
    if (
      path.includes(`sequence:${id}`) ||
      path.filter((p) => p.startsWith('sequence:')).length > 32
    )
      throw new VmotionError('NESTING_DEPTH', 'Sequence inspection is cyclic or exceeds depth');
    const sequence = snapshot.sequences.find((s) => s.id === id);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Inspection sequence is missing');
    for (const track of sequence.tracks.filter((t) => t.type === 'video' && !t.muted))
      for (const clip of track.clips) {
        const local = at - clip.start;
        if (local < 0 || local >= clipContentDuration(clip)) continue;
        const gain = opacity * clipGain(clip, local);
        if (gain <= 0) continue;
        const sourceFrame = clipSourceFrame(clip, local),
          next = [...path, `sequence:${id}`, `track:${track.id}`, `clip:${clip.id}`];
        if (clip.sequenceId) visit(clip.sequenceId, sourceFrame, gain, next);
        else if (clip.sceneId || clip.assetId)
          sources.push({
            type: clip.sceneId ? 'scene' : 'asset',
            id: (clip.sceneId ?? clip.assetId)!,
            frame: sourceFrame,
            opacity: gain,
            sequenceId: id,
            trackId: track.id,
            clipId: clip.id,
            path: next,
          });
      }
  };
  visit(sequenceId, frame, 1, []);
  return sources;
}
export function sequenceSampleCandidates(snapshot: Snapshot, sequenceId: string) {
  const candidates = new Map<number, Set<string>>(),
    sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Inspection sequence missing');
  const add = (frame: number, reason: string) => {
    frame = Math.floor(frame);
    if (frame < 0 || frame >= sequence.duration) return;
    const labels = candidates.get(frame) ?? new Set<string>();
    labels.add(reason);
    candidates.set(frame, labels);
  };
  add(0, 'sequence-start');
  add(sequence.duration - 1, 'sequence-end');
  const visit = (
    id: string,
    origin: number,
    rate: number,
    localStart: number,
    localEnd: number,
    ancestors: string[],
  ) => {
    if (ancestors.includes(id) || ancestors.length > 32)
      throw new VmotionError('NESTING_DEPTH', 'Sampling sequence recursion exceeds depth');
    const seq = snapshot.sequences.find((s) => s.id === id)!;
    for (const track of seq.tracks.filter((t) => t.type === 'video' && !t.muted))
      for (const clip of track.clips) {
        const begin = Math.max(localStart, clip.start),
          end = Math.min(localEnd, clip.start + clipContentDuration(clip));
        if (end <= begin) continue;
        const first = origin + (begin - localStart) / rate,
          last = origin + (end - localStart) / rate;
        for (const f of [
          Math.ceil(first) - 1,
          Math.ceil(first),
          Math.ceil(first) + 1,
          Math.floor((first + last) / 2),
          Math.ceil(last) - 1,
          Math.ceil(last),
          Math.ceil(last) + 1,
        ])
          add(f, `clip:${clip.id}`);
        if (clip.sequenceId) {
          const sourceIn = clip.sourceIn + (begin - clip.start) * clip.speed;
          visit(
            clip.sequenceId,
            first,
            rate * clip.speed,
            sourceIn,
            sourceIn + (end - begin) * clip.speed,
            [...ancestors, id],
          );
        }
      }
    for (const marker of seq.markers)
      if (marker.frame >= localStart && marker.frame < localEnd)
        add(origin + (marker.frame - localStart) / rate, `marker:${marker.id}`);
  };
  visit(sequenceId, 0, 1, 0, sequence.duration, []);
  for (let i = 1; i < 12; i++) add((sequence.duration * i) / 12, 'uniform');
  return [...candidates]
    .sort(([a], [b]) => a - b)
    .map(([frame, reasons]) => ({ frame, reasons: [...reasons] }));
}
export function stratifiedFrames<T>(values: T[], limit: number) {
  if (values.length <= limit) return values;
  if (limit === 1) return [values[0]];
  return Array.from(
    { length: limit },
    (_, i) => values[Math.round((i * (values.length - 1)) / (limit - 1))],
  );
}
