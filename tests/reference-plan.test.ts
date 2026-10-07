import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode, sceneSchema } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-reference-plan-'));
  await initProject(root, 'swap', {
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
async function image(id: string, color: string) {
  const canvas = createCanvas(32, 32);
  canvas.getContext('2d').fillStyle = color;
  canvas.getContext('2d').fillRect(0, 0, 32, 32);
  await writeFile(path.join(root, id + '.png'), await canvas.encode('png'));
  return {
    id,
    name: id,
    type: 'image' as const,
    path: id + '.png',
    managed: false,
    metadata: { width: 32, height: 32 },
  };
}
it('selectively replaces declared media across native layers/overrides/timeline while preserving object IDs and source code', async () => {
  const old = await image('old', '#ff0000'),
    next = await image('next', '#0000ff'),
    source =
      "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Asset',parameters:{},render(){return[node({id:'picture',type:'image',assetId:'old',width:32,height:32})]}});";
  await app.service.transact([
    { type: 'addAsset', asset: old },
    { type: 'addAsset', asset: next },
    { type: 'writeSource', path: 'components/asset.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'direct', type: 'image', assetId: 'old', width: 32, height: 32, x: 20 }),
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/asset.ts',
            width: 320,
            height: 180,
            overrides: { picture: { assetId: 'old' } },
          }),
        ],
      },
    },
    {
      type: 'updateClip',
      sequenceId: 'main',
      trackId: 'visual',
      clipId: app.service.snapshot.sequences[0].tracks[0].clips[0].id,
      patch: { sceneId: undefined, assetId: 'old', sourceIn: 0 },
    },
  ]);
  const before = app.service.snapshot.revision,
    uses = await app.dispatch('projectReferences', {
      entity: { kind: 'asset', id: 'old' },
      detail: true,
    }),
    editable = uses.items.filter((e: any) => e.replaceable);
  expect(editable).toHaveLength(3);
  const plan = await app.dispatch('referencePlan', {
    revision: before,
    items: [
      {
        from: { kind: 'asset', id: 'old' },
        to: { kind: 'asset', id: 'next' },
        referenceIds: editable.map((e: any) => e.id),
        expectedUses: 3,
      },
    ],
  });
  expect(app.service.snapshot.revision).toBe(before);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.scenes[0].nodes[0].assetId).toBe('next');
  expect(app.service.snapshot.scenes[0].nodes[1].overrides.picture.assetId).toBe('next');
  expect(app.service.snapshot.sequences[0].tracks[0].clips[0].assetId).toBe('next');
  expect(await readFile(path.join(root, 'components/asset.ts'), 'utf8')).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.scenes[0].nodes[0].assetId).toBe('old');
});
it('rejects locked sources, stale counts, short scene windows and reference cycles before changing files', async () => {
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({ id: 'short', name: 'Short', duration: 10, nodes: [] }),
    },
  ]);
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('referencePlan', {
      revision,
      items: [{ from: { kind: 'scene', id: 'intro' }, to: { kind: 'scene', id: 'short' } }],
    }),
  ).rejects.toMatchObject({ code: 'REFERENCE_RANGE' });
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: [
          { ...app.service.snapshot.sequences[0].tracks[0], locked: true },
          app.service.snapshot.sequences[0].tracks[1],
        ],
      },
    },
  ]);
  const locked = app.service.snapshot.revision;
  await expect(
    app.dispatch('referencePlan', {
      revision: locked,
      items: [{ from: { kind: 'scene', id: 'intro' }, to: { kind: 'scene', id: 'short' } }],
    }),
  ).rejects.toMatchObject({ code: 'TRACK_LOCKED' });
  await expect(
    app.dispatch('referencePlan', {
      revision: locked,
      items: [
        {
          from: { kind: 'scene', id: 'intro' },
          to: { kind: 'scene', id: 'short' },
          expectedUses: 9,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'REFERENCE_COUNT' });
  expect(app.service.snapshot.revision).toBe(locked);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'reference', type: 'scene', sceneId: 'short', width: 320, height: 180 }),
        ],
      },
    },
  ]);
  const current = app.service.snapshot.revision;
  await expect(
    app.dispatch('referencePlan', {
      revision: current,
      items: [
        {
          from: { kind: 'scene', id: 'short' },
          to: { kind: 'scene', id: 'intro' },
          files: ['scenes/intro.json'],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(app.service.snapshot.revision).toBe(current);
});
it('uses runtime samples to reveal computed asset IDs and supplies editable generated locators without source rewriting', async () => {
  await app.service.transact([
    { type: 'addAsset', asset: await image('old', '#ff0000') },
    {
      type: 'writeSource',
      path: 'components/dynamic.ts',
      content:
        "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Dynamic',parameters:{},render(){return[node({id:'picture',type:'image',assetId:['o','ld'].join(''),width:32,height:32})]}});",
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'dynamic',
        type: 'component',
        component: 'components/dynamic.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    staticUses = await app.dispatch('projectReferences', {
      entity: { kind: 'asset', id: 'old' },
      includeHints: true,
    });
  expect(staticUses.items.filter((e: any) => e.relation === 'code-literal')).toHaveLength(0);
  const sampled = await app.dispatch('referenceSample', {
    revision,
    samples: [{ sceneId: 'intro', frame: 15 }],
    entity: { kind: 'asset', id: 'old' },
    detail: true,
  });
  expect(sampled.items[0]).toMatchObject({
    nodeId: 'dynamic/picture',
    path: ['dynamic'],
    localFrame: 15,
    editable: true,
    to: { kind: 'asset', id: 'old' },
  });
  expect(sampled.coverage.runtimeComplete).toBe(false);
  expect(app.service.snapshot.revision).toBe(revision);
});
it('rejects overlapping selected edits and changed media evidence without partial source writes', async () => {
  await app.service.transact([
    { type: 'addAsset', asset: await image('one', '#ff0000') },
    { type: 'addAsset', asset: await image('two', '#00ff00') },
    { type: 'addAsset', asset: await image('three', '#0000ff') },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'picture', type: 'image', assetId: 'one', width: 32, height: 32 },
    },
  ]);
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('referencePlan', {
      revision,
      items: [
        { from: { kind: 'asset', id: 'one' }, to: { kind: 'asset', id: 'two' } },
        { from: { kind: 'asset', id: 'one' }, to: { kind: 'asset', id: 'three' } },
      ],
    }),
  ).rejects.toMatchObject({ code: 'REFERENCE_OVERLAP' });
  const plan = await app.dispatch('referencePlan', {
    revision,
    items: [{ from: { kind: 'asset', id: 'one' }, to: { kind: 'asset', id: 'two' } }],
  });
  await image('two', '#8899aa');
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toThrow();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[0].assetId).toBe('one');
});
