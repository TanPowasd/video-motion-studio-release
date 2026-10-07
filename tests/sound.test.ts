import { it, expect } from 'vitest';
import {
  compileSound,
  SoundRenderer,
  SOUND_RATE,
  tempoClock,
  noteFrequency,
  soundPreset,
} from '../src/core/sound.js';
import { soundEffects } from '../src/core/sound-effects.js';
import { importSoundMidi, exportSoundMidi } from '../src/core/sound-midi.js';
import { fftMagnitudes } from '../src/media/analysis.js';
const score = (patch: Record<string, unknown> = {}) => ({
  kind: 'sound',
  version: 1,
  id: 'score',
  name: 'test',
  unit: 'seconds',
  duration: 1,
  tail: 0,
  tracks: [
    {
      id: 'tone',
      instrument: { ...soundPreset('sine'), attack: 0, decay: 0, sustain: 1, release: 0 },
      events: [{ id: 'a', at: 0, duration: 1, note: 'A4', velocity: 1 }],
    },
  ],
  ...patch,
});
function render(raw: unknown, size = 4096) {
  const r = new SoundRenderer(raw),
    left = new Float64Array(r.compiled.sampleCount),
    right = new Float64Array(left.length);
  while (r.position < left.length) {
    const start = r.position,
      block = r.process(Math.min(size, left.length - start));
    left.set(block.left, start);
    right.set(block.right, start);
  }
  return { left, right };
}
it('maps note names and tempo changes to sample positions without accumulated drift', () => {
  expect(noteFrequency('A4')).toBe(440);
  expect(noteFrequency('Bb3')).toBeCloseTo(noteFrequency(58));
  const clock = tempoClock([
    { beat: 0, bpm: 120 },
    { beat: 8, bpm: 90 },
    { beat: 16, bpm: 180 },
  ]);
  expect(clock.beatSeconds(8)).toBe(4);
  expect(clock.secondsBeat(clock.beatSeconds(21.5))).toBeCloseTo(21.5);
  const c = compileSound(
    score({
      unit: 'beats',
      duration: 24,
      tempo: [
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 60 },
      ],
      tracks: [
        {
          id: 'tone',
          instrument: soundPreset('sine'),
          events: [{ id: 'a', at: 10, duration: 2, note: 'C4' }],
        },
      ],
    }),
  );
  expect(c.tracks[0].events[0].start).toBe(6 * SOUND_RATE);
  expect(c.tracks[0].events[0].gate).toBe(2);
});
it('produces the expected A4 spectrum and identical samples for arbitrary block partitions', () => {
  const a = render(score()),
    b = render(score(), 997);
  expect(a.left).toEqual(b.left);
  expect(a.right).toEqual(b.right);
  const spectrum = fftMagnitudes(a.left.slice(0, 32768)),
    max = spectrum.reduce((best, v, i) => (v > spectrum[best] ? i : best), 0);
  expect((max * SOUND_RATE) / 32768).toBeCloseTo(440, -1);
  expect(Math.max(...a.left.slice(0, 4800))).toBeCloseTo(0.3 / Math.sqrt(2));
});
it('retains release at a gate inside attack, seeded noise and post-fader automation across blocks', () => {
  const input = score({
    duration: 0.4,
    tracks: [
      {
        id: 'noise',
        instrument: {
          type: 'synth',
          wave: 'noise',
          attack: 0.1,
          decay: 0.1,
          sustain: 0.5,
          release: 0.1,
          gain: 0.5,
        },
        events: [{ id: 'a', at: 0.05, duration: 0.03 }],
        automation: [
          {
            property: 'gainDb',
            keys: [
              { at: 0, value: -6 },
              { at: 0.4, value: 0 },
            ],
          },
          {
            property: 'pan',
            keys: [
              { at: 0, value: -1 },
              { at: 0.4, value: 1 },
            ],
          },
        ],
      },
    ],
  });
  const a = render(input, 512),
    b = render(input, 137);
  expect(a).toEqual(b);
  expect(a.left.slice(0, 2400).every((v) => v === 0)).toBe(true);
  expect(a.left.slice(9000).every((v) => v === 0)).toBe(true);
});
it('routes acyclic post-fader sends once and preserves feedback echoes and stereo-linked limiting', () => {
  const e = soundEffects([{ type: 'delay', seconds: 0.01, feedback: 0.5, mix: 1 }]),
    block = { left: new Float64Array(1500), right: new Float64Array(1500) };
  block.left[0] = 1;
  e(block, 0);
  expect(block.left[480]).toBe(1);
  expect(block.left[960]).toBe(0.5);
  expect(block.left[1440]).toBe(0.25);
  const input = score({
    tracks: [
      {
        id: 'tone',
        instrument: soundPreset('sine'),
        events: [{ id: 'a', at: 0, duration: 1 }],
        busId: 'dry',
        sends: [{ busId: 'wet', db: -6 }],
      },
    ],
    buses: [{ id: 'dry' }, { id: 'wet', effects: [{ type: 'reverb', seconds: 1, mix: 1 }] }],
    master: { effects: [{ type: 'limiter', ceilingDb: -6 }] },
  });
  const a = render(input);
  expect(Math.max(...a.left.slice(0, 15000).map(Math.abs))).toBeLessThanOrEqual(
    10 ** (-6 / 20) + 1e-12,
  );
  expect(() =>
    compileSound(
      score({
        buses: [
          { id: 'a', busId: 'b' },
          { id: 'b', busId: 'a' },
        ],
      }),
    ),
  ).toThrow('cycle');
});
it('filters EQ bands, compresses linked peaks and retains effect tails after note-off', () => {
  const high = render(
      score({
        tracks: [
          {
            id: 'tone',
            instrument: { ...soundPreset('sine'), attack: 0, decay: 0, sustain: 1, release: 0 },
            events: [{ id: 'a', at: 0, duration: 1, note: 100 }],
            effects: [{ type: 'filter', mode: 'lowpass', frequency: 200 }],
          },
        ],
      }),
    ),
    plain = render(
      score({
        tracks: [
          {
            id: 'tone',
            instrument: { ...soundPreset('sine'), attack: 0, decay: 0, sustain: 1, release: 0 },
            events: [{ id: 'a', at: 0, duration: 1, note: 100 }],
          },
        ],
      }),
    );
  const rms = (values: Float64Array) =>
    Math.sqrt(values.slice(2400).reduce((a, v) => a + v * v, 0) / (values.length - 2400));
  expect(rms(high.left)).toBeLessThan(rms(plain.left) * 0.01);
  const block = { left: new Float64Array(48000).fill(1), right: new Float64Array(48000).fill(0.5) };
  soundEffects([
    {
      type: 'compressor',
      thresholdDb: -20,
      ratio: 4,
      kneeDb: 0,
      attack: 0.001,
      release: 0.1,
      makeupDb: 0,
    },
  ])(block, 0);
  expect(block.left[47999]).toBeCloseTo(10 ** (-15 / 20));
  expect(block.right[47999] / block.left[47999]).toBe(0.5);
  const tail = render(
    score({
      duration: 0.1,
      tail: 0.2,
      tracks: [
        {
          id: 'tone',
          instrument: { ...soundPreset('sine'), release: 0 },
          events: [{ id: 'a', at: 0, duration: 0.1 }],
          effects: [{ type: 'delay', seconds: 0.15, feedback: 0, mix: 1 }],
        },
      ],
    }),
  );
  expect(tail.left.slice(0, 7200).every((v) => v === 0)).toBe(true);
  expect(rms(tail.left)).toBeGreaterThan(0);
});
it('rejects bad notes, tempos, automation, oversized work and duplicate stable IDs', () => {
  for (const patch of [
    { tempo: [{ beat: 1, bpm: 120 }] },
    {
      tracks: [
        {
          id: 'a',
          instrument: soundPreset('sine'),
          events: [{ id: 'x', at: 0, duration: 1, note: 'C99' }],
        },
      ],
    },
    { duration: 1801 },
    {
      tracks: [
        {
          id: 'a',
          instrument: soundPreset('sine'),
          events: [
            { id: 'x', at: 0, duration: 1 },
            { id: 'x', at: 0, duration: 1 },
          ],
        },
      ],
    },
  ])
    expect(() => compileSound(score(patch))).toThrow();
});
it('round-trips MIDI note/velocity/tempo data and reports effects omitted from MIDI', () => {
  const original = compileSound(
      score({
        unit: 'beats',
        duration: 8,
        tempo: [
          { beat: 0, bpm: 120 },
          { beat: 4, bpm: 90 },
        ],
        tracks: [
          {
            id: 'tone',
            instrument: soundPreset('bell'),
            events: [
              { id: 'a', at: 0, duration: 2, note: 'C4', velocity: 90 / 127 },
              { id: 'b', at: 4, duration: 2, note: 'E4', velocity: 100 / 127 },
            ],
            effects: [{ type: 'reverb', mix: 0.2 }],
          },
        ],
      }),
    ),
    exported = exportSoundMidi(original.document),
    imported = importSoundMidi(exported.data, { id: 'midi', name: 'import' });
  expect(imported.notes).toBe(2);
  expect(imported.document.duration).toBe(8);
  expect(imported.document.tempo.map((t) => t.beat)).toEqual([0, 4]);
  for (let i = 0; i < original.document.tempo.length; i++)
    expect(imported.document.tempo[i].bpm).toBeCloseTo(original.document.tempo[i].bpm, 4);
  expect(
    imported.document.tracks[0].events.map((e) => [e.at, e.duration, e.note, e.velocity]),
  ).toEqual([
    [0, 2, 60, 90 / 127],
    [4, 2, 64, 100 / 127],
  ]);
  expect(exported.warnings.length).toBeGreaterThan(0);
  expect(() =>
    importSoundMidi(exported.data.slice(0, -2), { id: 'broken', name: 'broken' }),
  ).toThrow('Truncated');
});
it('imports MIDI sustain and running status as explicit extended note gates', () => {
  const track = [
      0, 0x90, 60, 100, 0, 0xb0, 64, 127, 0x83, 0x60, 0x80, 60, 0, 0x83, 0x60, 0xb0, 64, 0, 0, 0xff,
      0x2f, 0,
    ],
    data = new Uint8Array([
      77,
      84,
      104,
      100,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
      1,
      1,
      224,
      77,
      84,
      114,
      107,
      0,
      0,
      0,
      track.length,
      ...track,
    ]),
    imported = importSoundMidi(data, { id: 'sustain', name: 'sustain' });
  expect(imported.document.tracks[0].events[0].duration).toBe(2);
  expect(imported.warnings.some((w) => w.includes('Controller'))).toBe(false);
});
it('band-limits pitched samples to suppress aliases and wraps loop interpolation deterministically', () => {
  const samples = new Float32Array(48000);
  for (let i = 0; i < samples.length; i++)
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 22000 * i) / 48000);
  const doc = score({
      duration: 0.15,
      tracks: [
        {
          id: 'sample',
          instrument: {
            type: 'sample',
            assetId: 'source',
            sourceDuration: 1,
            rootNote: 'A4',
            attack: 0,
            release: 0,
          },
          events: [{ id: 'a', at: 0, duration: 0.15, note: 'A5', velocity: 1 }],
        },
      ],
    }),
    renderer = new SoundRenderer(doc, new Map([['sample', { left: samples, right: samples }]]));
  const block = renderer.process(4096),
    rms = Math.sqrt(
      block.left.slice(100).reduce((sum, v) => sum + v * v, 0) / (block.left.length - 100),
    );
  expect(rms).toBeLessThan(0.01);
});
