import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  trackingSettingsSchema,
  trackingSeedSchema,
  trackingDocumentSchema,
  type TrackingDocument,
  type TrackingSample,
} from '../core/tracking-schema.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { VideoDecoder, mediaContentHash } from '../media/ffmpeg.js';
import { inspectMedia, checkAssets } from './media-evidence.js';
import { atomicWrite, hash, safePath } from './project.js';
import { useCacheFile } from '../media/proxy-cache.js';
const startSchema = z
  .object({
    assetId: z.string(),
    revision: z.string().optional(),
    fingerprint: z.string().optional(),
    start: z.number().int().nonnegative().default(0),
    end: z.number().int().positive(),
    width: z.number().int().min(64).max(1280).default(640),
    portable: z.boolean().default(true),
    settings: trackingSettingsSchema.default({}),
    points: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(200).optional(),
            seeds: z.array(trackingSeedSchema).min(1).max(256),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    autoCount: z.number().int().min(0).max(32).default(8),
    region: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const trackingAnalyzeSchema = z
  .object({
    action: z.enum(['start', 'status', 'cancel']).default('start'),
    request: startSchema.optional(),
    id: z.string().optional(),
    wait: z.boolean().default(false),
  })
  .strict();
type TrackingJob = {
  id: string;
  assetId: string;
  revision: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  frame: number;
  totalFrames: number;
  stage: string;
  analysisId?: string;
  points?: number;
  error?: { code: string; message: string };
  metrics?: Record<string, number>;
};
const moduleDirectory = path.dirname(
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? fileURLToPath(import.meta.url)
    : String(import.meta.url),
);
const workerScript = String.raw`const {parentPort,workerData}=require('node:worker_threads');const {SparseTracker}=require(workerData.module);const tracker=new SparseTracker(workerData.settings);parentPort.on('message',({id,payload})=>{try{parentPort.postMessage({id,result:tracker.frame(new Uint8Array(payload.rgba),payload.width,payload.height,payload.frame,payload.points,payload.autoCount,payload.region)});}catch(e){parentPort.postMessage({id,error:{code:e.code||'TRACKING_ENGINE',message:e.message}});}});`;
export class TrackingManager {
  readonly jobs = new Map<string, TrackingJob>();
  private controllers = new Map<string, AbortController>();
  private promises = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private runtime?: Promise<string>;
  private closed = false;
  constructor(
    readonly root: string,
    private changed: () => void = () => {},
  ) {}
  get active() {
    return this.controllers.size;
  }
  private runtimeFile() {
    if (!this.runtime)
      this.runtime = (async () => {
        const bundled = path.resolve(moduleDirectory, '../tracking/engine.cjs');
        if (!import.meta.url.endsWith('.ts') && existsSync(bundled)) return bundled;
        const result = await build({
            entryPoints: [path.resolve(moduleDirectory, '../core/tracking-engine.ts')],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node22',
            write: false,
            packages: 'external',
          }),
          content = result.outputFiles[0].contents,
          file = safePath(
            this.root,
            `.vmotion/compiled/tracking-${hash(Buffer.from(content))}.cjs`,
          );
        await atomicWrite(file, Buffer.from(content));
        return file;
      })();
    return this.runtime;
  }
  start(snapshot: Snapshot, raw: unknown) {
    if (this.closed) throw new VmotionError('CANCELLED', 'Tracking manager closed');
    const request = startSchema.parse(raw);
    if (request.revision && request.revision !== snapshot.revision)
      throw new VmotionError('REVISION_CONFLICT', 'Project changed before motion analysis');
    if (request.end <= request.start || request.end - request.start > 3600)
      throw new VmotionError('TRACKING_RANGE', 'Analyze 1–3600 source frames in one task');
    if (!snapshot.project.assets.some((a) => a.id === request.assetId && a.type === 'video'))
      throw new VmotionError('TRACKING_SOURCE', 'Tracking requires a registered video asset');
    if (this.active >= 4)
      throw new VmotionError('TRACKING_QUEUE', 'At most four active tracking tasks');
    if (new Set(request.points.map((p) => p.id)).size !== request.points.length)
      throw new VmotionError('TRACKING_POINT', 'Seed IDs must be unique');
    if (
      request.points.some(
        (p) =>
          p.seeds.some((s) => s.frame < request.start || s.frame >= request.end) ||
          new Set(p.seeds.map((s) => s.frame)).size !== p.seeds.length,
      )
    )
      throw new VmotionError(
        'TRACKING_SEED',
        'Seeds require unique frames inside the analysis range',
      );
    while (this.jobs.size >= 32) {
      const old = [...this.jobs.values()].find((j) => !['running', 'queued'].includes(j.status));
      if (!old) break;
      this.jobs.delete(old.id);
      this.promises.delete(old.id);
    }
    const id = randomUUID(),
      controller = new AbortController(),
      copy: Snapshot = {
        project: structuredClone(snapshot.project),
        revision: snapshot.revision,
        scenes: [],
        sequences: [],
        files: {},
      },
      job: TrackingJob = {
        id,
        assetId: request.assetId,
        revision: snapshot.revision,
        status: 'queued',
        progress: 0,
        frame: request.start,
        totalFrames: request.end - request.start,
        stage: 'probe',
      };
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    const work = this.queue
      .catch(() => {})
      .then(() => this.execute(copy, request, job, controller.signal))
      .catch((e) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.stage = job.status;
        job.error = {
          code: controller.signal.aborted ? 'CANCELLED' : (e.code ?? 'TRACKING_ANALYSIS'),
          message: e.message,
        };
        this.changed();
      })
      .finally(() => {
        this.controllers.delete(id);
      });
    this.queue = work;
    this.promises.set(id, work);
    this.changed();
    return { ...job };
  }
  private async execute(
    snapshot: Snapshot,
    request: z.output<typeof startSchema>,
    job: TrackingJob,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new VmotionError('CANCELLED', 'Tracking task cancelled');
    const info = await inspectMedia(this.root, snapshot, {
      assetId: request.assetId,
      fingerprint: request.fingerprint,
    });
    job.stage = 'fingerprint';
    job.status = 'running';
    this.changed();
    const contentHash = request.portable
      ? await mediaContentHash(path.resolve(this.root, info.asset.path), signal)
      : undefined;
    if (!info.sourceEnd || request.end > Math.ceil(info.sourceEnd - 1e-8))
      throw new VmotionError('TRACKING_RANGE', 'Analysis range extends beyond the source', {
        sourceEnd: info.sourceEnd,
      });
    const width = Number(info.metadata.width),
      height = Number(info.metadata.height),
      factor = Math.min(1, request.width / width, 1280 / height),
      dw = Math.round(width * factor),
      dh = Math.round(height * factor),
      sx = dw / width,
      sy = dh / height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || dw < 32 || dh < 32)
      throw new VmotionError(
        'TRACKING_SOURCE',
        'Video dimensions do not fit the tracking analysis budget',
      );
    for (const p of request.points)
      for (const s of p.seeds)
        if (s.x < 0 || s.y < 0 || s.x >= width || s.y >= height)
          throw new VmotionError(
            'TRACKING_SEED',
            'Seed coordinates must lie inside the source image',
          );
    const points: TrackingDocument['points'] = request.points.map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        seeds: p.seeds,
        samples: [],
      })),
      auto = points.length ? 0 : request.autoCount;
    if (!auto && !points.length)
      throw new VmotionError('TRACKING_POINT', 'Provide points or a positive autoCount');
    const region = request.region
        ? {
            x: request.region.x * sx,
            y: request.region.y * sy,
            width: request.region.width * sx,
            height: request.region.height * sy,
          }
        : undefined,
      worker = new Worker(workerScript, {
        eval: true,
        workerData: { module: await this.runtimeFile(), settings: request.settings },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      }),
      decoder = new VideoDecoder(
        path.resolve(this.root, info.asset.path),
        dw,
        dh,
        snapshot.project.fps,
      ),
      pending = new Map<
        number,
        {
          resolve: (v: any) => void;
          reject: (e: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
    let counter = 0,
      lastNotice = 0;
    const fail = (error: Error) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
    };
    worker.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      error ? p.reject(new VmotionError(error.code, error.message)) : p.resolve(result);
    });
    worker.on('error', fail);
    worker.on('exit', (code) =>
      fail(new VmotionError('TRACKING_WORKER', `Tracking worker exited ${code}`)),
    );
    const cancel = () => {
      fail(new VmotionError('CANCELLED', 'Tracking task cancelled'));
      void decoder.close();
      void worker.terminate();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const started = performance.now();
    job.status = 'running';
    job.stage = 'tracking';
    this.changed();
    try {
      for (let frame = request.start; frame < request.end; frame++) {
        if (signal.aborted) throw new VmotionError('CANCELLED', 'Tracking task cancelled');
        const pixels = await decoder.frame(frame),
          rgba = Uint8Array.from(pixels),
          seeds = points.map((p) => {
            const seed = p.seeds.find((s) => s.frame === frame);
            return { id: p.id, ...(seed ? { seed: { x: seed.x * sx, y: seed.y * sy } } : {}) };
          }),
          result = await new Promise<any>((resolve, reject) => {
            const id = ++counter,
              timer = setTimeout(() => {
                pending.delete(id);
                reject(
                  new VmotionError('TRACKING_TIMEOUT', 'A tracking frame exceeded ten seconds'),
                );
              }, 10000);
            pending.set(id, { resolve, reject, timer });
            worker.postMessage(
              {
                id,
                payload: {
                  rgba: rgba.buffer,
                  width: dw,
                  height: dh,
                  frame,
                  points: seeds,
                  autoCount: frame === request.start ? auto : 0,
                  region,
                },
              },
              [rgba.buffer],
            );
          });
        if (frame === request.start && auto) {
          if (!result.detected.length)
            throw new VmotionError(
              'TRACKING_FEATURES',
              'No textured corners found; choose a different region or manual seeds',
            );
          for (const [i, p] of result.detected.entries())
            points.push({
              id: `feature-${i + 1}`,
              name: `Feature ${i + 1}`,
              seeds: [{ frame, x: p.x / sx, y: p.y / sy }],
              samples: [],
            });
        }
        for (const item of result.points) {
          const sample = item.sample as TrackingSample;
          points
            .find((p) => p.id === item.id)!
            .samples.push({
              ...sample,
              x: sample.x === null ? null : sample.x / sx,
              y: sample.y === null ? null : sample.y / sy,
            });
        }
        job.frame = frame;
        job.progress = (frame - request.start + 1) / job.totalFrames;
        job.points = points.length;
        const decode = decoder.diagnostics();
        job.metrics = {
          ...result.metrics,
          analysisMs: performance.now() - started,
          decodedFrames: decode.decodedFrames,
          decodeCopiedBytes: decode.copiedBytes,
          decodeConcatenations: decode.concatenations,
          decodeRetainedBytes: decode.cachedBytes,
        };
        if (performance.now() - lastNotice > 150 || frame === request.end - 1) {
          lastNotice = performance.now();
          this.changed();
        }
      }
      await checkAssets(this.root, snapshot, [info.assetCheck]);
      if (
        contentHash &&
        (await mediaContentHash(path.resolve(this.root, info.asset.path), signal)) !== contentHash
      )
        throw new VmotionError('ASSET_CHANGED', 'Source bytes changed during tracking');
      if (signal.aborted) throw new VmotionError('CANCELLED', 'Tracking task cancelled');
      const document = trackingDocumentSchema.parse({
          kind: 'tracking',
          version: 1,
          id: request.assetId.slice(0, 190) + '-motion',
          name: info.asset.name.slice(0, 190) + ' · 运动跟踪',
          source: {
            assetId: request.assetId,
            fingerprint: info.fingerprint,
            contentHash,
            width,
            height,
            fps: snapshot.project.fps,
          },
          range: { start: request.start, end: request.end },
          analysis: {
            width: dw,
            height: dh,
            algorithm: 'pyramidal-lk-fb-1',
            settings: request.settings,
            metrics: job.metrics,
          },
          points,
        }),
        content = JSON.stringify(document),
        analysisId = hash(content),
        file = safePath(this.root, `.vmotion/tracking/${analysisId}.json`),
        release = useCacheFile(file);
      if (Buffer.byteLength(content) > 16 * 1024 * 1024) {
        release();
        throw new VmotionError(
          'TRACKING_BUDGET',
          'Analysis exceeds 16MiB; use fewer points or split the source range',
        );
      }
      try {
        await atomicWrite(file, content);
      } finally {
        release();
      }
      if (signal.aborted) throw new VmotionError('CANCELLED', 'Tracking task cancelled');
      job.analysisId = analysisId;
      job.status = 'completed';
      job.stage = 'completed';
      job.progress = 1;
      this.changed();
    } finally {
      signal.removeEventListener('abort', cancel);
      await decoder.close();
      await worker.terminate();
    }
  }
  status(id?: string) {
    if (id) {
      const job = this.jobs.get(id);
      if (!job) throw new VmotionError('TRACKING_JOB', 'Tracking job not found');
      return structuredClone(job);
    }
    return { jobs: [...this.jobs.values()].map((j) => structuredClone(j)), active: this.active };
  }
  cancel(id: string) {
    const controller = this.controllers.get(id);
    if (!controller) throw new VmotionError('TRACKING_JOB', 'Tracking job is not active');
    controller.abort();
    return this.status(id);
  }
  async wait(id: string) {
    if (!this.promises.has(id)) throw new VmotionError('TRACKING_JOB', 'Tracking job not found');
    await this.promises.get(id);
    return this.status(id) as TrackingJob;
  }
  async close() {
    this.closed = true;
    for (const c of this.controllers.values()) c.abort();
    await this.queue;
  }
}
export async function readTrackingAnalysis(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new VmotionError('TRACKING_ANALYSIS', 'Analysis ID must be a SHA-256 hash');
  const file = safePath(root, `.vmotion/tracking/${id}.json`),
    release = useCacheFile(file);
  try {
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content) > 16 * 1024 * 1024 || hash(content) !== id)
      throw new VmotionError('TRACKING_ANALYSIS', 'Analysis content check failed');
    return trackingDocumentSchema.parse(JSON.parse(content));
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError(
      'TRACKING_ANALYSIS',
      'Tracking analysis is missing or invalid; regenerate it',
    );
  } finally {
    release();
  }
}
