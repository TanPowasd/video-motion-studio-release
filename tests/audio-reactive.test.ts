import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeAudio, audioAt, fftMagnitudes } from '../src/media/analysis.js';
import { ffmpegBinary, runProcess } from '../src/media/ffmpeg.js';
it('FFT identifies known frequency and amplitude with window normalization', () => {
  const samples = Float64Array.from(
      { length: 2048 },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 64 * i) / 2048),
    ),
    magnitudes = fftMagnitudes(samples),
    maximum = Math.max(...magnitudes);
  expect(magnitudes.indexOf(maximum)).toBe(64);
  expect(maximum).toBeCloseTo(0.5, 3);
});
it('analyzes real PCM tone energy and samples features independently of order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-analysis-')),
    file = path.join(root, 'bass.wav');
  try {
    await runProcess(ffmpegBinary(), [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=100:duration=2',
      '-c:a',
      'pcm_s16le',
      file,
    ]);
    const analysis = await analyzeAudio(file),
      a = audioAt(analysis, 0.7);
    expect(analysis.features.length).toBeGreaterThan(40);
    expect(a.rms).toBeCloseTo(0.125 / Math.sqrt(2), 2);
    expect(a.bass).toBeGreaterThan(a.mid * 10);
    expect(a.bass).toBeGreaterThan(a.treble * 10);
    audioAt(analysis, 0.1);
    expect(audioAt(analysis, 0.7)).toEqual(a);
    expect(audioAt(analysis, 3).rms).toBe(0);
    const segment = await analyzeAudio(file, { start: 1, duration: 0.5 });
    expect(segment.duration).toBeCloseTo(0.5, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
