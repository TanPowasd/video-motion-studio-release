import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
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
const root = await mkdtemp(path.resolve('artifacts/source-organization-'));
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
for (const [id, color] of [
  ['old', '#5588ff'],
  ['next', '#bc88ff'],
]) {
  const canvas = createCanvas(64, 64),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#eaf2ff';
  ctx.fillRect(12, 12, 40, 5);
  await writeFile(path.join(root, id + '.png'), await canvas.encode('png'));
}
const client = new Client({ name: 'organization-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function call(name, args = {}, error) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(result.isError, true, JSON.stringify(value));
  return { value, result };
}
const source =
  "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Computed media',parameters:{},render(ctx){return[node({id:'picture',type:'image',assetId:['o','ld'].join(''),x:120+Math.sin(ctx.seconds)*20,y:120,width:64,height:64})]}});";
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const discovery = parse(
    await client.callTool({
      name: 'tools_search',
      arguments: { pluginId: 'vmotion.organization', limit: 24 },
    }),
  );
  assert.equal(discovery.total, 4);
  const before = (await call('project_context')).value.revision,
    request = {
      revision: before,
      files: [
        { type: 'replace', path: 'components/computed.ts', expectedHash: null, content: source },
      ],
      operations: [
        ...['old', 'next'].map((id) => ({
          type: 'addAsset',
          asset: {
            id,
            name: id,
            type: 'image',
            path: id + '.png',
            managed: false,
            metadata: { width: 64, height: 64 },
          },
        })),
        {
          type: 'updateScene',
          sceneId: 'intro',
          patch: {
            nodes: [
              { id: 'native', type: 'image', assetId: 'old', x: 36, y: 120, width: 64, height: 64 },
              {
                id: 'computed',
                type: 'component',
                component: 'components/computed.ts',
                width: 640,
                height: 360,
              },
              {
                id: 'overridden',
                type: 'component',
                component: 'components/computed.ts',
                width: 640,
                height: 360,
                x: 160,
                overrides: { picture: { assetId: 'old' } },
              },
              ...Array.from({ length: 60 }, (_, i) => ({
                id: 'cell-' + i,
                type: 'image',
                assetId: 'old',
                x: 8 + (i % 20) * 31,
                y: 242 + Math.floor(i / 20) * 31,
                width: 22,
                height: 22,
              })),
            ],
          },
        },
        {
          type: 'addTrack',
          sequenceId: 'main',
          track: {
            id: 'alternate',
            name: 'Alternative asset uses',
            type: 'video',
            muted: true,
            locked: false,
            clips: Array.from({ length: 60 }, (_, i) => ({
              id: 'alt-' + i,
              assetId: 'old',
              start: i,
              duration: 1,
              sourceIn: 0,
              speed: 1,
              volume: 1,
              fadeIn: 0,
              fadeOut: 0,
            })),
          },
        },
      ],
    },
    checked = (await call('project_preflight', request)).value;
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  await call('project_apply', { ...request, expectedCandidateRevision: checked.candidateRevision });
  const original = (await call('project_context')).value.revision,
    uses = (
      await call('project_references', {
        entity: { kind: 'asset', id: 'old' },
        limit: 100,
        detail: true,
      })
    ).value;
  assert.ok(uses.total > 100);
  assert.equal(uses.items.length, 100);
  assert.equal(uses.nextOffset, 100);
  assert.equal(uses.coverage.runtimeComplete, false);
  report.referenceBytes = Buffer.byteLength(JSON.stringify(uses));
  const defaultPage = (await call('project_references', { entity: { kind: 'asset', id: 'old' } }))
      .value,
    entire = (await call('project_inspect')).value;
  assert.equal(defaultPage.items.length, 24);
  assert.equal(defaultPage.total, uses.total);
  report.defaultReferenceBytes = Buffer.byteLength(JSON.stringify(defaultPage));
  report.fullProjectBytes = Buffer.byteLength(JSON.stringify(entire));
  assert.ok(report.defaultReferenceBytes < report.fullProjectBytes / 10);
  const stats = uses.index;
  for (let i = 0; i < 20; i++)
    await call('project_references', { entity: { kind: 'asset', id: 'old' }, limit: 2 });
  const warm = (
    await call('project_references', { entity: { kind: 'asset', id: 'old' }, limit: 2 })
  ).value;
  assert.equal(warm.index.scans, stats.scans);
  assert.ok(warm.index.indexHits >= 20);
  report.indexReuse = {
    requests: 21,
    newScans: warm.index.scans - stats.scans,
    accountedBytes: warm.index.indexAccountedBytes,
    budgetBytes: warm.index.indexRetainedBudgetBytes,
  };
  const uncertainty = (await call('project_references', { section: 'uncertainties' })).value;
  assert.ok(uncertainty.items.some((u) => u.file === 'components/computed.ts'));
  const runtime = (
    await call('reference_sample', {
      samples: [{ sceneId: 'intro', frame: 15 }],
      entity: { kind: 'asset', id: 'old' },
      detail: true,
      limit: 100,
    })
  ).value;
  const generated = runtime.items.find((r) => r.nodeId === 'computed/picture');
  assert.ok(generated);
  assert.deepEqual(generated.path, ['computed']);
  assert.equal(generated.localFrame, 15);
  assert.equal(generated.editable, true);
  report.runtimeBytes = Buffer.byteLength(JSON.stringify(runtime));
  const timeline = (
    await call('sequence_query', {
      source: { kind: 'asset', id: 'old' },
      range: [10, 30],
      limit: 4,
    })
  ).value;
  assert.equal(timeline.total, 20);
  assert.equal(timeline.items.length, 4);
  assert.equal(timeline.nextOffset, 4);
  assert.equal(timeline.items[0].id, 'alt-10');
  assert.equal(timeline.items[0].clip, undefined);
  report.defaultSequenceBytes = Buffer.byteLength(
    JSON.stringify((await call('sequence_query')).value),
  );
  const detailed = (await call('sequence_query', { clipIds: ['alt-10'], detail: true })).value;
  assert.equal(detailed.items[0].clip.sourceIn, 0);
  const selected = uses.items.filter(
    (e) =>
      e.nodeId === 'native' ||
      (e.nodeId === 'overridden' && e.relation === 'node-media') ||
      e.clipId === 'alt-0',
  );
  assert.equal(selected.length, 3);
  const plan = (
    await call('reference_plan', {
      revision: original,
      items: [
        {
          from: { kind: 'asset', id: 'old' },
          to: { kind: 'asset', id: 'next' },
          referenceIds: selected.map((e) => e.id),
          expectedUses: 3,
        },
      ],
    })
  ).value;
  assert.equal((await call('project_context')).value.revision, original);
  assert.equal(plan.coverage.references, 3);
  assert.equal(plan.coverage.runtimeComplete, false);
  const check = await call('project_preflight', plan.candidate);
  assert.equal(check.value.valid, true, JSON.stringify(check.value.diagnostics));
  assert.ok(check.result.content.some((c) => c.type === 'image'));
  await call('project_apply', plan.apply);
  const after = (
    await call('project_references', {
      entity: { kind: 'asset', id: 'next' },
      limit: 100,
      detail: true,
    })
  ).value;
  assert.equal(after.items.filter((r) => r.replaceable).length, 3);
  const sampled = (
    await call('reference_sample', {
      samples: [{ sceneId: 'intro', frame: 15 }],
      entity: { kind: 'asset', id: 'old' },
      detail: true,
      limit: 100,
    })
  ).value;
  assert.ok(sampled.items.some((r) => r.nodeId === 'computed/picture'));
  assert.ok(!sampled.items.some((r) => r.nodeId === 'overridden/picture'));
  assert.equal(await readFile(path.join(root, 'components/computed.ts'), 'utf8'), source);
  const reach = (
    await call('project_references', {
      section: 'reachable',
      entity: { kind: 'sequence', id: 'main' },
      direction: 'outgoing',
      limit: 100,
    })
  ).value;
  assert.ok(reach.items.some((e) => e.kind === 'asset' && e.id === 'next'));
  await call(
    'reference_plan',
    {
      revision: plan.candidateRevision,
      items: [
        {
          from: { kind: 'asset', id: 'old' },
          to: { kind: 'asset', id: 'next' },
          referenceIds: selected.map((e) => e.id),
        },
      ],
    },
    'REFERENCE_SELECTION',
  );
  await call(
    'reference_plan',
    {
      revision: plan.candidateRevision,
      items: [
        {
          from: { kind: 'asset', id: 'old' },
          to: { kind: 'asset', id: 'next' },
          expectedUses: 999,
        },
      ],
    },
    'REFERENCE_COUNT',
  );
  await call('project_references', { revision: 'stale' }, 'REVISION_CONFLICT');
  await call('sequence_query', { trackIds: ['missing'] }, 'TRACK_NOT_FOUND');
  await call('sequence_query', { range: [30, 10] }, 'TOOL_ARGUMENTS');
  assert.equal((await call('project_context')).value.revision, plan.candidateRevision);
  const pathRequest = path.join(root, 'references-request.json');
  await writeFile(pathRequest, JSON.stringify({ entity: { kind: 'asset', id: 'next' }, limit: 2 }));
  const cliValue = JSON.parse(
    execFileSync(exe, [cli, 'project-references', '--project', root, '--request', pathRequest], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(cliValue.items.length, 2);
  await client.callTool({
    name: 'tools_load',
    arguments: {
      names: ['project_references', 'sequence_query', 'reference_sample', 'reference_plan'],
    },
  });
  const direct = await client.callTool({
    name: 'project_references',
    arguments: { entity: { kind: 'asset', id: 'next' } },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).total, 4);
  const image = (
    await call('frame_capture', {
      frame: 15,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/preview.png'),
    })
  ).value;
  async function wait(id) {
    for (let i = 0; i < 300; i++) {
      const j = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        assert.equal(j.status, 'completed', JSON.stringify(j.error));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('render deadline');
  }
  const png = (
    await call('render_start', {
      revision: plan.candidateRevision,
      start: 15,
      end: 16,
      format: 'png',
      output: path.join(root, 'exports/parity'),
      width: 640,
      height: 360,
    })
  ).value;
  await wait(png.id);
  assert.equal(
    (await readFile(image.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000015.png')),
    ),
    true,
  );
  const video = (
    await call('render_start', {
      revision: plan.candidateRevision,
      output: path.join(root, 'exports/organization.mp4'),
      width: 640,
      height: 360,
    })
  ).value;
  await wait(video.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'exports/organization.mp4')],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, original);
  assert.equal(await readFile(path.join(root, 'components/computed.ts'), 'utf8'), source);
  report.checks = [
    'compact discovery; four organization capabilities',
    'declared 100-item pages with unknown dynamic code explicitly marked',
    '21 unchanged queries reuse exact text index with no new scans',
    'runtime generated references and editable retimed locators',
    'source/range timeline pages and selected full clip opt-in',
    'selective native/generated override/muted clip swap with media evidence',
    'exact preflight/apply and one undo; original source/window preserved',
    'stale/invalid/count/unsupported selection errors preserve revision',
    'CLI current-service bridge and directly loaded MCP tools',
    'native images without duplicate JSON media; identical preview/export PNG and 60-frame MP4',
  ];
  report.output = path.join(root, 'exports/organization.mp4');
  report.passed = true;
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
