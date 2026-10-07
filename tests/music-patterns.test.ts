import { it, expect } from 'vitest';
import { compileSound, SoundRenderer } from '../src/core/sound.js';
import { exportSoundMidi, importSoundMidi } from '../src/core/sound-midi.js';
import {
  newMusic,
  musicEvents,
  setMusicEvents,
  moveMusicNotes,
  musicReducer,
  emptyMusicDraft,
  removeMusicTrack,
  musicSeconds,
  musicTime,
} from '../src/editor/music/music-model.js';

it('expands linked patterns with stable occurrence IDs while retaining editable source', () => {
  const doc = newMusic('music'),
    before = structuredClone(doc),
    c = compileSound(doc);
  expect(c.eventCount).toBe(16);
  expect(c.tracks[0].events.map((e) => e.at)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  expect(doc).toEqual(before);
  expect(new Set(c.tracks[0].events.map((e) => e.id)).size).toBe(16);
  const events = musicEvents(doc, 'lead', 'pattern-1').map((e) => ({ ...e, note: 65 }));
  const next = setMusicEvents(doc, 'lead', 'pattern-1', events);
  expect(compileSound(next).tracks[0].events.every((e) => e.note === 65)).toBe(true);
});
it('renders expanded patterns and direct scores sample-identically through arbitrary block partitions', () => {
  const doc = newMusic('music'),
    compiled = compileSound(doc);
  const direct = {
    ...doc,
    patterns: undefined,
    arrangement: undefined,
    tracks: compiled.tracks.map(({ track }) => track),
  };
  const a = new SoundRenderer(doc),
    b = new SoundRenderer(direct);
  const whole = a.process(9000),
    first = b.process(1337),
    second = b.process(7663);
  expect([...whole.left]).toEqual([...first.left, ...second.left]);
  expect(exportSoundMidi(doc).data).toEqual(exportSoundMidi(direct).data);
  expect(importSoundMidi(exportSoundMidi(doc).data, { id: 'import', name: 'import' }).notes).toBe(
    16,
  );
});
it('rejects invalid references, ranges, duplicate IDs and expansion budgets before allocation', () => {
  const d = newMusic('music');
  for (const change of [
    { arrangement: [{ id: 'missing', patternId: 'missing', at: 0 }] },
    { arrangement: [{ id: 'long', patternId: 'pattern-1', at: 14 }] },
    { patterns: [...d.patterns!, d.patterns![0]] },
    { patterns: [{ ...d.patterns![0], channels: [{ trackId: 'missing', events: [] }] }] },
    {
      patterns: [
        {
          ...d.patterns![0],
          channels: [{ trackId: 'lead', events: [{ id: 'long', at: 3.9, duration: 1 }] }],
        },
      ],
    },
    {
      duration: 4096,
      patterns: [
        {
          ...d.patterns![0],
          channels: [
            {
              trackId: 'lead',
              events: Array.from({ length: 64 }, (_, i) => ({
                id: String(i),
                at: 0,
                duration: 0.1,
              })),
            },
          ],
        },
      ],
      arrangement: [{ id: 'huge', at: 0, patternId: 'pattern-1', repeats: 1024 }],
    },
  ])
    expect(() => compileSound({ ...d, ...change })).toThrow();
});
it('moves groups within pitch/time bounds, keeps sweeps and removes dangling pattern channels', () => {
  const doc = newMusic('music'),
    notes = musicEvents(doc, 'lead', 'pattern-1');
  const moved = moveMusicNotes(
    notes,
    notes.map((e) => e.id),
    100,
    100,
    4,
  );
  expect(moved[0].at).toBe(0.25);
  expect(Math.max(...moved.map((e) => Number(e.note)))).toBe(127);
  expect(
    moveMusicNotes(
      notes,
      notes.map((e) => e.id),
      -100,
      -100,
      4,
    )[0].at,
  ).toBe(0);
  expect(removeMusicTrack(doc, 'lead').patterns![0].channels).toEqual([]);
});
it('keeps draft undo pure and bounded and maps tempo clocks in both directions', () => {
  const doc = newMusic('music');
  let state = musicReducer(emptyMusicDraft, { type: 'load', document: doc, saved: doc });
  const initial = state;
  for (let i = 0; i < 30; i++)
    state = musicReducer(state, { type: 'edit', document: { ...doc, name: String(i) } });
  expect(state.past).toHaveLength(24);
  expect(initial.document).toEqual(doc);
  state = musicReducer(state, { type: 'undo' });
  expect(state.document!.name).toBe('28');
  state = musicReducer(state, { type: 'redo' });
  expect(state.document!.name).toBe('29');
  const tempo = {
    ...doc,
    tempo: [
      { beat: 0, bpm: 120 },
      { beat: 4, bpm: 90 },
    ],
  };
  expect(musicTime(tempo, musicSeconds(tempo, 11.5))).toBeCloseTo(11.5);
});
