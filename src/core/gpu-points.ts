import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import type { CompiledGraphNode } from './effect-graph.js';
import { graphDependencies } from './effect-graph.js';
import { VmotionError } from './model.js';
import { GpuFrames } from './gpu-transport.js';
import { colorMatrixPixels, mergeGraphChannels } from './graph-channel-pixels.js';
import { keyerPixels } from './keyer-pixels.js';
export type GpuMode = 'cpu' | 'auto' | 'gpu';
export type GpuPoint = Extract<CompiledGraphNode, { type: 'colorMatrix' | 'keyer' | 'channels' }>;
export function encodeGpuPoint(node: CompiledGraphNode): number[] | undefined {
  const values = Array<number>(32).fill(0);
  if (node.type === 'colorMatrix') {
    values[0] = 0;
    values[1] = node.colorSpace === 'linear' ? 1 : 0;
    node.matrix.forEach((value, i) => {
      values[i + 2] = value;
    });
    if (node.matrix.some((value) => Math.abs(value) > 1e20)) return;
    values[31] = Math.max(
      node.colorSpace === 'linear' ? 0.02 : 0.001,
      ...[0, 1, 2, 3].map(
        (row) =>
          node.matrix.slice(row * 5, row * 5 + 5).reduce((sum, value) => sum + Math.abs(value), 0) *
          255 *
          2 ** -18,
      ),
    );
  } else if (node.type === 'keyer') {
    const color = [1, 3, 5].map((i) => parseInt(node.color.slice(i, i + 2), 16) / 255),
      y = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    values.splice(
      0,
      10,
      1,
      node.mode === 'luma' ? 1 : 0,
      (color[2] - y) / 1.8556,
      (color[0] - y) / 1.5748,
      node.threshold,
      node.softness,
      node.invert ? 1 : 0,
      node.view === 'matte' ? 1 : 0,
      color.indexOf(Math.max(...color)),
      node.spill,
    );
    values[31] = Math.max(0.001, node.softness ? (0.00001 / node.softness) * 1.5 * 255 : 0.001);
  } else if (node.type === 'channels') {
    if (new Set(graphDependencies(node)).size !== 1) return;
    values[0] = 2;
    values[31] = 0.001;
    const indices = { red: 0, green: 1, blue: 2, alpha: 3, luma: 4 };
    [node.red, node.green, node.blue, node.alpha].forEach((channel, i) => {
      values[1 + i * 2] = typeof channel === 'number' ? -1 : indices[channel.channel];
      values[2 + i * 2] = typeof channel === 'number' ? channel : 0;
    });
  } else return;
  return values.every((value) => Number.isFinite(Math.fround(value))) ? values : undefined;
}
let canvasTable: Buffer | undefined;
export function gpuCanvasTable() {
  if (canvasTable) return canvasTable;
  const canvas = createCanvas(256, 256),
    pixels = new Uint8ClampedArray(65536 * 4);
  try {
    for (let c = 0; c < 256; c++)
      for (let alpha = 0; alpha < 256; alpha++) {
        const at = (c * 256 + alpha) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = c;
        pixels[at + 3] = alpha;
      }
    canvas.getContext('2d').putImageData(new ImageData(pixels, 256, 256), 0, 0);
    const actual = canvas.getContext('2d').getImageData(0, 0, 256, 256).data;
    canvasTable = Buffer.alloc(65536);
    for (let i = 0; i < 65536; i++) canvasTable[i] = actual[i * 4];
    return canvasTable;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
export function resolveGpuBinary(nativeBinary: string) {
  if (process.env.VMOTION_GPU_NATIVE) return process.env.VMOTION_GPU_NATIVE;
  try {
    const directory = path.dirname(nativeBinary),
      manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (
      typeof manifest.gpuExecutable === 'string' &&
      path.basename(manifest.gpuExecutable) === manifest.gpuExecutable
    )
      return path.join(directory, manifest.gpuExecutable);
  } catch {}
  return path.join(
    path.dirname(nativeBinary),
    process.platform === 'win32' ? 'vmotion-gpu.exe' : 'vmotion-gpu',
  );
}
export class GpuPoints {
  readonly mode: GpuMode;
  readonly binary: string;
  private child?: ChildProcessWithoutNullStreams;
  private initialization?: Promise<boolean>;
  private adapter?: Record<string, unknown>;
  private status: 'cold' | 'disabled' | 'ready' | 'failed' | 'closed' = 'cold';
  private error?: { code: string; message: string };
  private pending?: {
    id: number;
    resolve: (value: { header: any; body: Buffer }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private stats = {
    requests: 0,
    stages: 0,
    dispatches: 0,
    pixels: 0,
    uploadedBytes: 0,
    downloadedBytes: 0,
    ipcSentBytes: 0,
    ipcReceivedBytes: 0,
    retainedBytes: 0,
    surfaceAllocations: 0,
    wallMs: 0,
    fallbacks: 0,
    correctedPixels: 0,
  };
  constructor(
    nativeBinary: string,
    readonly options: {
      mode?: GpuMode;
      strictAfterReady?: boolean;
      binary?: string;
      timeoutMs?: number;
    } = {},
  ) {
    const mode = options.mode ?? process.env.VMOTION_GPU ?? 'auto';
    if (!['cpu', 'auto', 'gpu'].includes(mode))
      throw new VmotionError('GPU_MODE', 'Choose cpu, auto or gpu');
    this.mode = mode as GpuMode;
    this.binary = options.binary ?? resolveGpuBinary(nativeBinary);
    if (this.mode === 'cpu') this.status = 'disabled';
  }
  report() {
    return {
      mode: this.mode,
      status: this.status,
      scope: 'point-effects',
      fullSceneGpu: false,
      adapter: this.adapter,
      error: this.error,
      ...this.stats,
      autoThresholdPixels: 262144,
      autoMinimumStages: 2,
      bufferBudgetBytes: 3840 * 2160 * 12 + Math.ceil((3840 * 2160) / 32) * 8 + 65536 + 8192 + 16,
      kernels: ['colorMatrix', 'keyer', 'single-input channels'],
    };
  }
  eligible(pixels: number, stages: number) {
    return (
      this.mode !== 'cpu' &&
      this.status !== 'closed' &&
      (this.mode === 'gpu' || (pixels >= 262144 && stages >= 2))
    );
  }
  async initialize(): Promise<boolean> {
    if (this.status === 'ready') return true;
    if (this.status === 'disabled' || this.status === 'closed') return false;
    if (this.status === 'failed') {
      if (this.mode === 'gpu' || (this.options.strictAfterReady && this.adapter))
        throw new VmotionError(this.error!.code, this.error!.message);
      return false;
    }
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      try {
        if (!existsSync(this.binary))
          throw new VmotionError('GPU_UNAVAILABLE', 'Native GPU runtime is missing');
        const result = await this.request('initialize', {}, gpuCanvasTable());
        if (result.header.version !== 1 || !result.header.adapter?.hardware)
          throw new VmotionError('GPU_PROTOCOL', 'GPU runtime did not report a hardware adapter');
        this.adapter = result.header.adapter;
        this.status = 'ready';
        return true;
      } catch (error) {
        this.failed(error as Error);
        if (this.mode === 'gpu') throw error;
        return false;
      }
    })();
    return this.initialization;
  }
  async identity() {
    await this.initialize();
    return {
      mode: this.mode,
      status: this.status,
      adapter: this.adapter,
      binary: existsSync(this.binary)
        ? createHash('sha256').update(readFileSync(this.binary)).digest('hex')
        : 'missing',
      quantization: createHash('sha256').update(gpuCanvasTable()).digest('hex'),
    };
  }
  async customShader(
    pixels: Buffer,
    width: number,
    height: number,
    shader: string,
    uniforms: number[],
    workgroup: [number, number],
    timeoutMs = 10000,
  ) {
    const work = async () => {
      if (this.mode === 'cpu' || !(await this.initialize()))
        throw new VmotionError(
          'PROGRAM_GPU_REQUIRED',
          'WGSL rendering requires a hardware GPU; choose auto or gpu',
        );
      const reply = await this.request(
        'customShader',
        { width, height, shader, uniforms, workgroup },
        pixels,
        timeoutMs,
      );
      if (reply.body.length !== width * height * 4)
        throw new VmotionError('GPU_PROTOCOL', 'Custom shader output dimensions differ');
      this.stats.requests++;
      this.stats.dispatches++;
      this.stats.uploadedBytes += pixels.length + uniforms.length * 4;
      this.stats.downloadedBytes += reply.body.length;
      this.stats.wallMs+=Number(reply.header.elapsedMs??0);
      return new Uint8ClampedArray(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength);
    };
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async run(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    nodes: CompiledGraphNode[],
  ): Promise<Uint8ClampedArray | undefined> {
    if (!this.eligible(width * height, nodes.length)) return;
    const operations = nodes.map(encodeGpuPoint);
    if (operations.some((value) => !value)) {
      if (this.mode === 'gpu')
        throw new VmotionError(
          'GPU_UNSUPPORTED',
          'Point controls or multi-input channels cannot use this GPU kernel',
        );
      return;
    }
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 3840 ||
      height > 2160 ||
      pixels.length !== width * height * 4 ||
      nodes.length < 1 ||
      nodes.length > 64 ||
      width * height * nodes.length > 256 * 1024 * 1024
    )
      throw new VmotionError('GPU_BUDGET', 'GPU input exceeds UHD/64-stage/256M-pixel bounds');
    if (!(await this.initialize())) {
      this.stats.fallbacks++;
      return;
    }
    const work = async () => {
      try {
        if (this.status !== 'ready') {
          if (this.mode === 'gpu' || this.options.strictAfterReady)
            throw new VmotionError(
              this.error?.code ?? 'GPU_UNAVAILABLE',
              this.error?.message ?? 'GPU context is unavailable',
            );
          this.stats.fallbacks++;
          return undefined;
        }
        const started = performance.now(),
          result = await this.request(
            'pointChain',
            { width, height, operations },
            Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          );
        const flagBytes = Math.ceil((width * height) / 32) * 4;
        if (result.body.length !== pixels.length + flagBytes)
          throw new VmotionError('GPU_PROTOCOL', 'GPU pixel output has inconsistent dimensions');
        this.stats.requests++;
        this.stats.stages += nodes.length;
        this.stats.pixels += width * height * nodes.length;
        this.stats.dispatches += result.header.dispatches;
        this.stats.uploadedBytes += result.header.uploadedBytes;
        this.stats.downloadedBytes += result.header.downloadedBytes;
        this.stats.retainedBytes = result.header.retainedBytes;
        this.stats.surfaceAllocations = result.header.surfaceAllocations;
        const output = new Uint8ClampedArray(
            result.body.buffer,
            result.body.byteOffset,
            pixels.length,
          ),
          indices = new Uint32Array(65536),
          lut = gpuCanvasTable();
        let count = 0;
        const correct = () => {
          if (!count) return;
          let corrected = new Uint8ClampedArray(count * 4);
          for (let i = 0; i < count; i++) {
            const at = indices[i] * 4;
            for (let c = 0; c < 4; c++) corrected[i * 4 + c] = pixels[at + c];
          }
          for (const [index, node] of nodes.entries()) {
            corrected =
              node.type === 'colorMatrix'
                ? colorMatrixPixels(corrected, node)
                : node.type === 'keyer'
                  ? keyerPixels(corrected, node)
                  : mergeGraphChannels(
                      node as GpuPoint & { type: 'channels' },
                      new Map([[graphDependencies(node)[0], corrected]]),
                      corrected.length,
                    );
            if (index + 1 < nodes.length)
              for (let at = 0; at < corrected.length; at += 4) {
                const a = corrected[at + 3];
                for (let c = 0; c < 3; c++) corrected[at + c] = lut[corrected[at + c] * 256 + a];
              }
          }
          for (let i = 0; i < count; i++)
            for (let c = 0; c < 4; c++) output[indices[i] * 4 + c] = corrected[i * 4 + c];
          this.stats.correctedPixels += count;
          count = 0;
        };
        for (let word = 0; word < flagBytes / 4; word++) {
          let bits = result.body.readUInt32LE(pixels.length + word * 4);
          while (bits) {
            const bit = 31 - Math.clz32(bits & -bits),
              index = word * 32 + bit;
            if (index < width * height) {
              indices[count++] = index;
              if (count === indices.length) correct();
            }
            bits = (bits & (bits - 1)) >>> 0;
          }
        }
        correct();
        this.stats.wallMs += performance.now() - started;
        return output;
      } catch (error) {
        this.failed(error as Error);
        this.stats.fallbacks++;
        if (this.mode === 'gpu' || this.options.strictAfterReady) throw error;
        return undefined;
      }
    };
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private request(
    method: string,
    params: Record<string, unknown>,
    body: Buffer,
    timeoutMs?: number,
  ): Promise<{ header: any; body: Buffer }> {
    if (this.status === 'closed')
      return Promise.reject(new VmotionError('GPU_CLOSED', 'GPU process is closed'));
    if (this.pending)
      return Promise.reject(
        new VmotionError('GPU_BUSY', 'GPU transport only permits one active request'),
      );
    if (!this.child) {
      const child = spawn(this.binary, [], { stdio: 'pipe', windowsHide: true });
      this.child = child;
      const reader = new GpuFrames((header, body) => {
        const pending = this.pending;
        if (!pending || header.id !== pending.id)
          throw new VmotionError('GPU_PROTOCOL', 'Unexpected GPU response ID');
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (header.error)
          pending.reject(
            new VmotionError(
              String(header.error).match(/^([A-Z_]+):/)?.[1] ?? 'GPU_EXECUTION',
              header.error,
            ),
          );
        else pending.resolve({ header: header.result, body });
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        this.stats.ipcReceivedBytes += chunk.length;
        try {
          reader.push(chunk);
        } catch (error) {
          this.failed(error as Error);
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', (error) => {
        if (this.child === child) this.failed(error);
      });
      child.on('exit', () => {
        if (this.child === child)
          this.failed(new VmotionError('GPU_EXIT', 'Native GPU process exited'));
      });
      child.stdin.on('error', (error) => {
        if (this.child === child) this.failed(error);
      });
    }
    const id = ++this.counter,
      header = Buffer.from(JSON.stringify({ id, method, ...params })),
      prefix = Buffer.alloc(8);
    if (header.length > 512 * 1024 || body.length > 3840 * 2160 * 4)
      throw new VmotionError('GPU_PROTOCOL', 'GPU request exceeds frame bounds');
    prefix.writeUInt32LE(header.length, 0);
    prefix.writeUInt32LE(body.length, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.failed(new VmotionError('GPU_TIMEOUT', 'Native GPU request timed out')),
        timeoutMs ?? this.options.timeoutMs ?? 30000,
      );
      this.pending = { id, resolve, reject, timer };
      this.stats.ipcSentBytes += 8 + header.length + body.length;
      this.child!.stdin.write(prefix);
      this.child!.stdin.write(header);
      this.child!.stdin.write(body);
    });
  }
  private failed(error: Error) {
    this.error = {
      code: error instanceof VmotionError ? error.code : 'GPU_EXECUTION',
      message: error.message,
    };
    if (this.status !== 'closed') this.status = 'failed';
    const child = this.child;
    this.child = undefined;
    child?.kill();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
  close() {
    this.status = 'closed';
    this.failed(new VmotionError('GPU_CLOSED', 'GPU process closed'));
  }
}
