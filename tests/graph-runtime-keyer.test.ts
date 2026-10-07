import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { Renderer } from '../src/core/renderer.js';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { newNode, type Snapshot } from '../src/core/model.js';
import { defineEffectGraph, compileEffectGraph } from '../src/core/effect-graph.js';
import { effectGraph } from '../src/sdk/post.js';
import { renderEffectGraph } from '../src/core/effect-graph-render.js';
import { graphPointPass } from '../src/core/graph-point-pass.js';
import { keyerPixels } from '../src/core/keyer-pixels.js';
import { effectGraphNodeSchema } from '../src/core/effect-graph-schema.js';
let root: string, snapshot: Snapshot, optimized: Renderer, baseline: Renderer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-graph-runtime-'));
  await initProject(root, 'runtime', { template: 'blank', width: 320, height: 180 });
  snapshot = await loadProject(root);
  snapshot.scenes[0].background = 'transparent';
  optimized = new Renderer(root, { graphTrace: true });
  baseline = new Renderer(root, {
    graphOptimize: false,
    graphRegions: false,
    graphTileRows: 0,
    graphTrace: true,
  });
});
afterEach(async () => {
  await optimized.close();
  await baseline.close();
  await rm(root, { recursive: true, force: true });
});
async function paired(frame = 0) {
  const a = await optimized.render(snapshot, frame, { sceneId: 'intro' }),
    b = await baseline.render(snapshot, frame, { sceneId: 'intro' });
  expect((await a.encode('png')).equals(await b.encode('png'))).toBe(true);
  return a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
}
const bytes = (data: Uint8ClampedArray, x: number, y: number) =>
  Array.from(data.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4));
