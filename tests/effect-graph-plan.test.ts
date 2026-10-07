import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-effect-plan-'));
  await initProject(root, 'plan', {
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
const definition = () =>
  defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'shared branch',
    parameters: { distance: { type: 'number', default: 10, min: 0, max: 100 } },
    nodes: [
      { id: 'src', type: 'input' },
      { id: 'copy', type: 'transform', input: 'src' },
      { id: 'out', type: 'blend', background: 'src', foreground: 'copy', opacity: 0.6 },
    ],
    links: [{ nodeId: 'copy', property: 'matrix.4', parameter: 'distance' }],
    output: 'out',
  });
it('atomically stores a graph and applies independent parameter channels across native/generated scenes', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk'; export default defineComponent({name:'inside',parameters:{},render(){return [node({id:'title',type:'text',text:'生成图层',x:30,y:30,width:180,height:48,fontSize:22})]}});";
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'native',
        type: 'text',
        text: '原始图层',
        x: 30,
        y: 30,
        width: 180,
        height: 48,
        fontSize: 22,
      },
    },
    { type: 'writeSource', path: 'components/inside.ts', content: source },
    {
      type: 'addScene',
      scene: {
        id: 'other',
        name: 'Other',
        duration: 60,
        background: '#101525',
        nodes: [
          newNode({
            id: 'inside',
            type: 'component',
            component: 'components/inside.ts',
            width: 320,
            height: 180,
          }),
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    original = app.service.snapshot.files['components/inside.ts'],
    plan = await app.dispatch('effectGraphPlan', {
      revision,
      graph: definition(),
      source: 'components/effects/branch.json',
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'native',
          effectId: 'graph',
          params: { distance: 15 },
          keys: [
            {
              parameter: 'distance',
              keys: [
                { frame: 0, value: 15, easing: 'linear' },
                { frame: 59, value: 40, easing: 'linear' },
              ],
            },
          ],
        },
        { sceneId: 'other', nodeId: 'inside/title', path: ['inside'], params: { distance: 25 } },
      ],
    });
  expect(app.service.snapshot.revision).toBe(revision);
  expect(plan.layers).toHaveLength(2);
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  expect(checked.data).toBeTruthy();
  await app.dispatch('projectApply', plan.apply);
  const described = await app.dispatch('effectGraphInspect', {
    source: { sceneId: 'intro', nodeId: 'native', effectId: 'graph', frame: 29.5 },
  });
  expect(described.parameters.distance).toBeCloseTo(27.5);
  expect(described.nodes).toHaveLength(3);
  expect(app.service.snapshot.files['components/inside.ts']).toBe(original);
  await expect(
    app.service.transact([
      {
        type: 'editFiles',
        edits: [{ type: 'delete', path: plan.source, expectedHash: described.resources[0].hash }],
      },
    ]),
  ).rejects.toThrow();
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.files[plan.source]).toBeUndefined();
});
it('rejects invalid resources/parameter links before commit, protects hashes, and stores reusable subgraphs', async () => {
  const revision = app.service.snapshot.revision;
  const nested = defineEffectGraph({
    kind: 'effect-graph',
    version: 1,
    name: 'nested',
    nodes: [
      { id: 'src', type: 'input' },
      {
        id: 'child',
        type: 'subgraph',
        source: 'components/effects/shared.json',
        inputs: { source: 'src' },
      },
    ],
    output: 'child',
  });
  const plan = await app.dispatch('effectGraphPlan', {
    revision,
    source: 'components/effects/root.json',
    graph: nested,
    resources: [{ file: 'components/effects/shared.json', graph: definition() }],
  });
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const description = await app.dispatch('effectGraphInspect', {
    source: { file: plan.source },
    includeGraph: true,
  });
  expect(description.resources).toHaveLength(2);
  const bad = structuredClone(definition());
  bad.links[0].parameter = 'missing';
  await expect(
    app.dispatch('effectGraphPlan', { revision: app.service.snapshot.revision, graph: bad }),
  ).rejects.toThrow();
  const current = await readFile(path.join(root, plan.source), 'utf8');
  await expect(
    app.dispatch('effectGraphPlan', {
      revision: app.service.snapshot.revision,
      source: plan.source,
      graph: definition(),
      expectedHash: '0'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'FILE_HASH_CONFLICT' });
  expect(await readFile(path.join(root, plan.source), 'utf8')).toBe(current);
});
it('requires named bindings and keeps previous state on native sampled rendering failures', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'base', type: 'rect', x: 30, y: 30, width: 80, height: 40 },
    },
  ]);
  const revision = app.service.snapshot.revision,
    graph = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'foreign',
      nodes: [
        { id: 's', type: 'input' },
        { id: 'm', type: 'input', slot: 'matte' },
        { id: 'out', type: 'mask', input: 's', matte: 'm' },
      ],
      output: 'out',
    });
  await expect(
    app.dispatch('effectGraphPlan', {
      revision,
      graph,
      targets: [{ sceneId: 'intro', nodeId: 'base' }],
    }),
  ).rejects.toMatchObject({ code: 'EFFECT_GRAPH_BINDING' });
  const plan = await app.dispatch('effectGraphPlan', {
    revision,
    graph,
    targets: [{ sceneId: 'intro', nodeId: 'base', bindings: { matte: 'missing' } }],
  });
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid).toBe(false);
  expect(checked.diagnostics.some((d: any) => d.code === 'EFFECT_GRAPH_LAYER')).toBe(true);
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  expect(app.service.snapshot.revision).toBe(revision);
});
it('explicitly resets obsolete graph parameters and keys while preserving unrelated layer animation', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'base',
        type: 'rect',
        width: 40,
        height: 30,
        animations: [
          {
            property: 'rotation',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 59, value: 5, easing: 'linear' },
            ],
          },
        ],
      },
    },
  ]);
  const plan = await app.dispatch('effectGraphPlan', {
    revision: app.service.snapshot.revision,
    graph: definition(),
    source: 'components/effects/upgrade.json',
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'base',
        effectId: 'graph',
        keys: [
          {
            parameter: 'distance',
            keys: [
              { frame: 0, value: 10, easing: 'linear' },
              { frame: 59, value: 30, easing: 'linear' },
            ],
          },
        ],
      },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  const info = await app.dispatch('effectGraphInspect', { source: { file: plan.source } }),
    updated = structuredClone(definition());
  updated.parameters = { shift: { type: 'number', default: 20 } };
  updated.links[0].parameter = 'shift';
  const current = app.service.snapshot.revision;
  await expect(
    app.dispatch('effectGraphPlan', {
      revision: current,
      source: plan.source,
      graph: updated,
      expectedHash: info.resources[0].hash,
      targets: [{ sceneId: 'intro', nodeId: 'base', effectId: 'graph', action: 'update' }],
    }),
  ).rejects.toThrow('Unknown');
  const upgrade = await app.dispatch('effectGraphPlan', {
    revision: current,
    source: plan.source,
    graph: updated,
    expectedHash: info.resources[0].hash,
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'base',
        effectId: 'graph',
        action: 'update',
        resetParams: true,
        resetKeys: true,
      },
    ],
  });
  await app.dispatch('projectApply', upgrade.apply);
  const node = app.service.snapshot.scenes[0].nodes[0];
  expect(node.animations.map((channel) => channel.property)).toEqual(['rotation']);
  expect((node.effects[0] as any).params).toEqual({ shift: 20 });
});
it('edits graph nodes by stable ID with exact resource hashes and rejects broken rewiring atomically', async () => {
  const plan = await app.dispatch('effectGraphPlan', {
    revision: app.service.snapshot.revision,
    graph: definition(),
    source: 'components/effects/edit.json',
  });
  await app.dispatch('projectApply', plan.apply);
  const description = await app.dispatch('effectGraphInspect', { source: { file: plan.source } }),
    revision = app.service.snapshot.revision,
    oldFile = app.service.snapshot.files[plan.source],
    update = await app.dispatch('effectGraphPlan', {
      revision,
      source: plan.source,
      expectedHash: description.resources[0].hash,
      actions: [{ type: 'update', nodeId: 'out', patch: { opacity: 0.2 } }],
    });
  expect(app.service.snapshot.files[plan.source]).toBe(oldFile);
  await app.dispatch('projectApply', update.apply);
  expect(
    JSON.parse(app.service.snapshot.files[plan.source]).nodes.find((node: any) => node.id === 'out')
      .opacity,
  ).toBe(0.2);
  const info = await app.dispatch('effectGraphInspect', { source: { file: plan.source } });
  await expect(
    app.dispatch('effectGraphPlan', {
      revision: app.service.snapshot.revision,
      source: plan.source,
      expectedHash: info.resources[0].hash,
      actions: [{ type: 'remove', nodeId: 'copy' }],
    }),
  ).rejects.toMatchObject({ code: 'EFFECT_GRAPH_INPUT' });
  expect(JSON.parse(app.service.snapshot.files[plan.source]).nodes).toHaveLength(3);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
