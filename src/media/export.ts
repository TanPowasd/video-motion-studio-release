import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../core/model.js';
import { VmotionError } from '../core/model.js';
import { Renderer } from '../core/renderer.js';
import { renderRuntimeFingerprint } from '../core/render-runtime.js';
import type { GpuMode } from '../core/gpu-points.js';
import { frameSeconds } from '../core/time.js';
import { renderAudio } from './audio.js';
export { audioClips } from './audio.js';
import { atomicWrite, hash, json, safePath } from '../platform/project-files.js';
import { validateSnapshot } from '../service/project.js';
import { ffmpegBinary, runProcess, fingerprint } from './ffmpeg.js';
import type { VideoCodec, VideoQuality } from '../core/video-export-schema.js';
import { encoderEvidence, resolveVideoEncoder, type EncoderResolution } from './video-encoder.js';

export interface RenderOptions {
  output: string;
  format: 'mp4' | 'png' | 'wav';
  start?: number;
  end?: number;
  width?: number;
  height?: number;
  /** auto|software|nvenc|qsv|amf|mediafoundation|videotoolbox|vaapi, or a raw FFmpeg encoder name. */
  encoder?: string;
  codec?: VideoCodec;
  quality?: VideoQuality;
  resume?: boolean;
  revision?: string;
  gpu?: GpuMode;
}
export interface RenderJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  revision: string;
  frame: number;
  totalFrames: number;
  progress: number;
  output: string;
  error?: string;
  stage: string;
  gpu?: ReturnType<Renderer['performanceInfo']>['gpu'];
  /** MP4 only: requested/used encoder, fallback reason, probe rows and encode timing. */
  encoder?: ReturnType<typeof encoderEvidence> & {
    segments: number;
    encodedSegments: number;
    resumedSegments: number;
    /** Wall time from encoder spawn to close summed over encoded segments (includes rendering fed to it). */
    segmentWallMs: number;
    /** Time the render loop was blocked on encoder backpressure plus the final flush. */
    encoderWaitMs: number;
  };
  startedAt: string;
  finishedAt?: string;
}
export class RenderManager {
  jobs = new Map<string, RenderJob>();
  private controllers = new Map<string, AbortController>();
  private promises = new Map<string, Promise<void>>();
  private executionQueue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private onChange: () => void = () => {},
  ) {}
  start(snapshot: Snapshot, options: RenderOptions) {
    if (options.revision !== undefined && options.revision !== snapshot.revision)
      throw new VmotionError(
        'REVISION_CONFLICT',
        'The project changed after review; export the inspected revision',
        { expected: options.revision, actual: snapshot.revision },
      );
    const copy = structuredClone(snapshot),
      sequence = copy.sequences.find((s) => s.id === copy.project.activeSequence)!;
    const start = options.start ?? 0,
      end = options.end ?? sequence.duration;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > sequence.duration
    )
      throw new VmotionError('FRAME_RANGE', 'Render range must be within the active sequence');
    const output = path.resolve(options.output);
    if (
      Array.from(this.jobs.values()).some(
        (j) => ['queued', 'running'].includes(j.status) && j.output === output,
      )
    )
      throw new VmotionError('OUTPUT_BUSY', 'A render is already writing this output');
    if (this.controllers.size >= 16)
      throw new VmotionError('QUEUE_FULL', 'The render queue is limited to 16 pending jobs');
    const id = randomUUID(),
      controller = new AbortController(),
      job: RenderJob = {
        id,
        status: 'queued',
        revision: copy.revision,
        frame: start,
        totalFrames: end - start,
        progress: 0,
        output,
        stage: 'validate',
        startedAt: new Date().toISOString(),
      };
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    const promise = this.executionQueue
      .then(() => this.execute(job, copy, { ...options, output, start, end }, controller.signal))
      .catch((e) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = (e as Error).message;
        job.finishedAt = new Date().toISOString();
        this.onChange();
      })
      .finally(() => this.controllers.delete(id));
    this.executionQueue = promise;
    this.promises.set(id, promise);
    this.onChange();
    return job;
  }
  private async execute(
    job: RenderJob,
    snapshot: Snapshot,
    options: RenderOptions & { start: number; end: number },
    signal: AbortSignal,
  ) {
    const renderer = new Renderer(this.root, { gpu: options.gpu, gpuStrict: true });
    try {
      if (signal.aborted) throw new VmotionError('CANCELLED', 'Render cancelled');
      const diagnostics = await validateSnapshot(this.root, snapshot);
      if (diagnostics.some((d) => d.severity === 'error'))
        throw new VmotionError('VALIDATION_FAILED', 'Cannot render invalid project', diagnostics);
      await renderer.components.validate(snapshot);
      job.status = 'running';
      this.onChange();
      const sourceFingerprints = new Map<string, string>();
      for (const asset of snapshot.project.assets)
        sourceFingerprints.set(asset.path, await fingerprint(path.resolve(this.root, asset.path)));
      const verify = async () => {
        if (signal.aborted) throw new VmotionError('CANCELLED', 'Render cancelled');
        for (const [file, original] of sourceFingerprints)
          if ((await fingerprint(path.resolve(this.root, file))) !== original)
            throw new VmotionError(
              'ASSET_CHANGED',
              `Asset changed during render: ${file}. Restart with the new asset version.`,
            );
      };
      const runtime = await renderRuntimeFingerprint(
        renderer.native.binary,
        {...await renderer.gpu.identity(),programRuntime:await renderer.programs.identity(snapshot)},
      );
      let video: EncoderResolution | undefined;
      if (options.format === 'mp4') {
        job.stage = 'encoder-probe';
        this.onChange();
        const defaults = snapshot.project.videoExport;
        video = await resolveVideoEncoder({
          encoder: options.encoder ?? defaults?.encoder,
          codec: options.codec ?? defaults?.codec,
          quality: { ...defaults?.quality, ...options.quality },
        });
        job.encoder = {
          ...encoderEvidence(video),
          segments: 0,
          encodedSegments: 0,
          resumedSegments: 0,
          segmentWallMs: 0,
          encoderWaitMs: 0,
        };
        if (signal.aborted) throw new VmotionError('CANCELLED', 'Render cancelled');
      }
      const key = hash(
          snapshot.revision +
            json({
              output: options.output,
              format: options.format,
              start: options.start,
              end: options.end,
              width: options.width,
              height: options.height,
              encoder: options.encoder,
              ...(video ? { video: video.identity } : {}),
              assets: [...sourceFingerprints.entries()],
              runtime: runtime.fingerprint,
            }),
        ),
        cache = safePath(this.root, `.vmotion/renders/${key}`);
      await mkdir(cache, { recursive: true });
      await atomicWrite(path.join(cache, 'snapshot.json'), json(snapshot));
      await atomicWrite(path.join(cache, 'runtime.json'), json(runtime));
      const videoIdentity = video ? hash(json(video.identity)) : undefined;
      if (video) await atomicWrite(path.join(cache, 'encoder.json'), json(video.identity));
      await mkdir(path.dirname(options.output), { recursive: true });
      if (options.format === 'wav') {
        job.stage = 'audio';
        await renderAudio(
          this.root,
          snapshot,
          options.output + '.partial',
          options.start,
          options.end,
          signal,
        );
        await verify();
        await rename(options.output + '.partial', options.output);
      } else if (options.format === 'png') {
        job.stage = 'frames';
        await mkdir(options.output, { recursive: true });
        for (let frame = options.start; frame < options.end; frame++) {
          await verify();
          const file = path.join(options.output, `frame-${String(frame).padStart(8, '0')}.png`);
          const canvas = await renderer.render(snapshot, frame, options);
          await atomicWrite(file, await canvas.encode('png'));
          job.frame = frame + 1;
          job.progress = (frame + 1 - options.start) / (options.end - options.start);
          this.onChange();
        }
      } else {
        const checkpoint = path.join(cache, 'checkpoint.json');
        let completed: number[] = [];
        if (options.resume !== false)
          try {
            const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
            if (
              saved.revision === snapshot.revision &&
              saved.runtime === runtime.fingerprint &&
              saved.encoder === videoIdentity &&
              Array.isArray(saved.completed) &&
              saved.completed.every(
                (i: unknown) => typeof i === 'number' && Number.isInteger(i) && i >= 0,
              )
            )
              completed = saved.completed;
          } catch {}
        const width = options.width ?? snapshot.project.width,
          height = options.height ?? snapshot.project.height;
        if (width % 2 || height % 2)
          throw new VmotionError('RESOLUTION', 'MP4 requires even width and height');
        const segmentSize = Math.max(
            1,
            Math.round((snapshot.project.fps.num / snapshot.project.fps.den) * 5),
          ),
          segments: string[] = [],
          codec = video!.args,
          evidence = job.encoder!,
          hevc = video!.codec === 'hevc';
        for (
          let begin = options.start, index = 0;
          begin < options.end;
          begin += segmentSize, index++
        ) {
          await verify();
          const end = Math.min(begin + segmentSize, options.end),
            file = path.join(cache, `segment-${String(index).padStart(6, '0')}.mp4`);
          segments.push(file);
          evidence.segments = segments.length;
          let exists = false;
          try {
            exists = (await stat(file)).size > 0;
          } catch {}
          if (!completed.includes(index) || !exists) {
            job.stage = 'video';
            const partial = file + '.partial',
              segmentStarted = performance.now();
            const child = spawn(
              ffmpegBinary(),
              [
                '-y',
                '-v',
                'error',
                ...codec.input,
                '-f',
                'rawvideo',
                '-pix_fmt',
                'rgba',
                '-s',
                `${width}x${height}`,
                '-r',
                `${snapshot.project.fps.num}/${snapshot.project.fps.den}`,
                '-i',
                'pipe:0',
                '-an',
                ...codec.output,
                '-f',
                'mp4',
                partial,
              ],
              { windowsHide: true, signal },
            );
            let stderr = '';
            child.stderr.on('data', (c) => (stderr = (stderr + c.toString()).slice(-16000)));
            const closed = new Promise<void>((resolve, reject) => {
              child.on('error', reject);
              child.on('close', (code) =>
                code === 0
                  ? resolve()
                  : reject(
                      new VmotionError(
                        'ENCODE_FAILED',
                        `${video!.used} failed in segment ${index} (no encoder fallback inside a started export; completed checkpoints kept): ${stderr.trim() || `exit ${code}`}`,
                        { encoder: video!.used, segment: index },
                      ),
                    ),
              );
            });
            closed.catch(() => {});
            child.stdin.on('error', () => {});
            try {
              for (let frame = begin; frame < end; frame++) {
                if (signal.aborted) throw new VmotionError('CANCELLED', 'Render cancelled');
                const canvas = await renderer.render(snapshot, frame, { width, height });
                const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
                const ok = child.stdin.write(
                  Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
                );
                if (!ok) {
                  const waitStarted = performance.now();
                  await Promise.race([
                    once(child.stdin, 'drain'),
                    closed.then(() => {
                      throw new VmotionError(
                        'ENCODE_FAILED',
                        `${video!.used} exited before all frames were written`,
                        { encoder: video!.used, segment: index },
                      );
                    }),
                  ]).catch(async (e) => {
                    // A dying encoder surfaces first as stdin EPIPE; report its stderr instead.
                    await closed;
                    throw e;
                  });
                  evidence.encoderWaitMs += performance.now() - waitStarted;
                }
                job.frame = frame + 1;
                job.progress = (0.9 * (frame + 1 - options.start)) / (options.end - options.start);
                this.onChange();
              }
              child.stdin.end();
              const flushStarted = performance.now();
              await closed;
              evidence.encoderWaitMs += performance.now() - flushStarted;
              evidence.segmentWallMs += performance.now() - segmentStarted;
              evidence.encodedSegments++;
              await rename(partial, file);
            } catch (e) {
              child.kill();
              throw e;
            }
            completed.push(index);
            await atomicWrite(
              checkpoint,
              json({
                revision: snapshot.revision,
                runtime: runtime.fingerprint,
                ...(videoIdentity ? { encoder: videoIdentity } : {}),
                completed,
              }),
            );
          } else {
            evidence.resumedSegments++;
            job.frame = end;
            job.progress = (0.9 * (end - options.start)) / (options.end - options.start);
            this.onChange();
          }
        }
        evidence.segmentWallMs = Math.round(evidence.segmentWallMs);
        evidence.encoderWaitMs = Math.round(evidence.encoderWaitMs);
        await verify();
        job.stage = 'audio';
        this.onChange();
        const audio = path.join(cache, 'audio.wav');
        await renderAudio(this.root, snapshot, audio, options.start, options.end, signal);
        job.stage = 'mux';
        this.onChange();
        const list = path.join(cache, 'concat.txt');
        await atomicWrite(
          list,
          segments.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
        );
        await runProcess(
          ffmpegBinary(),
          [
            '-y',
            '-v',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            list,
            '-i',
            audio,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'copy',
            ...(hevc ? ['-tag:v', 'hvc1'] : []),
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-t',
            frameSeconds(options.end - options.start, snapshot.project.fps).toFixed(9),
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            options.output + '.partial',
          ],
          signal,
        );
        await verify();
        await rename(options.output + '.partial', options.output);
      }
      job.gpu = renderer.gpu.report();
      job.status = 'completed';
      job.stage = 'done';
      job.progress = 1;
      job.frame = options.end;
      job.finishedAt = new Date().toISOString();
      this.onChange();
    } finally {
      job.gpu = renderer.gpu.report();
      await renderer.close();
    }
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new VmotionError('NOT_FOUND', 'Render job not found');
    this.controllers.get(id)?.abort();
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.stage = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.onChange();
    }
    return job;
  }
  async wait(id: string) {
    if (!this.jobs.has(id)) throw new VmotionError('NOT_FOUND', 'Render job not found');
    await this.promises.get(id);
    return this.jobs.get(id)!;
  }
  async close() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.promises.values());
  }
}
