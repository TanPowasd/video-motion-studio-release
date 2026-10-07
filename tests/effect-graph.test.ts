import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newNode, type Snapshot } from '../src/core/model.js';
import { defineEffectGraph, compileEffectGraph } from '../src/core/effect-graph.js';
import { effectGraph, levels } from '../src/sdk/post.js';
import { Renderer } from '../src/core/renderer.js';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { renderEffectGraph } from '../src/core/effect-graph-render.js';
import { createCanvas } from '@napi-rs/canvas';
let root: string, snapshot: Snapshot, renderer: Renderer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-effect-graph-'));
  await initProject(root, 'graph', { template: 'blank', width: 160, height: 90 });
  snapshot = await loadProject(root);
  snapshot.scenes[0].background = 'transparent';
  renderer = new Renderer(root);
});
afterEach(async () => {
  await renderer.close();
  await rm(root, { recursive: true, force: true });
});
const render = async (frame = 0) =>
  (await renderer.render(snapshot, frame, { sceneId: 'intro' }))
    .getContext('2d')
    .getImageData(0, 0, 160, 90).data;
const pixel = (data: Uint8ClampedArray, x: number, y = 25) =>
  Array.from(data.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
const source = () =>
  newNode({ id: 'box', type: 'rect', x: 20, y: 20, width: 20, height: 20, fill: '#ff0000' });
it('branches one source into translated/tinted compositing with alpha and exact source identity', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'branch',
    nodes: [
      { id: 'source', type: 'input' },
      { id: 'shift', type: 'transform', input: 'source', matrix: [1, 0, 0, 1, 30, 0] },
      { id: 'result', type: 'blend', background: 'source', foreground: 'shift', opacity: 0.5 },
    ],
    output: 'result',
  });
  snapshot.scenes[0].nodes = [{ ...source(), effects: [effectGraph(graph)] }];
  const data = await render();
  expect(pixel(data, 25)).toEqual([255, 0, 0, 255]);
  expect(pixel(data, 55)[3]).toBeCloseTo(128, 0);
  const identity = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'identity',
    nodes: [{ id: 'src', type: 'input' }],
    output: 'src',
  });
  snapshot.scenes[0].nodes[0].effects = [];
  const plain = await render();
  snapshot.scenes[0].nodes[0].effects = [effectGraph(identity)];
  expect(await render()).toEqual(plain);
});
it('uses named sibling layers as mask inputs and rejects cycles/missing/wrong-parent inputs', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'mask',
    nodes: [
      { id: 'source', type: 'input' },
      { id: 'matte', type: 'input', slot: 'matte' },
      { id: 'out', type: 'mask', input: 'source', matte: 'matte' },
    ],
    output: 'out',
  });
  snapshot.scenes[0].nodes = [
    { ...source(), effects: [effectGraph(graph, {}, { matte: 'matte' })] },
    newNode({ id: 'matte', type: 'rect', x: 30, y: 0, width: 50, height: 90, fill: '#fff' }),
  ];
  // Hide the matte from ordinary display by making it a mask source for an invisible carrier.
  snapshot.scenes[0].nodes.push(
    newNode({ id: 'carrier', type: 'rect', opacity: 0, maskId: 'matte' }),
  );
  const result = await render();
  expect(pixel(result, 25)[3]).toBe(0);
  expect(pixel(result, 35)).toEqual([255, 0, 0, 255]);
  snapshot.scenes[0].nodes[0].effects = [effectGraph(graph, {}, { matte: 'box' })];
  await expect(render()).rejects.toMatchObject({ code: 'EFFECT_GRAPH_CYCLE' });
  snapshot.scenes[0].nodes[0].effects = [effectGraph(graph, {}, { matte: 'missing' })];
  await expect(render()).rejects.toMatchObject({ code: 'EFFECT_GRAPH_LAYER' });
  snapshot.scenes[0].nodes[0].effects = [];
  expect(pixel(await render(), 25)).toEqual([255, 0, 0, 255]);
});
it('resolves parameter links and nested resources, with explicit DAG/resource-cycle diagnostics', async () => {
  const child = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'offset',
    parameters: { distance: { type: 'number', default: 10, min: 0, max: 100 } },
    nodes: [
      { id: 'source', type: 'input' },
      { id: 'move', type: 'transform', input: 'source' },
    ],
    links: [{ nodeId: 'move', property: 'matrix.4', parameter: 'distance' }],
    output: 'move',
  });
  const rootGraph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'nested',
    nodes: [
      { id: 'src', type: 'input' },
      {
        id: 'child',
        type: 'subgraph',
        source: 'components/effects/child.json',
        inputs: { source: 'src' },
        params: { distance: 30 },
      },
      { id: 'out', type: 'blend', background: 'src', foreground: 'child' },
    ],
    output: 'out',
  });
  snapshot.files['components/effects/child.json'] = JSON.stringify(child);
  snapshot.scenes[0].nodes = [{ ...source(), effects: [effectGraph(rootGraph)] }];
  expect(pixel(await render(), 55)).toEqual([255, 0, 0, 255]);
  expect(compileEffectGraph(rootGraph, {}, () => child).resources).toEqual([
    'components/effects/child.json',
  ]);
  expect(() =>
    defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'cycle',
      nodes: [
        { id: 'a', type: 'transform', input: 'b' },
        { id: 'b', type: 'transform', input: 'a' },
      ],
      output: 'a',
    }),
  ).toThrow('cycle');
  expect(() =>
    compileEffectGraph(rootGraph, {}, () => ({ ...rootGraph, parameters: child.parameters })),
  ).toThrow('cycle');
});
it('shares raster pass results with the ordered stack and samples displacement with transparent neutral maps', async () => {
  const pass = levels({ gamma: 0.7 }),
    graph = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'pass',
      nodes: [
        { id: 'src', type: 'input' },
        { id: 'pass', type: 'pass', input: 'src', effect: pass },
      ],
      output: 'pass',
    });
  const node = source();
  node.fill = '#668899';
  node.effects = [pass];
  snapshot.scenes[0].nodes = [node];
  const plain = await render();
  node.effects = [effectGraph(graph)];
  expect(await render()).toEqual(plain);
  const displacement = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'disp',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'map', type: 'solid', color: '#ffffff', opacity: 0 },
      { id: 'warp', type: 'displace', input: 'src', map: 'map', amountX: 15, amountY: 10 },
    ],
    output: 'warp',
  });
  node.effects = [];
  const baseline = await render();
  node.effects = [effectGraph(displacement)];
  expect(await render()).toEqual(baseline);
});
it('regenerates graph resources during deterministic seeking and resolves relative generated sibling bindings', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'noise',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'noise', type: 'noise', scale: 12, evolution: 0.3 },
      { id: 'mask', type: 'mask', input: 'noise', matte: 'src' },
    ],
    output: 'mask',
  });
  snapshot.files['components/inside.ts'] =
    "import {defineComponent,node,effectGraph} from '@vmotion/sdk';const graph={kind:'effect-graph',version:1,name:'mask',nodes:[{id:'src',type:'input'},{id:'mask',type:'input',slot:'mask'},{id:'result',type:'mask',input:'src',matte:'mask'}],output:'result'} as const;export default defineComponent({name:'scope',parameters:{},render(ctx){return [node({id:'base',type:'rect',x:20,y:20,width:20,height:20,fill:'#ff0000',effects:[effectGraph(graph,{}, {mask:'matte'})]}),node({id:'matte',type:'rect',x:30,y:20,width:20,height:20}),node({id:'carrier',type:'rect',opacity:0,maskId:'matte'})]}});";
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'outer',
      type: 'component',
      component: 'components/inside.ts',
      width: 160,
      height: 90,
    }),
  ];
  expect(pixel(await render(), 25)[3]).toBe(0);
  expect(pixel(await render(), 35)[3]).toBe(255);
  snapshot.scenes[0].nodes = [{ ...source(), effects: [effectGraph(graph)] }];
  const result = await render(30);
  await render(0);
  expect(await render(30)).toEqual(result);
});
it('converts transforms through rotated layer coordinates and applies nonneutral map displacement without color fringes', async () => {
  const translated = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'local transform',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'out', type: 'transform', input: 'src', matrix: [1, 0, 0, 1, 20, 0] },
    ],
    output: 'out',
  });
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'rotated',
      type: 'rect',
      x: 60,
      y: 20,
      width: 20,
      height: 10,
      rotation: 90,
      fill: '#ff0000',
      effects: [effectGraph(translated)],
    }),
  ];
  const result = await render();
  expect(pixel(result, 55, 45)).toEqual([255, 0, 0, 255]);
  expect(pixel(result, 55, 25)[3]).toBe(0);
  const warp = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'field',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'map', type: 'solid', color: '#ffffff', space: 'canvas' },
      { id: 'warp', type: 'displace', input: 'src', map: 'map', amountX: 10, amountY: 0 },
    ],
    output: 'warp',
  });
  snapshot.scenes[0].nodes = [{ ...source(), opacity: 0.5, effects: [effectGraph(warp)] }];
  const warped = await render();
  expect(pixel(warped, 15).slice(0, 3)).toEqual([255, 0, 0]);
  expect(pixel(warped, 15)[3]).toBeCloseTo(128, 0);
  expect(pixel(warped, 35)[3]).toBe(0);
});
it('releases shared branch surfaces after a budget failure and passes parameters into nested defaults', async () => {
  const child = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'child',
    parameters: { distance: { type: 'number', default: 5 } },
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'out', type: 'transform', input: 'src' },
    ],
    links: [{ nodeId: 'out', property: 'matrix.4', parameter: 'distance' }],
    output: 'out',
  });
  const definition = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'links',
      parameters: { delta: { type: 'number', default: 25 } },
      nodes: [
        { id: 'src', type: 'input' },
        {
          id: 'child',
          type: 'subgraph',
          source: 'components/effects/child.json',
          inputs: { source: 'src' },
        },
        { id: 'out', type: 'blend', foreground: 'child', background: 'src' },
      ],
      links: [{ nodeId: 'child', property: 'params.distance', parameter: 'delta' }],
      output: 'out',
    }),
    compiled = compileEffectGraph(definition, {}, () => child);
  expect((compiled.nodes.find((node) => node.id === 'child/out') as any).matrix[4]).toBe(25);
  let live = 0,
    count = 0;
  const makeSurface = () => {
    const canvas = createCanvas(16, 16);
    live++;
    let released = false;
    return {
      canvas,
      ctx: canvas.getContext('2d'),
      release: () => {
        if (!released) {
          released = true;
          live--;
          canvas.width = 1;
          canvas.height = 1;
        }
      },
    };
  };
  const env = {
    makeSurface,
    frame: 0,
    fps: 30,
    scale: 1,
    matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    canvasMatrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    bounds: { x: 0, y: 0, width: 16, height: 16 },
    input: async () => makeSurface(),
    charge: () => {
      if (++count > 3) throw new Error('work budget');
    },
  };
  await expect(renderEffectGraph(compiled, env)).rejects.toThrow('work budget');
  expect(live).toBe(0);
  const result = await renderEffectGraph(compiled, { ...env, charge: undefined });
  expect(live).toBe(1);
  result.release();
  expect(live).toBe(0);
});
it('supports a fully collapsed entrance pose through local graph transforms and generators', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'collapsed',
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'noise', type: 'noise' },
      { id: 'offset', type: 'transform', input: 'src', matrix: [1, 0, 0, 1, 5, 0] },
      { id: 'out', type: 'blend', foreground: 'offset', background: 'noise' },
    ],
    output: 'out',
  });
  snapshot.scenes[0].nodes = [{ ...source(), scaleX: 0, scaleY: 0, effects: [effectGraph(graph)] }];
  expect((await render()).every((value) => value === 0)).toBe(true);
});
it('links colors, enums and booleans through typed fields and protects graph topology', async () => {
  const graph = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'typed',
      parameters: {
        tint: { type: 'color', default: '#00ff00' },
        mode: { type: 'enum', options: ['screen', 'multiply'], default: 'screen' },
        mono: { type: 'boolean', default: true },
      },
      nodes: [
        { id: 'src', type: 'input' },
        { id: 'solid', type: 'solid', color: '#ffffff' },
        {
          id: 'grain',
          type: 'pass',
          input: 'src',
          effect: { type: 'grain', amount: 0, monochrome: true },
        },
        { id: 'out', type: 'blend', foreground: 'solid', background: 'grain' },
      ],
      links: [
        { nodeId: 'solid', property: 'color', parameter: 'tint' },
        { nodeId: 'out', property: 'mode', parameter: 'mode' },
        { nodeId: 'grain', property: 'effect.monochrome', parameter: 'mono' },
      ],
      output: 'out',
    }),
    compiled = compileEffectGraph(graph, { tint: '#0000ff', mode: 'multiply', mono: false });
  expect((compiled.nodes.find((node) => node.id === 'solid') as any).color).toBe('#0000ff');
  expect((compiled.nodes.find((node) => node.id === 'grain') as any).effect.monochrome).toBe(false);
  const bad = structuredClone(graph);
  bad.links = [{ ...bad.links[0], property: 'id' }];
  expect(() => compileEffectGraph(bad)).toThrow('topology');
});
