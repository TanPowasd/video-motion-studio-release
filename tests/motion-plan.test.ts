import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newNode } from '../src/core/model.js';
import {
  builtinMotions,
  applyMotionCues,
  mergeMotionParameters,
} from '../src/core/motion-template.js';
import { evaluateNode } from '../src/core/time.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
it('composes relative entrances, emphasis and exits deterministically without changing unrelated channels', () => {
  const node = newNode({
    id: 'title',
    type: 'text',
    x: 100,
    y: 80,
    opacity: 0.5,
    scaleX: 2,
    scaleY: 2,
    animations: [
      {
        property: 'rotation',
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 100, value: 30, easing: 'linear' },
        ],
      },
    ],
  });
  const original = structuredClone(node),
    result = applyMotionCues(node, [
      {
        id: 'in',
        template: builtinMotions.fadeSlide,
        parameters: { dy: 40 },
        start: 0,
        duration: 20,
      },
      {
        id: 'pulse',
        template: builtinMotions.pulse,
        parameters: { peakScale: 1.2 },
        start: 30,
        duration: 20,
      },
      {
        id: 'out',
        template: builtinMotions.fadeOut,
        parameters: { dy: -20 },
        start: 80,
        duration: 20,
      },
    ]);
  expect(node).toEqual(original);
  expect(evaluateNode(result.node, 0)).toMatchObject({ opacity: 0, y: 120 });
  expect(evaluateNode(result.node, 20)).toMatchObject({ opacity: 0.5, y: 80 });
  expect(evaluateNode(result.node, 40).scaleX).toBe(2.4);
  expect(evaluateNode(result.node, 100)).toMatchObject({ opacity: 0, y: 60, rotation: 30 });
  const middle = evaluateNode(result.node, 50);
  evaluateNode(result.node, 7);
  expect(evaluateNode(result.node, 50)).toEqual(middle);
});
it('uses one rational clock conversion and rejects existing channels, overlaps and rounded-time collisions', () => {
  const node = newNode({ id: 'x', type: 'text' }),
    result = applyMotionCues(
      node,
      [{ id: 'cue', template: builtinMotions.fadeSlide, start: 1000, duration: 0.5 }],
      { units: 'seconds', fps: 30000 / 1001 },
    );
  expect(result.cues[0]).toMatchObject({
    start: Math.round((1000 * 30000) / 1001),
    end: Math.round((1000.5 * 30000) / 1001),
  });
  expect(() =>
    applyMotionCues(result.node, [
      { id: 'cue', template: builtinMotions.fadeSlide, start: 0, duration: 30 },
    ]),
  ).toThrow('existing');
  expect(() =>
    applyMotionCues(node, [
      { id: 'a', template: builtinMotions.fadeSlide, start: 0, duration: 30 },
      { id: 'b', template: builtinMotions.fadeOut, start: 20, duration: 20 },
    ]),
  ).toThrow('overlap');
  expect(() =>
    applyMotionCues(node, [{ id: 'cue', template: builtinMotions.pop, start: 0, duration: 1 }]),
  ).toThrow('same frame');
  const animated = newNode({
    id: 'a',
    type: 'text',
    opacity: 0.8,
    animations: [
      {
        property: 'opacity',
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 10, value: 0.8, easing: 'linear' },
        ],
      },
    ],
  });
  const replaced = applyMotionCues(
    animated,
    [{ id: 'cue', template: builtinMotions.fadeSlide, start: 0, duration: 30 }],
    { collision: 'replaceChannels' },
  );
  expect(evaluateNode(replaced.node, 30).opacity).toBe(0.8);
  const duplicate = structuredClone(animated);
  duplicate.animations.push(structuredClone(duplicate.animations[0]));
  const deduped = applyMotionCues(
    duplicate,
    [{ id: 'cue', template: builtinMotions.fadeSlide, start: 0, duration: 30 }],
    { collision: 'replaceChannels' },
  );
  expect(deduped.node.animations.filter((channel) => channel.property === 'opacity')).toHaveLength(
    1,
  );
});
it('keeps cue-level vector values when target bindings override one axis, and rejects invalid bindings', () => {
  const template = {
    kind: 'motion-template' as const,
    version: 1 as const,
    name: '偏移',
    parameters: { delta: { type: 'vec2', default: { x: 0, y: 0 } } },
    channels: [
      {
        property: 'x',
        keys: [
          { at: 0, value: { base: 1, parameters: { 'delta.x': 1 } } },
          { at: 1, value: { base: 1 } },
        ],
      },
      {
        property: 'y',
        keys: [
          { at: 0, value: { base: 1, parameters: { 'delta.y': 1 } } },
          { at: 1, value: { base: 1 } },
        ],
      },
    ],
  };
  const node = newNode({ id: 'box', type: 'rect', x: 50, y: 80 }),
    parameters = mergeMotionParameters({ delta: { x: 10, y: 20 } }, { delta: { x: 30 } }),
    compiled = applyMotionCues(node, [{ id: 'cue', template, parameters, start: 0, duration: 24 }]);
  expect(evaluateNode(compiled.node, 0)).toMatchObject({ x: 80, y: 100 });
  expect(() =>
    applyMotionCues(node, [
      { id: 'cue', template, parameters: { unknown: 3 }, start: 0, duration: 24 },
    ]),
  ).toThrow('Unknown');
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-motion-'));
  await initProject(root, 'motions', {
    template: 'blank',
    width: 640,
    height: 360,
    durationSeconds: 3,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('saves a parameter template and reuses it across native/generated scenes with one exact commit and undo', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk'; export default defineComponent({name:'Card',parameters:{},render(){return [node({id:'title',type:'text',text:'另一个场景',x:40,y:80,width:400,height:60,fontSize:28})]}});";
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'title',
        type: 'text',
        text: '第一个场景',
        x: 50,
        y: 80,
        width: 400,
        height: 60,
        fontSize: 28,
      },
    },
    { type: 'writeSource', path: 'components/card.ts', content: source },
    {
      type: 'addScene',
      scene: {
        id: 'other',
        name: '另一场景',
        duration: 90,
        background: '#101525',
        nodes: [
          newNode({
            id: 'card',
            type: 'component',
            component: 'components/card.ts',
            width: 640,
            height: 360,
          }),
        ],
      },
    },
  ]);
  const rev = app.service.snapshot.revision,
    plan = await app.dispatch('motionPlan', {
      revision: rev,
      saveTemplates: [
        { file: 'components/motions/brand.json', template: builtinMotions.fadeSlide },
      ],
      cues: [
        {
          id: 'enter',
          template: { file: 'components/motions/brand.json' },
          start: 0,
          duration: 24,
        },
      ],
      targets: [
        { sceneId: 'intro', nodeId: 'title', bindings: { enter: { dy: 40 } } },
        {
          sceneId: 'other',
          nodeId: 'card/title',
          path: ['card'],
          offset: 6,
          bindings: { enter: { dx: -24, dy: 0 } },
        },
      ],
    });
  expect(app.service.snapshot.revision).toBe(rev);
  expect(app.service.snapshot.files['components/motions/brand.json']).toBeUndefined();
  expect(plan.layers).toHaveLength(2);
  expect(plan.coverage.incomplete).toBe(false);
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  expect(checked.data).toBeTruthy();
  const applied = await app.dispatch('projectApply', plan.apply);
  expect(applied.revision).toBe(plan.candidateRevision);
  const native = app.service.snapshot.scenes[0].nodes[0];
  expect(evaluateNode(native, 0).y).toBe(120);
  expect(evaluateNode(native, 24).y).toBe(80);
  const generated = await app.renderer.inspectComposition(app.service.snapshot, 'other', 30, [
    'card',
  ]);
  expect(evaluateNode(generated.scene.nodes[0], 30).opacity).toBe(1);
  expect(app.service.snapshot.files['components/card.ts']).toBe(source);
  expect(
    (await app.dispatch('motionTemplates', { source: { file: 'components/motions/brand.json' } }))
      .templates[0].parameterSchema.type,
  ).toBe('object');
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(rev);
  expect(app.service.snapshot.files['components/motions/brand.json']).toBeUndefined();
});
it('lets TypeScript components share pinned JSON templates through the SDK and validates bad resource edits', async () => {
  const template = JSON.stringify(builtinMotions.fadeSlide),
    source =
      "import {defineComponent,node,parseMotionTemplate,applyMotionCues} from '@vmotion/sdk'; import data from './motions/shared.json'; const template=parseMotionTemplate(data); export default defineComponent({name:'SDK',parameters:{},render(){return [applyMotionCues(node({id:'text',type:'text',text:'共享动作',x:40,y:80,width:400,height:60,fontSize:28}),[{id:'enter',template,start:0,duration:24,parameters:{dy:40}}]).node]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/motions/shared.json', content: template },
    { type: 'writeSource', path: 'components/sdk.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'sdk',
        type: 'component',
        component: 'components/sdk.ts',
        width: 640,
        height: 360,
      },
    },
  ]);
  const image = await app.frame({ sceneId: 'intro', frame: 24, width: 320, height: 180 });
  expect(image.buffer.length).toBeGreaterThan(100);
  const original = await readFile(path.join(root, 'components/motions/shared.json'), 'utf8');
  await expect(
    app.service.transact([
      {
        type: 'writeSource',
        path: 'components/motions/shared.json',
        content: '{"kind":"motion-template","version":2}',
      },
    ]),
  ).rejects.toThrow();
  expect(await readFile(path.join(root, 'components/motions/shared.json'), 'utf8')).toBe(original);
});
