import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/drivers-batch-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--name',
    'Agent 属性、布局与路径',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '4',
  ],
  { env, stdio: 'pipe', windowsHide: true },
);
const client = new Client({ name: 'drivers-batch-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged };
const parse = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, content: result.content };
}
const curve = 'M50 160 C120 30 270 310 370 160 C430 50 520 120 580 245';
const source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Driver sources',parameters:{},render(){return [
node({id:'heading',type:'text',text:'属性表达式 + 布局约束 + 曲线动作',x:24,y:20,width:590,height:42,fontSize:24,fontWeight:700,fill:'#e7f1ff'}),
node({id:'route',type:'path',path:${JSON.stringify(curve)},stroke:'#4777af',strokeWidth:2,fill:'transparent'}),
node({id:'marker',type:'rect',width:20,height:12,originX:10,originY:6,fill:'#adddff'}),
node({id:'label',type:'text',text:'FOLLOW',width:120,height:28,fontSize:17,fontWeight:700,fill:'#b8caff'}),
node({id:'panel',type:'rect',height:25,radius:5,fill:'#675588'})]}});`;
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/batch.ts', content: source },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 60,
          nodes: [
            {
              id: 'gallery',
              type: 'component',
              component: 'components/batch.ts',
              width: 640,
              height: 360,
            },
          ],
        },
      },
      {
        type: 'addScene',
        scene: {
          id: 'other',
          name: '另一场景',
          duration: 60,
          background: '#151b2c',
          nodes: [
            {
              id: 'heading',
              type: 'text',
              text: '同批次 · 原生布局与表达式',
              x: 24,
              y: 20,
              width: 590,
              height: 42,
              fontSize: 24,
              fontWeight: 700,
              fill: '#e7f1ff',
            },
            {
              id: 'box',
              type: 'rect',
              width: 200,
              height: 90,
              x: 200,
              y: 120,
              fill: '#59649a',
              radius: 10,
            },
            {
              id: 'linked',
              type: 'text',
              text: 'LINKED',
              width: 130,
              height: 35,
              fontSize: 22,
              fontWeight: 700,
              fill: '#d8e5ff',
            },
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          tracks: [
            {
              id: 'visual',
              name: '两场景',
              type: 'video',
              clips: [
                { id: 'a', sceneId: 'intro', start: 0, duration: 60 },
                { id: 'b', sceneId: 'other', start: 60, duration: 60 },
              ],
            },
            { id: 'audio', name: '声音', type: 'audio', clips: [] },
          ],
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    sourceHash = (await call('project_file_read', { path: 'components/batch.ts' })).value.hash,
    measured = await call('curve_path', { path: curve, progress: [0, 0.5, 1] });
  assert.ok(measured.value.length > 500);
  assert.equal(measured.value.samples[0].x, 50);
  const planned = await call('drivers_plan', {
    revision: before,
    targets: [
      {
        sceneId: 'intro',
        path: ['gallery'],
        nodeId: 'gallery/marker',
        motionPath: { nodeId: 'route', autoRotate: true, anchor: 'origin' },
        expressions: { 'motionPath.progress': 'frame / 59' },
      },
      {
        sceneId: 'intro',
        path: ['gallery'],
        nodeId: 'gallery/label',
        expressions: { x: 'clamp(layer("marker").x + 20, 25, 495)', y: 'layer("marker").y - 32' },
      },
      {
        sceneId: 'intro',
        path: ['gallery'],
        nodeId: 'gallery/panel',
        layout: {
          reference: 'scene',
          width: { value: 0.25 },
          x: { at: 'end', self: 'end', offset: -24 },
          y: { at: 'end', self: 'end', offset: -20 },
        },
        expressions: { 'layout.width.value': '.24 + .04 * sin(time * Math.PI)' },
      },
      {
        sceneId: 'other',
        nodeId: 'box',
        layout: {
          reference: 'scene',
          x: { at: 'center', self: 'center' },
          y: { at: 'center', self: 'center' },
        },
        expressions: { width: '180 + 50 * sin(time * Math.PI)' },
      },
      {
        sceneId: 'other',
        nodeId: 'linked',
        expressions: {
          x: 'layer("box").x + (layer("box").width - base.width) / 2',
          y: 'layer("box").y + 28',
        },
      },
    ],
  });
  assert.equal((await call('project_context')).value.revision, before);
  assert.equal(planned.value.layers.length, 5);
  const checked = await call('project_preflight', planned.value.candidate);
  assert.equal(checked.value.valid, true);
  assert.ok(checked.content.some((block) => block.type === 'image'));
  const accepted = (await call('project_apply', planned.value.apply)).value.revision;
  const inspected = await call('drivers_inspect', {
      sceneId: 'other',
      nodeIds: ['box', 'linked'],
      frames: [15],
    }),
    box = inspected.value.samples[0].layers[0],
    label = inspected.value.samples[0].layers[1];
  assert.equal(box.pose.width, 230);
  assert.equal(box.pose.x, 205);
  assert.equal(label.pose.x, 255);
  assert.ok(label.dependencies.some((dependency) => dependency.inputs.includes('box:x')));
  const animated = await call('animation_inspect', {
    sceneId: 'other',
    nodeId: 'box',
    frames: [15],
  });
  assert.equal(animated.value.sampleSource, 'keys-and-drivers');
  assert.equal(animated.value.samples[0].values.width, 230);
  assert.equal(
    (await call('project_file_read', { path: 'components/batch.ts' })).value.hash,
    sourceHash,
  );
  const cycle = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'drivers_plan',
      arguments: {
        revision: accepted,
        targets: [{ sceneId: 'other', nodeId: 'box', expressions: { x: 'layer("linked").x' } }],
      },
    },
  });
  assert.equal(cycle.isError, true);
  assert.equal(parse(cycle).code, 'DRIVER_CYCLE');
  assert.equal((await call('project_context')).value.revision, accepted);
  const frame = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  await call('frame_capture', { frame: 2, width: 640, height: 360 });
  const repeated = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  assert.equal(
    repeated.content.find((block) => block.type === 'image').data,
    frame.content.find((block) => block.type === 'image').data,
  );
  await call('frame_sample', {
    frames: [0, 15, 30, 59, 60, 75, 90, 119],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  const waitJob = async (id) => {
    for (let i = 0; i < 240; i++) {
      const job = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error);
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Render timeout');
  };
  const png = await call('render_start', {
    revision: accepted,
    format: 'png',
    start: 30,
    end: 31,
    output: path.join(root, 'exports/parity'),
  });
  await waitJob(png.value.id);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    Buffer.from(frame.content.find((block) => block.type === 'image').data, 'base64'),
  );
  const output = path.join(root, 'exports/drivers-batch.mp4'),
    job = await call('render_start', { revision: accepted, output });
  await waitJob(job.value.id);
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(
    Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_frames),
    120,
  );
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_apply', planned.value.apply);
  report.output = output;
  report.revision = accepted;
  report.checks = [
    'arc-length/tangent evidence',
    'expression+layout+path batch',
    'native/generated cross-scene edits',
    'actual animation inspection',
    'dependency-cycle recovery',
    'unchanged component code',
    'random seek determinism',
    'native picture preflight',
    'PNG parity',
    '120-frame MP4',
    'one atomic undo',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
