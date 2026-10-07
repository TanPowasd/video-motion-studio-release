import { field, present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-graph-query-'));
  await initProject(root, 'query', { template: 'blank', width: 320, height: 180 });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const resource = 'components/effects/ports.json',
  component =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Card',parameters:{},render(){return [node({id:'label',type:'rect',x:40,y:30,width:100,height:80,fill:'#aa33ff'})]}});",
  graph = () =>
    defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Ports',
      nodes: [
        { id: 'source', type: 'input' },
        {
          id: 'matte',
          type: 'channels',
          red: 1,
          green: 1,
          blue: 1,
          alpha: { input: 'source', channel: 'alpha' },
        },
      ],
      output: 'source',
      outputs: { picture: 'source', matte: 'matte' },
    });
it('plans native/generated port choices, preserves output on updates, explicitly resets it, and commits one undo', async () => {
  await app.service.transact([
    { type: 'writeSource', path: 'components/card.ts', content: component },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          {
            id: 'native',
            type: 'rect',
            x: 20,
            y: 20,
            width: 80,
            height: 60,
            fill: '#2299ff',
          } as any,
          {
            id: 'generated',
            type: 'component',
            component: 'components/card.ts',
            width: 320,
            height: 180,
          } as any,
        ],
      },
    },
  ]);
  const before = app.service.snapshot.revision,
    original = app.service.snapshot.files['components/card.ts'],
    plan = await app.dispatch('effectGraphPlan', {
      revision: before,
      source: resource,
      graph: graph(),
      targets: [
        { sceneId: 'intro', nodeId: 'native', effectId: 'native-graph', output: 'picture' },
        {
          sceneId: 'intro',
          path: ['generated'],
          nodeId: 'generated/label',
          effectId: 'generated-graph',
          output: 'matte',
        },
      ],
    });
  expect(plan.layers.map((l: any) => l.output)).toEqual(['picture', 'matte']);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(
    (
      await app.dispatch('effectGraphQuery', {
        source: {
          sceneId: 'intro',
          path: ['generated'],
          nodeId: 'generated/label',
          effectId: 'generated-graph',
        },
      })
    ).selectedOutput,
  ).toBe('matte');
  const query = await app.dispatch('effectGraphQuery', {
    source: { file: resource },
    section: 'outputs',
  });
  expect(query.items.map((n: any) => n.name)).toEqual(['picture', 'matte']);
  expect(query.counts.outputs).toBe(2);
  const update = await app.dispatch('effectGraphPlan', {
    revision: app.service.snapshot.revision,
    source: resource,
    targets: [{ sceneId: 'intro', nodeId: 'native', action: 'update', effectId: 'native-graph' }],
  });
  expect(update.layers[0].output).toBe('picture');
  const reset = await app.dispatch('effectGraphPlan', {
    revision: app.service.snapshot.revision,
    source: resource,
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'native',
        action: 'update',
        effectId: 'native-graph',
        output: null,
      },
    ],
  });
  expect(reset.layers[0].output).toBeUndefined();
  const active = app.service.snapshot.revision;
  await expect(
    app.dispatch('effectGraphPlan', {
      revision: active,
      source: resource,
      targets: [{ sceneId: 'intro', nodeId: 'native', output: 'bad' }],
    }),
  ).rejects.toMatchObject({ code: 'EFFECT_GRAPH_OUTPUT' });
  expect(app.service.snapshot.revision).toBe(active);
  expect(app.service.snapshot.files['components/card.ts']).toBe(original);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files[resource]).toBeUndefined();
});
it('pages large graphs without full schemas/parameter arrays and offers selected complete evidence', async () => {
  const values = Array.from({ length: 2000 }, (_, i) => i),
    definition = defineEffectGraph({
      kind: 'effect-graph',
      version: 1,
      name: 'Large',
      parameters: {
        values: {
          type: 'array',
          items: { type: 'number', default: 0 },
          default: values,
          maxLength: 3000,
        },
      },
      nodes: [
        { id: 'source', type: 'input' },
        ...Array.from({ length: 80 }, (_, i) => ({
          id: 'step' + i,
          type: 'transform' as const,
          input: i ? 'step' + (i - 1) : 'source',
        })),
      ],
      output: 'step79',
      outputs: { original: 'source', final: 'step79' },
    });
  await app.service.transact([
    { type: 'writeSource', path: resource, content: JSON.stringify(definition) },
  ]);
  const before = app.service.snapshot.revision,
    first = await app.dispatch('effectGraphQuery', { source: { file: resource } }),
    full = await app.dispatch('effectGraphInspect', {
      source: { file: resource },
      includeGraph: true,
    }),
    params = await app.dispatch('effectGraphQuery', {
      source: { file: resource },
      section: 'parameters',
    });
  expect(first.items).toHaveLength(24);
  expect(first.total).toBe(81);
  expect(first.nextOffset).toBe(24);
  expect(field(first, 'parameters')).toBeUndefined();
  expect(field(first, 'parameterSchema')).toBeUndefined();
  expect(field(params.items[0], 'value')).toMatchObject({
    kind: 'array',
    length: 2000,
    items: [0, 1, 2, 3],
    truncated: true,
  });
  const detail = await app.dispatch('effectGraphQuery', {
    source: { file: resource },
    section: 'parameters',
    ids: ['values'],
    detail: true,
  });
  expect(field(detail.items[0], 'value')).toEqual(values);
  expect(field(detail.items[0], 'schema')).toBeDefined();
  const last = await app.dispatch('effectGraphQuery', {
    source: { file: resource },
    offset: 80,
    limit: 2,
    detail: true,
  });
  expect(field(last.items[0], 'id')).toBe('step79');
  expect(last.nextOffset).toBeUndefined();
  expect(field(present(field(last.items[0], 'values')), 'matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  const originalPort = await app.dispatch('effectGraphQuery', {
    source: { file: resource },
    output: 'original',
  });
  expect(originalPort.total).toBe(1);
  expect(originalPort.counts.unused).toBe(80);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) / 4,
  );
  for (const input of [
    { revision: 'old' },
    { ids: ['missing'] },
    { section: 'parameters', ids: ['missing'] },
    { limit: 101 },
    { output: 'missing' },
  ])
    await expect(
      app.dispatch('effectGraphQuery', { source: { file: resource }, ...input }),
    ).rejects.toThrow();
  expect(app.service.snapshot.revision).toBe(before);
});
