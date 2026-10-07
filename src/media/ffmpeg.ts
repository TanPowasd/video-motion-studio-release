import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VmotionError } from '../core/model.js';
import { runtimeFile } from '../core/bundled-runtime.js';
export function mediaBinary(name: 'ffmpeg' | 'ffprobe') {
  const override = process.env[name === 'ffmpeg' ? 'VMOTION_FFMPEG' : 'VMOTION_FFPROBE'];
  if (override) return override;
  const bundled = runtimeFile(`media/bin/${name}${process.platform === 'win32' ? '.exe' : ''}`);
  if (bundled) {
    if (!existsSync(bundled))
      throw new VmotionError(
        'MEDIA_RUNTIME',
        `Bundled ${name} is missing; restore the complete portable folder`,
      );
    return bundled;
  }
  return name;
}
export const ffmpegBinary = () => mediaBinary('ffmpeg');
export const ffprobeBinary = () => mediaBinary('ffprobe');
export async function runProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let stderr = '',
      bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) {
        child.kill();
        reject(new VmotionError('PROCESS_OUTPUT_LIMIT', 'Process output exceeds 128MB'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-16000)),
    );
    child.on('error', (e) => reject(new VmotionError('MEDIA_PROCESS', `${binary}: ${e.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new VmotionError(
              signal?.aborted ? 'CANCELLED' : 'MEDIA_PROCESS',
              `${binary} exited ${code}: ${stderr}`,
            ),
          ),
    );
  });
}
export async function probe(file: string) {
  const raw = await runProcess(ffprobeBinary(), [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(raw.toString()) as {
    format: { duration?: string };
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      channels?: number;
      channel_layout?: string;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: Array<{ rotation?: number }>;
    }>;
  };
}
export function videoDisplayDimensions(stream: {
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}) {
  const rotation =
      stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
      Number(stream.tags?.rotate ?? 0),
    quarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  return {
    width: quarter % 2 ? stream.height : stream.width,
    height: quarter % 2 ? stream.width : stream.height,
    rotation,
  };
}
export async function fingerprint(file: string) {
  const s = await stat(file);
  return `${s.size}:${s.mtimeMs}`;
}
export async function mediaContentHash(file: string, signal?: AbortSignal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024, signal }))
    digest.update(chunk);
  return digest.digest('hex');
}
export async function waveform(file: string, samples = 500) {
  const info = await probe(file),
    duration = Number(
      info.format.duration ?? info.streams.find((s) => s.codec_type === 'audio')?.duration,
    );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new VmotionError('MEDIA_DURATION', 'Cannot determine audio duration');
  if (!info.streams.some((s) => s.codec_type === 'audio'))
    throw new VmotionError('NO_AUDIO', 'This asset has no audio stream');
  samples = Math.max(1, Math.min(2000, Math.floor(samples)));
  const bin = Math.max(1, Math.ceil((duration * 48000) / samples)),
    peaks: number[] = [];
  let pending = Buffer.alloc(0),
    position = 0,
    stderr = '';
  const child = spawn(
    ffmpegBinary(),
    ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true },
  );
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk.toString()).slice(-8000)));
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new VmotionError('WAVEFORM_DECODE', stderr || `Decoder exited ${code}`)),
    );
  });
  closed.catch(() => {});
  try {
    for await (const chunk of child.stdout) {
      const bytes = Buffer.concat([pending, chunk]),
        complete = Math.floor(bytes.length / 8) * 8;
      for (let offset = 0; offset < complete; offset += 8) {
        const index = Math.min(samples - 1, Math.floor(position++ / bin)),
          peak = Math.max(
            Math.abs(bytes.readFloatLE(offset)),
            Math.abs(bytes.readFloatLE(offset + 4)),
          );
        if (Number.isFinite(peak)) peaks[index] = Math.max(peaks[index] ?? 0, peak);
      }
      pending = bytes.subarray(complete);
    }
    await closed;
    return peaks;
  } catch (e) {
    child.kill();
    throw e;
  }
}
export async function proxy(file: string, output: string, signal?: AbortSignal) {
  await runProcess(
    ffmpegBinary(),
    [
      '-y',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      'scale=960:-2',
      '-c:v',
      'mpeg4',
      '-q:v',
      '5',
      '-c:a',
      'aac',
      output,
    ],
    signal,
  );
  return output;
}

export class VideoDecoder {
  private stats = { decodedFrames: 0, copiedBytes: 0, concatenations: 0, peakPendingBytes: 0 };
  diagnostics() {
    return {
      ...this.stats,
      framing: this.options.framing ?? 'direct',
      cachedBytes: this.frameBytes,
      cachedFrames: this.frames.size,
    };
  }
  private child?: ChildProcessWithoutNullStreams;
  private iterator?: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private current = -1;
  private stderr = '';
  private frames = new Map<number, Buffer>();
  private frameBytes = 0;
  constructor(
    private file: string,
    private width: number,
    private height: number,
    private fps: { num: number; den: number },
    private options: { framing?: 'direct' | 'concat' } = {},
  ) {}
  async frame(index: number) {
    index = Math.max(0, Math.floor(index));
    const cached = this.frames.get(index);
    if (cached) {
      this.frames.delete(index);
      this.frames.set(index, cached);
      return cached;
    }
    if (!this.child || index <= this.current || index > this.current + 5) this.start(index);
    while (this.current < index) {
      const size = this.width * this.height * 4;
      const next = async () => {
        const part = await this.iterator!.next();
        if (part.done)
          throw new VmotionError(
            'VIDEO_DECODE',
            `Cannot decode frame ${index} of ${this.file}: ${this.stderr}`,
          );
        return part.value;
      };
      let copy: Buffer;
      if (this.options.framing === 'concat') {
        while (this.pending.length < size) {
          const chunk = await next();
          this.stats.copiedBytes += this.pending.length + chunk.length;
          this.stats.concatenations++;
          this.pending = Buffer.concat([this.pending, chunk]);
          this.stats.peakPendingBytes = Math.max(this.stats.peakPendingBytes, this.pending.length);
        }
        copy = Buffer.from(this.pending.subarray(0, size));
        this.stats.copiedBytes += size;
        this.pending = this.pending.subarray(size);
      } else {
        copy = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          if (!this.pending.length) this.pending = await next();
          this.stats.peakPendingBytes = Math.max(this.stats.peakPendingBytes, this.pending.length);
          const count = Math.min(size - offset, this.pending.length);
          this.pending.copy(copy, offset, 0, count);
          this.pending = this.pending.subarray(count);
          offset += count;
          this.stats.copiedBytes += count;
        }
      }
      this.current++;
      this.stats.decodedFrames++;
      const budget = 48 * 1024 * 1024;
      while (
        this.frames.size &&
        (this.frames.size >= 8 || this.frameBytes + copy.length > budget)
      ) {
        const first = this.frames.keys().next().value!,
          old = this.frames.get(first)!;
        this.frames.delete(first);
        this.frameBytes -= old.length;
      }
      if (copy.length <= budget) {
        this.frames.set(this.current, copy);
        this.frameBytes += copy.length;
      }
      if (this.current === index) return copy;
    }
    throw new Error('Invalid decoder state');
  }
  private start(index: number) {
    this.close(false);
    this.stderr = '';
    this.pending = Buffer.alloc(0);
    this.current = index - 1;
    const seekTime = (Math.max(0, index - 2) * this.fps.den) / this.fps.num;
    this.child = spawn(
      ffmpegBinary(),
      [
        '-v',
        'error',
        '-ss',
        seekTime.toFixed(9),
        '-copyts',
        '-start_at_zero',
        '-i',
        this.file,
        '-an',
        '-vf',
        `fps=${this.fps.num}/${this.fps.den}:eof_action=pass,trim=start_pts=${index},scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        '-pix_fmt',
        'rgba',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    this.child.on('error', (e) => {
      this.stderr = e.message;
    });
    this.child.stderr.on(
      'data',
      (chunk) => (this.stderr = (this.stderr + chunk.toString()).slice(-8000)),
    );
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
  }
  close(clearFrames = true) {
    const child = this.child;
    const closed = child
      ? new Promise<void>((resolve) => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.once('close', () => resolve());
          child.once('error', () => resolve());
          child.stdout.destroy();
          child.stderr.destroy();
          child.kill();
        })
      : Promise.resolve();
    this.child = undefined;
    this.iterator = undefined;
    this.pending = Buffer.alloc(0);
    if (clearFrames) {
      this.frames.clear();
      this.frameBytes = 0;
    }
    return closed;
  }
}
