import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
import { GraphExecution } from '../src/core/graph-execution.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-compare-'));
  await initProject(root, 'compare', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('compares pinned native frames with short locators, exact equivalence, true reduced work and no mutation', async () => {
  const graph = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'Many identity passes',
    nodes: [
      { id: 'src', type: 'input' },
      ...Array.from({ length: 25 }, (_, i) => ({
        id: 'step' + i,
        type: 'transform' as const,
        input: i ? 'step' + (i - 1) : 'src',
        space: 'canvas' as const,
      })),
      {
        id: 'grade',
        type: 'colorMatrix',
        input: 'step24',
        matrix: [0.8, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 1, 0],
      },
    ],
    output: 'grade',
  });
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'card',
        type: 'rect',
        x: 25,
        y: 20,
        width: 60,
        height: 50,
        fill: '#5588ff',
        brightness: 0.9,
        shadow: { color: '#000000', blur: 2, x: 1, y: 1 },
        effects: [{ id: 'graph', type: 'effectGraph', graph, params: {}, bindings: {} }],
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    result = await app.dispatch('renderCompare', {
      revision,
      sceneId: 'intro',
      frames: [0, 30, 12],
      repeat: 2,
      width: 320,
      height: 180,
    });
  expect(result.equivalence).toMatchObject({ matched: true, mismatches: 0, compared: 6 });
  expect(result.optimized.graph.passthroughs).toBe(150);
  expect(result.optimized.graph.surfaces).toBeLessThan(result.baseline.graph.surfaces);
  expect(result.optimized.graph.scalarPixels).toBeLessThan(result.baseline.graph.scalarPixels / 10);
  expect(present(present(present(result)).optimized.graphNodes).items[0]).toMatchObject({
    ownerId: 'card',
    effectId: 'graph',
    index: 0,
  });
  expect(result.optimized.samples).toBeUndefined();
  expect(result.coverage.graphTrackingLimit).toBe(256);
  expect(app.service.snapshot.revision).toBe(revision);
  await expect(app.dispatch('renderCompare', { revision: 'stale' })).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await expect(
    app.dispatch('renderCompare', { baseline: { graphTileRows: -1 } }),
  ).rejects.toThrow();
  const reverse = await app.dispatch('renderCompare', {
    sceneId: 'intro',
    frames: [12],
    repeat: 1,
    width: 320,
    height: 180,
    order: 'optimized-first',
    detail: true,
  });
  expect(reverse.equivalence.matched).toBe(true);
  expect(reverse.baseline.samples).toHaveLength(1);
  const plan = await app.dispatch('effectGraphPlan', {
    revision,
    graph,
    targets: [{ sceneId: 'intro', nodeId: 'card', action: 'update', effectId: 'graph' }],
  });
  const candidate = await app.dispatch('renderCompare', {
    planId: plan.candidate.planId,
    sceneId: 'intro',
    frames: [12],
    repeat: 1,
    width: 320,
    height: 180,
  });
  expect(candidate.revision).toBe(plan.candidateRevision);
  expect(candidate.equivalence.matched).toBe(true);
  expect(app.service.snapshot.revision).toBe(revision);
});
it('reports stateful component nondeterminism even when corresponding paired pixels happen to match', async () => {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/state.ts',
      content:
        "import{defineComponent,node}from'@vmotion/sdk';let count=0;export default defineComponent({name:'State',parameters:{},render(){return[node({id:'r',type:'rect',x:count++*5,width:30,height:30})]}});",
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'code',
        type: 'component',
        component: 'components/state.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const result = await app.dispatch('renderCompare', {
    frames: [0],
    repeat: 2,
    width: 320,
    height: 180,
  });
  expect(result.equivalence.matched).toBe(false);
  expect(result.baseline.determinism.mismatchFrames).toEqual([0]);
});
it('detects media mutations during comparison while leaving project version/history intact', async () => {
  const image = createCanvas(4, 4);
  await writeFile(path.join(root, 'unused.png'), await image.encode('png'));
  await app.service.transact([
    {
      type: 'addAsset',
      asset: {
        id: 'external',
        type: 'image',
        name: 'image',
        path: 'unused.png',
        managed: false,
        metadata: {},
      },
    },
    {
      type: 'writeSource',
      path: 'components/change.ts',
      content:
        "import{defineComponent,node}from'@vmotion/sdk';import{appendFileSync}from'node:fs';export default defineComponent({name:'Change',parameters:{},render(){appendFileSync(" +
        JSON.stringify(path.join(root, 'unused.png')) +
        ",'x');return[node({id:'r',type:'rect',width:30,height:30})]}});",
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'code',
        type: 'component',
        component: 'components/change.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('renderCompare', { frames: [0], repeat: 1, width: 320, height: 180 }),
  ).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
  expect(app.service.snapshot.revision).toBe(revision);
});
it('bounds trace storage and marks varying execution kinds and omitted executions explicitly', () => {
  const trace = new GraphExecution(true, 2),
    owner = { ownerId: 'code/card', index: 0, output: 'out', graph: 'graph' };
  const event = (nodeId: string, kind: 'surface' | 'passthrough') => ({
    nodeId,
    type: 'transform',
    kind,
    surfacePixels: kind === 'surface' ? 100 : 0,
    readbackPixels: 0,
    scalarPixels: 0,
    elapsedMs: 0.2,
  });
  trace.add(event('a', 'surface'), owner);
  trace.add(event('a', 'passthrough'), owner);
  trace.add(event('b', 'surface'), owner);
  trace.add(event('c', 'surface'), owner);
  expect(trace.detail(1)).toMatchObject({
    trackedNodes: 2,
    maxNodes: 2,
    omittedExecutions: 1,
    returned: 1,
    omitted: 1,
  });
  expect(trace.detail(2).items[0]).toMatchObject({
    nodeId: 'a',
    kind: 'mixed',
    executions: 2,
    surfaces: 1,
    passthroughs: 1,
  });
  expect(trace.report().executions).toBe(4);
});
