import { VmotionError } from './model.js';
import type { SoundDocument, SoundTrack } from './sound-schema.js';

/** Resolve reusable patterns for every consumer; the canonical document stays editable. */
export function expandSoundTracks(document: SoundDocument): SoundTrack[] {
  const patterns = document.patterns ?? [],
    clips = document.arrangement ?? [];
  if (
    new Set(patterns.map((p) => p.id)).size !== patterns.length ||
    new Set(clips.map((c) => c.id)).size !== clips.length
  )
    throw new VmotionError('SOUND_ID', 'Pattern and arrangement IDs must be unique');
  const byId = new Map(patterns.map((p) => [p.id, p])),
    tracks = new Map(document.tracks.map((t) => [t.id, t]));
  let declared = document.tracks.reduce((sum, t) => sum + t.events.length, 0);
  for (const pattern of patterns) {
    if (new Set(pattern.channels.map((c) => c.trackId)).size !== pattern.channels.length)
      throw new VmotionError('SOUND_PATTERN', 'Duplicate pattern channel', {
        patternId: pattern.id,
      });
    for (const channel of pattern.channels) {
      if (!tracks.has(channel.trackId))
        throw new VmotionError('SOUND_TRACK', 'Pattern channel references a missing track', {
          patternId: pattern.id,
          trackId: channel.trackId,
        });
      declared += channel.events.length;
      if (new Set(channel.events.map((e) => e.id)).size !== channel.events.length)
        throw new VmotionError('SOUND_ID', 'Duplicate pattern note IDs', {
          patternId: pattern.id,
          trackId: channel.trackId,
        });
      if (channel.events.some((e) => e.at + e.duration > pattern.length + 1e-8))
        throw new VmotionError('SOUND_RANGE', 'Pattern note extends beyond its length', {
          patternId: pattern.id,
        });
    }
  }
  if (declared > 20000)
    throw new VmotionError('SOUND_BUDGET', 'Declared score and pattern notes exceed 20000');
  let total = document.tracks.reduce((sum, t) => sum + t.events.length, 0);
  for (const clip of clips) {
    const p = byId.get(clip.patternId);
    if (!p)
      throw new VmotionError('SOUND_PATTERN', 'Arrangement references a missing pattern', {
        clipId: clip.id,
      });
    if (clip.at + p.length * clip.repeats > document.duration + 1e-8)
      throw new VmotionError('SOUND_RANGE', 'Pattern clip extends beyond the score', {
        clipId: clip.id,
      });
    total += p.channels.reduce((sum, c) => sum + c.events.length, 0) * clip.repeats;
    if (total > 20000)
      throw new VmotionError('SOUND_BUDGET', 'Expanded pattern notes exceed 20000');
  }
  if (!clips.length) return document.tracks;
  const expanded = new Map(document.tracks.map((t) => [t.id, { ...t, events: [...t.events] }]));
  for (const clip of clips) {
    const p = byId.get(clip.patternId)!;
    for (let repeat = 0; repeat < clip.repeats; repeat++)
      for (const channel of p.channels) {
        const t = expanded.get(channel.trackId)!;
        for (const event of channel.events)
          t.events.push({
            ...event,
            id: `pattern:${JSON.stringify([clip.id, repeat, event.id])}`,
            at: clip.at + repeat * p.length + event.at,
          });
      }
  }
  return [...expanded.values()];
}
