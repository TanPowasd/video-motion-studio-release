import { soundPreset } from '../src/core/sound.js';
import { soundDocumentSchema, type SoundInput } from '../src/core/sound-schema.js';
export function musicStudioScore(): SoundInput {
  const chords = [
    [60, 64, 67],
    [57, 60, 64],
    [53, 57, 60],
    [55, 59, 62],
  ];
  const phrase = (id: string, name: string, variation: number) => ({
    id,
    name,
    length: 16,
    channels: [
      {
        trackId: 'keys',
        events: Array.from({ length: 32 }, (_, i) => ({
          id: 'key-' + i,
          at: i * 0.5,
          duration: 0.34,
          note: chords[Math.floor(i / 8)][(i + variation) % 3] + (i % 8 === 7 ? 12 : 0),
          velocity: i % 2 ? 0.48 : 0.65,
        })),
      },
      {
        trackId: 'pad',
        events: chords.flatMap((chord, bar) =>
          chord.map((note, i) => ({
            id: `pad-${bar}-${i}`,
            at: bar * 4,
            duration: 3.8,
            note,
            velocity: 0.32,
          })),
        ),
      },
      {
        trackId: 'bass',
        events: Array.from({ length: 16 }, (_, i) => ({
          id: 'bass-' + i,
          at: i,
          duration: 0.6,
          note: chords[Math.floor(i / 4)][0] - 24,
          velocity: 0.6,
        })),
      },
      {
        trackId: 'kick',
        events: Array.from({ length: 8 }, (_, i) => ({
          id: 'kick-' + i,
          at: i * 2,
          duration: 0.2,
          velocity: 0.68,
        })),
      },
      {
        trackId: 'snare',
        events: Array.from({ length: 8 }, (_, i) => ({
          id: 'snare-' + i,
          at: i * 2 + 1,
          duration: 0.18,
          velocity: 0.5,
        })),
      },
      {
        trackId: 'hat',
        events: Array.from({ length: 32 }, (_, i) => ({
          id: 'hat-' + i,
          at: i * 0.5,
          duration: 0.1,
          velocity: i % 2 ? 0.22 : 0.32,
        })),
      },
    ],
  });
  return soundDocumentSchema.parse({
    kind: 'sound',
    version: 1,
    id: 'studio-score',
    name: '暖色循环 · Pattern 编曲',
    unit: 'beats',
    duration: 64,
    tail: 1.5,
    tempo: [{ beat: 0, bpm: 120 }],
    seed: 73,
    tracks: [
      {
        id: 'keys',
        name: 'Keys · FM 铃音',
        instrument: soundPreset('bell'),
        gainDb: -8,
        pan: -0.15,
        sends: [{ busId: 'room', db: -15 }],
        effects: [{ type: 'delay', seconds: 0.25, feedback: 0.25, mix: 0.18 }],
      },
      {
        id: 'pad',
        name: 'Pad · 和弦',
        instrument: soundPreset('pad'),
        gainDb: -10,
        pan: 0.15,
        sends: [{ busId: 'room', db: -15 }],
      },
      {
        id: 'bass',
        name: 'Bass · 低音',
        instrument: soundPreset('bass'),
        gainDb: -10,
        effects: [{ type: 'filter', mode: 'lowpass', frequency: 1400 }],
      },
      ...(['kick', 'snare', 'hat'] as const).map((voice) => ({
        id: voice,
        name: voice[0].toUpperCase() + voice.slice(1),
        instrument: soundPreset(voice),
        gainDb: -9,
      })),
    ],
    patterns: [
      phrase('phrase-a', 'Pattern A · 主题', 0),
      phrase('phrase-b', 'Pattern B · 变化', 1),
    ],
    arrangement: [
      { id: 'a1', patternId: 'phrase-a', at: 0, repeats: 2 },
      { id: 'b1', patternId: 'phrase-b', at: 32, repeats: 2 },
    ],
    buses: [
      {
        id: 'room',
        name: 'Room · 空间',
        effects: [{ type: 'reverb', seconds: 1.5, mix: 1 }],
        gainDb: -6,
      },
    ],
    master: { gainDb: -2, effects: [{ type: 'limiter', ceilingDb: -1 }] },
  });
}
