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
const root = await mkdtemp(path.resolve('artifacts/render-compare-'));
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
const client = new Client({ name: 'runtime-compare-check', version: '1.0.0' }),
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
    "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Green subject',parameters:{},render(ctx){return[node({id:'screen',type:'rect',width:640,height:360,fill:'#00ff00'}),node({id:'subject',type:'ellipse',x:235+Math.sin(ctx.seconds)*30,y:120,width:90,height:100,fill:'#fa9b69'})]}});",
  graph = {
    kind: 'effect-graph',
    version: 1,
    name: 'Key and optimized grade',
    parameters: { threshold: { type: 'number', default: 0.1, min: 0, max: 0.4 } },
    nodes: [
      { id: 'src', type: 'input' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 'step' + i,
        type: 'transform',
        input: i ? 'step' + (i - 1) : 'src',
        space: 'canvas',
      })),
      {
        id: 'key',
        type: 'keyer',
        input: 'step29',
        color: '#00ff00',
        threshold: 0.1,
        softness: 0.1,
        spill: 0.6,
      },
      {
        id: 'grade',
        type: 'colorMatrix',
        input: 'key',
        matrix: [0.8, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 1, 0],
      },
    ],
    links: [{ nodeId: 'key', property: 'threshold', parameter: 'threshold' }],
    output: 'grade',
    outputs: { color: 'grade', matte: 'key' },
  };
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const original = (await call('project_context')).value.revision,
    setup = {
      revision: original,
      files: [
        { type: 'replace', path: 'components/green.ts', expectedHash: null, content: source },
      ],
      operations: [
        {
          type: 'addNode',
          sceneId: 'intro',
          node: {
            id: 'green',
            type: 'component',
            component: 'components/green.ts',
            width: 640,
            height: 360,
          },
        },
      ],
    },
    check = (await call('project_preflight', setup)).value;
  assert.equal(check.valid, true, JSON.stringify(check.diagnostics));
  await call('project_apply', { ...setup, expectedCandidateRevision: check.candidateRevision });
  const before = (await call('project_context')).value.revision;
  const grouped = (
    await call('effect_graph_plan', {
      revision: before,
      source: 'components/effects/key.json',
      graph,
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'green',
          effectId: 'green-key',
          params: { threshold: 0.1 },
          keys: [
            {
              parameter: 'threshold',
              keys: [
                { frame: 0, value: 0.08, easing: 'linear' },
                { frame: 59, value: 0.12, easing: 'linear' },
              ],
            },
          ],
        },
      ],
    })
  ).value;
  const compared = await call('render_compare', {
      planId: grouped.candidate.planId,
      sceneId: 'intro',
      frames: [0, 12, 29, 45, 59],
      repeat: 2,
      width: 640,
      height: 360,
    }),
    candidate = compared.value;
  assert.equal(candidate.revision, grouped.candidateRevision);
  assert.equal(candidate.equivalence.matched, true);
  assert.equal((await call('project_context')).value.revision, before);
  assert.ok(candidate.optimized.graph.passthroughs >= 300);
  assert.ok(candidate.optimized.graph.surfaces < candidate.baseline.graph.surfaces / 5);
  assert.ok(candidate.optimized.graph.scalarPixels < candidate.baseline.graph.scalarPixels * 0.6);
  assert.equal(candidate.optimized.samples, undefined);
  assert.ok(
    candidate.optimized.graphNodes.items.some(
      (n) => n.ownerId === 'green' && n.effectId === 'green-key',
    ),
  );
  assert.ok(!JSON.stringify(compared.result.structuredContent).includes('base64'));
  report.compactBytes = Buffer.byteLength(JSON.stringify(candidate));
  const full = (
    await call('render_compare', {
      planId: grouped.candidate.planId,
      sceneId: 'intro',
      frames: [0, 12, 29, 45, 59],
      repeat: 2,
      width: 640,
      height: 360,
      detail: true,
      order: 'optimized-first',
    })
  ).value;
  assert.equal(full.equivalence.matched, true);
  assert.equal(full.equivalence.pairs.length, 10);
  report.fullBytes = Buffer.byteLength(JSON.stringify(full));
  await call('render_compare', { revision: 'stale' }, 'REVISION_CONFLICT');
  await call('render_compare', { baseline: { graphTileRows: -1 } }, 'TOOL_ARGUMENTS');
  await call('render_compare', { optimized: { unexpected: true } }, 'TOOL_ARGUMENTS');
  const checked = await call('project_preflight', grouped.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  assert.ok(checked.result.content.some((c) => c.type === 'image'));
  await call('project_apply', grouped.apply);
  const profile = (
    await call('render_profile', {
      sceneId: 'intro',
      frames: [12, 45],
      repeat: 2,
      width: 640,
      height: 360,
      graphDetail: true,
      graphNodeLimit: 3,
    })
  ).value;
  assert.equal(profile.graphNodes.returned, 3);
  assert.equal(profile.cache.graphScratchBytes, 0);
  const query = (
    await call('effect_graph_query', {
      source: { sceneId: 'intro', nodeId: 'green', effectId: 'green-key' },
      ids: ['key'],
      detail: true,
    })
  ).value;
  assert.equal(query.items[0].values.type, 'keyer');
  const request = path.join(root, 'compare-request.json');
  await writeFile(
    request,
    JSON.stringify({ sceneId: 'intro', frames: [29], repeat: 1, width: 640, height: 360 }),
  );
  const cliValue = JSON.parse(
    execFileSync(exe, [cli, 'render-compare', '--project', root, '--request', request], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(cliValue.equivalence.matched, true);
  await client.callTool({ name: 'tools_load', arguments: { names: ['render_compare'] } });
  const direct = await client.callTool({
    name: 'render_compare',
    arguments: { sceneId: 'intro', frames: [29], repeat: 1, width: 640, height: 360 },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).equivalence.matched, true);
  const frame = (
    await call('frame_capture', {
      frame: 29,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/preview.png'),
    })
  ).value;
  async function wait(id) {
    for (let i = 0; i < 300; i++) {
      const job = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'completed', JSON.stringify(job.error));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('render deadline');
  }
  const png = (
    await call('render_start', {
      revision: grouped.candidateRevision,
      format: 'png',
      start: 29,
      end: 30,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/parity'),
    })
  ).value;
  await wait(png.id);
  assert.equal(
    (await readFile(frame.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000029.png')),
    ),
    true,
  );
  const video = (
    await call('render_start', {
      revision: grouped.candidateRevision,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/keyer.mp4'),
    })
  ).value;
  await wait(video.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'exports/keyer.mp4')],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  assert.equal(await readFile(path.join(root, 'components/green.ts'), 'utf8'), source);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  report.comparison = {
    equivalence: candidate.equivalence,
    difference: candidate.difference,
    baseline: candidate.baseline.graph,
    optimized: candidate.optimized.graph,
    scratch: {
      baseline: candidate.baseline.graphScratchPeakBytes,
      optimized: candidate.optimized.graphScratchPeakBytes,
    },
    tracking: candidate.optimized.graphNodes,
  };
  report.checks = [
    '10-entry discovery and namespaced runtime capabilities',
    'candidate comparison before save and unchanged project revision',
    'baseline/optimized exact pixels and reduced real surface/scalar work',
    'reverse-order/full paired evidence and bounded node locators',
    'invalid/stale parameters preserve project',
    'UV keyer linked parameters and native pictures',
    'current-service CLI and loaded direct MCP parity',
    'preview/export identical PNG and 60-frame MP4',
    'author source preserved and one undo',
  ];
  report.output = path.join(root, 'exports/keyer.mp4');
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
