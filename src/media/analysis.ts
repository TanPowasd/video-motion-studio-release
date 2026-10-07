import { spawn } from 'node:child_process';
import { ffmpegBinary, probe } from './ffmpeg.js';
import { VmotionError } from '../core/model.js';
export interface AudioFeature {
  time: number;
  rms: number;
  peak: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  beat: number;
}
export interface AudioAnalysis {
  sampleRate: number;
  rate: number;
  duration: number;
  bpm: number;
  beats: number[];
  features: AudioFeature[];
}
export function fftMagnitudes(samples: Float64Array) {
  const n = samples.length;
  if (n < 2 || n & (n - 1)) throw new Error('FFT size must be a power of two');
  const re = new Float64Array(n),
    im = new Float64Array(n);
  let normalization = 0;
  for (let i = 0, j = 0; i < n; i++) {
    if (i) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
    }
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[j] = samples[i] * window;
    normalization += window;
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size,
      wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let begin = 0; begin < n; begin += size) {
      let ar = 1,
        ai = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = begin + k,
          b = a + size / 2,
          tr = ar * re[b] - ai * im[b],
          ti = ar * im[b] + ai * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = ar * wr - ai * wi;
        ai = ar * wi + ai * wr;
        ar = next;
      }
    }
  }
  return Float64Array.from(
    { length: n / 2 + 1 },
    (_, i) => (Math.hypot(re[i], im[i]) * (i === 0 || i === n / 2 ? 1 : 2)) / normalization,
  );
}
export async function analyzeAudio(
  file: string,
  options: { rate?: number; start?: number; duration?: number; signal?: AbortSignal } = {},
): Promise<AudioAnalysis> {
  const metadata = await probe(file);
  if (!metadata.streams.some((s) => s.codec_type === 'audio'))
    throw new VmotionError('NO_AUDIO', 'This asset has no audio');
  const fullDuration = Number(
      metadata.format.duration ?? metadata.streams.find((s) => s.codec_type === 'audio')?.duration,
    ),
    start = options.start ?? 0,
    duration = options.duration ?? fullDuration - start,
    rate = options.rate ?? 30,
    sampleRate = 24000,
    windowSize = 2048,
    hop = Math.round(sampleRate / rate);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 14400 ||
    !Number.isFinite(start) ||
    start < 0 ||
    start >= fullDuration ||
    rate < 5 ||
    rate > 60
  )
    throw new VmotionError(
      'ANALYSIS_RANGE',
      'Analyze a finite 0–4 hour range at 5–60 samples per second',
    );
  const child = spawn(
    ffmpegBinary(),
    [
      '-v',
      'error',
      '-ss',
      String(start),
      '-i',
      file,
      '-t',
      String(duration),
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { windowsHide: true, signal: options.signal },
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr = (stderr + c.toString()).slice(-8000)));
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new VmotionError(
              options.signal?.aborted ? 'CANCELLED' : 'AUDIO_ANALYSIS',
              stderr || `Audio decoder exited ${code}`,
            ),
          ),
    );
  });
  closed.catch(() => {});
  const features: AudioFeature[] = [],
    previous = new Float64Array(windowSize / 2 + 1),
    ring = new Float64Array(windowSize);
  let position = 0,
    since = 0,
    pending = Buffer.alloc(0);
  function emit() {
    const samples = new Float64Array(windowSize);
    let sum = 0,
      peak = 0;
    for (let i = 0; i < windowSize; i++) {
      const sample = ring[(position + i) % windowSize];
      samples[i] = sample;
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const spectrum = fftMagnitudes(samples);
    let bass = 0,
      mid = 0,
      treble = 0,
      onset = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const frequency = (i * sampleRate) / windowSize,
        energy = spectrum[i] ** 2;
      onset += Math.max(0, spectrum[i] - previous[i]);
      previous[i] = spectrum[i];
      if (frequency < 250) bass += energy;
      else if (frequency < 4000) mid += energy;
      else treble += energy;
    }
    features.push({
      time: Math.max(0, (position - windowSize / 2) / sampleRate),
      rms: Math.sqrt(sum / windowSize),
      peak,
      bass: Math.sqrt(bass / 2),
      mid: Math.sqrt(mid / 2),
      treble: Math.sqrt(treble / 2),
      onset,
      beat: 0,
    });
  }
  try {
    for await (const chunk of child.stdout) {
      const bytes = Buffer.concat([pending, chunk]),
        complete = Math.floor(bytes.length / 4) * 4;
      for (let i = 0; i < complete; i += 4) {
        const sample = bytes.readFloatLE(i);
        ring[position % windowSize] = Number.isFinite(sample) ? sample : 0;
        position++;
        since++;
        if (position >= windowSize && since >= hop) {
          emit();
          since = 0;
        }
      }
      pending = bytes.subarray(complete);
    }
    if (!features.length && position) {
      while (position < windowSize) {
        ring[position % windowSize] = 0;
        position++;
      }
      emit();
    }
    await closed;
  } catch (e) {
    child.kill();
    throw e;
  }
  const beats: number[] = [];
  let last = -1;
  for (let i = 1; i < features.length - 1; i++) {
    const feature = features[i],
      begin = Math.max(0, i - Math.round(rate)),
      history = features.slice(begin, i),
      mean = history.reduce((sum, f) => sum + f.onset, 0) / Math.max(1, history.length);
    if (
      feature.onset > 0.025 &&
      feature.onset > mean * 1.6 &&
      feature.onset >= features[i - 1].onset &&
      feature.onset > features[i + 1].onset &&
      feature.time - last > 0.24
    ) {
      feature.beat = 1;
      beats.push(feature.time);
      last = feature.time;
    }
  }
  const intervals = beats
      .slice(1)
      .map((t, i) => t - beats[i])
      .filter((v) => v >= 0.25 && v <= 1.5)
      .sort((a, b) => a - b),
    bpm = intervals.length ? 60 / intervals[Math.floor(intervals.length / 2)] : 0;
  return {
    sampleRate,
    rate,
    duration: Math.min(duration, position / sampleRate),
    bpm,
    beats,
    features,
  };
}
export function audioAt(analysis: AudioAnalysis, time: number) {
  const values = analysis.features;
  if (!values.length || time < 0 || time > analysis.duration)
    return { rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, onset: 0, beat: 0, bpm: analysis.bpm };
  let low = 0,
    high = values.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (values[mid].time <= time) low = mid;
    else high = mid - 1;
  }
  const a = values[low],
    b = values[Math.min(low + 1, values.length - 1)],
    t = b.time === a.time ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))),
    out: any = { bpm: analysis.bpm };
  for (const key of ['rms', 'peak', 'bass', 'mid', 'treble', 'onset'] as const)
    out[key] = a[key] + (b[key] - a[key]) * t;
  let begin = 0,
    end = analysis.beats.length;
  while (begin < end) {
    const middle = (begin + end) >> 1;
    if (analysis.beats[middle] <= time) begin = middle + 1;
    else end = middle;
  }
  const last = analysis.beats[begin - 1];
  out.beat = last === undefined ? 0 : Math.max(0, 1 - (time - last) / 0.12);
  return out as {
    rms: number;
    peak: number;
    bass: number;
    mid: number;
    treble: number;
    onset: number;
    beat: number;
    bpm: number;
  };
}
