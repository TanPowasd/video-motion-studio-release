import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
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
const root = await mkdtemp(path.resolve('artifacts/planar-motion-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--name',
    'Agent 时间、粒子与液化',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, stdio: 'pipe', windowsHide: true },
);
const client = new Client({ name: 'planar-motion-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { packaged, root };
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = JSON.parse(result.content.find((block) => block.type === 'text').text);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, content: result.content };
}
const source = `import {defineComponent,node,group} from '@vmotion/sdk';export default defineComponent({name:'Temporal agent demo',parameters:{},render(ctx){return [
node({id:'heading',type:'text',text:'时间采样 · 粒子 · 液化',x:24,y:16,width:590,height:48,fontSize:27,fontWeight:700,fill:'#eaf2ff'}),
node({id:'bar',type:'rect',x:40+480*(.5+.5*Math.sin(ctx.seconds*7)),y:90,width:14,height:28,fill:'#84c7ff'}),
node({id:'orbit',type:'ellipse',x:180+110*Math.cos(ctx.seconds*3),y:145+40*Math.sin(ctx.seconds*6),width:18,height:18,fill:'#d0a2ff'}),
...group('cloth',[node({id:'base',type:'rect',width:220,height:55,fill:'#456ecc'}),node({id:'text',type:'text',text:'可编辑变形',x:15,y:12,width:190,height:38,fontSize:24,fontWeight:700,fill:'#fff'})],{x:384,y:247,width:220,height:55})]}});`;
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/main.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'gallery',
          type: 'component',
          component: 'components/main.ts',
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    sourceHash = (await call('project_file_read', { path: 'components/main.ts' })).value.hash;
  const guide = await call('effects_guide', {
    types: ['motionBlur', 'echo', 'liquify'],
    schema: true,
  });
  assert.equal(guide.value.effects.length, 3);
  const effects = await call('effects_plan', {
    sceneId: 'intro',
    revision: before,
    frame: 30,
    targets: [
      {
        nodeId: 'gallery/bar',
        path: ['gallery'],
        actions: [
          {
            type: 'append',
            effect: { type: 'motionBlur', id: 'blur', samples: 8, shutterAngle: 360 },
          },
        ],
      },
      {
        nodeId: 'gallery/orbit',
        path: ['gallery'],
        actions: [
          {
            type: 'append',
            effect: {
              type: 'echo',
              id: 'trail',
              count: 8,
              spacing: 1.5,
              decay: 0.75,
              strength: 0.8,
              operator: 'screen',
            },
          },
        ],
      },
      {
        nodeId: 'gallery/cloth',
        path: ['gallery'],
        actions: [
          {
            type: 'append',
            effect: {
              type: 'liquify',
              id: 'field',
              brushes: [{ mode: 'twirl', center: { x: 0.75, y: 0.5 }, radius: 40, angle: 40 }],
            },
          },
          {
            type: 'keys',
            target: { id: 'field' },
            property: 'brushes.0.angle',
            keys: [
              { frame: 0, value: -50 },
              { frame: 59, value: 50 },
            ],
          },
        ],
      },
    ],
  });
  const check = await call('project_preflight', effects.value.candidate);
  assert.equal(check.value.valid, true);
  assert.ok(check.content.some((block) => block.type === 'image'));
  const applied = await call('project_apply', effects.value.apply),
    revised = applied.value.revision;
  const planned = await call('particles_plan', {
    revision: revised,
    sceneId: 'intro',
    path: ['gallery'],
    nodeId: 'sparks',
    settings: {
      seed: 22,
      origin: { x: 135, y: 320 },
      rate: 32,
      emission: 'line',
      area: { x: 90, y: 0 },
      lifetime: { min: 0.6, max: 1.2 },
      shape: 'streak',
      speed: { min: 90, max: 160 },
      gravity: { x: 0, y: 60 },
    },
    effects: [{ type: 'echo', count: 3, spacing: 1, strength: 0.5, decay: 0.6 }],
  });
  const checked = await call('project_preflight', planned.value.candidate);
  assert.equal(checked.value.valid, true);
  await call('project_apply', planned.value.apply);
  const meta = await call('component_parameters', {
    sceneId: 'intro',
    path: ['gallery'],
    nodeId: 'gallery/sparks',
    frame: 30,
  });
  assert.equal(meta.value.values.rate, 32);
  const evidence = await call('particles_inspect', {
    settings: planned.value.settings,
    time: 1,
    limit: 3,
  });
  assert.equal(evidence.value.particles.length, 3);
  assert.ok(evidence.value.bounds);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, revised);
  await call('project_apply', planned.value.apply);
  assert.equal(
    (await call('project_file_read', { path: 'components/main.ts' })).value.hash,
    sourceHash,
  );
  const accepted = (await call('project_context')).value.revision,
    frame = await call('frame_capture', { frame: 30, width: 640, height: 360 }),
    captured = frame.content.find((block) => block.type === 'image');
  const repeat = await call('frame_capture', { frame: 3, width: 640, height: 360 });
  assert.ok(repeat.content.some((block) => block.type === 'image'));
  const repeated = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  assert.equal(repeated.content.find((block) => block.type === 'image').data, captured.data);
  const sheet = await call('frame_sample', {
    frames: [0, 10, 30, 59],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  assert.ok(sheet.content.some((block) => block.type === 'image'));
  const waitJob = async (id) => {
    for (let i = 0; i < 300; i++) {
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
    output: path.join(root, 'exports/parity'),
    format: 'png',
    start: 30,
    end: 31,
  });
  await waitJob(png.value.id);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    Buffer.from(captured.data, 'base64'),
  );
  const output = path.join(root, 'exports/planar-motion.mp4'),
    job = await call('render_start', { revision: accepted, output });
  await waitJob(job.value.id);
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_frames), 60);
  report.output = output;
  report.revision = accepted;
  report.checks = [
    'generated time sampling',
    'stable effect IDs/brush keys',
    'particle component plan/controls',
    'atomic emitter undo',
    'source preserved',
    'random seeking',
    'native media blocks',
    'PNG parity',
    '60-frame MP4',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
