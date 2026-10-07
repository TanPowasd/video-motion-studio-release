import { field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { contentTimeSchema, mapContentTime, contentTiming } from '../src/core/content-time.js';
import { newNode, sceneSchema, type Node } from '../src/core/model.js';
import { evaluateNode } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
import { parentDelta, movePatch, transform } from '../src/core/interaction.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';

it('maps linear/freeze/reverse clocks with bounded loops, pingpong, blank and fractional frames', () => {
  const mapping = contentTimeSchema.parse({ anchor: 10, offset: 20, rate: -0.5 });
  expect(mapContentTime(mapping, 20).sourceFrame).toBe(15);
  expect(mapping.rate).toBe(-0.5);
  expect(mapContentTime(contentTimeSchema.parse({ rate: 0, offset: 23 }), 90).sourceFrame).toBe(23);
  for (const [repeat, input, expected, present] of [
    ['loop', -1, 9, true],
    ['loop', 10.5, 0.5, true],
    ['pingpong', -1, 1, true],
    ['pingpong', 10, 8, true],
    ['clamp', 90, 9, true],
    ['clamp', -1, 0, true],
    ['blank', 10, 10, false],
    ['blank', 9.5, 9.5, true],
  ] as const) {
    const actual = mapContentTime(
      contentTimeSchema.parse({ mode: 'remap', frame: input, repeat }),
      0,
      10,
    );
    expect(actual.sourceFrame).toBeCloseTo(expected, 8);
    expect(actual.present).toBe(present);
  }
  expect(mapContentTime(contentTimeSchema.parse({ repeat: 'pingpong' }), 100, 1).sourceFrame).toBe(
    0,
  );
  expect(() => mapContentTime(contentTimeSchema.parse({ repeat: 'loop' }), 3)).toThrow('duration');
});
it('Rust and TypeScript evaluate time controls without mutating source and retain random-access parity', async () => {
  const node = newNode({
      id: 'retime',
      type: 'component',
      timeMapping: { mode: 'remap', frame: 0, anchor: 0, rate: 1, offset: 0, repeat: 'continue' },
      animations: [
        {
          property: 'timeMapping.frame',
          keys: [
            { frame: 0, value: 59, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
            { frame: 60, value: 0, easing: 'linear' },
          ],
        },
      ],
    }),
    native = new NativeEvaluator();
  try {
    for (const frame of [30, 0, 59, 10, 60, 30])
      expect((await native.evaluate([node], frame))[0].timeMapping.frame).toBeCloseTo(
        evaluateNode(node, frame).timeMapping.frame,
        7,
      );
    expect(node.timeMapping.frame).toBe(0);
  } finally {
    native.close();
  }
});
let root: string, app: Application;
beforeEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-time-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(nodes: Node[]) {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { background: 'transparent', duration: 90, nodes },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 90,
        tracks: [
          {
            id: 'v',
            name: 'visual',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'intro',
                sceneId: 'intro',
                start: 0,
                duration: 90,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    },
  ]);
}
async function movingSource() {
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'moving',
        name: 'Moving',
        width: 320,
        height: 180,
        duration: 60,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'box',
            type: 'rect',
            x: 10,
            y: 30,
            width: 20,
            height: 20,
            fill: '#fff',
            animations: [
              {
                property: 'x',
                keys: [
                  { frame: 0, value: 10, easing: 'linear' },
                  { frame: 59, value: 128, easing: 'linear' },
                ],
              },
            ],
          }),
        ],
      }),
    },
  ]);
}
it('integration: frozen content keeps parent transform animation and actual selection geometry', async () => {
  await movingSource();
  await setup([
    newNode({
      id: 'ref',
      type: 'scene',
      sceneId: 'moving',
      width: 320,
      height: 180,
      timeMapping: contentTimeSchema.parse({ rate: 0, offset: 12 }),
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 60, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const first = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0),
    later = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 30),
    a = first.layers.find((l) => l.node.id === 'ref/box')!,
    b = later.layers.find((l) => l.node.id === 'ref/box')!;
  expect(a.frame).toBe(12);
  expect(b.frame).toBe(12);
  expect(b.contextFrames).toEqual([30]);
  const world = transform(b.matrix, { x: 10, y: 10 }),
    canvas = await app.renderer.render(app.service.snapshot, 30, { sceneId: 'intro' });
  expect(
    canvas.getContext('2d').getImageData(Math.floor(world.x), Math.floor(world.y), 1, 1).data[3],
  ).toBe(255);
  expect(b.matrix[4] - a.matrix[4]).toBeCloseTo(30);
}, 30000);
it('integration: component content clocks and parent parameters stay separate, and isolated contexts match parent preview', async () => {
  const content = `import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Clock',parameters:{value:{type:'number',default:0}},render:(ctx,params)=>[rect('box',{x:ctx.frame*2,y:params.value,width:16,height:16,fill:'#fff'})]});`;
  await app.service.transact([{ type: 'writeSource', path: 'components/clock.ts', content }]);
  await setup([
    newNode({
      id: 'clock',
      type: 'component',
      component: 'components/clock.ts',
      width: 320,
      height: 180,
      params: { value: 10 },
      timeMapping: contentTimeSchema.parse({ rate: 0, offset: 12 }),
      animations: [
        {
          property: 'params.value',
          keys: [
            { frame: 0, value: 10, easing: 'linear' },
            { frame: 60, value: 70, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 20),
    leaf = graph.layers.find((l) => l.node.id === 'clock/box')!;
  expect(leaf.node.x).toBe(24);
  expect(leaf.node.y).toBe(30);
  expect(leaf.frame).toBe(12);
  const isolated = await app.renderer.inspectComposition(
    app.service.snapshot,
    'intro',
    12,
    ['clock'],
    [20],
  );
  expect(isolated.scene.nodes[0].y).toBe(30);
  const parent = await app.frame({ frame: 20 }),
    focused = await app.frame({
      frame: 12,
      sceneId: 'intro',
      path: ['clock'],
      contextFrames: [20],
    });
  expect(parent.buffer.equals(focused.buffer)).toBe(true);
  // The contact sheet must retain the ancestor parameter clock, as frame_capture does.
  const sample = await app.dispatch('sample', {
      frames: [12],
      sceneId: 'intro',
      path: ['clock'],
      contextFrames: [20],
      width: 320,
    }),
    image = await loadImage(sample.output),
    sheet = createCanvas(320, 210);
  sheet.getContext('2d').drawImage(image, 0, 0);
  expect(sheet.getContext('2d').getImageData(25, 31, 1, 1).data[0]).toBe(255);
  expect(sheet.getContext('2d').getImageData(25, 11, 1, 1).data[0]).toBe(21);
}, 30000);
it('integration: source-clock dragging creates integer keys at the mapped frame and leaves source JSON unchanged', async () => {
  await movingSource();
  await setup([
    newNode({
      id: 'ref',
      type: 'scene',
      sceneId: 'moving',
      width: 320,
      height: 180,
      timeMapping: contentTimeSchema.parse({ rate: 1.5, offset: 5 }),
    }),
  ]);
  const original = await readFile(path.join(root, 'scenes/moving.json'), 'utf8'),
    graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 15),
    layer = graph.layers.find((l) => l.node.id === 'ref/box')!,
    local = parentDelta(layer, { x: 10, y: 0 })!;
  expect(layer.frame).toBe(27.5);
  await app.dispatch('compositionTransactBatch', {
    sceneId: 'intro',
    frame: 15,
    edits: [
      {
        path: layer.path,
        frame: layer.frame,
        contextFrames: layer.contextFrames,
        nodeId: layer.node.id,
        patch: movePatch(layer.node, layer.frame!, local),
      },
    ],
  });
  const keys = app.service.snapshot.scenes[0].nodes[0].overrides.box.animations![0].keys;
  expect(keys.some((k) => k.frame === 28 && k.value === 75)).toBe(true);
  expect(keys.some((k) => k.frame === 15)).toBe(false);
  expect(await readFile(path.join(root, 'scenes/moving.json'), 'utf8')).toBe(original);
}, 30000);
it('integration: a single agent layer edit preserves the pinned ancestor clock of a frozen component', async () => {
  const content =
    "import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Pinned layout',parameters:{value:{type:'number',default:0}},render(ctx,params){return [rect(params.value>=50?'late':'early',{x:ctx.frame,y:params.value,width:20,height:20})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/pinned-layout.ts', content },
  ]);
  await setup([
    newNode({
      id: 'clock',
      type: 'component',
      component: 'components/pinned-layout.ts',
      width: 320,
      height: 180,
      params: { value: 0 },
      timeMapping: contentTimeSchema.parse({ rate: 0, offset: 5 }),
      animations: [
        {
          property: 'params.value',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 60, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const result = await app.dispatch('agentToolInvoke', {
    name: 'composition_edit_layer',
    arguments: {
      sceneId: 'intro',
      path: ['clock'],
      nodeId: 'clock/late',
      contextFrames: [60],
      frame: 5,
      patch: { fill: '#ff0000' },
    },
  });
  expect(field(field(result, 'value'), 'snapshot')).toBeUndefined();
  expect(field(field(result, 'value'), 'revision')).toBe(app.service.snapshot.revision);
  const scoped = await app.renderer.inspectComposition(
    app.service.snapshot,
    'intro',
    5,
    ['clock'],
    [60],
  );
  expect(scoped.scene.nodes[0].id).toBe('clock/late');
  expect(scoped.scene.nodes[0].fill).toBe('#ff0000');
  expect(app.service.snapshot.scenes[0].nodes[0].overrides.late.fill).toBe('#ff0000');
}, 30000);
it('integration: remap easing, loops, blank and presets are undoable and deterministic after random seeking', async () => {
  await movingSource();
  await setup([newNode({ id: 'ref', type: 'scene', sceneId: 'moving', width: 320, height: 180 })]);
  const before = app.service.snapshot.revision;
  await app.dispatch('timeEdit', {
    sceneId: 'intro',
    nodeId: 'ref',
    keys: [
      { frame: 0, value: 59, easing: 'linear' },
      { frame: 59, value: 0, easing: 'linear' },
    ],
  });
  const report = await app.dispatch('timeInspect', {
    sceneId: 'intro',
    nodeId: 'ref',
    frames: [0, 30, 59],
  });
  expect(report.samples.map((s: { sourceFrame: number }) => s.sourceFrame)).toEqual([59, 29, 0]);
  const captured = await app.frame({ frame: 30 });
  await app.frame({ frame: 0 });
  expect((await app.frame({ frame: 30 })).buffer.equals(captured.buffer)).toBe(true);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  await app.dispatch('timeEdit', { sceneId: 'intro', nodeId: 'ref', frame: 20, preset: 'freeze' });
  expect(
    contentTiming(app.service.snapshot, app.service.snapshot.scenes[0].nodes[0], 40).sourceFrame,
  ).toBe(20);
  await app.dispatch('timeEdit', {
    sceneId: 'intro',
    nodeId: 'ref',
    frame: 0,
    settings: { repeat: 'loop', rate: 1, offset: 0, anchor: 0 },
  });
  expect(
    (await app.frame({ frame: 0 })).buffer.equals((await app.frame({ frame: 60 })).buffer),
  ).toBe(true);
  await app.dispatch('timeEdit', {
    sceneId: 'intro',
    nodeId: 'ref',
    settings: { repeat: 'blank' },
  });
  const canvas = await app.renderer.render(app.service.snapshot, 60, { sceneId: 'intro' });
  expect(
    canvas
      .getContext('2d')
      .getImageData(0, 0, 320, 180)
      .data.some((v) => v !== 0),
  ).toBe(false);
}, 30000);
it('integration: nested clocks preserve ancestor contexts during parameter, structure and frame edits', async () => {
  const content = `import {defineComponent,rect}from '@vmotion/sdk';export default defineComponent({name:'Clock',parameters:{value:{type:'number',default:10}},render:(ctx,params)=>[rect('box',{x:ctx.frame,y:params.value,width:16,height:16,fill:'#fff'})]});`;
  await app.service.transact([
    { type: 'writeSource', path: 'components/clock.ts', content },
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'source',
        name: 'Source',
        width: 320,
        height: 180,
        duration: 90,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'component',
            type: 'component',
            component: 'components/clock.ts',
            width: 320,
            height: 180,
            timeMapping: contentTimeSchema.parse({ rate: 0.5 }),
          }),
        ],
      }),
    },
  ]);
  await setup([
    newNode({
      id: 'ref',
      type: 'scene',
      sceneId: 'source',
      width: 320,
      height: 180,
      timeMapping: contentTimeSchema.parse({ rate: 2 }),
    }),
  ]);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 20),
    leaf = graph.layers.find((l) => l.node.id === 'ref/component/box')!;
  expect(leaf.frame).toBe(20);
  expect(leaf.contextFrames).toEqual([20, 40]);
  const view = await app.renderer.inspectComposition(
    app.service.snapshot,
    'intro',
    20,
    leaf.path,
    leaf.contextFrames,
  );
  expect(view.scene.nodes[0].x).toBe(20);
  await app.dispatch('compositionStructure', {
    sceneId: 'intro',
    path: leaf.path,
    contextFrames: leaf.contextFrames,
    frame: 20,
    action: { type: 'duplicate', ids: [leaf.node.id], offset: { x: 20, y: 0 } },
  });
  const next = await app.renderer.inspectComposition(
    app.service.snapshot,
    'intro',
    20,
    leaf.path,
    leaf.contextFrames,
  );
  expect(next.scene.nodes).toHaveLength(2);
}, 30000);
it('integration: video reverse/freeze seeks real decoded pixels and holds the last known frame', async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
  for (const [i, color] of colors.entries()) {
    const c = createCanvas(64, 64);
    c.getContext('2d').fillStyle = color;
    c.getContext('2d').fillRect(0, 0, 64, 64);
    await writeFile(path.join(root, `source-${i}.png`), await c.encode('png'));
  }
  const file = path.join(root, 'source.mkv');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-framerate',
    '30',
    '-i',
    path.join(root, 'source-%d.png'),
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'bgra',
    file,
  ]);
  const imported = await app.dispatch('import', { path: file, type: 'video' }),
    asset = app.service.snapshot.project.assets.find((a) => a.type === 'video')!;
  await setup([
    newNode({
      id: 'video',
      type: 'video',
      assetId: asset.id,
      width: 64,
      height: 64,
      timeMapping: contentTimeSchema.parse({ rate: -1, offset: 3 }),
    }),
  ]);
  const expected = [
    [255, 255, 255, 255],
    [0, 0, 255, 255],
    [0, 255, 0, 255],
    [255, 0, 0, 255],
  ];
  for (const frame of [0, 3, 1, 2, 1]) {
    const c = await app.renderer.render(app.service.snapshot, frame, { sceneId: 'intro' });
    expect([...c.getContext('2d').getImageData(30, 30, 1, 1).data]).toEqual(expected[frame]);
  }
  await app.dispatch('timeEdit', { sceneId: 'intro', nodeId: 'video', frame: 1, preset: 'freeze' });
  const frozen = await app.renderer.render(app.service.snapshot, 50, { sceneId: 'intro' });
  expect([...frozen.getContext('2d').getImageData(30, 30, 1, 1).data]).toEqual(expected[1]);
}, 30000);
it('integration: invalid time mappings keep the active revision and retimed PNG export matches preview', async () => {
  const content = `import {defineComponent,rect}from '@vmotion/sdk';export default defineComponent({name:'Clock',parameters:{},render:(ctx)=>[rect('box',{x:ctx.frame*3,y:30,width:16,height:16,fill:'#fff'})]});`;
  await app.service.transact([{ type: 'writeSource', path: 'components/clock.ts', content }]);
  await setup([
    newNode({
      id: 'clock',
      type: 'component',
      component: 'components/clock.ts',
      width: 320,
      height: 180,
    }),
  ]);
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('timeEdit', { sceneId: 'intro', nodeId: 'clock', settings: { repeat: 'loop' } }),
  ).rejects.toThrow('duration');
  expect(app.service.snapshot.revision).toBe(before);
  await app.dispatch('timeEdit', {
    sceneId: 'intro',
    nodeId: 'clock',
    settings: { rate: 2, offset: 4 },
  });
  const output = path.join(root, 'export'),
    job = app.renders.start(app.service.snapshot, { output, format: 'png', end: 3 });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  for (const frame of [2, 0, 1])
    expect(
      (await readFile(path.join(output, `frame-${String(frame).padStart(8, '0')}.png`))).equals(
        (await app.frame({ frame })).buffer,
      ),
    ).toBe(true);
}, 30000);
