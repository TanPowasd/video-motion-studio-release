import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
import { newNode, type Snapshot } from '../src/core/model.js';
import { defineEffectGraph, compileEffectGraph } from '../src/core/effect-graph.js';
import { editEffectGraph } from '../src/core/effect-graph-edit.js';
import { effectGraph } from '../src/sdk/post.js';
import { EffectGraphResolver } from '../src/core/effect-graph-cache.js';
import { renderEffectGraph } from '../src/core/effect-graph-render.js';
let root: string, snapshot: Snapshot, renderer: Renderer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-graph-ports-'));
  await initProject(root, 'ports', { template: 'blank', width: 160, height: 90 });
  snapshot = await loadProject(root);
  snapshot.scenes[0].background = 'transparent';
  renderer = new Renderer(root);
});
afterEach(async () => {
  await renderer.close();
  await rm(root, { recursive: true, force: true });
});
const ports = () =>
  defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Reusable channels',
    nodes: [
      { id: 'src', type: 'input' },
      {
        id: 'swap',
        type: 'channels',
        red: { input: 'src', channel: 'blue' },
        green: { input: 'src', channel: 'red' },
        blue: { input: 'src', channel: 'green' },
        alpha: { input: 'src', channel: 'alpha' },
      },
      {
        id: 'matte',
        type: 'channels',
        red: 1,
        green: 1,
        blue: 1,
        alpha: { input: 'src', channel: 'alpha' },
      },
    ],
    output: 'swap',
    outputs: { color: 'swap', matte: 'matte', original: 'src' },
  });
const data = async (r = renderer) =>
  (await r.render(snapshot, 0, { sceneId: 'intro' })).getContext('2d').getImageData(0, 0, 160, 90)
    .data;
