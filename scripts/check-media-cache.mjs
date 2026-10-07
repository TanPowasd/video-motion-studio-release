import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
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
const root = await mkdtemp(path.resolve('artifacts/media-cache-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '1280', '--height', '720', '--duration', '2'],
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
    'testsrc2=size=1280x720:rate=30:duration=2',
    '-c:v',
    'ffv1',
    path.join(root, 'source.mkv'),
  ],
  { windowsHide: true },
);
const client = new Client({ name: 'media-cache-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged };
const parse = (result) => JSON.parse(result.content.find((b) => b.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return { value: parse(result), content: result.content };
}
try {
  await client.connect(transport);
  const module = (await call('plugins_inspect', { id: 'vmotion.media' })).value.items[0];
  assert.equal(module.runtime, 'module');
  assert.equal(module.moduleTools, 12);
  assert.equal(module.hostTools, 0);
  assert.equal((await client.listTools()).tools.length, 10);
  await call('asset_import', { path: path.join(root, 'source.mkv'), type: 'video', copy: true });
  const item = (await call('media_status')).value.assets.items[0],
    assetId = item.id;
  await call('project_transact', {
    operations: [
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: { nodes: [{ id: 'video', type: 'video', assetId, width: 1280, height: 720 }] },
      },
    ],
  });
  const original = await call('frame_capture', {
    sceneId: 'intro',
    frame: 20,
    width: 640,
    height: 360,
  });
  const task = await call('media_proxy', { action: 'start', assetIds: [assetId], width: 640 });
  for (let i = 0; i < 200; i++) {
    const state = (await call('media_proxy', { action: 'status', jobId: task.value.jobs[0].id }))
      .value;
    if (['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert.equal(state.status, 'completed', state.error);
      break;
    }
    if (i === 199) throw new Error('Proxy timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = (await call('media_status')).value.assets.items[0];
  assert.equal(ready.proxy.status, 'ready');
  const normal = await call('render_profile', {
      sceneId: 'intro',
      frames: [10, 20],
      width: 640,
      repeat: 2,
      mediaQuality: 'original',
    }),
    auto = await call('render_profile', {
      sceneId: 'intro',
      frames: [10, 20],
      width: 640,
      repeat: 2,
      mediaQuality: 'auto',
    });
  assert.ok(auto.value.media.uses.some((u) => u.proxy));
  assert.equal(auto.value.media.uses[0].decodeWidth, 640);
  assert.equal(normal.value.media.uses[0].decodeWidth, 1280);
  assert.equal(
    (
      await call('frame_capture', { sceneId: 'intro', frame: 20, width: 640, height: 360 })
    ).content.find((b) => b.type === 'image').data,
    original.content.find((b) => b.type === 'image').data,
  );
  const cancel = await call('media_proxy', { action: 'start', assetIds: [assetId], width: 320 });
  await call('media_proxy', { action: 'cancel', jobId: cancel.value.jobs[0].id });
  for (let i = 0; i < 50; i++) {
    const state = (await call('media_proxy', { action: 'status', jobId: cancel.value.jobs[0].id }))
      .value;
    if (state.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = (await call('project_context')).value.revision,
    moved = path.join(root, 'relocated.mkv');
  await call('media_proxy', { action: 'release' });
  await rename(path.resolve(root, item.path), moved);
  assert.equal((await call('media_status')).value.assets.items[0].status, 'missing-or-invalid');
  const plan = await call('media_relink_plan', {
    items: [{ assetId, path: moved, expectedPath: item.path }],
  });
  assert.equal((await call('project_context')).value.revision, before);
  const check = await call('project_preflight', plan.value.candidate);
  assert.equal(check.value.valid, true);
  await call('project_apply', plan.value.apply);
  assert.equal((await call('media_status')).value.assets.items[0].id, assetId);
  assert.equal((await call('media_status')).value.assets.items[0].proxy.status, 'none-or-stale');
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_redo');
  assert.equal((await call('project_context')).value.revision, plan.value.candidateRevision);
  await mkdir(path.join(root, '.vmotion/media-evidence'), { recursive: true });
  await mkdir(path.join(root, '.vmotion/renders/protected'), { recursive: true });
  await writeFile(path.join(root, '.vmotion/media-evidence/reclaim.bin'), 'rebuildable data');
  await writeFile(path.join(root, '.vmotion/renders/protected/checkpoint.json'), 'checkpoint');
  const cache = await call('cache_plan', {
    groups: ['media-evidence'],
    maxBytes: 0,
    minAgeSeconds: 0,
  });
  assert.equal(cache.value.fileCount, 1);
  const cleaned = await call('cache_apply', cache.value.apply);
  assert.equal(cleaned.value.reclaimedBytes, 16);
  assert.equal(
    await readFile(path.join(root, '.vmotion/renders/protected/checkpoint.json'), 'utf8'),
    'checkpoint',
  );
  assert.ok((await stat(moved)).size > 0);
  assert.ok(
    (
      await stat(
        cache.value.planId && path.join(root, '.vmotion/cache-plans', cache.value.planId + '.json'),
      )
    ).isFile(),
  );
  const revision = (await call('project_context')).value.revision,
    exported = await call('render_start', {
      revision,
      format: 'png',
      width: 640,
      height: 360,
      start: 20,
      end: 21,
      output: path.join(root, 'exports/parity'),
    });
  const wait = async (id) => {
    for (let i = 0; i < 200; i++) {
      const job = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Render timeout');
  };
  await wait(exported.value.id);
  assert.ok(
    (await readFile(path.join(root, 'exports/parity/frame-00000020.png'))).equals(
      Buffer.from(original.content.find((b) => b.type === 'image').data, 'base64'),
    ),
    'Original preview/export PNG differs at the same frame and resolution',
  );
  const video = await call('render_start', {
    revision,
    output: path.join(root, 'exports/media-cache.mp4'),
  });
  await wait(video.value.id);
  const info = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'exports/media-cache.mp4')],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  report.output = path.join(root, 'exports/media-cache.mp4');
  report.revision = revision;
  report.relinkReplyBytes = Buffer.byteLength(JSON.stringify(plan.value));
  report.cacheReplyBytes = Buffer.byteLength(JSON.stringify(cache.value));
  report.profile = {
    original: normal.value.summary,
    auto: auto.value.summary,
    originalDecodePixels:
      normal.value.media.uses[0].decodeWidth * normal.value.media.uses[0].decodeHeight,
    autoDecodePixels: auto.value.media.uses[0].decodeWidth * auto.value.media.uses[0].decodeHeight,
  };
  report.checks = [
    'compact media inspection',
    'background lossless proxy+progress/cancellation',
    'screen-sized decode + original evidence',
    'missing-source relink candidate and stable IDs',
    'relink undo to missing path + redo',
    'stale proxy rejected',
    'fixed cache plan actually reclaims bytes',
    'source/history/candidates/checkpoints preserved',
    'native PNG/export original parity',
    '60-frame MP4',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
