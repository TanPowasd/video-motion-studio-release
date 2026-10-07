import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const root = await mkdtemp(path.resolve('artifacts/workstation-batch-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '4'],
  { env, windowsHide: true },
);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.2*sin(2*PI*1000*t):s=48000:d=4',
    '-c:a',
    'pcm_f32le',
    path.join(root, 'tone.wav'),
  ],
  { windowsHide: true },
);
const client = new Client({ name: 'workstation-batch', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged };
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);
async function call(name, args = {}) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return { value: parse(r), content: r.content };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const modules = {};
  for (const [id, count, runtime] of [
    ['vmotion.effects', 14, 'module'],
    ['vmotion.editing', 7, 'module'],
    ['vmotion.render', 7, 'module'],
  ]) {
    const plugin = (await call('plugins_inspect', { id })).value.items[0];
    assert.equal(plugin.moduleTools, count);
    assert.equal(plugin.runtime, runtime);
    modules[id] = { moduleTools: plugin.moduleTools, hostTools: plugin.hostTools };
  }
  report.modules = modules;
  const discovered = await client.callTool({ name: 'tools_search', arguments: { limit: 1 } });
  assert.equal(
    (await call('agent_guide')).value.discovery.availableCapabilities,
    parse(discovered).total,
  );
  const source =
    "import {defineComponent,text,rect} from '@vmotion/sdk';import data from './data.json';export default defineComponent({name:'cached',parameters:{},render(ctx){return [text('title','通用创作 / 渲染优化',{x:24,y:24,width:590,height:46,fontSize:30,fill:'#eff6ff'}),rect('box',{x:data.x+20*Math.sin(ctx.seconds),y:100,width:180,height:100,fill:'#70bfe1',effects:[{type:'blur',radius:2}]})]}});";
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/source.ts', content: source },
      { type: 'writeSource', path: 'components/data.json', content: '{"x":30}' },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 120,
          nodes: [
            {
              id: 'original',
              type: 'component',
              component: 'components/source.ts',
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
          name: 'B',
          duration: 120,
          background: '#202645',
          nodes: [
            {
              id: 'title-b',
              type: 'text',
              text: '可复用的场景转场',
              x: 35,
              y: 38,
              width: 570,
              height: 55,
              fontSize: 32,
              fill: '#d8d9ff',
            },
            {
              id: 'shape',
              type: 'ellipse',
              x: 300,
              y: 150,
              width: 100,
              height: 100,
              fill: '#c68deb',
            },
          ],
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    plan = await call('transition_plan', {
      items: [
        {
          sceneId: 'cross',
          fromSceneId: 'intro',
          toSceneId: 'other',
          style: 'crossfade',
          duration: 60,
          placement: { trackId: 'visual', at: 0 },
        },
        {
          sceneId: 'iris',
          fromSceneId: 'other',
          toSceneId: 'intro',
          style: 'iris',
          duration: 60,
          placement: { trackId: 'visual', at: 60 },
        },
      ],
    });
  const candidateProfile = await call('render_profile', {
    planId: plan.value.plan.planId,
    sceneId: 'cross',
    frames: [0, 30, 59],
    width: 640,
    repeat: 2,
    encode: true,
  });
  assert.equal(candidateProfile.value.revision, plan.value.candidateRevision);
  assert.deepEqual(candidateProfile.value.determinism.mismatchFrames, []);
  assert.equal((await call('project_context')).value.revision, before);
  const checked = await call('project_preflight', plan.value.candidate);
  assert.equal(checked.value.valid, true);
  await call('project_apply', plan.value.apply);
  const pooled = await call('render_profile', {
      sceneId: 'cross',
      frames: [0, 30, 59],
      width: 640,
      repeat: 3,
    }),
    baseline = await call('render_profile', {
      sceneId: 'cross',
      frames: [0, 30, 59],
      width: 640,
      repeat: 3,
      surfacePoolMb: 0,
    });
  assert.deepEqual(pooled.value.frames, baseline.value.frames);
  assert.ok(pooled.value.cache.surfaces.reuses > 0);
  assert.equal(baseline.value.cache.surfaces.retainedBytes, 0);
  assert.ok(pooled.value.cache.surfaces.allocations < baseline.value.cache.surfaces.allocations);
  const bad = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'transition_plan',
      arguments: { items: [{ fromSceneId: 'missing', toSceneId: 'other' }] },
    },
  });
  assert.equal(bad.isError, true);
  await call('asset_import', { path: path.join(root, 'tone.wav'), type: 'audio' });
  const whole = (await call('project_inspect')).value.snapshot,
    asset = whole.project.assets.find((a) => a.type === 'audio');
  await call('asset_place', { assetId: asset.id, sequenceId: 'main', trackId: 'voice', frame: 0 });
  const mix = await call('audio_mix_plan', {
      items: [
        {
          sequenceId: 'main',
          actions: [
            {
              type: 'master',
              patch: {
                normalization: { targetLufs: -16, targetLra: 11, truePeakDb: -1, mode: 'auto' },
              },
            },
          ],
        },
      ],
    }),
    audio = await call('audio_preview', { planId: mix.value.plan.planId, sampleCount: 48000 }),
    audit = await call('audio_audit', { planId: mix.value.plan.planId });
  assert.ok(audio.content.some((c) => c.type === 'audio'));
  assert.equal(audit.value.passed, true);
  await call('project_apply', mix.value.apply);
  const revision = (await call('project_context')).value.revision,
    job = await call('render_start', {
      revision,
      output: path.join(root, 'exports/workstation.mp4'),
    });
  for (let i = 0; i < 360; i++) {
    const state = (await call('render_status', { id: job.value.id })).value;
    if (['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert.equal(state.status, 'completed', state.error);
      break;
    }
    if (i === 359) throw new Error('Render timeout');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const tasks = (
    await call('render_query', { ids: [job.value.id], statuses: ['completed'], revision })
  ).value;
  assert.equal(tasks.total, 1);
  assert.equal(tasks.items[0].id, job.value.id);
  assert.equal(tasks.items[0].status, 'completed');
  assert.equal(tasks.items[0].output, undefined);
  const taskDetails = (await call('render_query', { ids: [job.value.id], detail: true })).value;
  assert.equal(taskDetails.items[0].output, path.join(root, 'exports/workstation.mp4'));
  const legacy = (await call('render_list')).value;
  assert.ok(Array.isArray(legacy));
  assert.ok(legacy.some((j) => j.id === job.value.id));
  const missing = await client.callTool({
    name: 'tool_call',
    arguments: { name: 'render_query', arguments: { ids: ['absent'] } },
  });
  assert.equal(missing.isError, true);
  assert.equal(parse(missing).code, 'NOT_FOUND');
  const long = await call('render_start', {
    revision,
    format: 'png',
    output: path.join(root, 'exports/cancelled'),
    width: 640,
    height: 360,
  });
  await call('render_cancel', { id: long.value.id });
  const cancelled = (await call('render_query', { ids: [long.value.id], statuses: ['cancelled'] }))
    .value;
  // Cancellation may be executing its final cleanup; poll the authoritative task status.
  for (let i = 0; i < 100; i++) {
    const state = (await call('render_status', { id: long.value.id })).value;
    if (state.status === 'cancelled') break;
    assert.notEqual(state.status, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (await call('render_query', { ids: [long.value.id], statuses: ['cancelled'] })).value.total,
    1,
  );
  report.taskQueryBytes = Buffer.byteLength(JSON.stringify(tasks));
  const output = path.join(root, 'exports/workstation.mp4'),
    info = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 120);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  await call('frame_sample', {
    frames: [0, 30, 59, 60, 90, 119],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  await call('project_undo');
  await call('project_apply', mix.value.apply);
  report.output = output;
  report.revision = revision;
  report.profile = {
    pooled: pooled.value.summary,
    baseline: baseline.value.summary,
    surfacePooled: pooled.value.cache.surfaces,
    surfaceBaseline: baseline.value.cache.surfaces,
  };
  report.loudness = audit.value.measurement;
  report.checks = [
    'compact MCP discovery',
    'multi-scene transition candidates + declared refs',
    'candidate performance inspection without commit',
    'native preflight/apply',
    'pool/no-pool exact pixel parity',
    'bounded memory + lower surface allocations',
    'missing source error recovery',
    'exact mixed-audio candidate audition + LUFS/true peak audit',
    '120-frame MP4 with sound',
    'atomic mixing undo/reapply',
    'builtin effects/editing/render module ownership',
    'filtered compact job progress, full evidence and legacy list parity',
    'render cancellation still uses the host task manager',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
