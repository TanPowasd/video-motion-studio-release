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
const root = await mkdtemp(path.resolve('artifacts/storyboard-batch-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '4'],
  { env, windowsHide: true },
);
const client = new Client({ name: 'storyboard-e2e', version: '1.0.0' }),
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
  const editing = (await call('plugins_inspect', { id: 'vmotion.editing' })).value;
  assert.equal(editing.items[0].runtime, 'module');
  assert.equal(editing.items[0].moduleTools, 7);
  assert.equal(editing.items[0].hostTools, 0);
  report.module = 'vmotion.editing';
  const search = await client.callTool({
    name: 'tools_search',
    arguments: { category: 'editing', query: '分镜' },
  });
  assert.ok(parse(search).items.some((i) => i.name === 'storyboard_plan'));
  const voice = await call('sound_plan', {
      delivery: 'inline',
      items: [
        {
          assetId: 'voice-draft',
          document: {
            kind: 'sound',
            version: 1,
            id: 'voice-draft',
            name: '绑定声音',
            unit: 'seconds',
            duration: 1,
            tail: 0,
            tracks: [
              {
                id: 'voice',
                instrument: { type: 'synth', wave: 'sine', gain: 0.15 },
                events: [{ id: 'a', at: 0, duration: 1, note: 69 }],
              },
            ],
          },
        },
      ],
    }),
    base = (await call('project_context')).value.revision;
  const plan = await call('storyboard_plan', {
    videoTrackId: 'visual',
    audioTrackId: 'voice',
    operations: [
      ...voice.value.candidate.operations,
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          tracks: [
            { id: 'visual', name: '画面', type: 'video', clips: [], muted: false },
            { id: 'voice', name: '声音', type: 'audio', clips: [], muted: false },
          ],
        },
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 120,
          nodes: [
            {
              id: 'heading',
              type: 'text',
              text: '章节一 · 稳定镜头与声音绑定',
              x: 24,
              y: 22,
              width: 585,
              height: 48,
              fontSize: 26,
              fill: '#eaf2ff',
            },
            {
              id: 'panel',
              type: 'rect',
              x: 24,
              y: 112,
              width: 540,
              height: 80,
              radius: 12,
              fill: '#397c93',
            },
          ],
        },
      },
      {
        type: 'addScene',
        scene: {
          id: 'chapter-two',
          name: '第二章',
          duration: 120,
          background: '#172240',
          nodes: [
            {
              id: 'heading-b',
              type: 'text',
              text: '章节二 · 全片抽样检查',
              x: 24,
              y: 22,
              width: 585,
              height: 48,
              fontSize: 28,
              fill: '#eee1ff',
            },
            {
              id: 'shape',
              type: 'ellipse',
              x: 245,
              y: 140,
              width: 110,
              height: 110,
              fill: '#b390da',
            },
          ],
        },
      },
    ],
    document: {
      kind: 'storyboard',
      version: 1,
      id: 'film',
      name: 'Agent 完整编排',
      unit: 'seconds',
      chapters: [
        { id: 'one', name: '第一章' },
        { id: 'two', name: '第二章' },
      ],
      shots: [
        {
          id: 'intro',
          name: '引入',
          chapterId: 'one',
          source: { type: 'scene', id: 'intro' },
          duration: 2,
          narration: [{ id: 'line-one', assetId: 'voice-draft' }],
        },
        {
          id: 'details',
          name: '细节',
          chapterId: 'two',
          source: { type: 'scene', id: 'chapter-two' },
          duration: 2,
          narration: [{ id: 'line-two', assetId: 'voice-draft' }],
        },
      ],
    },
  });
  assert.equal((await call('project_context')).value.revision, base);
  assert.equal(plan.value.shotCount, 2);
  assert.ok(!JSON.stringify(plan.value).includes('kind":"sound'));
  const checked = await call('project_preflight', plan.value.candidate);
  assert.equal(checked.value.valid, true);
  const audition = await call('audio_preview', {
    planId: plan.value.plan.planId,
    sampleCount: 48000,
  });
  assert.ok(audition.content.some((b) => b.type === 'audio'));
  const audit = await call('sequence_audit', {
    planId: plan.value.plan.planId,
    maxFrames: 12,
    maxImages: 4,
    width: 320,
  });
  assert.equal(audit.value.revision, plan.value.candidateRevision);
  assert.ok(audit.value.coverage.structuralClips === 4);
  assert.ok(audit.content.some((b) => b.type === 'image'));
  assert.equal(audit.value.coverage.fullFrameCoverage, false);
  assert.equal(audit.value.summary.errors, 0);
  await call('project_apply', plan.value.apply);
  const page = await call('storyboard_inspect', { source: plan.value.source, limit: 1 });
  assert.equal(page.value.shots.total, 2);
  assert.equal(page.value.shots.hasMore, true);
  assert.equal(page.value.placements[0].clipId, 'sb/film/intro/visual');
  const order = await call('storyboard_plan', {
    source: plan.value.source,
    expectedHash: page.value.hash,
    videoTrackId: 'visual',
    audioTrackId: 'voice',
    actions: [{ type: 'order', shotIds: ['details', 'intro'] }],
  });
  await call('project_apply', order.value.apply);
  assert.equal(
    (await call('storyboard_inspect', { source: plan.value.source, limit: 1 })).value.shots.items[0]
      .id,
    'details',
  );
  await call('project_undo');
  const stale = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'storyboard_plan',
      arguments: {
        source: plan.value.source,
        expectedHash: '0'.repeat(64),
        videoTrackId: 'visual',
        audioTrackId: 'voice',
      },
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(parse(stale).code, 'FILE_HASH_CONFLICT');
  const revision = (await call('project_context')).value.revision,
    job = await call('render_start', {
      revision,
      output: path.join(root, 'exports/storyboard.mp4'),
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
  const output = path.join(root, 'exports/storyboard.mp4'),
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
  assert.equal((await call('project_context')).value.revision, base);
  await call('project_apply', plan.value.apply);
  report.output = output;
  report.revision = revision;
  report.candidateReplyBytes = Buffer.byteLength(JSON.stringify(plan.value));
  report.auditReplyBytes = Buffer.byteLength(JSON.stringify(audit.value));
  report.coverage = audit.value.coverage;
  report.checks = [
    'compact chapter/shot discovery',
    'code/scenes/sound/storyboard one candidate',
    'stable visual/narration clip IDs',
    'candidate whole-sequence composite evidence + source locators',
    'explicit sampled coverage',
    'paged inspector + short order edits',
    'hash protection + recovery',
    'native audition',
    '120-frame MP4 with sound',
    'one whole-batch undo/reapply',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
