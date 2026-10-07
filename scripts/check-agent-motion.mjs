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
const root = await mkdtemp(path.resolve('artifacts/agent-motion-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--name',
    '参数化动作 · 跨场景',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '4',
  ],
  { env, windowsHide: true, stdio: 'pipe' },
);
const client = new Client({ name: 'motion-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
const parse = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(parse(result))}`);
  return { value: parse(result), content: result.content };
}
const source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Scene B card',parameters:{},render(){return [
node({id:'card',type:'group',x:40,y:92,width:560,height:180,originX:280,originY:90}),
node({id:'background',parentId:'card',type:'rect',width:560,height:180,radius:18,fill:'#342947'}),
node({id:'title',parentId:'card',type:'text',text:'同一份模板，不同参数',x:24,y:28,width:512,height:48,fontSize:27,fontWeight:700,fill:'#f0e6ff'}),
node({id:'caption',parentId:'card',type:'text',text:'场景 B：延迟 + 横向进入',x:24,y:96,width:512,height:50,fontSize:21,fill:'#c4b3df'})]}});`;
const report = { packaged, root, checks: [] };
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  await call('project_transact', {
    operations: [
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '场景 A',
          duration: 60,
          nodes: [
            {
              id: 'heading',
              type: 'text',
              text: '动作模板 · 场景 A',
              x: 32,
              y: 25,
              width: 570,
              height: 50,
              fontSize: 25,
              fontWeight: 700,
              fill: '#dceaff',
            },
            {
              id: 'card',
              type: 'group',
              x: 40,
              y: 92,
              width: 560,
              height: 180,
              originX: 280,
              originY: 90,
            },
            {
              id: 'background',
              parentId: 'card',
              type: 'rect',
              width: 560,
              height: 180,
              radius: 18,
              fill: '#213858',
            },
            {
              id: 'title',
              parentId: 'card',
              type: 'text',
              text: '同一套动作，可重复编排',
              x: 24,
              y: 28,
              width: 512,
              height: 48,
              fontSize: 27,
              fontWeight: 700,
              fill: '#e6efff',
            },
            {
              id: 'caption',
              parentId: 'card',
              type: 'text',
              text: '场景 A：入场 → 呼吸 → 退场',
              x: 24,
              y: 96,
              width: 512,
              height: 50,
              fontSize: 21,
              fill: '#acc6e7',
            },
          ],
        },
      },
      { type: 'writeSource', path: 'components/scene-b.ts', content: source },
      {
        type: 'addScene',
        scene: {
          id: 'other',
          name: '场景 B',
          duration: 60,
          background: '#151222',
          nodes: [
            {
              id: 'heading',
              type: 'text',
              text: '动作模板 · 场景 B',
              x: 32,
              y: 25,
              width: 570,
              height: 50,
              fontSize: 25,
              fontWeight: 700,
              fill: '#ebdfff',
            },
            {
              id: 'film',
              type: 'component',
              component: 'components/scene-b.ts',
              width: 640,
              height: 360,
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
              name: '两段动画',
              type: 'video',
              clips: [
                { id: 'a', sceneId: 'intro', start: 0, duration: 60 },
                { id: 'b', sceneId: 'other', start: 60, duration: 60 },
              ],
            },
            { id: 'voice', name: '声音', type: 'audio', clips: [] },
          ],
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    originalSource = (await call('project_file_read', { path: 'components/scene-b.ts' })).value
      .hash,
    library = await call('motion_templates', {
      source: { builtin: 'fadeSlide' },
      includeTemplate: true,
    });
  const template = { ...library.value.templates[0].template, name: '通用入场' };
  const planned = await call('motion_plan', {
    revision: before,
    saveTemplates: [{ file: 'components/motions/entrance.json', template }],
    cues: [
      {
        id: 'enter',
        template: { file: 'components/motions/entrance.json' },
        start: 0,
        duration: 16,
      },
      { id: 'emphasis', template: { builtin: 'pulse' }, start: 24, duration: 10 },
      { id: 'exit', template: { builtin: 'fadeOut' }, start: 42, duration: 13 },
    ],
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'card',
        bindings: { enter: { dy: 36 }, emphasis: { peakScale: 1.05 } },
      },
      {
        sceneId: 'other',
        nodeId: 'film/card',
        path: ['film'],
        offset: 4,
        bindings: {
          enter: { dx: -48, dy: 0 },
          emphasis: { peakScale: 1.08 },
          exit: { dx: 30, dy: 0 },
        },
      },
    ],
  });
  assert.equal((await call('project_context')).value.revision, before);
  assert.ok(planned.value.candidate.planId);
  assert.equal(planned.value.layers.length, 2);
  assert.equal(planned.value.coverage.incomplete, true);
  const checked = await call('project_preflight', planned.value.candidate);
  assert.equal(checked.value.valid, true);
  assert.ok(checked.content.some((block) => block.type === 'image'));
  const extra = await call('project_preflight', {
    ...planned.value.candidate,
    samples: [24, 29, 34, 42, 48, 55, 59].map((frame) => ({
      sceneId: 'other',
      path: ['film'],
      frame,
    })),
    determinism: true,
    visual: true,
  });
  assert.equal(extra.value.valid, true);
  assert.equal(extra.value.candidateRevision, checked.value.candidateRevision);
  const applied = await call('project_apply', planned.value.apply);
  assert.equal(applied.value.revision, planned.value.candidateRevision);
  assert.equal(
    (await call('project_file_read', { path: 'components/scene-b.ts' })).value.hash,
    originalSource,
  );
  const image = await call('frame_sample', {
    frames: [0, 8, 16, 29, 48, 55, 60, 68, 76, 89, 108, 119],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  assert.ok(image.content.some((block) => block.type === 'image'));
  const frame = await call('frame_capture', { frame: 76, width: 640, height: 360 }),
    png = await call('render_start', {
      revision: applied.value.revision,
      output: path.join(root, 'exports/parity'),
      format: 'png',
      start: 76,
      end: 77,
    });
  const waitJob = async (id) => {
    for (let i = 0; i < 200; i++) {
      const job = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error);
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Render timeout');
  };
  await waitJob(png.value.id);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000076.png')),
    Buffer.from(frame.content.find((block) => block.type === 'image').data, 'base64'),
  );
  const output = path.join(root, 'exports/agent-motion.mp4'),
    render = await call('render_start', { revision: applied.value.revision, output });
  await waitJob(render.value.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', output],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(
    Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_frames),
    120,
  );
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  assert.equal(
    (await call('motion_templates')).value.templates.filter(
      (template) => template.source === 'components/motions/entrance.json',
    ).length,
    0,
  );
  await call('project_apply', planned.value.apply);
  report.checks = [
    'parameter template schemas',
    'cross-scene native/generated motion',
    'combined entrance/emphasis/exit',
    'per-target bindings and offsets',
    'explicit incomplete coverage',
    'additional candidate preflight',
    'unchanged component source',
    'native contact sheet',
    'preview/export PNG parity',
    '120-frame MP4',
    'atomic resource+scenes undo',
  ];
  report.output = output;
  report.revision = applied.value.revision;
} finally {
  await client.close();
  await writeFile(path.join(root, 'motion-check.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
