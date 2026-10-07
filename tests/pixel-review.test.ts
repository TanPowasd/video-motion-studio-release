import { present, field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { storeAgentPlan } from '../src/service/agent-plans.js';
import { newNode, sceneSchema } from '../src/core/model.js';
import { applyOperations } from '../src/service/operations.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-pixel-review-'));
  await initProject(root, 'pixels', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const scene = (nodes: ReturnType<typeof newNode>[], background = '#000000') =>
  app.service.transact([{ type: 'updateScene', sceneId: 'intro', patch: { nodes, background } }]);
it('scopes native scene/sequence pixels with compact summaries and explicit distribution opt-in', async () => {
  await scene([
    newNode({ id: 'red', type: 'rect', width: 160, height: 180, fill: '#ff0000' }),
    newNode({ id: 'blue', type: 'rect', x: 160, width: 160, height: 180, fill: '#0000ff' }),
  ]);
  const state = app.service.state(),
    revision = state.snapshot.revision;
  const compact = await app.dispatch('colorScopes', {
    scope: { sceneId: 'intro' },
    frames: [30, 0],
    width: 320,
    images: false,
  });
  expect(field(compact, 'samples')[0].summary.channels.map((c: any) => c.mean)).toEqual([
    0.5,
    0,
    0.5,
    expect.closeTo(0.1424, 5),
  ]);
  expect(field(compact, 'samples')[0].histogram).toBeUndefined();
  const full = await app.dispatch('colorScopes', {
    scope: { sequenceId: 'main' },
    width: 320,
    images: false,
    includeDistributions: true,
  });
  expect(field(full, 'samples')[0].pixelHash).toBe(field(compact, 'samples')[0].pixelHash);
  expect(present(present(field(full, 'samples'))[0].waveform).channels[0].counts).toHaveLength(
    64 * 32,
  );
  expect(Buffer.byteLength(JSON.stringify(compact)) / 2).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) / 4,
  );
  const roi = await app.dispatch('colorScopes', {
    scope: { sceneId: 'intro' },
    width: 320,
    images: false,
    region: { x: 160, y: 0, width: 160, height: 180 },
    analysis: 'sampled',
    maxSamples: 256,
  });
  expect(field(roi, 'samples')[0].summary.channels[2].mean).toBe(1);
  expect(field(roi, 'samples')[0].coverage.fullPixelCoverage).toBe(false);
  expect(app.service.state()).toMatchObject({
    snapshot: { revision },
    canUndo: state.canUndo,
    canRedo: state.canRedo,
  });
});
it('returns native scope images for focused content at its true dimensions', async () => {
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'square',
        name: 'Square',
        duration: 60,
        width: 100,
        height: 100,
        background: '#ff0000',
        nodes: [],
      }),
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'nested', type: 'scene', sceneId: 'square', width: 100, height: 100 },
    },
  ]);
  const result = await app.dispatch('colorScopes', {
    scope: { sceneId: 'intro', path: ['nested'], contextFrames: [0] },
    width: 160,
    inline: true,
  });
  expect(result.samples[0]).toMatchObject({ width: 160, height: 160 });
  expect(present(present(present(result)).data).length).toBeGreaterThan(100);
  expect((await readFile(present(result.output))).subarray(1, 4).toString()).toBe('PNG');
});
it('compares a stored source candidate before applying, then preserves exact pixels and one undo', async () => {
  const source =
    "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Color',parameters:{},render(){return[node({id:'r',type:'rect',x:20,y:20,width:60,height:40,fill:'#ff0000'})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/color.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'code',
        type: 'component',
        component: 'components/color.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    input = {
      revision,
      operations: [
        {
          type: 'writeSource',
          path: 'components/color.ts',
          content: source.replace('#ff0000', '#0000ff'),
        },
      ],
    },
    stored = await storeAgentPlan(root, input),
    candidate = applyOperations(root, app.service.snapshot, input.operations as any);
  const compared = await app.dispatch('frameCompare', {
    revision,
    planId: stored.planId,
    scope: { sceneId: 'intro' },
    frames: [30, 0],
    width: 320,
    inline: true,
  });
  expect(compared.revision).toBe(candidate.revision);
  expect(compared.samples[0]).toMatchObject({
    changedPixels: 2400,
    changedBounds: { x: 20, y: 20, width: 60, height: 40 },
    determinism: { checked: true, before: true, after: true },
    result: 'changes-composite',
  });
  expect(present(present(present(compared)).data).length).toBeGreaterThan(100);
  expect(app.service.snapshot.revision).toBe(revision);
  expect(await readFile(path.join(root, 'components/color.ts'), 'utf8')).toBe(source);
  const scopes = await app.dispatch('colorScopes', {
    planId: stored.planId,
    width: 320,
    images: false,
  });
  expect(scopes.revision).toBe(candidate.revision);
  await app.dispatch('projectApply', {
    planId: stored.planId,
    expectedCandidateRevision: candidate.revision,
  });
  const applied = await app.dispatch('frameCompare', {
    scope: { sceneId: 'intro' },
    frames: [30],
    width: 320,
    images: false,
  });
  expect(field(applied, 'samples')[0].beforeHash).toBe(field(compared, 'samples')[0].afterHash);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
  await expect(
    app.dispatch('frameCompare', { planId: stored.planId, compareFrames: [0, 1], images: false }),
  ).rejects.toMatchObject({ code: 'REVIEW_FRAMES' });
});
it('supports intentional time/scope comparison and rejects aspect mismatch without explicit dimensions', async () => {
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'square',
        name: 'Square',
        duration: 60,
        width: 180,
        height: 180,
        background: '#ff0000',
        nodes: [],
      }),
    },
  ]);
  await expect(
    app.dispatch('frameCompare', {
      scope: { sceneId: 'intro' },
      compareScope: { sceneId: 'square' },
      width: 160,
      images: false,
    }),
  ).rejects.toMatchObject({ code: 'REVIEW_DIMENSIONS' });
  const result = await app.dispatch('frameCompare', {
    scope: { sceneId: 'intro' },
    compareScope: { sceneId: 'square' },
    frames: [30],
    compareFrames: [10],
    width: 160,
    height: 90,
    images: false,
  });
  expect(result.samples[0]).toMatchObject({ frame: 30, compareFrame: 10, changedRatio: 1 });
});
it('reports repeated-frame statefulness as inconclusive and makes unchecked determinism explicit', async () => {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/state.ts',
      content:
        "import{defineComponent,node}from'@vmotion/sdk';let n=0;export default defineComponent({name:'State',parameters:{},render(){return[node({id:'r',type:'rect',x:n++*5,width:20,height:20,fill:'#ff0000'})]}});",
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
  const compare = await app.dispatch('frameCompare', { width: 160, images: false });
  expect(compare.summary.nondeterministicFrames).toBe(1);
  expect(field(compare, 'samples')[0].result).toBe('inconclusive');
  const impact = await app.dispatch('layerImpact', {
    sceneId: 'intro',
    nodeIds: ['code/r'],
    width: 160,
    images: false,
  });
  expect(field(impact, 'samples')[0].result).toBe('inconclusive');
  const unchecked = await app.dispatch('frameCompare', {
    width: 160,
    images: false,
    determinism: false,
  });
  expect(field(unchecked, 'samples')[0].determinism).toEqual({
    checked: false,
    before: undefined,
    after: undefined,
  });
});
it('measures composite impact through occlusion, clipping, masks and transparent/offscreen layers', async () => {
  await scene([
    newNode({ id: 'covered', type: 'rect', x: 10, y: 10, width: 40, height: 40, fill: '#ff0000' }),
    newNode({ id: 'cover', type: 'rect', x: 10, y: 10, width: 40, height: 40, fill: '#0000ff' }),
    newNode({ id: 'offscreen', type: 'rect', x: 500, width: 40, height: 40, fill: '#ff0000' }),
    newNode({ id: 'transparent', type: 'rect', y: 80, width: 40, height: 40, opacity: 0 }),
    newNode({ id: 'mask', type: 'rect', x: 80, y: 10, width: 20, height: 40, fill: '#ffffff' }),
    newNode({
      id: 'masked',
      type: 'rect',
      maskId: 'mask',
      x: 80,
      y: 10,
      width: 40,
      height: 40,
      fill: '#ff0000',
    }),
    newNode({
      id: 'clipped',
      type: 'rect',
      x: 140,
      y: 10,
      width: 40,
      height: 40,
      clip: { x: 0, y: 0, width: 10, height: 40 },
      fill: '#ff0000',
    }),
  ]);
  const files = structuredClone(app.service.snapshot.files),
    state = app.service.state();
  const result = await app.dispatch('layerImpact', {
    sceneId: 'intro',
    nodeIds: ['covered', 'cover', 'offscreen', 'transparent', 'masked', 'mask', 'clipped'],
    width: 320,
    inline: true,
    maxImages: 2,
  });
  expect(result.samples.map((s: any) => s.changedPixels)).toEqual([0, 1600, 0, 0, 800, 800, 400]);
  expect(
    present(present(field(result, 'samples')).find((s: any) => s.nodeId === 'mask'))
      .dependencySensitive,
  ).toBe(true);
  expect(result.coverage).toMatchObject({ sampledPairs: 7, evidenceImages: 2, omittedImages: 5 });
  expect(result.limitations[0]).toContain('visible:false');
  expect(app.service.snapshot.files).toEqual(files);
  expect(app.service.state()).toMatchObject({
    snapshot: { revision: state.snapshot.revision },
    canUndo: state.canUndo,
    canRedo: state.canRedo,
  });
});
it('finds retimed generated child locators and measures the complete root scene instead of isolated bounds', async () => {
  const source =
    "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Clock',parameters:{},render(ctx){return[node({id:'g',type:'group',width:120,height:80}),node({id:'r',type:'rect',parentId:'g',x:ctx.frame,y:8,width:30,height:20,fill:'#ff0000'})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/clock.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'code',
        type: 'component',
        component: 'components/clock.ts',
        x: 60,
        y: 40,
        width: 120,
        height: 80,
        timeMapping: {
          mode: 'remap',
          frame: 12,
          anchor: 0,
          offset: 0,
          rate: 1,
          repeat: 'continue',
        },
      },
    },
  ]);
  const revision = app.service.snapshot.revision;
  const result = await app.dispatch('layerImpact', {
    sceneId: 'intro',
    nodeIds: ['code/r', 'code/g'],
    frames: [30, 0],
    width: 320,
    images: false,
  });
  expect(field(result, 'samples')[0].locator).toMatchObject({
    sceneId: 'intro',
    nodeId: 'code/r',
    frame: 12,
  });
  expect(field(result, 'samples')[0].locator.path).toContain('code');
  expect(field(result, 'samples')[0].locator.contextFrames[0]).toBe(30);
  expect(field(result, 'samples')[0].changedPixels).toBeGreaterThan(0);
  expect(present(present(field(result, 'samples'))[0].changedBounds).x).toBeGreaterThanOrEqual(60);
  expect(field(result, 'samples')[0].changedPixels).toBe(field(result, 'samples')[2].changedPixels);
  expect(app.service.snapshot.revision).toBe(revision);
  expect(await readFile(path.join(root, 'components/clock.ts'), 'utf8')).toBe(source);
});
it('supports exact candidate impact while stale/invalid/budget requests leave project and history intact', async () => {
  await scene([newNode({ id: 'r', type: 'rect', width: 40, height: 40, fill: '#ff0000' })]);
  const revision = app.service.snapshot.revision,
    stored = await storeAgentPlan(root, {
      revision,
      operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'r', patch: { x: 100 } }],
    });
  const result = await app.dispatch('layerImpact', {
    revision,
    planId: stored.planId,
    sceneId: 'intro',
    nodeIds: ['r'],
    width: 320,
    images: false,
  });
  expect(present(present(field(result, 'samples'))[0].changedBounds).x).toBe(100);
  for (const method of ['colorScopes', 'frameCompare', 'layerImpact'])
    await expect(
      app.dispatch(method, { revision: 'old', sceneId: 'intro', nodeIds: ['r'] }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    app.dispatch('layerImpact', { sceneId: 'intro', nodeIds: ['r', 'r'], images: false }),
  ).rejects.toMatchObject({ code: 'IMPACT_SELECTION' });
  await expect(
    app.dispatch('layerImpact', { sceneId: 'intro', nodeIds: ['missing'], images: false }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    app.dispatch('layerImpact', {
      sceneId: 'intro',
      nodeIds: ['r'],
      frames: Array(8).fill(0),
      width: 3840,
      height: 2160,
      images: false,
    }),
  ).rejects.toMatchObject({ code: 'IMPACT_BUDGET' });
  for (const scope of [
    { sceneId: 'intro', sequenceId: 'main' },
    { path: ['x'] },
    { sceneId: 'intro', contextFrames: [0] },
  ])
    await expect(app.dispatch('colorScopes', { scope, images: false })).rejects.toMatchObject({
      code: 'REVIEW_SCOPE',
    });
  await expect(app.dispatch('colorScopes', { frames: [60], images: false })).rejects.toMatchObject({
    code: 'FRAME_RANGE',
  });
  await expect(
    app.dispatch('frameCompare', {
      region: { x: 4000, y: 0, width: 10, height: 10 },
      images: false,
    }),
  ).rejects.toMatchObject({ code: 'PIXEL_REGION' });
  await app.service.transact([
    { type: 'updateNode', sceneId: 'intro', nodeId: 'r', patch: { x: 10 } },
  ]);
  const changed = app.service.snapshot.revision;
  await expect(
    app.dispatch('frameCompare', { planId: stored.planId, images: false }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(app.service.snapshot.revision).toBe(changed);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('pins both frame comparison resolutions to one live project base even during concurrent editing', async () => {
  const original = (app as any).candidateSnapshot.bind(app);
  let calls = 0;
  vi.spyOn(app as any, 'candidateSnapshot').mockImplementation(async (params: any) => {
    const snapshot = await original(params);
    if (++calls === 1)
      await app.service.transact([{ type: 'updateProject', patch: { name: 'concurrent edit' } }]);
    return snapshot;
  });
  await expect(app.dispatch('frameCompare', { images: false })).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(app.service.snapshot.project.name).toBe('concurrent edit');
});
it.each(['colorScopes', 'frameCompare', 'layerImpact'])(
  'detects media mutation during %s without saving review edits',
  async (method) => {
    const image = createCanvas(4, 4);
    await writeFile(path.join(root, 'external.png'), await image.encode('png'));
    await app.service.transact([
      {
        type: 'addAsset',
        asset: {
          id: 'external',
          name: 'external',
          type: 'image',
          path: 'external.png',
          managed: false,
          metadata: {},
        },
      },
      {
        type: 'writeSource',
        path: 'components/change.ts',
        content:
          "import{defineComponent,node}from'@vmotion/sdk';import{appendFileSync}from'node:fs';export default defineComponent({name:'Change',parameters:{},render(){appendFileSync(" +
          JSON.stringify(path.join(root, 'external.png')) +
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
    const scope =
      method === 'layerImpact'
        ? { sceneId: 'intro', nodeIds: ['code/r'] }
        : { scope: { sceneId: 'intro' } };
    await expect(
      app.dispatch(method, { ...scope, width: 160, images: false }),
    ).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
    expect(app.service.snapshot.revision).toBe(revision);
  },
);
