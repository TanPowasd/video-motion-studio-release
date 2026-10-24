import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SoundRenderer, SOUND_RATE, soundPreset } from '../src/core/sound.js';
import { soundDocumentSchema } from '../src/core/sound-schema.js';
import { measureLoudness, limitTruePeak, TruePeakLimiter } from '../src/core/sound-loudness.js';
import { sequenceSchema } from '../src/core/model.js';
import { SequenceMixRenderer } from '../src/core/audio-mix.js';
import { applySoundLoudness, audioSourceFile } from '../src/media/sound-source.js';

const sine = (seconds: number, frequency: number, amplitude: number, phase = 0) => {
  const n = Math.round(seconds * SOUND_RATE),
    out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SOUND_RATE + phase);
  return out;
};
const peak = (a: ArrayLike<number>) => {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
};
const score = (master: Record<string, unknown>) => ({
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
      instrument: { ...soundPreset('sine'), gain: 0.5, attack: 0, decay: 0, sustain: 1, release: 0 },
      events: [{ id: 'a', at: 0, duration: 1, note: 'A4', velocity: 1 }],
    },
  ],
  master,
});
function render(raw: unknown) {
  const r = new SoundRenderer(raw),
    left = new Float64Array(r.compiled.sampleCount),
    right = new Float64Array(left.length);
  while (r.position < left.length) {
    const start = r.position,
      block = r.process(Math.min(4096, left.length - start));
    left.set(block.left, start);
    right.set(block.right, start);
  }
  return { left, right };
}

describe('master gain stage (bug: gainDb bypassed the master limiter)', () => {
  it('applies sound master gain before the master chain by default so the limiter is last', () => {
    const ceiling = 10 ** (-6 / 20),
      limited = { gainDb: 12, effects: [{ type: 'limiter', ceilingDb: -6 }] };
    const pre = render(score(limited)),
      legacy = render(score({ ...limited, gainStage: 'post' }));
    expect(soundDocumentSchema.parse(score(limited)).master.gainStage).toBe('pre');
    expect(peak(pre.left)).toBeLessThanOrEqual(ceiling + 1e-9);
    // Legacy order: +12 dB after the -6 dB limiter pushes the output past 0 dBFS.
    expect(peak(legacy.left)).toBeGreaterThan(1);
    // Without nonlinear master effects both orders are identical.
    const linearPre = render(score({ gainDb: -3, effects: [{ type: 'gain', db: -2 }] })),
      linearPost = render(score({ gainDb: -3, gainStage: 'post', effects: [{ type: 'gain', db: -2 }] }));
    for (let i = 0; i < 2000; i += 97) expect(linearPre.left[i]).toBeCloseTo(linearPost.left[i], 12);
  });
  it('applies sequence-mix master gain before the master limiter by default', () => {
    const mix = (gainStage?: 'pre' | 'post') =>
        sequenceSchema.parse({
          id: 'main',
          name: 'mix',
          duration: 30,
          tracks: [{ id: 'music', name: 'Music', type: 'audio', clips: [] }],
          mix: {
            master: { gainDb: 12, ...(gainStage ? { gainStage } : {}), effects: [{ type: 'limiter', ceilingDb: -6, release: 0.1 }] },
          },
        }),
      run = (gainStage?: 'pre' | 'post') =>
        new SequenceMixRenderer(mix(gainStage), { num: 30, den: 1 }).process(
          new Map([['music', { left: sine(0.1, 220, 0.5), right: sine(0.1, 220, 0.5) }]]),
          4800,
        ).master;
    expect(peak(run().left)).toBeLessThanOrEqual(10 ** (-6 / 20) + 1e-9);
    expect(peak(run('post').left)).toBeGreaterThan(1.5);
  });
});

