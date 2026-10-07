import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { parameterChannels } from '../src/service/component-parameters.js';
import { pluginIdSchema } from '../src/core/plugin-schema.js';
let app: Application, root: string;
const source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'大数据组件',parameters:{origin:{type:'vec2',default:{x:20,y:10}},label:{type:'string',default:'可编辑'},series:{type:'array',items:{type:'number',default:2},default:Array.from({length:1600},(_,i)=>i)},style:{type:'object',default:{size:22},properties:{size:{type:'number',default:12},color:{type:'color',default:'#67abcd'}}}},render(ctx,p){return [node({id:'label',type:'text',text:p.label,fontSize:p.style.size,width:280,height:80})]}});`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-query-'));
  await initProject(root, 'Query', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
  await app.service.transact([
    { type: 'writeSource', path: 'components/data.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: newNode({
        id: 'data',
        type: 'component',
        component: 'components/data.ts',
        width: 320,
        height: 180,
      }),
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('returns bounded previews, array metadata and real channel pages beyond the old 1000-channel limit', async () => {
  const full = await app.dispatch('componentParameters', { sceneId: 'intro', nodeId: 'data' }),
    query = await app.dispatch('componentQuery', { sceneId: 'intro', nodeId: 'data' });
  expect(
    present(present(present(query)).parameters.items.find((p: any) => p.path === 'series')).value,
  ).toEqual({
    kind: 'array',
    length: 1600,
    items: [0, 1, 2, 3],
    truncated: true,
  });
  expect(query.parameters.items.some((p: any) => p.jsonSchema !== undefined)).toBe(false);
  expect(query.channels.items).toHaveLength(32);
  expect(query.channels.total).toBe(full.channelCount);
  const page = await app.dispatch('componentQuery', {
    sceneId: 'intro',
    nodeId: 'data',
    paths: ['series'],
    channelOffset: 1200,
    channelLimit: 12,
  });
  expect(page.channels.items[0].path).toBe('series.1200');
  expect(page.channels.items).toHaveLength(12);
  expect(page.channels.nextOffset).toBe(1212);
  expect(Buffer.byteLength(JSON.stringify(query))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) * 0.1,
  );
  expect(full.channels).toHaveLength(1000);
  expect(full.truncated).toBe(true);
});
it('reads selected keyed values and inherited vector/object defaults with exact full-value opt-in', async () => {
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    keys: [
      { path: 'origin.x', frame: 0, value: 20 },
      { path: 'origin.x', frame: 30, value: 80 },
    ],
    updates: [{ path: 'style.size', value: 32 }],
  });
  const query = await app.dispatch('componentQuery', {
    sceneId: 'intro',
    nodeId: 'data',
    frame: 15,
    paths: ['origin.x', 'style.size', 'series.1500'],
    includeSchema: true,
  });
  expect(query.parameters.items[0]).toMatchObject({
    path: 'origin.x',
    value: 20,
    evaluated: 50,
    defaultValue: 20,
    jsonSchema: { type: 'number', default: 20 },
  });
  expect(query.parameters.items[1]).toMatchObject({
    path: 'style.size',
    value: 32,
    evaluated: 32,
    defaultValue: 22,
  });
  const full = await app.dispatch('componentQuery', {
    sceneId: 'intro',
    nodeId: 'data',
    paths: ['series'],
    fullValues: true,
  });
  expect(full.parameters.items[0].value).toHaveLength(1600);
  expect(full.projection.valueFormat).toBe('full');
});
it('rejects invalid selection and stale revisions without editing or silently dropping paths', async () => {
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('componentQuery', {
      sceneId: 'intro',
      nodeId: 'data',
      paths: ['origin.x', 'series.99999'],
    }),
  ).rejects.toMatchObject({ code: 'PARAMETER_PATH' });
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'component_query',
      arguments: { sceneId: 'intro', nodeId: 'data', paths: ['__proto__.x'] },
    }),
  ).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
  await expect(
    app.dispatch('componentQuery', { sceneId: 'intro', nodeId: 'data', revision: 'outdated' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(app.service.snapshot.revision).toBe(revision);
});
it('recognizes the builtin 3D ID and validates channel traversal without serializing every leaf', () => {
  expect(pluginIdSchema.parse('vmotion.3d')).toBe('vmotion.3d');
  const specs = {
      data: { type: 'array' as const, items: { type: 'vec2' as const } },
      other: { type: 'number' as const },
    },
    values = {
      data: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      other: 10,
    };
  expect(
    parameterChannels(specs, values, { paths: ['data.1'], limit: 1, offset: 1 }),
  ).toMatchObject({ total: 2, channels: [{ path: 'data.1.y' }], truncated: true });
});
