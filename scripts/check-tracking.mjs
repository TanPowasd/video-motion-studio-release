import { mkdir, mkdtemp, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
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
const root = await mkdtemp(path.resolve('artifacts/tracking-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--template',
    'blank',
    '--width',
    '320',
    '--height',
    '180',
    '--duration',
    '1',
  ],
  { env, windowsHide: true },
);
await mkdir(path.join(root, 'input'));
for (let frame = 0; frame < 24; frame++) {
  const c = createCanvas(320, 180),
    g = c.getContext('2d'),
    rgba = g.createImageData(320, 180);
  for (let y = 0; y < 180; y++)
    for (let x = 0; x < 320; x++) {
      const px = x - frame,
        py = y - Math.floor(frame / 4),
        v = Math.round(
          125 +
            39 * Math.sin(px * 0.31) +
            32 * Math.sin(py * 0.39) +
            28 * Math.sin((px + py) * 0.19),
        ),
        i = (y * 320 + x) * 4;
      rgba.data[i] = rgba.data[i + 1] = rgba.data[i + 2] = v;
      rgba.data[i + 3] = 255;
    }
  g.putImageData(rgba, 0, 0);
  await writeFile(
    path.join(root, `input/${String(frame).padStart(3, '0')}.png`),
    await c.encode('png'),
  );
  c.width = 1;
}
const sourceFile = path.join(root, 'source.mkv');
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-framerate',
    '30',
    '-i',
    path.join(root, 'input/%03d.png'),
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'bgra',
    sourceFile,
  ],
  { windowsHide: true },
);
const points = [
    { id: 'tl', x: 65, y: 50 },
    { id: 'tr', x: 210, y: 50 },
    { id: 'br', x: 210, y: 125 },
    { id: 'bl', x: 65, y: 125 },
  ],
  client = new Client({ name: 'motion-tracking-real-client', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, schemas: [] };
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function call(name, args = {}) {
  const result = await client.callTool(
    ['tools_search', 'tool_schema', 'tools_load'].includes(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return { value: parse(result), raw: result };
}
async function invalid(name, args, code) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, code);
}
async function wait(id) {
  for (let i = 0; i < 200; i++) {
    const j = (await call('tracking_analyze', { action: 'status', id })).value;
    if (!['running', 'queued'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error('Tracking job did not finish');
}
try {
  await client.connect(transport);
  const module = (await call('plugins_inspect', { id: 'vmotion.tracking' })).value.items[0];
  assert.equal(module.runtime, 'module');
  assert.equal(module.moduleTools, 4);
  assert.equal(module.hostTools, 0);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.initialCatalogBytes = bytes(initial);
  assert.ok(report.initialCatalogBytes < 16000);
  const found = (await call('tools_search', { query: '跟踪 稳定', limit: 8 })).value;
  assert.ok(found.items.some((t) => t.name === 'tracking_plan'));
  for (const name of ['tracking_analyze', 'tracking_plan', 'tracking_inspect']) {
    const schema = (await call('tool_schema', { name })).value,
      expanded = (await call('tool_schema', { name, format: 'expanded' })).value,
      cached = (await call('tool_schema', { name, ifHash: schema.schemaHash })).value;
    assert.equal(cached.notModified, true);
    assert.ok(bytes(cached) < 250);
    report.schemas.push({
      name,
      compactBytes: bytes(schema),
      expandedBytes: bytes(expanded),
      cachedBytes: bytes(cached),
    });
  }
  await call('asset_import', { path: sourceFile, type: 'video' });
  const context = (await call('project_context')).value;
  const full = (await call('project_inspect')).value,
    asset = full.snapshot.project.assets[0];
  const source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Tracked shot',parameters:{},render(){return [node({id:'footage',type:'video',assetId:${JSON.stringify(asset.id)},width:320,height:180}),node({id:'label',type:'text',text:'TRACKED',fontSize:16,x:72,y:28,width:100,height:30,fill:'#ffffff'}),node({id:'insert',type:'rect',width:320,height:180,fill:'#559977'})]}});`;
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/shot.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'comp',
          type: 'component',
          component: 'components/shot.ts',
          width: 320,
          height: 180,
        },
      },
      { type: 'updateSequence', sequenceId: 'main', patch: { duration: 24 } },
    ],
  });
  const before = (await call('project_context')).value.revision;
  await invalid(
    'tracking_analyze',
    { request: { assetId: asset.id, revision: 'stale', end: 24 } },
    'REVISION_CONFLICT',
  );
  await invalid(
    'tracking_analyze',
    { request: { assetId: asset.id, end: 4000 } },
    'TRACKING_RANGE',
  );
  const started = (
    await call('tracking_analyze', {
      request: {
        assetId: asset.id,
        revision: before,
        end: 24,
        width: 320,
        points: points.map((p) => ({ id: p.id, seeds: [{ frame: 0, x: p.x, y: p.y }] })),
      },
    })
  ).value;
  report.jobBytes = bytes(started);
  assert.ok(report.jobBytes < 400);
  const job = await wait(started.id);
  assert.equal(job.status, 'completed');
  report.analysis = job.metrics;
  const info = (
      await call('tracking_inspect', { analysisId: job.analysisId, limit: 2, frames: [0, 12, 23] })
    ).value,
    detail = (
      await call('tracking_inspect', {
        analysisId: job.analysisId,
        limit: 32,
        frames: [0, 12, 23],
        detail: true,
      })
    ).value;
  assert.equal(info.points.items.length, 2);
  assert.equal(info.points.nextOffset, 2);
  assert.equal(info.points.items[0].lost, 0);
  assert.ok(Math.abs(info.points.items[0].samples[1].x - 77) < 0.2);
  report.inspectBytes = { compact: bytes(info), full: bytes(detail) };
  assert.equal((await call('project_context')).value.revision, before);
  const image = await call('tracking_evidence', {
    analysisId: job.analysisId,
    frames: [0, 12, 23],
    width: 320,
  });
  assert.ok(image.raw.content.some((c) => c.type === 'image'));
  assert.ok(!JSON.stringify(image.value).includes('base64'));
  await writeFile(
    path.join(root, 'tracking-evidence.png'),
    Buffer.from(image.raw.content.find((c) => c.type === 'image').data, 'base64'),
  );
  const plan = (
    await call('tracking_plan', {
      analysisId: job.analysisId,
      revision: before,
      bindings: [
        {
          sceneId: 'intro',
          path: ['comp'],
          sourceNodeId: 'comp/footage',
          targetNodeId: 'comp/label',
          mode: 'point',
          pointIds: ['tl'],
          endFrame: 24,
        },
        {
          sceneId: 'intro',
          path: ['comp'],
          sourceNodeId: 'comp/footage',
          targetNodeId: 'comp/insert',
          mode: 'cornerPin',
          pointIds: points.map((p) => p.id),
          endFrame: 24,
        },
      ],
    })
  ).value;
  report.planBytes = bytes(plan);
  assert.ok(report.planBytes < 3500);
  assert.equal((await call('project_context')).value.revision, before);
  const checked = await call('project_preflight', plan.candidate);
  assert.equal(checked.value.valid, true);
  assert.ok(checked.raw.content.some((c) => c.type === 'image'));
  await call('project_apply', plan.apply);
  const current = (await call('project_context')).value.revision;
  assert.equal(current, plan.candidateRevision);
  const animation = (
    await call('animation_inspect', {
      sceneId: 'intro',
      path: ['comp'],
      nodeId: 'comp/label',
      frames: [12],
      properties: ['matrix.4', 'matrix.5'],
    })
  ).value;
  assert.ok(Math.abs(animation.samples[0].values['matrix.4'] - 12) < 0.2);
  const profile = (
    await call('render_profile', { sceneId: 'intro', frames: [23, 0, 12], width: 320, repeat: 2 })
  ).value;
  assert.deepEqual(profile.determinism.mismatchFrames, []);
  report.renderWarmMs = profile.summary.warmMeanMs;
  const direct = (
      await call('render_profile', {
        sceneId: 'intro',
        frames: [0, 1, 2, 3, 4, 5, 6, 7],
        width: 320,
        repeat: 1,
        mediaFraming: 'direct',
      })
    ).value,
    concat = (
      await call('render_profile', {
        sceneId: 'intro',
        frames: [0, 1, 2, 3, 4, 5, 6, 7],
        width: 320,
        repeat: 1,
        mediaFraming: 'concat',
      })
    ).value;
  assert.deepEqual(direct.frames, concat.frames);
  const copied = (p) => p.media.decoders.reduce((n, d) => n + d.copiedBytes, 0);
  assert.ok(copied(concat) > copied(direct) * 1.8);
  report.decodeFraming = {
    directCopiedBytes: copied(direct),
    concatCopiedBytes: copied(concat),
    directMeanMs: direct.summary.meanRenderMs,
    concatMeanMs: concat.summary.meanRenderMs,
  };
  const hashes = new Map();
  for (const frame of [23, 0, 12, 23, 12]) {
    const r = await call('frame_capture', { frame, width: 320, height: 180 }),
      data = r.raw.content.find((c) => c.type === 'image').data;
    if (hashes.has(frame)) assert.equal(data, hashes.get(frame));
    else hashes.set(frame, data);
    await writeFile(path.join(root, `frame-${frame}.png`), Buffer.from(data, 'base64'));
  }
  const output = path.join(root, 'tracked.mp4'),
    render = (await call('render_start', { output, format: 'mp4', revision: current })).value;
  let done;
  for (let i = 0; i < 100; i++) {
    done = (await call('render_status', { id: render.id })).value;
    if (!['queued', 'running'].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(done.status, 'completed');
  const streams = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  ).streams;
  assert.equal(streams.find((s) => s.codec_type === 'video').nb_frames, '24');
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  assert.equal(await readFile(path.join(root, 'components/shot.ts'), 'utf8'), source);
  const stable = (
    await call('tracking_plan', {
      analysisId: job.analysisId,
      revision: before,
      bindings: [
        {
          sceneId: 'intro',
          path: ['comp'],
          sourceNodeId: 'comp/footage',
          targetNodeId: 'comp/footage',
          mode: 'stabilize',
          model: 'translation',
          pointIds: points.map((p) => p.id),
          endFrame: 24,
          smoothingRadius: 3,
          zoom: 1.08,
        },
      ],
    })
  ).value;
  assert.equal((await call('project_preflight', stable.candidate)).value.valid, true);
  await call('project_apply', stable.apply);
  assert.equal(
    (await call('tracking_inspect', { file: stable.resource.file })).value.points.total,
    4,
  );
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  const cancelled = (
    await call('tracking_analyze', { request: { assetId: asset.id, end: 24, width: 320 } })
  ).value;
  await call('tracking_analyze', { action: 'cancel', id: cancelled.id });
  assert.equal((await wait(cancelled.id)).status, 'cancelled');
  await writeFile(
    path.join(root, 'tracking-cli-request.json'),
    JSON.stringify({
      wait: true,
      request: {
        assetId: asset.id,
        end: 8,
        width: 320,
        points: [{ id: 'cli', seeds: [{ frame: 0, x: 65, y: 50 }] }],
      },
    }),
  );
  const cliJob = JSON.parse(
    execFileSync(
      executable,
      [
        cli,
        'tracking-analyze',
        '--project',
        root,
        '--request',
        path.join(root, 'tracking-cli-request.json'),
      ],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliJob.status, 'completed');
  await call('media_proxy', { action: 'release' });
  const backup = path.join(root, 'backup.mkv');
  await copyFile(sourceFile, backup);
  await writeFile(sourceFile, Buffer.from('changed'));
  await invalid('tracking_plan', { analysisId: job.analysisId, revision: before }, 'ASSET_CHANGED');
  await copyFile(backup, sourceFile);
  await call('tools_load', { categories: ['media', 'animation'] });
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'tracking_evidence'));
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  report.checks = [
    'compact discovery/schema hashes',
    'background worker progress',
    'paged point quality',
    'native annotated source evidence without media duplication',
    'generated attachment/corner-pin candidate and source preservation',
    'exact preflight/apply/undo',
    'random frame/hash consistency',
    '24-frame MP4',
    'stabilization/smoothing/zoom',
    'cancel',
    'CLI live-bridge parity',
    'stale revision/range/source rejection',
    'on-demand loading',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
