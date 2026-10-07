import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/visual-fields-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '2'],
  { env, windowsHide: true },
);
const client = new Client({ name: 'visual-fields-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged };
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return { value: parse(result), content: result.content };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const list = await call('visual_templates');
  assert.equal(list.value.templates.length, 9);
  assert.ok(list.value.templates.every((t) => !t.graph));
  const selected = await call('visual_templates', { preset: 'layerDisplace', includeGraph: true });
  assert.ok(selected.value.templates[0].graph);
  const rawSchema = await call('effects_guide', {
    types: ['bloom', 'radialRays', 'gradientMap'],
    schema: true,
  });
  assert.equal(rawSchema.value.effects.length, 3);
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'fields',parameters:{},render(){return [node({id:'title',type:'text',text:'程序化纹理 / 光效 / 置换',x:20,y:20,width:600,height:44,fontSize:27}),node({id:'panel',type:'rect',x:35,y:110,width:235,height:105,fill:'#78bbdc'}),node({id:'map',type:'rect',x:35,y:110,width:235,height:105,fill:'#ffffff'}),node({id:'carrier',type:'rect',opacity:0,maskId:'map'}),node({id:'bloom',type:'ellipse',x:360,y:110,width:35,height:35,fill:'#ffffff'})]}});";
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/lab.ts', content: source },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          nodes: [
            {
              id: 'lab',
              type: 'component',
              component: 'components/lab.ts',
              width: 640,
              height: 360,
            },
          ],
        },
      },
    ],
  });
  const original = await readFile(path.join(root, 'components/lab.ts'), 'utf8');
  const base = (await call('project_context')).value.revision,
    plan = await call('visual_plan', {
      revision: base,
      preset: 'marble',
      targets: [
        {
          sceneId: 'intro',
          path: ['lab'],
          nodeId: 'lab/panel',
          params: { scale: 20, warp: 0.6 },
          keys: [
            {
              parameter: 'evolution',
              keys: [
                { frame: 0, value: 0 },
                { frame: 59, value: 2 },
              ],
            },
          ],
        },
      ],
    });
  assert.equal((await call('project_context')).value.revision, base);
  const preflight = await call('project_preflight', plan.value.candidate);
  assert.equal(preflight.value.valid, true);
  await call('project_apply', plan.value.apply);
  const optimized = await call('render_profile', {
      sceneId: 'intro',
      frames: [10, 35],
      width: 640,
      repeat: 2,
    }),
    baseline = await call('render_profile', {
      sceneId: 'intro',
      frames: [10, 35],
      width: 640,
      repeat: 2,
      fieldScan: 'full',
    });
  assert.deepEqual(optimized.value.frames, baseline.value.frames);
  assert.ok(optimized.value.cache.fieldPixels < baseline.value.cache.fieldPixels * 0.2);
  const at = await call('frame_capture', { sceneId: 'intro', frame: 30, width: 640, height: 360 });
  await call('frame_capture', { sceneId: 'intro', frame: 1, width: 640, height: 360 });
  const repeated = await call('frame_capture', {
    sceneId: 'intro',
    frame: 30,
    width: 640,
    height: 360,
  });
  assert.equal(
    at.content.find((b) => b.type === 'image').data,
    repeated.content.find((b) => b.type === 'image').data,
  );
  const second = await call('visual_plan', {
    revision: (await call('project_context')).value.revision,
    preset: 'texture',
    targets: [
      {
        sceneId: 'intro',
        path: ['lab'],
        nodeId: 'lab/map',
        params: { scale: 24, low: '#000000', high: '#ffffff' },
      },
    ],
  });
  await call('project_apply', second.value.apply);
  const mapped = await call('visual_plan', {
    revision: (await call('project_context')).value.revision,
    preset: 'layerDisplace',
    targets: [
      {
        sceneId: 'intro',
        path: ['lab'],
        nodeId: 'lab/panel',
        bindings: { map: 'map' },
        params: { amountX: 8, amountY: 2 },
      },
    ],
  });
  await call('project_apply', mapped.value.apply);
  const effects = await call('effects_plan', {
    revision: (await call('project_context')).value.revision,
    sceneId: 'intro',
    targets: [
      {
        path: ['lab'],
        nodeId: 'lab/bloom',
        actions: [
          {
            type: 'append',
            effect: { id: 'light', type: 'bloom', radius: 5, intensity: 1.5, levels: 3 },
          },
          {
            type: 'append',
            effect: {
              id: 'rays',
              type: 'radialRays',
              length: 0.5,
              samples: 8,
              intensity: 1.5,
              threshold: 0.1,
            },
          },
          {
            type: 'keys',
            target: { id: 'rays' },
            property: 'length',
            keys: [
              { frame: 0, value: 0.2 },
              { frame: 59, value: 0.7 },
            ],
          },
        ],
      },
    ],
  });
  await call('project_apply', effects.value.apply);
  const keys = await call('animation_inspect', {
    sceneId: 'intro',
    path: ['lab'],
    nodeId: 'lab/bloom',
    frames: [0, 30, 59],
    properties: ['effects.1.length'],
  });
  assert.ok(
    Math.abs(keys.value.samples[1].values['effects.1.length'] - (0.2 + (0.5 * 30) / 59)) < 1e-8,
  );
  assert.equal(keys.value.channels[0].keyCount, 2);
  assert.equal(await readFile(path.join(root, 'components/lab.ts'), 'utf8'), original);
  const current = (await call('project_context')).value.revision,
    frame = await call('frame_capture', { sceneId: 'intro', frame: 30, width: 640, height: 360 }),
    bad = await client.callTool({
      name: 'tool_call',
      arguments: {
        name: 'visual_plan',
        arguments: { revision: current, preset: 'made-up', targets: [] },
      },
    });
  assert.equal(bad.isError, true);
  assert.equal((await call('project_context')).value.revision, current);
  const wait = async (id) => {
    for (let i = 0; i < 360; i++) {
      const job = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Render timeout');
  };
  const png = await call('render_start', {
    revision: current,
    format: 'png',
    start: 30,
    end: 31,
    output: path.join(root, 'exports/parity'),
  });
  await wait(png.value.id);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    Buffer.from(frame.content.find((b) => b.type === 'image').data, 'base64'),
  );
  const output = path.join(root, 'exports/visual-fields.mp4'),
    job = await call('render_start', { revision: current, output });
  await wait(job.value.id);
  const info = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  await call('frame_sample', {
    frames: [0, 15, 30, 45, 59],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  await call('project_undo');
  assert.notEqual((await call('project_context')).value.revision, current);
  await call('project_apply', effects.value.apply);
  report.output = output;
  report.revision = current;
  report.templateReplyBytes = Buffer.byteLength(JSON.stringify(list.value));
  report.planReplyBytes = Buffer.byteLength(JSON.stringify(plan.value));
  report.performance = {
    optimized: optimized.value.summary,
    baseline: baseline.value.summary,
    optimizedFieldPixels: optimized.value.cache.fieldPixels,
    fullFieldPixels: baseline.value.cache.fieldPixels,
  };
  report.checks = [
    'compact preset summaries + selected schema',
    'generated overrides/source preserved',
    'animated deterministic texture parameters',
    'bounded/full exact pixels',
    'lower region sample count',
    'layer input displacement',
    'bloom/rays ordinary effects + accurate length keys + budgets',
    'malformed request preserves revision',
    'PNG preview/export byte parity',
    '60-frame MP4',
    'atomic undo/reapply',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
