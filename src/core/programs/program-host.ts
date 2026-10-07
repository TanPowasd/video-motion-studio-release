import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, hash, safePath } from '../../platform/project-files.js';
import { runtimeFile } from '../bundled-runtime.js';
import type { GpuPoints } from '../gpu-points.js';
import { VmotionError, type Snapshot } from '../model.js';
import { resolveParameters, type ParameterDefinitions } from '../parameters.js';
import { BinaryWorker } from './binary-worker.js';
import { PYTHON_WORKER } from './python-worker-source.js';
import { renderProgramSchema, type RenderProgram } from './render-program-schema.js';

export function programDefinition(snapshot: Snapshot, source: string) {
  const text = snapshot.files[source];
  if (text === undefined)
    throw new VmotionError('PROGRAM_SOURCE', 'Renderer manifest is missing', { file: source });
  let definition: RenderProgram;
  try {
    definition = renderProgramSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new VmotionError('PROGRAM_SCHEMA', (error as Error).message, { file: source });
  }
  const files = [...new Set([definition.entry, ...definition.files])];
  let bytes = Buffer.byteLength(text);
  for (const file of files) {
    const code = snapshot.files[file];
    if (code === undefined)
      throw new VmotionError('PROGRAM_SOURCE', 'Renderer dependency is missing', { file });
    bytes += Buffer.byteLength(code);
  }
  if (bytes > 4 * 1024 * 1024)
    throw new VmotionError('PROGRAM_BUDGET', 'Renderer source exceeds 4MB');
  if (
    definition.backend === 'wgsl' &&
    Buffer.byteLength(snapshot.files[definition.entry]) > 128 * 1024
  )
    throw new VmotionError('PROGRAM_BUDGET', 'WGSL source exceeds 128KB');
  for (const id of definition.assets)
    if (!snapshot.project.assets.some((asset) => asset.id === id))
      throw new VmotionError('MISSING_ASSET', 'Renderer asset is missing', {
        assetId: id,
        file: source,
      });
  return {
    definition,
    files,
    sourceHash: hash(
      [source, text, ...files.flatMap((file) => [file, snapshot.files[file]])].join('\0'),
    ),
  };
}
export function pythonBinary() {
  if (process.env.VMOTION_PYTHON) return process.env.VMOTION_PYTHON;
  const bundled = runtimeFile('python/python.exe');
  if (bundled && existsSync(bundled)) return bundled;
  if (process.platform === 'win32') {
    try {
      return execFileSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      }).trim();
    } catch {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
export class ProgramHost {
  private resources = new Map<
    string,
    { value: ReturnType<typeof programDefinition>; probes: Map<string, string> }
  >();
  private workers = new Map<string, BinaryWorker>();
  private retired = new Set<Promise<void>>();
  private staged = new Map<string, string>();
  readonly stats = {
    sourceParses: 0,
    sourceHits: 0,
    frames: 0,
    pythonFrames: 0,
    shaderFrames: 0,
    workerStarts: 0,
    inputBytes: 0,
    outputBytes: 0,
  };
  constructor(
    private root: string,
    private gpu: GpuPoints,
  ) {}
  private resolve(snapshot: Snapshot, source: string) {
    const old = this.resources.get(source);
    if (old && [...old.probes].every(([file, text]) => snapshot.files[file] === text)) {
      this.stats.sourceHits++;
      return old.value;
    }
    const value = programDefinition(snapshot, source);
    this.stats.sourceParses++;
    this.resources.delete(source);
    while (this.resources.size >= 16) this.resources.delete(this.resources.keys().next().value!);
    this.resources.set(source, {
      value,
      probes: new Map([source, ...value.files].map((file) => [file, snapshot.files[file]])),
    });
    return value;
  }
  report() {
    return { ...this.stats, workers: this.workers.size, sourceSnapshots: this.staged.size };
  }
  private async worker(snapshot: Snapshot, resource: ReturnType<typeof programDefinition>) {
    const binary = pythonBinary(),
      key = resource.sourceHash + '\0' + binary;
    let worker = this.workers.get(key);
    if (worker) {
      this.workers.delete(key);
      this.workers.set(key, worker);
      return worker;
    }
    while (this.workers.size >= 4) {
      const first = this.workers.keys().next().value!;
      const closed = this.workers.get(first)!.close();
      this.retired.add(closed);
      void closed.finally(() => this.retired.delete(closed));
      this.workers.delete(first);
    }
    const directory = safePath(this.root, `.vmotion/programs/${resource.sourceHash}`);
    for (const file of resource.files)
      await atomicWrite(safePath(directory, file), snapshot.files[file]);
    const entry = safePath(directory, resource.definition.entry),
      runner = path.join(directory, 'vmotion_worker.py');
    await atomicWrite(runner, PYTHON_WORKER);
    worker = new BinaryWorker(binary, ['-u', runner, entry], directory);
    this.workers.set(key, worker);
    this.stats.workerStarts++;
    this.staged.set(resource.sourceHash, directory);
    while (this.staged.size > 16) this.staged.delete(this.staged.keys().next().value!);
    return worker;
  }
  async render(
    snapshot: Snapshot,
    source: string,
    frame: number,
    width: number,
    height: number,
    params: Record<string, unknown>,
    input?: Uint8ClampedArray,
  ): Promise<Canvas> {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 3840 ||
      height > 2160 ||
      !Number.isFinite(frame) ||
      frame < 0
    )
      throw new VmotionError('PROGRAM_BUDGET', 'Renderer size/time exceeds UHD bounds');
    const resource = this.resolve(snapshot, source),
      definition = resource.definition,
      values = Object.keys(definition.parameters).length
        ? resolveParameters(definition.parameters as ParameterDefinitions, params)
        : params;
    const fps = snapshot.project.fps.num / snapshot.project.fps.den,
      seed = parseInt(hash(snapshot.project.id + source).slice(0, 6), 16),
      pixels = input
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : Buffer.alloc(width * height * 4);
    if (pixels.length !== width * height * 4)
      throw new VmotionError('PROGRAM_PROTOCOL', 'Input RGBA dimensions differ');
    const context = {
      frame,
      seconds: frame / fps,
      fps,
      timebase: snapshot.project.fps,
      width,
      height,
      seed,
      revision: snapshot.revision,
      assets: definition.assets.map((id) => {
        const asset = snapshot.project.assets.find((asset) => asset.id === id)!;
        return {
          id,
          type: asset.type,
          path: path.resolve(this.root, asset.path),
          metadata: asset.metadata,
        };
      }),
    };
    this.stats.inputBytes += pixels.length;
    let output: Uint8ClampedArray | Buffer;
    try {
      if (definition.backend === 'python') {
        const worker = await this.worker(snapshot, resource),
          reply = await worker.request(
            'render',
            { context, params: values },
            pixels,
            definition.timeoutMs,
          );
        output = reply.body;
        this.stats.pythonFrames++;
      } else {
        const uniforms = Array<number>(72).fill(0);
        uniforms.splice(
          0,
          8,
          width,
          height,
          frame,
          frame / fps,
          fps,
          seed,
          definition.uniforms.length,
          0,
        );
        definition.uniforms.forEach((key, index) => {
          let value: unknown = values;
          for (const part of key.split('.')) {
            if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
              throw new VmotionError('PROGRAM_PARAMETER', 'Uniform path is missing', { key });
            value = (value as Record<string, unknown>)[part];
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 3e38)
            throw new VmotionError('PROGRAM_PARAMETER', 'WGSL uniforms must be finite f32 values', {
              key,
            });
          uniforms[8 + index] = value;
        });
        output = await this.gpu.customShader(
          pixels,
          width,
          height,
          snapshot.files[definition.entry],
          uniforms,
          definition.workgroup,
          definition.timeoutMs,
        );
        this.stats.shaderFrames++;
      }
    } catch (error) {
      throw new VmotionError(
        error instanceof VmotionError ? error.code : 'PROGRAM_RENDER',
        (error as Error).message,
        {
          file: definition.entry,
          source,
          frame,
          backend: definition.backend,
          ...(error instanceof VmotionError && error.details && typeof error.details === 'object'
            ? error.details
            : {}),
        },
      );
    }
    if (output.length !== width * height * 4)
      throw new VmotionError('PROGRAM_PROTOCOL', 'Renderer output RGBA size differs', {
        source,
        frame,
      });
    const canvas = createCanvas(width, height);
    canvas
      .getContext('2d')
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(output.buffer, output.byteOffset, output.byteLength),
          width,
          height,
        ),
        0,
        0,
      );
    this.stats.outputBytes += output.length;
    this.stats.frames++;
    return canvas;
  }
  async identity(snapshot: Snapshot) {
    if (
      !Object.values(snapshot.files).some((text) => {
        try {
          const value = JSON.parse(text);
          return value.kind === 'render-program' && value.backend === 'python';
        } catch {
          return false;
        }
      })
    )
      return undefined;
    const binary = pythonBinary();
    let version: string;
    try {
      version = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      }).trim();
    } catch (error) {
      throw new VmotionError('PROGRAM_RUNTIME', 'Python runtime is unavailable', { binary });
    }
    return {
      binary: existsSync(binary) ? hash(await readFile(binary)) : binary,
      path: binary,
      version,
      wrapper: hash(PYTHON_WORKER),
    };
  }
  async close() {
    await Promise.all(
      [...this.workers.values()].map((worker) => worker.close()).concat([...this.retired]),
    );
    this.workers.clear();
    this.staged.clear();
    this.resources.clear();
  }
}
