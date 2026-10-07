import { z } from 'zod';
import { AUDIO_SAMPLE_RATE, audioClips, sampleAtFrame, mixAudioSamples } from './audio.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { fingerprint, probe } from './ffmpeg.js';
import path from 'node:path';
import { audioEvidence, hasAudioMix } from './audio-mix-cache.js';
export const audioRangeSchema = z
  .object({
    sequenceId: z.string().optional(),
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startSample: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    sampleCount: z
      .number()
      .int()
      .min(1)
      .max(AUDIO_SAMPLE_RATE * 10)
      .default(AUDIO_SAMPLE_RATE * 4),
  })
  .strict();
export function audioMetrics(buffer: Buffer, bins = 120) {
  const samples = Math.floor(buffer.length / 8),
    levels: Array<{ peak: number; rms: number }> = [];
  let squared = 0,
    peak = 0,
    clipped = 0;
  for (let index = 0; index < samples; index++) {
    const left = buffer.readFloatLE(index * 8),
      right = buffer.readFloatLE(index * 8 + 4),
      power = (left * left + right * right) / 2,
      p = Math.max(Math.abs(left), Math.abs(right)),
      bin = Math.min(bins - 1, Math.floor((index / samples) * bins));
    squared += power;
    peak = Math.max(peak, p);
    if (p >= 0.9499) clipped++;
    const level = levels[bin] ?? { peak: 0, rms: 0 };
    level.peak = Math.max(level.peak, p);
    level.rms += power;
    levels[bin] = level;
  }
  return {
    peak,
    rms: Math.sqrt(squared / Math.max(1, samples)),
    limitedSampleRatio: clipped / Math.max(1, samples),
    levels: levels.map((level, index) => ({
      peak: level.peak,
      rms: Math.sqrt(
        level.rms /
          Math.max(
            1,
            Math.ceil(((index + 1) * samples) / bins) - Math.ceil((index * samples) / bins),
          ),
      ),
    })),
  };
}
export class AudioPreview {
  private cache = new Map<
    string,
    { buffer: Buffer; clipCount: number; inputs: Array<{ path: string; fingerprint: string }> }
  >();
  private bytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private probes = new Map<string, Awaited<ReturnType<typeof probe>>>();
  private controllers = new Set<AbortController>();
  private pending = 0;
  private closed = false;
  constructor(readonly root: string) {}
  get busy() {
    return this.pending > 0 || this.controllers.size > 0;
  }
  clearCache() {
    if (this.busy) throw new VmotionError('CACHE_BUSY', 'Audio preview is using its caches');
    this.cache.clear();
    this.probes.clear();
    this.bytes = 0;
  }
  async range(snapshot: Snapshot, raw: unknown, signal?: AbortSignal) {
    if (this.closed) throw new VmotionError('CANCELLED', 'Audio preview closed');
    const params = audioRangeSchema.parse(raw),
      sequenceId = params.sequenceId ?? snapshot.project.activeSequence,
      sequence = snapshot.sequences.find((s) => s.id === sequenceId);
    if (params.planId)
      throw new VmotionError(
        'AGENT_PLAN',
        'Resolve audio candidates through the project service before preview',
      );
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audio sequence not found');
    if (params.revision && params.revision !== snapshot.revision)
      throw new VmotionError('REVISION_CONFLICT', 'Project changed before audio preview', {
        expected: params.revision,
        actual: snapshot.revision,
      });
    const end = sampleAtFrame(sequence.duration, snapshot.project.fps);
    if (params.startSample >= end)
      throw new VmotionError('AUDIO_RANGE', 'Audio start lies beyond the sequence');
    const sampleCount = Math.min(params.sampleCount, end - params.startSample),
      clipSources = new Set(
        audioClips(snapshot, sequenceId)
          .filter(
            (c) =>
              sampleAtFrame(c.start, snapshot.project.fps) < params.startSample + sampleCount &&
              sampleAtFrame(c.start + c.duration, snapshot.project.fps) > params.startSample,
          )
          .map((c) => path.resolve(this.root, c.asset.path)),
      ),
      evidence = await audioEvidence(this.root, snapshot, sequenceId),
      key = JSON.stringify([
        snapshot.revision,
        sequenceId,
        params.startSample,
        sampleCount,
        evidence,
      ]);
    const result = (value: {
      buffer: Buffer;
      clipCount: number;
      inputs: Array<{ path: string; fingerprint: string }>;
    }) => ({
      ...value,
      revision: snapshot.revision,
      sequenceId,
      startSample: params.startSample,
      sampleCount,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 2,
      duration: sampleCount / AUDIO_SAMPLE_RATE,
    });
    if (signal?.aborted || this.closed)
      throw new VmotionError('CANCELLED', 'Audio request cancelled');
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return result(cached);
    }
    if (this.pending >= 8) throw new VmotionError('AUDIO_QUEUE', 'Audio preview queue is full');
    this.pending++;
    const task = this.queue
      .then(async () => {
        if (signal?.aborted) throw new VmotionError('CANCELLED', 'Audio request cancelled');
        const existing = this.cache.get(key);
        if (existing) return result(existing);
        const controller = new AbortController(),
          cancel = () => controller.abort();
        this.controllers.add(controller);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          const mixed =
            clipSources.size || hasAudioMix(snapshot, sequenceId)
              ? await mixAudioSamples(
                  this.root,
                  snapshot,
                  params.startSample,
                  sampleCount,
                  sequenceId,
                  controller.signal,
                  this.probes,
                )
              : { buffer: Buffer.alloc(sampleCount * 8), inputs: [], clipCount: 0 };
          for (const source of evidence.files)
            if ((await fingerprint(source.path)) !== source.fingerprint)
              throw new VmotionError(
                'ASSET_CHANGED',
                'Audio source changed while preparing preview',
                { file: source.path },
              );
          while (this.bytes + mixed.buffer.length > 32 * 1024 * 1024 && this.cache.size) {
            const first = this.cache.keys().next().value!;
            this.bytes -= this.cache.get(first)!.buffer.length;
            this.cache.delete(first);
          }
          this.cache.set(key, mixed);
          this.bytes += mixed.buffer.length;
          return result(mixed);
        } finally {
          signal?.removeEventListener('abort', cancel);
          this.controllers.delete(controller);
        }
      })
      .finally(() => this.pending--);
    this.queue = task.catch(() => {});
    return task;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await this.queue;
    this.cache.clear();
    this.bytes = 0;
    this.probes.clear();
  }
}
