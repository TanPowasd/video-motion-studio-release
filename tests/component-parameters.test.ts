import { present, field } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
import { defineComponent } from '../src/sdk/index.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  parameterDefault,
} from '../src/core/parameters.js';
import { NativeEvaluator } from '../src/core/native.js';
import { evaluateNode } from '../src/core/time.js';
let root: string, app: Application;
const source = `import {defineComponent,rect,path} from '@vmotion/sdk';export default defineComponent({name:'Data',parameters:{
 mode:{type:'enum',options:['bar','line'],default:'bar'},visible:{type:'boolean',default:true},
 center:{type:'vec2',default:{x:20,y:10}},series:{type:'array',items:{type:'number',min:0,max:100},default:[20,40,60],minLength:1},
 style:{type:'object',properties:{color:{type:'color',default:'#79b6ff'},line:{type:'object',properties:{width:{type:'number',min:1,max:20,default:3}}}}}
},render(ctx,p){if(!p.visible)return [];return p.series.map((value,i)=>rect('bar-'+i,{x:p.center.x+i*40,y:p.center.y,width:p.mode==='bar'?20:p.style.line.width,height:value,fill:p.style.color}));}});`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-params-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function setup() {
  await app.service.transact([
    { type: 'writeSource', path: 'components/data.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'data',
            type: 'component',
            component: 'components/data.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
}
it('SDK infers structured parameter values and fills defaults without mutating shared arrays', () => {
  const component = defineComponent({
    name: 'Types',
    parameters: {
      mode: { type: 'enum', options: ['a', 'b'] },
      points: { type: 'array', items: { type: 'vec2' }, default: [{ x: 2, y: 3 }] },
      style: { type: 'object', properties: { size: { type: 'number', default: 2 } } },
    },
    render(ctx, params) {
      const size: number = params.style.size;
      const x: number = params.points[0].x;
      const mode: 'a' | 'b' = params.mode;
      return [{ id: mode, type: 'rect', x: x + size }];
    },
  });
  const a = resolveParameters(component.parameters, {}),
    b = resolveParameters(component.parameters, {});
  a.points[0].x = 100;
  expect(b.points[0].x).toBe(2);
  expect(parameterDefault({ type: 'number', integer: true, max: -0.1 })).toBe(-1);
  expect(resolveParameters({ point: { type: 'vec2', default: { x: 10 } } }, {}).point).toEqual({
    x: 10,
    y: 0,
  });
  expect(() =>
    validateParameterDefinitions({
      bad: {
        type: 'array',
        minLength: 10000,
        items: { type: 'array', minLength: 10000, items: { type: 'number' } },
      },
    }),
  ).toThrow('size/depth');
});
it('inspect/edit shares nested defaults, schema and keyframes; runtime pictures update and undo restores values', async () => {
  await setup();
  const description = await app.dispatch('componentParameters', {
    sceneId: 'intro',
    nodeId: 'data',
    frame: 0,
  });
  expect(description.values.style).toEqual({ color: '#79b6ff', line: { width: 3 } });
  expect(field(field(present(description.jsonSchema).properties.series, 'items'), 'maximum')).toBe(
    100,
  );
  expect(description.channels.map((c: any) => c.path)).toContain('center.x');
  expect(description.channels.map((c: any) => c.path)).toContain('series.1');
  const before = await app.frame({ sceneId: 'intro', frame: 0, width: 160, height: 90 }),
    revision = app.service.snapshot.revision;
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    revision,
    updates: [
      { path: 'style.color', value: '#ff3344' },
      { path: 'mode', value: 'line' },
    ],
    keys: [
      { path: 'center.x', frame: 0, value: 20 },
      { path: 'center.x', frame: 60, value: 60 },
      { path: 'series.1', frame: 0, value: 40 },
      { path: 'series.1', frame: 60, value: 80 },
    ],
  });
  const middle = await app.dispatch('componentParameters', {
    sceneId: 'intro',
    nodeId: 'data',
    frame: 30,
  });
  expect(field(middle.evaluated.center, 'x')).toBeCloseTo(40);
  expect(field(field(field(middle, 'evaluated'), 'series'), 1)).toBeCloseTo(60);
  expect(field(present(field(middle.values.style, 'line')), 'width')).toBe(3);
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    reset: ['center.x'],
  });
  expect(app.service.snapshot.scenes[0].nodes[0].params.center).toEqual({ x: 20, y: 10 });
  await app.service.undo();
  expect(
    (await app.frame({ sceneId: 'intro', frame: 30, width: 160, height: 90 })).buffer.equals(
      before.buffer,
    ),
  ).toBe(false);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[0].params).toEqual({});
}, 30000);
it('rejects wrong parameter types, enum values, typos and invalid declarations before any project commit', async () => {
  await setup();
  const revision = app.service.snapshot.revision;
  for (const [property, value] of [
    ['visible', 'false'],
    ['mode', 'pie'],
    ['series', [10, 200]],
    ['style.line.width', 0],
    ['centerr.x', 3],
  ]) {
    await expect(
      app.dispatch('componentParametersEdit', {
        sceneId: 'intro',
        nodeId: 'data',
        updates: [{ path: property, value }],
      }),
    ).rejects.toThrow();
    expect(app.service.snapshot.revision).toBe(revision);
  }
  const invalid = await app.dispatch('projectPreflight', {
    operations: [
      { type: 'updateNode', sceneId: 'intro', nodeId: 'data', patch: { params: { typo: 1 } } },
    ],
  });
  expect(invalid.valid).toBe(false);
  expect(invalid.diagnostics[0].code).toBe('PARAMETER_VALUE');
  expect(invalid.diagnostics[0].path).toBe('params.typo');
  const bad = await app.dispatch('projectPreflight', {
    operations: [
      {
        type: 'writeSource',
        path: 'components/data.ts',
        content: source.replace("default:'bar'", "default:'missing'"),
      },
    ],
  });
  expect(bad.valid).toBe(false);
  expect(bad.diagnostics.some((d: any) => d.code === 'PARAMETER_SCHEMA')).toBe(true);
}, 30000);
it('edits nested generated component parameters on the owning override and retains TypeScript source', async () => {
  const outer =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Outer',parameters:{},render(){return [node({id:'inner',type:'component',component:'components/data.ts',width:160,height:90})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/data.ts', content: source },
    { type: 'writeSource', path: 'components/outer.ts', content: outer },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'outer',
            type: 'component',
            component: 'components/outer.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    path: ['outer'],
    nodeId: 'outer/inner',
    updates: [
      { path: 'center.y', value: 30 },
      { path: 'visible', value: false },
    ],
  });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides.inner.params).toMatchObject({
    center: { x: 20, y: 30 },
    visible: false,
  });
  expect(app.service.snapshot.files['components/outer.ts']).toBe(outer);
  expect(
    (
      await app.dispatch('componentParameters', {
        sceneId: 'intro',
        path: ['outer'],
        nodeId: 'outer/inner',
      })
    ).values.visible,
  ).toBe(false);
}, 30000);
it('Rust and TypeScript agree on nested vector and array keyframes after arbitrary seeks', async () => {
  const n = newNode({
      id: 'n',
      type: 'component',
      params: { center: { x: 10, y: 20 }, series: [10, 20] },
      animations: [
        {
          property: 'params.center.x',
          keys: [
            { frame: 0, value: 10, easing: 'linear' },
            { frame: 60, value: 70, easing: 'linear' },
          ],
        },
        {
          property: 'params.series.1',
          keys: [
            { frame: 0, value: 20, easing: 'linear' },
            { frame: 60, value: 80, easing: 'linear' },
          ],
        },
      ],
    }),
    native = new NativeEvaluator();
  try {
    for (const frame of [45, 0, 30, 15, 60])
      expect((await native.evaluate([n], frame))[0].params).toEqual(evaluateNode(n, frame).params);
  } finally {
    native.close();
  }
});
it('array insertion, removal and reordering keep keyframes attached to their original items', async () => {
  await setup();
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    keys: [
      { path: 'series.1', frame: 0, value: 40 },
      { path: 'series.1', frame: 60, value: 80 },
    ],
  });
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    arrays: [{ type: 'insert', path: 'series', index: 0, value: 5 }],
  });
  let node = app.service.snapshot.scenes[0].nodes[0];
  expect(node.params.series).toEqual([5, 20, 40, 60]);
  expect(node.animations[0].property).toBe('params.series.2');
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    arrays: [{ type: 'move', path: 'series', from: 2, to: 0 }],
  });
  node = app.service.snapshot.scenes[0].nodes[0];
  expect(node.params.series).toEqual([40, 5, 20, 60]);
  expect(node.animations[0].property).toBe('params.series.0');
  expect(
    field(
      field(
        field(
          await app.dispatch('componentParameters', {
            sceneId: 'intro',
            nodeId: 'data',
            frame: 30,
          }),
          'evaluated',
        ),
        'series',
      ),
      0,
    ),
  ).toBe(60);
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'data',
    arrays: [{ type: 'remove', path: 'series', index: 0 }],
  });
  expect(app.service.snapshot.scenes[0].nodes[0].animations).toHaveLength(0);
  await app.service.undo();
  expect(app.service.snapshot.scenes[0].nodes[0].animations[0].property).toBe('params.series.0');
}, 30000);
