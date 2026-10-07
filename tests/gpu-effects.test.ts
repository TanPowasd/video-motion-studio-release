import { it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { GpuPoints, gpuCanvasTable, encodeGpuPoint } from '../src/core/gpu-points.js';
import { GpuFrames } from '../src/core/gpu-transport.js';
import { NativeEvaluator } from '../src/core/native.js';
import { colorMatrixPixels, mergeGraphChannels } from '../src/core/graph-channel-pixels.js';
import { keyerPixels } from '../src/core/keyer-pixels.js';
import { effectGraphSchema } from '../src/core/effect-graph-schema.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
import { Renderer } from '../src/core/renderer.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { comparePixels } from '../src/core/pixel-evidence.js';
const instances: GpuPoints[] = [],
  renderers: Renderer[] = [];
afterEach(async () => {
  instances.forEach((g) => g.close());
  instances.length = 0;
  await Promise.all(renderers.map((r) => r.close()));
  renderers.length = 0;
});
const gpu = (
  mode: 'cpu' | 'auto' | 'gpu' = 'gpu',
  options: ConstructorParameters<typeof GpuPoints>[1] = {},
) => {
  const result = new GpuPoints(new NativeEvaluator().binary, { mode, ...options });
  instances.push(result);
  return result;
};
const matrix = [
  0.82, 0.05, 0.03, 0, 0.03, 0, 0.91, 0.06, 0, 0.01, 0.08, 0.02, 0.88, 0, 0, 0, 0, 0, 1, 0,
];
const nodes = effectGraphSchema
  .parse({
    kind: 'effect-graph',
    version: 1,
    name: 'kernels',
    nodes: [
      { id: 'source', type: 'input' },
      { id: 'grade', type: 'colorMatrix', input: 'source', matrix },
      {
        id: 'key',
        type: 'keyer',
        input: 'grade',
        color: '#00ff00',
        threshold: 0.13,
        softness: 0.25,
        spill: 0.6,
      },
      {
        id: 'channels',
        type: 'channels',
        red: { input: 'key', channel: 'blue' },
        green: { input: 'key', channel: 'luma' },
        blue: 0.4,
        alpha: { input: 'key', channel: 'alpha' },
      },
    ],
    output: 'channels',
  })
  .nodes.slice(1) as any[];
function nativeRoundtrip(pixels: Uint8ClampedArray, w: number, h: number) {
  const canvas = createCanvas(w, h);
  try {
    canvas.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
    return canvas.getContext('2d').getImageData(0, 0, w, h).data;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
function reference(pixels: Uint8ClampedArray, w: number, h: number, operations: any[]) {
  let current = pixels;
  for (const [i, node] of operations.entries()) {
    current =
      node.type === 'colorMatrix'
        ? colorMatrixPixels(current, node)
        : node.type === 'keyer'
          ? keyerPixels(current, node)
          : mergeGraphChannels(node, new Map([[node.alpha.input, current]]), current.length);
    if (i < operations.length - 1) current = nativeRoundtrip(current, w, h);
  }
  return current;
}
it('parses fragmented/coalesced binary replies without text/base64 or quadratic concatenation', () => {
  const frame = (id: number, payload: Buffer) => {
    const header = Buffer.from(JSON.stringify({ id, result: { pixels: payload.length / 4 } })),
      prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(header.length);
    prefix.writeUInt32LE(payload.length, 4);
    return Buffer.concat([prefix, header, payload]);
  };
  const combined = Buffer.concat([
    frame(1, Buffer.from([0, 1, 2, 3])),
    frame(2, Buffer.alloc(0)),
    frame(3, Buffer.from([4, 5, 6, 7])),
  ]);
  for (const chunkSize of [1, 2, 7, 8, 13, combined.length]) {
    const received: any[] = [];
    const reader = new GpuFrames((header, body) => received.push([header.id, [...body]]));
    for (let at = 0; at < combined.length; at += chunkSize)
      reader.push(combined.subarray(at, at + chunkSize));
    expect(received).toEqual([
      [1, [0, 1, 2, 3]],
      [2, []],
      [3, [4, 5, 6, 7]],
    ]);
  }
  const invalid = Buffer.alloc(8);
  invalid.writeUInt32LE(1);
  invalid.writeUInt32LE(40 * 1024 * 1024, 4);
  expect(() => new GpuFrames(() => {}).push(invalid)).toThrow(/bounds/);
});
it('uses host Skia quantization for every alpha/color combination and bounded point controls', () => {
  const lut = gpuCanvasTable();
  expect(lut).toHaveLength(65536);
  expect(gpuCanvasTable()).toBe(lut);
  for (let color = 0; color < 256; color++) expect(lut[color * 256 + 255]).toBe(color);
  for (const node of nodes) expect(encodeGpuPoint(node)).toHaveLength(32);
  expect(encodeGpuPoint({ ...nodes[0], matrix: Array(20).fill(1e100) })).toBeUndefined();
  expect(encodeGpuPoint({ ...nodes[2], red: { input: 'second', channel: 'red' } })).toBeUndefined();
});
it('keeps unavailable auto backends on CPU with explicit evidence and required GPU failures', async () => {
  const missing = path.resolve('artifacts/does-not-exist-gpu.exe'),
    auto = gpu('auto', { binary: missing }),
    required = gpu('gpu', { binary: missing });
  expect(await auto.initialize()).toBe(false);
  expect(auto.report()).toMatchObject({
    status: 'failed',
    fullSceneGpu: false,
    requests: 0,
    error: { code: 'GPU_UNAVAILABLE' },
  });
  expect(await gpu('cpu').initialize()).toBe(false);
  await expect(required.initialize()).rejects.toMatchObject({ code: 'GPU_UNAVAILABLE' });
  expect(auto.eligible(160 * 90, 1)).toBe(false);
  await expect(gpu('gpu').run(new Uint8ClampedArray(4), 5000, 1, nodes)).rejects.toMatchObject({
    code: 'GPU_BUDGET',
  });
});
const available = process.platform === 'win32' && existsSync(gpu().binary);
it.skipIf(!available)(
  'corrects more than one precision batch with bounded work buffers',
  async () => {
    const backend = gpu(),
      width = 512,
      height = 256,
      pixels = new Uint8ClampedArray(width * height * 4);
    for (let at = 0; at < pixels.length; at += 4) {
      pixels[at] = 20;
      pixels[at + 1] = 90;
      pixels[at + 2] = 180;
      pixels[at + 3] = 128;
    }
    const half = {
        ...nodes[0],
        matrix: [1, 0, 0, 0, 0.5 / 255, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
      },
      chain = [half, half];
    const result = (await backend.run(pixels, width, height, chain))!;
    expect(result).toEqual(reference(pixels, width, height, chain));
    expect(backend.report().correctedPixels).toBe(width * height);
  },
);
it.skipIf(!available)(
  'runs real hardware kernels with transparent edges, linear/sRGB matrices, keying and channel controls',
  async () => {
    const backend = gpu(),
      w = 256,
      h = 128,
      pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      pixels[i * 4] = i % 256;
      pixels[i * 4 + 1] = (i * 13) % 256;
      pixels[i * 4 + 2] = (i * 71) % 256;
      pixels[i * 4 + 3] = Math.floor(i / 128) % 256;
    }
    const variants = [
      nodes,
      [{ ...nodes[0], colorSpace: 'linear' }],
      [{ ...nodes[1], mode: 'luma', invert: true, view: 'matte' }],
      [{ ...nodes[0], matrix: [...matrix.slice(0, 15), 0.2, 0.1, 0, 0.7, 0.1] }, nodes[1]],
      Array.from({ length: 8 }, (_, i) => ({ ...nodes[0], id: 'grade' + i })),
      Array.from({ length: 32 }, (_, i) => ({ ...nodes[0], id: 'long-grade' + i })),
    ];
    for (const chain of variants) {
      const actual = (await backend.run(pixels, w, h, chain))!,
        expected = reference(pixels, w, h, chain),
        comparison = comparePixels(
          nativeRoundtrip(expected, w, h),
          nativeRoundtrip(actual, w, h),
          w,
          h,
          { tolerance: 0 },
        );
      expect(comparison.changedPixels, JSON.stringify(comparison)).toBe(0);
    }
    expect(backend.report()).toMatchObject({
      status: 'ready',
      adapter: { hardware: true, backend: 'Dx12' },
      dispatches: variants.length,
      surfaceAllocations: 1,
      fullSceneGpu: false,
    });
    expect(backend.report().correctedPixels).toBeGreaterThan(0);
  },
);
it.skipIf(!available)(
  'serializes concurrent requests and reports device-process loss without mixing fallback into strict exports',
  async () => {
    const backend = gpu(),
      pixels = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    const results = await Promise.all([
      backend.run(pixels, 64, 64, [nodes[0]]),
      backend.run(pixels, 64, 64, [nodes[0]]),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(backend.report().requests).toBe(2);
    const child = (backend as any).child;
    child.kill();
    await once(child, 'exit');
    await expect(backend.run(pixels, 64, 64, [nodes[0]])).rejects.toMatchObject({
      code: 'GPU_EXIT',
    });
    const strict = gpu('auto', { strictAfterReady: true });
    await strict.initialize();
    const strictChild = (strict as any).child;
    strictChild.kill();
    await once(strictChild, 'exit');
    await expect(
      strict.run(new Uint8ClampedArray(512 * 512 * 4), 512, 512, [nodes[0], nodes[0]]),
    ).rejects.toMatchObject({ code: 'GPU_EXIT' });
  },
);
it.skipIf(!available)(
  'fuses graph stages with real alpha quantization, preserves branch consumers and measures tolerance through the shared service',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-gpu-graph-'));
    await initProject(root, 'GPU', {
      template: 'blank',
      width: 640,
      height: 360,
      durationSeconds: 1,
    });
    const app = await new Application(root).open(false);
    try {
      const graph = defineEffectGraph({
        kind: 'effect-graph',
        version: 1,
        name: 'fused',
        nodes: [
          { id: 'source', type: 'input' },
          ...Array.from({ length: 6 }, (_, i) => ({
            id: 'grade' + i,
            type: 'colorMatrix' as const,
            input: i ? 'grade' + (i - 1) : 'source',
            matrix,
          })),
        ],
        output: 'grade5',
      });
      await app.service.transact([
        {
          type: 'addNode',
          sceneId: 'intro',
          node: {
            id: 'picture',
            type: 'rect',
            x: 0,
            y: 0,
            width: 640,
            height: 360,
            fill: '#65bf8a',
            effects: [{ id: 'graph', type: 'effectGraph', graph, params: {}, bindings: {} }],
          },
        },
      ]);
      const revision = app.service.snapshot.revision;
      const compared = await app.dispatch('renderCompare', {
        sceneId: 'intro',
        frames: [0, 12],
        repeat: 2,
        width: 640,
        height: 360,
        pixelTolerance: 2,
        baseline: { gpu: 'cpu', graphOptimize: true },
        optimized: { gpu: 'gpu' },
        detail: true,
      });
      expect(compared.equivalence).toMatchObject({ matched: true, pixelTolerance: 2 });
      expect(compared.optimized.gpu).toMatchObject({
        requests: 4,
        stages: 24,
        dispatches: 4,
        surfaceAllocations: 1,
      });
      expect(compared.optimized.graph.fused).toBe(20);
      expect(compared.optimized.graph.readbackPixels).toBeLessThan(
        compared.baseline.graph.readbackPixels,
      );
      expect(app.service.snapshot.revision).toBe(revision);
      const cpu = new Renderer(root, { gpu: 'cpu', graphTrace: true }),
        accelerated = new Renderer(root, { gpu: 'gpu', graphTrace: true });
      renderers.push(cpu, accelerated);
      const branch = defineEffectGraph({
        kind: 'effect-graph',
        version: 1,
        name: 'branch',
        nodes: [
          { id: 'source', type: 'input' },
          { ...nodes[0], id: 'first', input: 'source' },
          { ...nodes[0], id: 'second', input: 'first' },
          { id: 'merge', type: 'blend', background: 'first', foreground: 'second', opacity: 0.4 },
        ],
        output: 'merge',
      });
      await app.service.transact([
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: 'picture',
          patch: {
            effects: [
              { id: 'graph', type: 'effectGraph', graph: branch, params: {}, bindings: {} },
            ],
          },
        },
      ]);
      const a = await cpu.render(app.service.snapshot, 0, { width: 640, height: 360 }),
        b = await accelerated.render(app.service.snapshot, 0, { width: 640, height: 360 });
      expect(
        comparePixels(
          a.getContext('2d').getImageData(0, 0, 640, 360).data,
          b.getContext('2d').getImageData(0, 0, 640, 360).data,
          640,
          360,
          { tolerance: 2 },
        ).changedPixels,
      ).toBe(0);
      expect(accelerated.gpu.report()).toMatchObject({ requests: 2, stages: 2 });
      a.width = a.height = b.width = b.height = 1;
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
