import path from 'node:path';
import { readFile, stat, mkdir, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { VmotionError, type Snapshot, type Asset } from '../core/model.js';
import { hash, json, safePath, atomicWrite } from '../platform/project-files.js';
import { fingerprint, probe, ffmpegBinary } from './ffmpeg.js';
export type ProxyRecord = {
  version: 1;
  assetId: string;
  sourcePath: string;
  sourceFingerprint: string;
  fps: Snapshot['project']['fps'];
  width: number;
  height: number;
  frames: number;
  output: string;
  fingerprint: string;
  createdAt: string;
};
const leases = new Map<string, number>();
export function useCacheFile(file: string) {
  file = path.resolve(file);
  leases.set(file, (leases.get(file) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const count = (leases.get(file) ?? 1) - 1;
    if (count > 0) leases.set(file, count);
    else leases.delete(file);
  };
}
export function activeCacheFiles() {
  return [...leases.keys()];
}
function indexPath(root: string, file: string, stamp: string, fps: Snapshot['project']['fps']) {
  return safePath(
    root,
    `.vmotion/proxies-v2/index-${hash(json({ file: path.resolve(file), stamp, fps })).slice(0, 32)}.json`,
  );
}
export async function videoProxy(root: string, snapshot: Snapshot, asset: Asset) {
  const file = path.resolve(root, asset.path),
    stamp = await fingerprint(file),
    index = indexPath(root, file, stamp, snapshot.project.fps);
  let record: ProxyRecord;
  try {
    record = JSON.parse(await readFile(index, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  if (
    !record ||
    typeof record.output !== 'string' ||
    !/^\.vmotion\/proxies-v2\/[a-f0-9]{64}\/video\.mkv$/.test(record.output) ||
    !record.fps ||
    !Number.isInteger(record.width) ||
    !Number.isInteger(record.height) ||
    record.width < 1 ||
    record.height < 1 ||
    record.width > 3840 ||
    record.height > 2160
  )
    return;
  const output = safePath(root, record.output);
  if (
    record.version !== 1 ||
    record.sourcePath !== file ||
    record.sourceFingerprint !== stamp ||
    record.fps.num !== snapshot.project.fps.num ||
    record.fps.den !== snapshot.project.fps.den
  )
    return;
  try {
    if ((await fingerprint(output)) !== record.fingerprint) return;
  } catch {
    return;
  }
  return { ...record, output };
}
export type ProxyJob = {
  id: string;
  assetId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  stage: string;
  progress: number;
  processedSeconds: number;
  sourceDuration?: number;
  width: number;
  revision: string;
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};
export class ProxyManager {
  readonly jobs = new Map<string, ProxyJob>();
  private controllers = new Map<string, AbortController>();
  private promises = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    readonly root: string,
    private changed: () => void = () => {},
  ) {}
  get active() {
    return this.controllers.size;
  }
  start(snapshot: Snapshot, assetId: string, width = 960) {
    if (this.closed) throw new VmotionError('CANCELLED', 'Proxy manager is closed');
    if (!Number.isInteger(width) || width < 128 || width > 1920)
      throw new VmotionError('PROXY_WIDTH', 'Proxy width uses 128–1920 pixels');
    const asset = snapshot.project.assets.find((a) => a.id === assetId);
    if (!asset || asset.type !== 'video')
      throw new VmotionError('PROXY_SOURCE', 'Proxy source must be a registered video asset');
    if (
      [...this.jobs.values()].some(
        (j) => j.assetId === assetId && ['queued', 'running'].includes(j.status),
      )
    )
      throw new VmotionError('PROXY_BUSY', 'A proxy task already targets this asset');
    if (this.controllers.size >= 8)
      throw new VmotionError('PROXY_QUEUE', 'Proxy queue supports at most 8 active tasks');
    while (this.jobs.size >= 64) {
      const old = [...this.jobs.values()].find((j) =>
        ['completed', 'failed', 'cancelled'].includes(j.status),
      );
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
      job: ProxyJob = {
        id,
        assetId,
        status: 'queued',
        stage: 'probe',
        progress: 0,
        processedSeconds: 0,
        width,
        revision: copy.revision,
        startedAt: new Date().toISOString(),
      };
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    const promise = this.queue
      .then(() => this.execute(copy, assetId, job, controller.signal))
      .catch((error) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = (error as Error).message;
        job.finishedAt = new Date().toISOString();
        this.changed();
      })
      .finally(() => {
        this.controllers.delete(id);
      });
    this.queue = promise;
    this.promises.set(id, promise);
    this.changed();
    return { ...job };
  }
  private async execute(snapshot: Snapshot, assetId: string, job: ProxyJob, signal: AbortSignal) {
    if (signal.aborted) throw new VmotionError('CANCELLED', 'Proxy task cancelled');
    const asset = snapshot.project.assets.find((a) => a.id === assetId)!,
      source = path.resolve(this.root, asset.path),
      stamp = await fingerprint(source),
      info = await probe(source),
      video = info.streams.find((s) => s.codec_type === 'video'),
      duration = Number(info.format.duration ?? video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 14400)
      throw new VmotionError('PROXY_SOURCE', 'Use finite video sources of at most four hours');
    const key = hash(
        json({ engine: 'proxy-1', source, stamp, fps: snapshot.project.fps, width: job.width }),
      ),
      relative = `.vmotion/proxies-v2/${key}/video.mkv`,
      output = safePath(this.root, relative),
      directory = path.dirname(output),
      temporary = output + '.partial.mkv',
      index = indexPath(this.root, source, stamp, snapshot.project.fps);
    try {
      const record: ProxyRecord = JSON.parse(
        await readFile(path.join(directory, 'record.json'), 'utf8'),
      );
      if (
        record.version === 1 &&
        record.sourcePath === source &&
        record.sourceFingerprint === stamp &&
        record.output === relative &&
        record.fps.num === snapshot.project.fps.num &&
        record.fps.den === snapshot.project.fps.den &&
        (await fingerprint(output)) === record.fingerprint
      ) {
        if (signal.aborted) throw new VmotionError('CANCELLED', 'Proxy task cancelled');
        if ((await fingerprint(source)) !== stamp)
          throw new VmotionError('ASSET_CHANGED', 'Source changed before proxy cache reuse');
        await atomicWrite(index, json(record));
        job.status = 'completed';
        job.stage = 'reused';
        job.progress = 1;
        job.output = output;
        job.finishedAt = new Date().toISOString();
        this.changed();
        return;
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
    await mkdir(directory, { recursive: true });
    job.status = 'running';
    job.stage = 'encode';
    job.sourceDuration = duration;
    this.changed();
    const release = useCacheFile(temporary);
    try {
      const child = spawn(
        ffmpegBinary(),
        [
          '-y',
          '-hide_banner',
          '-v',
          'error',
          '-i',
          source,
          '-an',
          '-vf',
          `fps=${snapshot.project.fps.num}/${snapshot.project.fps.den},scale=min(${job.width}\\,iw):-2,format=bgra`,
          '-c:v',
          'ffv1',
          '-level',
          '3',
          '-coder',
          '1',
          '-context',
          '1',
          '-g',
          '1',
          '-slices',
          '4',
          '-slicecrc',
          '1',
          '-progress',
          'pipe:1',
          '-nostats',
          temporary,
        ],
        { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '',
        pending = '';
      child.stderr.on('data', (chunk) => (stderr = (stderr + String(chunk)).slice(-8000)));
      child.stdout.on('data', (chunk) => {
        pending += String(chunk);
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          if (line.startsWith('out_time_us=')) {
            const seconds = Number(line.slice(12)) / 1e6;
            if (Number.isFinite(seconds)) {
              job.processedSeconds = seconds;
              job.progress = Math.min(0.99, seconds / duration);
              this.changed();
            }
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.on('error', (e) =>
          reject(new VmotionError(signal.aborted ? 'CANCELLED' : 'PROXY_PROCESS', e.message)),
        );
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new VmotionError(
                  signal.aborted ? 'CANCELLED' : 'PROXY_PROCESS',
                  stderr || `Proxy encoder exited ${code}`,
                ),
              ),
        );
      });
      if (signal.aborted) throw new VmotionError('CANCELLED', 'Proxy task cancelled');
      if ((await fingerprint(source)) !== stamp)
        throw new VmotionError('ASSET_CHANGED', 'Source changed during proxy generation');
      job.stage = 'verify';
      const result = await probe(temporary),
        stream = result.streams.find((s) => s.codec_type === 'video');
      if (!stream?.width || !stream.height)
        throw new VmotionError('PROXY_VERIFY', 'Proxy has no valid video dimensions');
      await rename(temporary, output);
      const record: ProxyRecord = {
        version: 1,
        assetId,
        sourcePath: source,
        sourceFingerprint: stamp,
        fps: snapshot.project.fps,
        width: stream.width,
        height: stream.height,
        frames: Math.round((duration * snapshot.project.fps.num) / snapshot.project.fps.den),
        output: relative,
        fingerprint: await fingerprint(output),
        createdAt: new Date().toISOString(),
      };
      await atomicWrite(path.join(directory, 'record.json'), json(record));
      await atomicWrite(index, json(record));
      job.status = 'completed';
      job.stage = 'completed';
      job.progress = 1;
      job.output = output;
      job.finishedAt = new Date().toISOString();
      this.changed();
    } finally {
      release();
      await unlink(temporary).catch(() => {});
    }
  }
  cancel(id: string) {
    const controller = this.controllers.get(id);
    if (!controller) throw new VmotionError('PROXY_JOB', 'Proxy task is not active');
    controller.abort();
    return { ...this.jobs.get(id)! };
  }
  status(id?: string) {
    if (id) {
      const job = this.jobs.get(id);
      if (!job) throw new VmotionError('PROXY_JOB', 'Proxy task not found');
      return { ...job };
    }
    return { jobs: [...this.jobs.values()].map((j) => ({ ...j })), active: this.active };
  }
  async wait(id: string) {
    await this.promises.get(id);
    return this.status(id) as ProxyJob;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.queue;
  }
}
