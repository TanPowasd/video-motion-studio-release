/*
 * Deterministic, streaming loudness tools for rendered sound (48 kHz stereo):
 *
 * - LoudnessMeter: ITU-R BS.1770-4 / EBU R128 integrated loudness (K-weighting, 400 ms
 *   blocks with 75 % overlap, -70 LUFS absolute and -10 LU relative gates) and true peak
 *   (4× oversampled, BS.1770 Annex 2 style polyphase interpolation).
 * - TruePeakLimiter: look-ahead brick-wall limiter whose detector runs on the same 4×
 *   oversampled signal, so inter-sample peaks stay under the ceiling. It has a fixed
 *   latency (`latency` samples); offline callers drop that many leading output samples and
 *   flush with silence, so the result is time-aligned with the input.
 *
 * Pure TypeScript, no FFmpeg: the sound cache stays reproducible on every platform.
 */
import { SOUND_RATE, dbGain } from './sound-effects.js';

export const OVERSAMPLE = 4;
/** Half the interpolation filter length per phase (taps per phase = 2 * HALF). */
const HALF = 8;
/** Windowed-sinc polyphase interpolator for positions m + p/4, p = 1..3. */
const PHASES: Float64Array[] = (() => {
  const phases: Float64Array[] = [];
  for (let p = 1; p < OVERSAMPLE; p++) {
    const frac = p / OVERSAMPLE,
      taps = new Float64Array(2 * HALF);
    let sum = 0;
    for (let k = 0; k < 2 * HALF; k++) {
      // tap k multiplies x[m - HALF + 1 + k]
      const x = k - HALF + 1 - frac,
        sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x),
        window = 0.5 + 0.5 * Math.cos((Math.PI * x) / (HALF + 0.5));
      taps[k] = sinc * window;
      sum += taps[k];
    }
    for (let k = 0; k < taps.length; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
})();

/** Ring of the last 2*HALF samples of one channel; yields inter-sample peak magnitudes. */
class Interpolator {
  private ring = new Float64Array(2 * HALF);
  private at = 0;
  /** Push x[n]; returns max |x(t)| for t in (n-HALF, n-HALF+1) (exclusive ends). */
  push(value: number) {
    this.ring[this.at] = value;
    this.at = (this.at + 1) % this.ring.length;
    let peak = 0;
    for (const taps of PHASES) {
      let y = 0;
      // oldest sample in the ring is x[n - 2*HALF + 1] = x[m - HALF + 1] for m = n - HALF
      for (let k = 0; k < taps.length; k++) y += taps[k] * this.ring[(this.at + k) % this.ring.length];
      peak = Math.max(peak, Math.abs(y));
    }
    return peak;
  }
}

// BS.1770 K-weighting at 48 kHz (pre-filter shelf + RLB high-pass).
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  HIGHPASS = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };
class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private c: { b: number[]; a: number[] }) {}
  run(x: number) {
    const y = this.c.b[0] * x + this.z1;
    this.z1 = this.c.b[1] * x - this.c.a[0] * y + this.z2;
    this.z2 = this.c.b[2] * x - this.c.a[1] * y;
    return y;
  }
}

const SEGMENT = SOUND_RATE / 10; // 100 ms; a gating block is 4 segments
export interface LoudnessReport {
  /** Gated integrated loudness, LUFS; null for silence or < 400 ms of audio. */
  integratedLufs: number | null;
  /** 4× oversampled true peak, dBTP; null for digital silence. */
  truePeakDb: number | null;
  samplePeakDb: number | null;
  sampleCount: number;
}
export class LoudnessMeter {
  private filters = [0, 1].map(() => [new Biquad(SHELF), new Biquad(HIGHPASS)]);
  private interpolators = [new Interpolator(), new Interpolator()];
  private segments: number[] = [];
  private segmentSum = 0;
  private segmentCount = 0;
  private truePeak = 0;
  private samplePeak = 0;
  private count = 0;
  push(left: ArrayLike<number>, right: ArrayLike<number>) {
    for (let i = 0; i < left.length; i++) {
      const l = left[i],
        r = right[i],
        kl = this.filters[0][1].run(this.filters[0][0].run(l)),
        kr = this.filters[1][1].run(this.filters[1][0].run(r)),
        sample = Math.max(Math.abs(l), Math.abs(r));
      this.samplePeak = Math.max(this.samplePeak, sample);
      this.truePeak = Math.max(
        this.truePeak,
        sample,
        this.interpolators[0].push(l),
        this.interpolators[1].push(r),
      );
      this.segmentSum += kl * kl + kr * kr;
      if (++this.segmentCount === SEGMENT) {
        this.segments.push(this.segmentSum);
        this.segmentSum = 0;
        this.segmentCount = 0;
      }
    }
    this.count += left.length;
  }
  report(): LoudnessReport {
    // Flush the interpolators so a peak in the last few samples is seen.
    const tail = new Float64Array(2 * HALF),
      saved = this.interpolators;
    for (let i = 0; i < tail.length; i++)
      this.truePeak = Math.max(this.truePeak, saved[0].push(0), saved[1].push(0));
    this.interpolators = [new Interpolator(), new Interpolator()];
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.segments.length; i++)
      blocks.push(
        (this.segments[i] + this.segments[i + 1] + this.segments[i + 2] + this.segments[i + 3]) /
          (4 * SEGMENT),
      );
    const lufs = (z: number) => -0.691 + 10 * Math.log10(z),
      absolute = blocks.filter((z) => z > 0 && lufs(z) > -70);
    let integrated: number | null = null;
    if (absolute.length) {
      const relative = lufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10,
        gated = absolute.filter((z) => lufs(z) > relative);
      if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
    }
    const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : null);
    return {
      integratedLufs: integrated,
      truePeakDb: db(this.truePeak),
      samplePeakDb: db(this.samplePeak),
      sampleCount: this.count,
    };
  }
}
export function measureLoudness(left: ArrayLike<number>, right: ArrayLike<number>) {
  const meter = new LoudnessMeter();
  meter.push(left, right);
  return meter.report();
}