const pixel = (p: Uint8ClampedArray, x = 25, y = 25) =>
  Array.from(p.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
function owner(graph = ports(), output?: string) {
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'card',
      type: 'rect',
      x: 20,
      y: 20,
      width: 40,
      height: 30,
      fill: '#cc663380',
      effects: [effectGraph(graph, {}, {}, output)],
    }),
  ];
}
it('selects named outputs by reachability and supports independent subgraph output choices', () => {
  const child = ports(),
    matte = compileEffectGraph(child, {}, undefined, 'matte');
  expect(matte.nodes.map((n) => n.id)).toEqual(['src', 'matte']);
  expect(matte.unused).toContain('swap');
  expect(matte.outputs).toEqual(child.outputs);
  const parent = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Parent',
    nodes: [
      { id: 'src', type: 'input' },
      {
        id: 'child',
        type: 'subgraph',
        source: 'components/effects/child.json',
        output: 'original',
        inputs: { source: 'src' },
      },
    ],
    output: 'child',
  });
  const compiled = compileEffectGraph(parent, {}, () => child);
  expect(compiled.nodes.map((n) => n.id)).toEqual(['src', 'child/src', 'child']);
  expect(compiled.unused).toContain('child/matte');
  expect(() => compileEffectGraph(parent, {}, () => ({ ...child, outputs: {} }))).toThrow(
    /Selected named/,
  );
  expect(() => defineEffectGraph({ ...child, outputs: { missing: 'none' } })).toThrow(
    /Named graph output/,
  );
  expect(() =>
    defineEffectGraph({
      ...child,
      outputs: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['port' + i, 'src'])),
    }),
  ).toThrow(/32 named/);
  expect(() => compileEffectGraph(child, {}, undefined, 'unknown')).toThrow(/Selected named/);
  expect(editEffectGraph(child, [{ type: 'outputs', outputs: { mask: 'matte' } }]).outputs).toEqual(
    { mask: 'matte' },
  );
  expect(() => editEffectGraph(child, [{ type: 'remove', nodeId: 'matte' }])).toThrow(
    /Named graph output/,
  );
});
it('reorders straight RGBA channels and outputs a reusable matte with exact transparent boundaries', async () => {
  owner();
  const routed = snapshot.scenes[0].nodes[0].effects;
  snapshot.scenes[0].nodes[0].effects = [];
  const sourcePixel = pixel(await data());
  snapshot.scenes[0].nodes[0].effects = routed;
  const swapped = pixel(await data());
  // Canvas premultiplication rounds partially transparent colors to 8-bit storage.
  for (const [channel, expected] of [sourcePixel[2], sourcePixel[0], sourcePixel[1]].entries())
    expect(Math.abs(swapped[channel] - expected)).toBeLessThanOrEqual(1);
  expect(swapped[3]).toBe(sourcePixel[3]);
  expect(pixel(await data(), 10, 10)[3]).toBe(0);
  owner(ports(), 'matte');
  expect(pixel(await data())).toEqual([255, 255, 255, sourcePixel[3]]);
  owner(ports(), 'original');
  const original = await data();
  snapshot.scenes[0].nodes[0].effects = [];
  expect(Buffer.from(await data()).equals(Buffer.from(original))).toBe(true);
});
it('combines multiple graph inputs and luma without implicit alpha multiplication or hidden constants', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Recombine',
    nodes: [
      { id: 'color', type: 'solid', color: '#ff0000', opacity: 0.5, space: 'canvas' },
      { id: 'other', type: 'solid', color: '#0000ff', space: 'canvas' },
      {
        id: 'out',
        type: 'channels',
        red: { input: 'other', channel: 'blue' },
        green: { input: 'color', channel: 'luma' },
        blue: 0.25,
        alpha: { input: 'color', channel: 'alpha' },
      },
    ],
    output: 'out',
  });
  owner(graph);
  const p = pixel(await data());
  expect(p[0]).toBe(255);
  expect(p[1]).toBeCloseTo(54, 0);
  expect(p[2]).toBeCloseTo(64, 0);
  const reference = createCanvas(1, 1),
    ctx = reference.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, 0, 1, 1);
  expect(p[3]).toBe(ctx.getImageData(0, 0, 1, 1).data[3]);
  expect(renderer.performanceInfo().graphScratchBytes).toBe(0);
  expect(renderer.performanceInfo().graphScratchPeakBytes).toBe(160 * 90 * 4 * 3);
});
it('applies row-major color matrices in sRGB or linear RGB while leaving alpha linear', async () => {
  const matrix = [0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 1, 0],
    graph = (colorSpace: 'srgb' | 'linear') =>
      defineEffectGraph({
        kind: 'effect-graph',
        version: 1,
        name: 'Exposure',
        nodes: [
          { id: 'src', type: 'input' },
          { id: 'adjust', type: 'colorMatrix', input: 'src', matrix, colorSpace },
        ],
        output: 'adjust',
      });
  owner(graph('srgb'));
  snapshot.scenes[0].nodes[0].fill = '#ffffff';
  expect(pixel(await data())).toEqual([128, 128, 128, 255]);
  owner(graph('linear'));
  snapshot.scenes[0].nodes[0].fill = '#ffffff';
  expect(pixel(await data())).toEqual([188, 188, 188, 255]);
  const identity = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Identity',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'adjust', type: 'colorMatrix', input: 'src' },
    ],
    output: 'adjust',
  });
  owner(identity);
  const image = await data();
  snapshot.scenes[0].nodes[0].effects = [];
  expect(Buffer.from(await data()).equals(Buffer.from(image))).toBe(true);
  expect(() =>
    defineEffectGraph({
      ...identity,
      nodes: [
        { id: 'src', type: 'input' },
        { id: 'bad', type: 'colorMatrix', input: 'src', matrix: [1] },
      ],
      output: 'bad',
    }),
  ).toThrow();
});
it('supports explicit alpha inversion and clamps signed/bias color coefficients over the full working canvas', async () => {
  const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, -1, 0, 0, 0, -1, 1],
    graph = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Invert alpha',
      nodes: [
        { id: 'src', type: 'input' },
        { id: 'out', type: 'colorMatrix', input: 'src', matrix },
      ],
      output: 'out',
    });
  owner(graph);
  snapshot.scenes[0].nodes[0].fill = '#cc6633';
  expect(pixel(await data())[3]).toBe(0);
  expect(pixel(await data(), 10, 10)).toEqual([255, 64, 0, 255]);
});
it('invalidates exact nested resource probes and bounds caches without caching rendered pictures', async () => {
  const childFile = 'components/effects/child.json',
    rootFile = 'components/effects/root.json',
    parent = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Root',
      nodes: [
        { id: 'src', type: 'input' },
        {
          id: 'child',
          type: 'subgraph',
          source: childFile,
          output: 'matte',
          inputs: { source: 'src' },
        },
      ],
      output: 'child',
    });
  snapshot.files[rootFile] = JSON.stringify(parent);
  snapshot.files[childFile] = JSON.stringify(ports());
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'card',
      type: 'rect',
      x: 20,
      y: 20,
      width: 40,
      height: 30,
      fill: '#cc6633',
      effects: [effectGraph(rootFile)],
    }),
  ];
  const uncached = new Renderer(root, { graphCache: false });
  try {
    for (const frame of [0, 60, 30, 0]) {
      const cached = await renderer.render(snapshot, frame, { sceneId: 'intro' }),
        baseline = await uncached.render(snapshot, frame, { sceneId: 'intro' });
      expect((await cached.encode('png')).equals(await baseline.encode('png'))).toBe(true);
    }
    expect(renderer.effectGraphs.report()).toMatchObject({ parses: 2, compiles: 1, reused: 3 });
    expect(uncached.effectGraphs.report()).toMatchObject({ parses: 8, compiles: 4, reused: 0 });
    snapshot.files['components/unrelated.ts'] = 'export const x = 1';
    await data();
    expect(renderer.effectGraphs.report().compiles).toBe(1);
    const edited = ports();
    (edited.nodes[2] as any).red = 0;
    snapshot.files[childFile] = JSON.stringify(edited);
    expect(pixel(await data())[0]).toBe(0);
    expect(renderer.effectGraphs.report()).toMatchObject({
      parses: 3,
      compiles: 2,
      invalidations: 1,
    });
    delete snapshot.files[childFile];
    await expect(data()).rejects.toMatchObject({ code: 'EFFECT_GRAPH_SOURCE' });
    snapshot.files[childFile] = JSON.stringify(ports());
    expect(pixel(await data())[0]).toBe(255);
  } finally {
    await uncached.close();
  }
  const bounded = new EffectGraphResolver(8192, 2);
  for (let i = 0; i < 8; i++)
    bounded.resolve(snapshot, effectGraph({ ...ports(), name: 'variant' + i }));
  expect(bounded.report().compiled.entries).toBeLessThanOrEqual(2);
  expect(bounded.report().compiled.accountedBytes).toBeLessThanOrEqual(8192);
  expect(bounded.report().compiled.evictions).toBeGreaterThan(0);
});
it('does not reuse stale mutable inline definitions or JSON-signature collisions with invalid extra fields', () => {
  const cache = new EffectGraphResolver(),
    inline = effectGraph(ports());
  const first = cache.resolve(snapshot, inline);
  expect(Object.isFrozen(first.nodes[1])).toBe(true);
  (inline.graph!.nodes[1] as any).red = 0.5;
  expect((cache.resolve(snapshot, inline).nodes[1] as any).red).toBe(0.5);
  (inline.graph as any).unexpected = undefined;
  expect(() => cache.resolve(snapshot, inline)).toThrow(/Unrecognized key/);
  const wrong = ports();
  wrong.parameters = { path: { type: 'string', default: 'matte' } };
  wrong.links = [
    {
      nodeId: 'swap',
      property: 'red.input',
      parameter: 'path',
      mode: 'direct',
      scale: 1,
      offset: 0,
    },
  ];
  expect(() => compileEffectGraph(wrong)).toThrow(/channel input routing/);
});
it('releases surfaces and scratch reservations when channel pixel work fails', async () => {
  const graph = compileEffectGraph(ports()),
    active = new Set<unknown>();
  let reserved = 0;
  const makeSurface = () => {
    const canvas = createCanvas(16, 16),
      surface = {
        canvas,
        ctx: canvas.getContext('2d'),
        release: () => {
          active.delete(surface);
        },
      };
    active.add(surface);
    return surface;
  };
  const env = {
    makeSurface,
    input: async () => makeSurface(),
    scale: 1,
    matrix: [1, 0, 0, 1, 0, 0] as const,
    canvasMatrix: [1, 0, 0, 1, 0, 0] as const,
    bounds: { x: 0, y: 0, width: 16, height: 16 },
    frame: 0,
    fps: 30,
    reserveScratch: (bytes: number) => {
      reserved += bytes;
      return () => {
        reserved -= bytes;
      };
    },
    evaluatedPixels: () => {
      throw new Error('budget exhausted');
    },
  };
  await expect(renderEffectGraph(graph, env as any)).rejects.toThrow(/budget exhausted/);
  expect(active.size).toBe(0);
  expect(reserved).toBe(0);
});