const identity = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
it('shares exact identity surfaces across branches and preserves all 8-bit alpha/color values', async () => {
  const canvas = createCanvas(320, 180),
    pixels = new Uint8ClampedArray(320 * 180 * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = (at / 4) % 256;
    pixels[at + 1] = (at / 8) % 256;
    pixels[at + 2] = (at / 12) % 256;
    pixels[at + 3] = (at / 16) % 256;
  }
  canvas.getContext('2d').putImageData(new ImageData(pixels, 320, 180), 0, 0);
  await writeFile(path.join(root, 'source.png'), await canvas.encode('png'));
  snapshot.project.assets = [
    { id: 'image', name: 'image', type: 'image', path: 'source.png', managed: false, metadata: {} },
  ];
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Identity branches',
    nodes: [
      { id: 'src', type: 'input' },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: 'identity' + i,
        type: 'transform' as const,
        input: i ? 'identity' + (i - 1) : 'src',
        space: 'canvas' as const,
      })),
      {
        id: 'matrix',
        type: 'colorMatrix',
        input: 'identity19',
        matrix: identity,
        colorSpace: 'linear',
      },
      {
        id: 'channels',
        type: 'channels',
        red: { input: 'matrix', channel: 'red' },
        green: { input: 'matrix', channel: 'green' },
        blue: { input: 'matrix', channel: 'blue' },
        alpha: { input: 'matrix', channel: 'alpha' },
      },
      { id: 'map', type: 'solid', color: '#ff0000' },
      { id: 'displace', type: 'displace', input: 'channels', map: 'map', amountX: 0, amountY: 0 },
      {
        id: 'out',
        type: 'blend',
        background: 'displace',
        foreground: 'src',
        opacity: 0,
        mode: 'screen',
      },
    ],
    output: 'out',
  });
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'image',
      type: 'image',
      assetId: 'image',
      width: 320,
      height: 180,
      effects: [effectGraph(graph)],
    }),
  ];
  await paired();
  expect(optimized.graphExecution.report().passthroughs).toBe(24);
  expect(optimized.graphExecution.report().surfaces).toBe(2);
  expect(baseline.graphExecution.report().surfaces).toBe(26);
  expect(optimized.graphExecution.report().scalarPixels).toBe(0);
});
it('uses exact sparse support with rotation, blur and translucent edges while preserving alpha-creating bias and constants', async () => {
  const matrix = [0.7, 0.1, 0, 0, 0.1, 0, 0.8, 0, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 0, 0.8, 0],
    graph = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Sparse grade',
      nodes: [
        { id: 'src', type: 'input' },
        { id: 'out', type: 'colorMatrix', input: 'src', matrix, colorSpace: 'linear' },
      ],
      output: 'out',
    });
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'small',
      type: 'rect',
      x: 74.3,
      y: 60.8,
      width: 39,
      height: 32,
      rotation: 31,
      fill: '#7799ff80',
      effects: [{ type: 'blur', radius: 3 }, effectGraph(graph)],
    }),
  ];
  for (const frame of [0, 30, 12, 0]) await paired(frame);
  expect(optimized.graphExecution.report().scalarPixels).toBeLessThan(
    baseline.graphExecution.report().scalarPixels / 10,
  );
  const opaque = structuredClone(graph);
  (opaque.nodes[1] as any).matrix[19] = 0.25;
  snapshot.scenes[0].nodes[0].effects = [effectGraph(opaque)];
  const opaqueData = await paired();
  expect(bytes(opaqueData, 0, 0)[3]).toBeGreaterThan(0);
  const constant = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Constant alpha',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'out', type: 'channels', red: 1, green: 0, blue: 0, alpha: 0.5 },
    ],
    output: 'out',
  });
  snapshot.scenes[0].nodes[0].effects = [effectGraph(constant)];
  expect(bytes(await paired(), 0, 0)[3]).toBe(128);
});
it('keys chroma and luma in straight SDR with soft transitions, inversion, spill and preserved source alpha', () => {
  const node = effectGraphNodeSchema.parse({
    id: 'key',
    type: 'keyer',
    input: 'src',
    threshold: 0,
    softness: 0,
  });
  if (node.type !== 'keyer') throw new Error('Expected keyer');
  const image = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 128, 0, 255, 0, 0]);
  expect(Array.from(keyerPixels(image, node)).filter((_, i) => i % 4 === 3)).toEqual([0, 128, 0]);
  expect(Array.from(keyerPixels(image, { ...node, invert: true, view: 'matte' }))).toEqual([
    255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0,
  ]);
  const luma = { ...node, mode: 'luma' as const, threshold: 0.25, softness: 0.5 },
    gray = new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 128, 255, 255, 255, 255]);
  const keyed = keyerPixels(gray, luma);
  expect(keyed[3]).toBe(0);
  expect(keyed[7]).toBeGreaterThan(63);
  expect(keyed[7]).toBeLessThan(66);
  expect(keyed[11]).toBe(255);
  const spill = keyerPixels(new Uint8ClampedArray([100, 200, 120, 200]), {
    ...node,
    threshold: 0,
    softness: 0,
    spill: 1,
  });
  expect(spill[1]).toBe(120);
  expect(spill[3]).toBe(200);
});
it('renders keyed generated media identically with tiling/regions and keeps matrix errors and eager input failures visible', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Key and grade',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'key', type: 'keyer', input: 'src', threshold: 0.06, softness: 0.1, spill: 0.7 },
      {
        id: 'grade',
        type: 'colorMatrix',
        input: 'key',
        matrix: [0.7, 0.1, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
      },
    ],
    output: 'grade',
  });
  snapshot.scenes[0].nodes = [
    newNode({ id: 'group', type: 'group', width: 320, height: 180, effects: [effectGraph(graph)] }),
    newNode({
      id: 'green',
      type: 'rect',
      parentId: 'group',
      width: 320,
      height: 180,
      fill: '#00ff00',
    }),
    newNode({
      id: 'subject',
      type: 'ellipse',
      parentId: 'group',
      x: 100,
      y: 50,
      width: 60,
      height: 50,
      fill: '#cc669980',
    }),
  ];
  const image = await paired();
  expect(bytes(image, 0, 0)[3]).toBe(0);
  expect(bytes(image, 125, 70)[3]).toBeGreaterThan(0);
  const bad = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Singular',
      nodes: [
        { id: 'src', type: 'solid', color: '#ff0000', space: 'canvas' },
        { id: 'out', type: 'transform', input: 'src' },
      ],
      output: 'out',
    }),
    compiled = compileEffectGraph(bad),
    makeSurface = () => {
      const canvas = createCanvas(16, 16);
      return {
        canvas,
        ctx: canvas.getContext('2d'),
        release: () => {
          canvas.width = 1;
          canvas.height = 1;
        },
      };
    },
    env = {
      makeSurface,
      input: async () => makeSurface(),
      scale: 1,
      matrix: [0, 0, 0, 1, 0, 0],
      canvasMatrix: [1, 0, 0, 1, 0, 0],
      bounds: { x: 0, y: 0, width: 16, height: 16 },
      frame: 0,
      fps: 30,
      optimize: true,
    };
  await expect(renderEffectGraph(compiled, env as any)).rejects.toMatchObject({
    code: 'EFFECT_GRAPH_MATRIX',
  });
  const missing = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Eager',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'bad', type: 'input', slot: 'missing' },
      { id: 'out', type: 'blend', background: 'src', foreground: 'bad', opacity: 0 },
    ],
    output: 'out',
  });
  await expect(
    renderEffectGraph(compileEffectGraph(missing), {
      ...env,
      matrix: [1, 0, 0, 1, 0, 0],
      input: async (slot: string) => {
        if (slot === 'missing') throw new Error('missing source');
        return makeSurface();
      },
    } as any),
  ).rejects.toThrow(/missing source/);
});
it('streams full UHD channel recombination under a strict scratch budget without reducing dimensions', () => {
  const width = 3840,
    height = 2160,
    canvases = Array.from({ length: 5 }, () => createCanvas(width, height)),
    surfaces = canvases.map((canvas) => ({
      canvas,
      ctx: canvas.getContext('2d'),
      release: () => {},
    })),
    colors = ['#fa0a14', '#112233', '#123456', '#01010180'];
  colors.forEach((color, i) => {
    surfaces[i].ctx.fillStyle = color;
    surfaces[i].ctx.fillRect(0, 0, width, height);
  });
  const node = effectGraphNodeSchema.parse({
    id: 'out',
    type: 'channels',
    red: { input: 'r', channel: 'red' },
    green: { input: 'g', channel: 'green' },
    blue: { input: 'b', channel: 'blue' },
    alpha: { input: 'a', channel: 'alpha' },
  });
  if (node.type !== 'channels') throw new Error('Expected channels');
  const inputs = new Map(['r', 'g', 'b', 'a'].map((id, i) => [id, surfaces[i]]));
  let live = 0,
    peak = 0,
    work = 0;
  const reserveScratch = (bytes: number) => {
    if (bytes > 16 * 1024 * 1024) throw new Error('scratch budget');
    live += bytes;
    peak = Math.max(peak, live);
    return () => {
      live -= bytes;
    };
  };
  try {
    expect(() =>
      graphPointPass(node, inputs, surfaces[4], { regions: false, tileRows: 0, reserveScratch }),
    ).toThrow(/scratch budget/);
    graphPointPass(node, inputs, surfaces[4], {
      regions: false,
      tileRows: 64,
      reserveScratch,
      evaluatedPixels: (p) => {
        work += p;
      },
    });
    expect(work).toBe(width * height);
    expect(live).toBe(0);
    expect(peak).toBeLessThan(16 * 1024 * 1024);
    expect(surfaces[4].canvas.width).toBe(3840);
    expect(surfaces[4].canvas.height).toBe(2160);
    const ref = createCanvas(1, 1),
      rgba = new Uint8ClampedArray([250, 34, 86, 128]);
    ref.getContext('2d').putImageData(new ImageData(rgba, 1, 1), 0, 0);
    const expected = Array.from(ref.getContext('2d').getImageData(0, 0, 1, 1).data);
    for (const y of [0, 63, 64, 2112, 2159])
      expect(Array.from(surfaces[4].ctx.getImageData(width - 1, y, 1, 1).data)).toEqual(expected);
  } finally {
    canvases.forEach((canvas) => {
      canvas.width = 1;
      canvas.height = 1;
    });
  }
});