describe('BS.1770 loudness and true-peak limiting for music', () => {
  it('measures integrated loudness and 4x true peak', () => {
    const tone = sine(3, 997, 0.1),
      m = measureLoudness(tone, tone);
    expect(m.integratedLufs!).toBeCloseTo(-20, 0);
    expect(Math.abs(m.integratedLufs! + 20)).toBeLessThan(0.2);
    // fs/4 sine at 45° phase: samples are ±0.707 but the waveform reaches 1.0 between them.
    const hidden = sine(1, SOUND_RATE / 4, 1, Math.PI / 4),
      h = measureLoudness(hidden, hidden);
    expect(h.samplePeakDb!).toBeCloseTo(-3.01, 1);
    expect(h.truePeakDb!).toBeGreaterThan(-0.4);
    expect(measureLoudness(new Float64Array(48000), new Float64Array(48000)).integratedLufs).toBeNull();
    // Gating: a silent half does not lower the integrated loudness.
    const half = new Float64Array(tone.length * 2);
    half.set(tone);
    // (only the few 400 ms blocks straddling the edge pass the relative gate)
    expect(Math.abs(measureLoudness(half, half).integratedLufs! - m.integratedLufs!)).toBeLessThan(0.3);
  });
  it('limits inter-sample peaks under the ceiling with a time-aligned, latency-free result', () => {
    const left = sine(1, SOUND_RATE / 4, 1.6, Math.PI / 4),
      right = sine(1, 3000, 0.2);
    left.fill(0, 30000);
    left[47000] = 0.3; // isolated quiet impulse well after the loud part
    const out = limitTruePeak(left, right, -1);
    expect(measureLoudness(out.left, out.right).truePeakDb!).toBeLessThanOrEqual(-1 + 0.05);
    expect(out.maxReductionDb).toBeGreaterThan(4);
    // Same timing: the impulse stays at its sample, at its original level after release.
    expect(out.left[47000]).toBeCloseTo(0.3, 3);
    expect(Math.abs(out.left[46999])).toBeLessThan(1e-9);
    expect(new TruePeakLimiter(-1).latency).toBeGreaterThan(0);
  });
  it('normalises a rendered sound to the LUFS target and keeps true peak under the ceiling', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vmotion-loudness-'));
    try {
      const n = 3 * SOUND_RATE,
        left = sine(3, 440, 0.05),
        right = sine(3, 660, 0.05);
      left[SOUND_RATE] = 0.9; // transient that normalisation would push past 0 dBFS
      const header = Buffer.alloc(44),
        data = Buffer.alloc(n * 8);
      for (let i = 0; i < n; i++) {
        data.writeFloatLE(left[i], i * 8);
        data.writeFloatLE(right[i], i * 8 + 4);
      }
      await writeFile(path.join(dir, 'in.wav'), Buffer.concat([header, data]));
      const result = await applySoundLoudness(
        path.join(dir, 'in.wav'),
        path.join(dir, 'out.wav'),
        n,
        { targetLufs: -14, truePeakDb: -1, maxGainDb: 24, release: 0.05 },
      );
      expect(result.loudness.input!.integratedLufs!).toBeLessThan(-25);
      expect(result.loudness.gainDb).toBeGreaterThan(10);
      expect(Math.abs(result.loudness.output.integratedLufs! + 14)).toBeLessThan(0.5);
      expect(result.loudness.output.truePeakDb!).toBeLessThanOrEqual(-0.95);
      const bytes = await readFile(path.join(dir, 'out.wav'));
      expect(bytes.length).toBe(44 + n * 8);
      expect(soundDocumentSchema.parse(score({ loudness: {} })).master.loudness).toEqual({
        targetLufs: -14,
        truePeakDb: -1,
        maxGainDb: 24,
        release: 0.05,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('renders master.loudness through the sound cache with a loudness report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-loudness-cache-'));
    try {
      const doc = { ...score({ loudness: { targetLufs: -16, truePeakDb: -1.5 } }), duration: 2 },
        asset = { id: 'score', name: 'score', type: 'audio', path: 'components/sounds/score.json', soundSource: 'components/sounds/score.json' },
        snapshot = { files: { 'components/sounds/score.json': JSON.stringify(doc) }, project: { assets: [asset] } };
      const file = await audioSourceFile(root, snapshot as never, asset as never),
        report = JSON.parse(await readFile(file + '.json', 'utf8'));
      expect(Math.abs(report.loudness.output.integratedLufs + 16)).toBeLessThan(0.5);
      expect(report.loudness.output.truePeakDb).toBeLessThanOrEqual(-1.45);
      expect(report.peak).toBeLessThanOrEqual(10 ** (-1.45 / 20));
      const plain = await audioSourceFile(
        root,
        { ...snapshot, files: { 'components/sounds/score.json': JSON.stringify({ ...doc, master: {} }) } } as never,
        asset as never,
      );
      expect(plain).not.toBe(file);
      expect(JSON.parse(await readFile(plain + '.json', 'utf8')).loudness).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
