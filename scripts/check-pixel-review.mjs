import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  exe = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...process.env,
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/pixel-review-'));
execFileSync(
  exe,
  [
    cli,
    'init',
    '--project',
    root,
    '--template',
    'blank',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'pixel-review-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = {
    root,
    packaged,
    metric: 'JSON UTF-8 bytes, not model-specific token estimates',
    checks: [],
  },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function call(name, args = {}, error) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(result.isError, true, JSON.stringify(value));
  return { value, result };
}
function nativeMedia(result) {
  assert.equal(result.content.filter((c) => c.type === 'image').length, 1);
  const value = parse(result);
  assert.equal(value.data, undefined);
  assert.equal(result.structuredContent.data, undefined);
  assert.equal(
    JSON.stringify(value).includes(
      result.content.find((c) => c.type === 'image').data.slice(0, 100),
    ),
    false,
  );
}
async function wait(id) {
  for (let i = 0; i < 300; i++) {
    const job = (await call('render_status', { id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      assert.equal(job.status, 'completed', JSON.stringify(job.error));
      return job;
    }
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error('Render timeout');
}
const source =
  "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Pixel scene',parameters:{},render(ctx){return[node({id:'moving',type:'rect',x:280+Math.sin(ctx.seconds)*12,y:140,width:90,height:65,fill:'#56cbaa'}),node({id:'label',type:'text',text:'真实像素 / 准确候选',x:30,y:28,width:560,height:50,fontSize:28,fill:'#eef3ff'})]}});";
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 10);
  report.startupCatalogBytes = bytes(catalog);
  const discovered = parse(
    await client.callTool({
      name: 'tools_search',
      arguments: { pluginId: 'vmotion.review', limit: 24 },
    }),
  );
  assert.equal(discovered.total, 7);
  report.schemas = [];
  for (const name of ['color_scopes', 'frame_compare', 'layer_impact']) {
    const schema = parse(await client.callTool({ name: 'tool_schema', arguments: { name } })),
      cached = parse(
        await client.callTool({
          name: 'tool_schema',
          arguments: { name, ifHash: schema.schemaHash },
        }),
      );
    assert.equal(schema.annotations.readOnlyHint, true);
    assert.equal(cached.notModified, true);
    assert.ok(bytes(cached) < 250);
    report.schemas.push({ name, bytes: bytes(schema), cachedBytes: bytes(cached) });
  }
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/pixels.ts', content: source },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#121c2d',
          nodes: [
            { id: 'covered', type: 'rect', x: 36, y: 140, width: 70, height: 65, fill: '#ff5555' },
            { id: 'cover', type: 'rect', x: 34, y: 138, width: 74, height: 70, fill: '#679dff' },
            { id: 'mask', type: 'rect', x: 170, y: 140, width: 35, height: 65, fill: '#ffffff' },
            {
              id: 'masked',
              type: 'rect',
              x: 170,
              y: 140,
              width: 70,
              height: 65,
              fill: '#b28aff',
              maskId: 'mask',
            },
            {
              id: 'art',
              type: 'component',
              component: 'components/pixels.ts',
              width: 640,
              height: 360,
            },
          ],
        },
      },
    ],
  });
  const revision = (await call('project_context')).value.revision;
  const compact = await call('color_scopes', {
    revision,
    scope: { sceneId: 'intro' },
    frames: [0],
    width: 320,
  });
  nativeMedia(compact.result);
  assert.equal(compact.value.samples[0].histogram, undefined);
  const full = (
    await call('color_scopes', {
      revision,
      scope: { sceneId: 'intro' },
      frames: [0],
      width: 320,
      includeDistributions: true,
      images: false,
    })
  ).value;
  assert.equal(full.samples[0].pixelHash, compact.value.samples[0].pixelHash);
  report.scopeCompactBytes = bytes(compact.value);
  report.scopeFullBytes = bytes(full);
  assert.ok(report.scopeCompactBytes < report.scopeFullBytes / 4);
  const sampled = (
    await call('color_scopes', {
      scope: { sequenceId: 'main' },
      width: 320,
      region: { x: 0, y: 0, width: 160, height: 90 },
      analysis: 'sampled',
      maxSamples: 256,
      images: false,
    })
  ).value;
  assert.equal(sampled.samples[0].coverage.fullPixelCoverage, false);
  const impact = await call('layer_impact', {
    revision,
    sceneId: 'intro',
    nodeIds: ['covered', 'cover', 'mask', 'art/moving'],
    frames: [0, 30],
    width: 320,
    maxImages: 2,
  });
  nativeMedia(impact.result);
  assert.equal(impact.value.samples.length, 8);
  assert.equal(impact.value.samples[0].changedPixels, 0);
  assert.ok(impact.value.samples[1].changedPixels > 0);
  assert.equal(impact.value.samples[2].dependencySensitive, true);
  assert.ok(impact.value.samples[3].locator.path.includes('art'));
  assert.equal(impact.value.coverage.omittedImages, 6);
  report.impactBytes = bytes(impact.value);
  assert.equal((await call('project_context')).value.revision, revision);
  assert.equal(await readFile(path.join(root, 'components/pixels.ts'), 'utf8'), source);
  const planned = (
    await call('visual_repair_plan', {
      revision,
      sceneId: 'intro',
      frame: 0,
      frames: [0, 30, 59],
      targets: [{ nodeId: 'art/moving', actions: [{ type: 'move', delta: { x: 45, y: 20 } }] }],
    })
  ).value;
  const compared = await call('frame_compare', {
    revision,
    planId: planned.candidate.planId,
    scope: { sceneId: 'intro' },
    frames: [0, 30, 59],
    width: 320,
  });
  nativeMedia(compared.result);
  assert.equal(compared.value.revision, planned.candidateRevision);
  assert.equal(compared.value.summary.changedFrames, 3);
  assert.equal(compared.value.summary.nondeterministicFrames, 0);
  report.compareBytes = bytes(compared.value);
  const candidateImpact = (
    await call('layer_impact', {
      revision,
      planId: planned.candidate.planId,
      sceneId: 'intro',
      nodeIds: ['art/moving'],
      width: 320,
      images: false,
    })
  ).value;
  assert.equal(candidateImpact.revision, planned.candidateRevision);
  const candidateScopes = (
    await call('color_scopes', {
      revision,
      planId: planned.candidate.planId,
      width: 320,
      images: false,
    })
  ).value;
  assert.equal(candidateScopes.samples[0].pixelHash, compared.value.samples[0].afterHash);
  const reverse = (
    await call('frame_compare', {
      revision,
      baselinePlanId: planned.candidate.planId,
      scope: { sceneId: 'intro' },
      width: 320,
      images: false,
    })
  ).value;
  assert.equal(reverse.samples[0].beforeHash, compared.value.samples[0].afterHash);
  assert.equal(reverse.samples[0].afterHash, compared.value.samples[0].beforeHash);
  for (const name of ['color_scopes', 'frame_compare'])
    await call(name, { revision: 'stale', images: false }, 'REVISION_CONFLICT');
  await call(
    'layer_impact',
    { revision: 'stale', sceneId: 'intro', nodeIds: ['cover'], images: false },
    'REVISION_CONFLICT',
  );
  await call('color_scopes', { width: 5000 }, 'TOOL_ARGUMENTS');
  await call('frame_compare', { unexpected: true }, 'TOOL_ARGUMENTS');
  await call(
    'layer_impact',
    { sceneId: 'intro', nodeIds: ['missing'], images: false },
    'NOT_FOUND',
  );
  await call(
    'layer_impact',
    { sceneId: 'intro', nodeIds: ['cover', 'cover'], images: false },
    'IMPACT_SELECTION',
  );
  await call(
    'color_scopes',
    { scope: { sceneId: 'intro', sequenceId: 'main' }, images: false },
    'REVIEW_SCOPE',
  );
  await call('color_scopes', { frames: [60], images: false }, 'FRAME_RANGE');
  await call(
    'frame_compare',
    { frames: [0], compareFrames: [0, 1], images: false },
    'REVIEW_FRAMES',
  );
  await call(
    'frame_compare',
    { width: 160, region: { x: 160, y: 0, width: 1, height: 1 }, images: false },
    'PIXEL_REGION',
  );
  assert.equal((await call('project_context')).value.revision, revision);
  await client.callTool({
    name: 'tools_load',
    arguments: { names: ['color_scopes', 'frame_compare', 'layer_impact'] },
  });
  const direct = await client.callTool({
    name: 'color_scopes',
    arguments: { width: 160, images: false },
  });
  assert.notEqual(direct.isError, true);
  const requestFile = path.join(root, 'compare-request.json');
  await writeFile(
    requestFile,
    JSON.stringify({ revision, planId: planned.candidate.planId, width: 320, images: false }),
  );
  const cliValue = JSON.parse(
    execFileSync(
      exe,
      [cli, 'frame-compare', '--project', root, '--request', requestFile, '--json'],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliValue.samples[0].afterHash, compared.value.samples[0].afterHash);
  const checked = await call('project_preflight', planned.candidate);
  assert.equal(checked.value.valid, true);
  await call('project_apply', planned.apply);
  assert.equal((await call('project_context')).value.revision, planned.candidateRevision);
  assert.equal(await readFile(path.join(root, 'components/pixels.ts'), 'utf8'), source);
  await call(
    'frame_compare',
    { planId: planned.candidate.planId, images: false },
    'REVISION_CONFLICT',
  );
  const current = (await call('frame_compare', { width: 320, images: false })).value;
  assert.equal(current.samples[0].beforeHash, compared.value.samples[0].afterHash);
  assert.equal(current.samples[0].changedPixels, 0);
  const frame = (
    await call('frame_capture', {
      frame: 30,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/preview.png'),
    })
  ).value;
  const png = (
    await call('render_start', {
      revision: planned.candidateRevision,
      format: 'png',
      start: 30,
      end: 31,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/parity'),
    })
  ).value;
  await wait(png.id);
  assert.ok(
    (await readFile(frame.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    ),
  );
  const video = (
    await call('render_start', {
      revision: planned.candidateRevision,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/review.mp4'),
    })
  ).value;
  await wait(video.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'exports/review.mp4')],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, revision);
  assert.equal(await readFile(path.join(root, 'components/pixels.ts'), 'utf8'), source);
  report.checks = [
    '10-entry compact startup / seven review tools / cached schemas',
    'compact vs full scopes / sampled ROI / single native media',
    'covered and masked final composite impact / generated locators / omitted images',
    'exact candidate before-after and reversed baseline / readonly source/history',
    'negative schema/scope/frame/ROI/stale/ID requests preserve state',
    'direct tool load / packaged CLI current-service bridge',
    'exact preflight/apply / stable PNG preview-export parity / 60-frame MP4 / one undo',
  ];
  report.output = path.join(root, 'exports/review.mp4');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