/**
 * Look-ahead true-peak limiter. Output sample k is input k times a smooth gain that is
 * never above ceiling / (oversampled peak near k). Latency = lookahead + HALF samples.
 */
export class TruePeakLimiter {
  readonly latency: number;
  private readonly lookahead: number;
  private readonly ceiling: number;
  private readonly release: number;
  private interpolators = [new Interpolator(), new Interpolator()];
  /** Delay line of input samples (interleaved by channel). */
  private delayL: Float64Array;
  private delayR: Float64Array;
  private size: number;
  private n = 0;
  private previousInter = 0;
  /** Monotonic deque for the sliding minimum of required gain. */
  private dequeIndex: number[] = [];
  private dequeValue: number[] = [];
  private targets: Float64Array;
  private targetSum: number;
  private targetAt = 0;
  private gain = 1;
  /** Peak gain reduction applied so far, dB (positive). */
  maxReductionDb = 0;
  constructor(ceilingDb = -1, options: { lookaheadSeconds?: number; releaseSeconds?: number } = {}) {
    this.lookahead = Math.max(4, Math.round((options.lookaheadSeconds ?? 0.0015) * SOUND_RATE));
    // Small safety margin: gain modulation slightly changes the interpolated peaks.
    this.ceiling = dbGain(ceilingDb - 0.05);
    this.release = Math.exp(-1 / (Math.max(0.001, options.releaseSeconds ?? 0.05) * SOUND_RATE));
    this.latency = this.lookahead + HALF;
    this.size = 1;
    while (this.size < this.latency + 2 * HALF + 4) this.size *= 2;
    this.delayL = new Float64Array(this.size);
    this.delayR = new Float64Array(this.size);
    this.targets = new Float64Array(this.lookahead).fill(1);
    this.targetSum = this.lookahead;
  }
  /** Process one block; returns the same number of (delayed) samples. */
  process(left: ArrayLike<number>, right: ArrayLike<number>) {
    const outL = new Float64Array(left.length),
      outR = new Float64Array(left.length),
      mask = this.size - 1,
      L = this.lookahead;
    for (let i = 0; i < left.length; i++) {
      const n = this.n++;
      this.delayL[n & mask] = left[i];
      this.delayR[n & mask] = right[i];
      // Inter-sample peak in (m, m+1) for m = n - HALF.
      const inter = Math.max(this.interpolators[0].push(left[i]), this.interpolators[1].push(right[i])),
        m = n - HALF;
      let required = 1;
      if (m >= 0) {
        const peak = Math.max(
          Math.abs(this.delayL[m & mask]),
          Math.abs(this.delayR[m & mask]),
          inter,
          this.previousInter,
        );
        required = peak > this.ceiling ? this.ceiling / peak : 1;
      }
      this.previousInter = inter;
      // Sliding minimum of required gain over [m - L, m] = target for sample m - L.
      while (this.dequeValue.length && this.dequeValue[this.dequeValue.length - 1] >= required) {
        this.dequeValue.pop();
        this.dequeIndex.pop();
      }
      this.dequeValue.push(required);
      this.dequeIndex.push(m);
      while (this.dequeIndex[0] < m - L) {
        this.dequeIndex.shift();
        this.dequeValue.shift();
      }
      const target = this.dequeValue[0];
      // Moving average over the last L targets: reaches each minimum before its peak.
      this.targetSum += target - this.targets[this.targetAt];
      this.targets[this.targetAt] = target;
      this.targetAt = (this.targetAt + 1) % L;
      const average = Math.min(1, this.targetSum / L);
      this.gain = average < this.gain ? average : this.gain + (average - this.gain) * (1 - this.release);
      if (this.gain < 1) this.maxReductionDb = Math.max(this.maxReductionDb, -20 * Math.log10(this.gain));
      const k = n - this.latency;
      outL[i] = k >= 0 ? this.delayL[k & mask] * this.gain : 0;
      outR[i] = k >= 0 ? this.delayR[k & mask] * this.gain : 0;
    }
    return { left: outL, right: outR };
  }
}

/**
 * Offline, time-aligned limiting of a whole stereo signal held in memory (tests and small
 * buffers). Streaming callers use TruePeakLimiter directly and drop `latency` samples.
 */
export function limitTruePeak(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  ceilingDb = -1,
  options: { lookaheadSeconds?: number; releaseSeconds?: number } = {},
) {
  const limiter = new TruePeakLimiter(ceilingDb, options),
    a = limiter.process(left, right),
    b = limiter.process(new Float64Array(limiter.latency), new Float64Array(limiter.latency)),
    n = left.length,
    outL = new Float64Array(n),
    outR = new Float64Array(n);
  const all = (x: Float64Array, y: Float64Array, i: number) => (i < x.length ? x[i] : y[i - x.length]);
  for (let i = 0; i < n; i++) {
    outL[i] = all(a.left, b.left, i + limiter.latency);
    outR[i] = all(a.right, b.right, i + limiter.latency);
  }
  return { left: outL, right: outR, maxReductionDb: limiter.maxReductionDb };
}
