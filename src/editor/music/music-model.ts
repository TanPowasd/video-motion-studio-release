import { noteNumber, soundPreset, tempoClock } from '../../core/sound.js';
import {
  soundDocumentSchema,
  soundTrackSchema,
  type SoundDocument,
  type SoundEvent,
} from '../../core/sound-schema.js';

export const musicUrl = (id = '') => `#/music${id ? '/' + encodeURIComponent(id) : ''}`;
export const noteLabel = (value: string | number) => {
  const n = Math.round(noteNumber(value));
  return (
    ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] +
    (Math.floor(n / 12) - 1)
  );
};
export function newMusic(id: string): SoundDocument {
  return soundDocumentSchema.parse({
    kind: 'sound',
    version: 1,
    id,
    name: '新乐曲',
    duration: 16,
    tracks: [
      soundTrackSchema.parse({ id: 'lead', name: '旋律', instrument: soundPreset('pluck') }),
    ],
    patterns: [
      {
        id: 'pattern-1',
        name: 'Pattern 01',
        length: 4,
        channels: [
          {
            trackId: 'lead',
            events: [60, 64, 67, 72].map((note, i) => ({
              id: `note-${i}`,
              at: i,
              duration: 0.75,
              note,
              velocity: 0.7,
            })),
          },
        ],
      },
    ],
    arrangement: [{ id: 'clip-1', patternId: 'pattern-1', at: 0, repeats: 4 }],
    master: { effects: [{ type: 'limiter', ceilingDb: -1 }] },
  });
}
export function musicSeconds(doc: SoundDocument, at: number) {
  return doc.unit === 'beats' ? tempoClock(doc.tempo).beatSeconds(at) : at;
}
export function musicTime(doc: SoundDocument, seconds: number) {
  return doc.unit === 'beats' ? tempoClock(doc.tempo).secondsBeat(seconds) : seconds;
}
export function musicEvents(doc: SoundDocument, trackId: string, patternId: string): SoundEvent[] {
  if (patternId)
    return (
      doc.patterns?.find((p) => p.id === patternId)?.channels.find((c) => c.trackId === trackId)
        ?.events ?? []
    );
  return doc.tracks.find((t) => t.id === trackId)?.events ?? [];
}
export function setMusicEvents(
  doc: SoundDocument,
  trackId: string,
  patternId: string,
  events: SoundEvent[],
): SoundDocument {
  if (!patternId)
    return { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, events } : t)) };
  return {
    ...doc,
    patterns: doc.patterns?.map((p) => {
      if (p.id !== patternId) return p;
      const exists = p.channels.some((c) => c.trackId === trackId);
      return {
        ...p,
        channels: exists
          ? p.channels.map((c) => (c.trackId === trackId ? { ...c, events } : c))
          : [...p.channels, { trackId, events }],
      };
    }),
  };
}
export function moveMusicNotes(
  events: SoundEvent[],
  ids: string[],
  offset: number,
  transpose: number,
  limit: number,
): SoundEvent[] {
  const selected = events.filter((e) => ids.includes(e.id));
  if (!selected.length) return events;
  const minAt = Math.min(...selected.map((e) => e.at)),
    maxEnd = Math.max(...selected.map((e) => e.at + e.duration));
  const pitches = selected.flatMap((e) => [
    noteNumber(e.note),
    ...(e.endNote === undefined ? [] : [noteNumber(e.endNote)]),
  ]);
  const shift = Math.max(-minAt, Math.min(limit - maxEnd, offset));
  const pitch = Math.max(
    -Math.min(...pitches),
    Math.min(127 - Math.max(...pitches), Math.round(transpose)),
  );
  return events.map((e) =>
    ids.includes(e.id)
      ? {
          ...e,
          at: Number((e.at + shift).toFixed(6)),
          note: noteNumber(e.note) + pitch,
          ...(e.endNote === undefined ? {} : { endNote: noteNumber(e.endNote) + pitch }),
        }
      : e,
  );
}
export function removeMusicTrack(doc: SoundDocument, trackId: string): SoundDocument {
  return {
    ...doc,
    tracks: doc.tracks.filter((t) => t.id !== trackId),
    patterns: doc.patterns?.map((p) => ({
      ...p,
      channels: p.channels.filter((c) => c.trackId !== trackId),
    })),
  };
}
export interface MusicDraft {
  document: SoundDocument | undefined;
  saved: SoundDocument | undefined;
  past: SoundDocument[];
  future: SoundDocument[];
  trackId: string;
  patternId: string;
  selected: string[];
}
export const emptyMusicDraft: MusicDraft = {
  document: undefined,
  saved: undefined,
  past: [],
  future: [],
  trackId: '',
  patternId: '',
  selected: [],
};
export type MusicAction =
  | { type: 'load'; document: SoundDocument; saved?: SoundDocument }
  | { type: 'edit'; document: SoundDocument }
  | { type: 'saved'; document: SoundDocument }
  | { type: 'select'; trackId?: string; patternId?: string; selected?: string[] }
  | { type: 'undo' | 'redo' };
export function musicReducer(state: MusicDraft, action: MusicAction): MusicDraft {
  if (action.type === 'load')
    return {
      ...emptyMusicDraft,
      document: action.document,
      saved: action.saved,
      trackId: action.document.tracks[0]?.id ?? '',
      patternId: action.document.patterns?.[0]?.id ?? '',
    };
  if (action.type === 'edit') {
    if (!state.document || JSON.stringify(state.document) === JSON.stringify(action.document))
      return state;
    return {
      ...state,
      document: action.document,
      past: [...state.past.slice(-23), state.document],
      future: [],
    };
  }
  if (action.type === 'saved') return { ...state, saved: action.document, past: [], future: [] };
  if (action.type === 'select')
    return {
      ...state,
      ...('trackId' in action ? { trackId: action.trackId!, selected: [] } : {}),
      ...('patternId' in action ? { patternId: action.patternId!, selected: [] } : {}),
      ...('selected' in action ? { selected: action.selected! } : {}),
    };
  if (action.type === 'undo' && state.past.length)
    return {
      ...state,
      document: state.past.at(-1),
      past: state.past.slice(0, -1),
      future: [state.document!, ...state.future],
    };
  if (action.type === 'redo' && state.future.length)
    return {
      ...state,
      document: state.future[0],
      past: [...state.past, state.document!],
      future: state.future.slice(1),
    };
  return state;
}
