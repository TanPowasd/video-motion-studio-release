import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateNode, getNumericPath, setNumericPath } from './time.js';
import { VmotionError, type Node } from './model.js';
import { rasterize3D, type RasterRequest, type RasterResult } from './raster3d.js';
import { AnimationPrograms } from './animation-program.js';
import { copyNumericUpdates } from './numeric-copy.js';
type IndexedResult = {
  version: number;
  nodes?: Node[];
  missing?: string[];
  stats?: Record<string, number>;
};
export class NativeEvaluator {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void }
  >();
  private counter = 0;
  private buffer = '';
  private indexedSupported: boolean | undefined;
  private knownPrograms = new Set<string>();
  private nativeStats: Record<string, number> = {};
  private programs: AnimationPrograms;
  private stats = {
    indexedRequests: 0,
    evaluationBytesSent: 0,
    definitionBytesSent: 0,
    hashedPrograms: 0,
    missingRetries: 0,
    fallbackNodes: 0,
  };
  constructor(readonly options: { cache?: boolean } = {}) {
    this.programs = new AnimationPrograms(options.cache !== false);
  }
  diagnostics() {
    return {
      ...this.stats,
      indexedSupported: this.indexedSupported ?? null,
      cache: this.options.cache !== false,
      native: { ...this.nativeStats },
      definitions: this.programs.report(),
    };
  }
  readonly binary =
    process.env.VMOTION_NATIVE ??
    (() => {
      const dir = path.dirname(
        typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
          ? fileURLToPath(import.meta.url)
          : String(import.meta.url),
      );
      const bundled = resolveNativeBinary(path.resolve(dir, '../native'));
      return existsSync(bundled)
        ? bundled
        : resolveNativeBinary(path.resolve(dir, '../../dist/native'));
    })();
  get available() {
    return existsSync(this.binary);
  }
  async evaluate(nodes: Node[], frame: number): Promise<Node[]> {
    const moving = (node: Node) => !!(node.animations.length || node.animationLayers?.length);
    if (!this.available || this.indexedSupported === false) {
      this.stats.fallbackNodes += nodes.length;
      return nodes.map((n) => evaluateNode(n, frame));
    }
    const animated = nodes.filter(moving);
    if (!animated.length) return nodes.map((n) => evaluateNode(n, frame));
    const evaluated: Node[] = [];
    try {
      for (let begin = 0; begin < animated.length; begin += 64) {
        const originals = animated.slice(begin, begin + 64),
          definitions: Record<string, unknown> = {},
          keys: string[] = [],
          entries = originals.map((node) => {
            const { program, key } = this.programs.resolve(node);
            this.stats.hashedPrograms = this.programs.report().hashes;
            keys.push(key);
            definitions[key] = program;
            const projection: Record<string, unknown> = {};
            if (node.animationLayers)
              projection.animationLayers = node.animationLayers.map(
                ({ channels, ...meta }) => meta,
              );
            const paths = [
              ...new Set([
                ...node.animations.map((c) => c.property),
                ...(node.animationLayers ?? []).flatMap((l) => l.channels.map((c) => c.property)),
              ]),
            ];
            for (const path of paths) {
              try {
                getNumericPath(node, path);
              } catch (error) {
                throw new VmotionError('ANIMATION_TARGET', (error as Error).message, {
                  nodeId: node.id,
                  property: path,
                });
              }
              const parts = path.split('.');
              let target: any = projection,
                source: any = node;
              for (const [index, part] of parts.entries()) {
                source = source[part];
                if (index === parts.length - 1) target[part] = source;
                else {
                  if (target[part] === undefined) target[part] = {};
                  target = target[part];
                }
              }
            }
            return { program: key, node: projection };
          }),
          cache = this.options.cache !== false;
        const send = async (programs: Record<string, unknown>) => {
          this.stats.indexedRequests++;
          this.stats.definitionBytesSent += Buffer.byteLength(JSON.stringify(programs));
          return this.request<IndexedResult>('evaluateIndexed', {
            entries,
            programs,
            frame,
            cache,
          });
        };
        let response: IndexedResult;
        try {
          response = await send(
            Object.fromEntries(
              Object.entries(definitions).filter(([key]) => !cache || !this.knownPrograms.has(key)),
            ),
          );
        } catch (error) {
          if (error instanceof VmotionError && error.code === 'ANIMATION_PROGRAM_MISSING') {
            response = { version: 1, missing: keys };
          } else throw error;
        }
        if (response.missing?.length) {
          this.stats.missingRetries++;
          response = await send(definitions);
        }
        if (response.version !== 1 || !response.nodes || response.nodes.length !== originals.length)
          throw new VmotionError(
            'NATIVE_ANIMATION_PROTOCOL',
            'Indexed animation output is incomplete',
          );
        this.indexedSupported = true;
        this.nativeStats = response.stats ?? {};
        if (cache)
          for (const key of keys) {
            this.knownPrograms.delete(key);
            this.knownPrograms.add(key);
            if (this.knownPrograms.size > 128)
              this.knownPrograms.delete(this.knownPrograms.values().next().value!);
          }
        response.nodes.forEach((projection, i) => {
          const original = originals[i],
            paths = [
              ...new Set([
                ...original.animations.map((c) => c.property),
                ...(original.animationLayers ?? []).flatMap((l) =>
                  l.channels.map((c) => c.property),
                ),
              ]),
            ];
          const updates: Array<[string, number]> = paths.map((path) => [
            path,
            getNumericPath(projection, path),
          ]);
          if (original.animationLayers)
            original.animationLayers.forEach((_, j) =>
              updates.push([`animationLayers.${j}.weight`, projection.animationLayers![j].weight]),
            );
          const node = copyNumericUpdates(original, updates);
          node.opacity = Math.min(1, Math.max(0, node.opacity));
          node.reveal = Math.min(1, Math.max(0, node.reveal));
          evaluated.push(node);
        });
      }
    } catch (error) {
      if (
        error instanceof VmotionError &&
        error.code === 'NATIVE_ERROR' &&
        error.message.includes('Unknown method')
      ) {
        this.indexedSupported = false;
        this.stats.fallbackNodes += nodes.length;
        return nodes.map((n) => evaluateNode(n, frame));
      }
      throw error;
    }
    let cursor = 0;
    return nodes.map((n) => (moving(n) ? evaluated[cursor++] : evaluateNode(n, frame)));
  }
  async raster3D(request: RasterRequest): Promise<RasterResult> {
    if (!this.available) return rasterize3D(request);
    let result: {
      rgba: string;
      depth?: string;
      faceIds?: string;
      triangles: number;
      shadingVersion?: number;
    };
    try {
      result = await this.request('raster3d', request);
    } catch (e) {
      if (
        e instanceof VmotionError &&
        e.code === 'NATIVE_ERROR' &&
        e.message.includes('Unknown method')
      )
        return rasterize3D(request);
      throw e;
    }
    if (request.lighting && result.shadingVersion !== 1) return rasterize3D(request);
    const pixels = Buffer.from(result.rgba, 'base64'),
      size = request.width * request.height;
    if (pixels.length !== size * 4)
      throw new VmotionError('RASTER3D_OUTPUT', 'Native pixel buffer size mismatch');
    const floats = (data: string) => {
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length !== size * 4)
          throw new VmotionError('RASTER3D_OUTPUT', 'Native depth buffer size mismatch');
        const out = new Float32Array(size);
        for (let i = 0; i < size; i++) out[i] = bytes.readFloatLE(i * 4);
        return out;
      },
      ints = (data: string) => {
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length !== size * 4)
          throw new VmotionError('RASTER3D_OUTPUT', 'Native ID buffer size mismatch');
        const out = new Int32Array(size);
        for (let i = 0; i < size; i++) out[i] = bytes.readInt32LE(i * 4);
        return out;
      };
    if (request.inspection && (!result.depth || !result.faceIds))
      throw new VmotionError('RASTER3D_OUTPUT', 'Native inspection buffers are missing');
    return {
      pixels,
      backend: 'rust',
      triangles: result.triangles,
      ...(request.inspection
        ? { depth: floats(result.depth!), faceIds: ints(result.faceIds!) }
        : {}),
    };
  }
  private request<T>(method: string, payload: object): Promise<T> {
    const id = ++this.counter,
      line = JSON.stringify({ id, method, ...payload });
    if (method === 'evaluateIndexed') this.stats.evaluationBytesSent += Buffer.byteLength(line);
    if (Buffer.byteLength(line) > 16 * 1024 * 1024)
      return Promise.reject(
        new VmotionError(
          'NATIVE_INPUT_LIMIT',
          'Native request exceeds 16MB; split or simplify geometry',
        ),
      );
    if (!this.child) {
      const child = spawn(this.binary, [], { windowsHide: true });
      this.child = child;
      child.stderr.on('data', () => {});
      child.on('error', (e) => {
        if (this.child === child) this.fail(e);
      });
      child.on('exit', () => {
        if (this.child === child)
          this.fail(new VmotionError('NATIVE_EXIT', 'Native animation core exited'));
      });
      child.stdout.on('data', (chunk) => {
        if (this.child !== child) return;
        this.buffer += chunk.toString();
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const raw = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const message = JSON.parse(raw),
              request = this.pending.get(message.id);
            if (!request) continue;
            this.pending.delete(message.id);
            if (message.error)
              request.reject(
                new VmotionError(
                  message.error.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? 'NATIVE_ERROR',
                  message.error,
                ),
              );
            else request.resolve(message.result);
          } catch (e) {
            this.fail(e as Error);
          }
        }
      });
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(line + '\n');
    });
  }
  private fail(e: Error) {
    for (const value of this.pending.values()) value.reject(e);
    this.pending.clear();
    this.child = undefined;
    this.knownPrograms.clear();
    this.indexedSupported = undefined;
    this.nativeStats = {};
    this.buffer = '';
  }
  close() {
    const child = this.child;
    this.child = undefined;
    for (const value of this.pending.values())
      value.reject(new VmotionError('NATIVE_CLOSED', 'Native process closed'));
    this.pending.clear();
    child?.kill();
    this.child = undefined;
    this.knownPrograms.clear();
    this.programs.clear();
    this.buffer = '';
    this.indexedSupported = undefined;
    this.nativeStats = {};
  }
}
export function resolveNativeBinary(directory: string) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (
      typeof manifest.executable === 'string' &&
      path.basename(manifest.executable) === manifest.executable
    )
      return path.join(directory, manifest.executable);
  } catch {}
  return path.join(directory, process.platform === 'win32' ? 'vmotion-core.exe' : 'vmotion-core');
}
