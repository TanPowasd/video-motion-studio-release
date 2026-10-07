import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
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
const root = await mkdtemp(path.resolve('artifacts/graph-outputs-'));
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
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'graph-outputs-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = {
    root,
    packaged,
    metric: 'JSON UTF-8 bytes and local timings; no model token estimate',
    checks: [],
  },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function call(name, args = {}, error) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(result.isError, true, JSON.stringify(value));
  return { result, value };
}
const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Agent picture',parameters:{},render(ctx){return [node({id:'shape',type:'rect',x:12+ctx.frame/2,y:110,width:110,height:85,fill:'#cc8833'})]}});",
  childFile = 'components/effects/shared.json',
  rootFile = 'components/effects/root.json',
  child = {
    kind: 'effect-graph',
    version: 1,
    name: 'Color and alpha',
    parameters: { gain: { type: 'number', default: 1, min: 0.2, max: 2 } },
    nodes: [
      { id: 'src', type: 'input' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 'step' + i,
        type: 'transform',
        input: i ? 'step' + (i - 1) : 'src',
      })),
      {
        id: 'grade',
        type: 'colorMatrix',
        input: 'step29',
        colorSpace: 'linear',
        matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
      },
      {
        id: 'matte',
        type: 'channels',
        red: 1,
        green: 1,
        blue: 1,
        alpha: { input: 'src', channel: 'alpha' },
      },
    ],
    links: [{ nodeId: 'grade', property: 'matrix.0', parameter: 'gain' }],
    output: 'grade',
    outputs: { color: 'grade', matte: 'matte' },
  },
  graph = {
    kind: 'effect-graph',
    version: 1,
    name: 'Reusable two-output graph',
    parameters: {
      exposure: { type: 'number', default: 1, min: 0.2, max: 2 },
      samples: {
        type: 'array',
        items: { type: 'number', default: 0 },
        default: Array.from({ length: 2000 }, (_, i) => i),
        maxLength: 3000,
      },
    },
    nodes: [
      { id: 'src', type: 'input' },
      {
        id: 'color',
        type: 'subgraph',
        source: childFile,
        output: 'color',
        inputs: { source: 'src' },
      },
      {
        id: 'alpha',
        type: 'subgraph',
        source: childFile,
        output: 'matte',
        inputs: { source: 'src' },
      },
    ],
    links: [{ nodeId: 'color', property: 'params.gain', parameter: 'exposure' }],
    output: 'color',
    outputs: { picture: 'color', matte: 'alpha' },
  };
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const search = parse(
    await client.callTool({ name: 'tools_search', arguments: { query: 'effect_graph_query' } }),
  );
  assert.ok(search.items.some((i) => i.name === 'effect_graph_query'));
  const before = (await call('project_context')).value.revision,
    setup = {
      revision: before,
      files: [{ type: 'replace', path: 'components/card.ts', expectedHash: null, content: source }],
      operations: [
        {
          type: 'updateScene',
          sceneId: 'intro',
          patch: {
            background: 'transparent',
            nodes: [
              {
                id: 'native',
                type: 'rect',
                x: 320,
                y: 110,
                width: 130,
                height: 85,
                fill: '#4477cc',
              },
              {
                id: 'code',
                type: 'component',
                component: 'components/card.ts',
                width: 640,
                height: 360,
              },
            ],
          },
        },
      ],
    },
    checked = (await call('project_preflight', setup)).value;
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  await call('project_apply', { ...setup, expectedCandidateRevision: checked.candidateRevision });
  const initial = (await call('project_context')).value.revision,
    plan = (
      await call('effect_graph_plan', {
        revision: initial,
        source: rootFile,
        graph,
        resources: [{ file: childFile, graph: child }],
        targets: [
          {
            sceneId: 'intro',
            nodeId: 'native',
            effectId: 'native-graph',
            output: 'picture',
            keys: [
              {
                parameter: 'exposure',
                keys: [
                  { frame: 0, value: 0.6, easing: 'linear' },
                  { frame: 59, value: 1.2, easing: 'linear' },
                ],
              },
            ],
          },
          {
            sceneId: 'intro',
            path: ['code'],
            nodeId: 'code/shape',
            effectId: 'code-graph',
            output: 'matte',
          },
        ],
      })
    ).value,
    preflight = await call('project_preflight', plan.candidate);
  assert.equal(preflight.value.valid, true, JSON.stringify(preflight.value.diagnostics));
  assert.ok(preflight.result.content.some((c) => c.type === 'image'));
  await call('project_apply', plan.apply);
  assert.equal((await call('project_context')).value.revision, plan.candidateRevision);
  assert.equal(await readFile(path.join(root, 'components/card.ts'), 'utf8'), source);
  const query = (
      await call('effect_graph_query', {
        source: { sceneId: 'intro', nodeId: 'native', effectId: 'native-graph' },
        revision: plan.candidateRevision,
      })
    ).value,
    complete = (
      await call('effect_graph_inspect', {
        source: { sceneId: 'intro', nodeId: 'native', effectId: 'native-graph' },
        includeGraph: true,
      })
    ).value;
  assert.equal(query.items.length, 24);
  assert.ok(query.total > 24);
  assert.equal(query.nextOffset, 24);
  assert.equal(query.parameters, undefined);
  assert.equal(query.parameterSchema, undefined);
  report.queryBytes = Buffer.byteLength(JSON.stringify(query));
  report.fullBytes = Buffer.byteLength(JSON.stringify(complete));
  assert.ok(report.queryBytes < report.fullBytes * 0.4);
  const tail = (
    await call('effect_graph_query', { source: { file: rootFile }, offset: 24, detail: true })
  ).value;
  assert.ok(tail.items.some((n) => n.type === 'colorMatrix' && n.values.matrix.length === 20));
  const params = (
    await call('effect_graph_query', {
      source: { file: rootFile },
      section: 'parameters',
      ids: ['samples'],
    })
  ).value;
  assert.equal(params.items[0].value.length, 2000);
  assert.deepEqual(params.items[0].value.items, [0, 1, 2, 3]);
  const detail = (
    await call('effect_graph_query', {
      source: { file: rootFile },
      section: 'parameters',
      ids: ['samples'],
      detail: true,
    })
  ).value;
  assert.equal(detail.items[0].value.length, 2000);
  assert.ok(detail.items[0].schema);
  const matte = (await call('effect_graph_query', { source: { file: rootFile }, output: 'matte' }))
    .value;
  assert.equal(matte.selectedOutput, 'matte');
  assert.equal(matte.total, 4);
  const outputs = (
    await call('effect_graph_query', { source: { file: rootFile }, section: 'outputs' })
  ).value;
  assert.deepEqual(
    outputs.items.map((o) => o.name),
    ['picture', 'matte'],
  );
  await call(
    'effect_graph_query',
    { source: { file: rootFile }, revision: 'stale' },
    'REVISION_CONFLICT',
  );
  await call(
    'effect_graph_query',
    { source: { file: rootFile }, ids: ['missing'] },
    'EFFECT_GRAPH_INPUT',
  );
  await call(
    'effect_graph_query',
    { source: { file: rootFile }, output: 'missing' },
    'EFFECT_GRAPH_OUTPUT',
  );
  await call('effect_graph_query', { source: { file: rootFile }, limit: 101 }, 'TOOL_ARGUMENTS');
  const profileArgs = {
      sceneId: 'intro',
      frames: [0, 12, 27, 45, 59],
      repeat: 4,
      width: 640,
      height: 360,
      detail: true,
    },
    cached = (await call('render_profile', { ...profileArgs, graphCache: true })).value,
    baseline = (await call('render_profile', { ...profileArgs, graphCache: false })).value;
  assert.deepEqual(
    cached.samples.map((s) => s.pixelHash),
    baseline.samples.map((s) => s.pixelHash),
  );
  assert.equal(cached.cache.effectGraphs.parses, 2);
  assert.ok(cached.cache.effectGraphs.compiles < baseline.cache.effectGraphs.compiles);
  assert.equal(cached.cache.graphScratchBytes, 0);
  report.profile = {
    cached: cached.summary,
    baseline: baseline.summary,
    cachedGraph: cached.cache.effectGraphs,
    baselineGraph: baseline.cache.effectGraphs,
  };
  const first = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  assert.ok(first.result.content.some((c) => c.type === 'image'));
  assert.equal(first.value.data, undefined);
  const imageBefore = await readFile(first.value.output),
    childInfo = (await call('effect_graph_query', { source: { file: childFile } })).value,
    edit = (
      await call('effect_graph_plan', {
        revision: plan.candidateRevision,
        source: childFile,
        expectedHash: childInfo.source.hash,
        actions: [
          {
            type: 'update',
            nodeId: 'grade',
            patch: { matrix: [1, 0, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
          },
        ],
      })
    ).value,
    editCheck = (
      await call('project_preflight', {
        ...edit.candidate,
        samples: [{ sceneId: 'intro', frame: 30 }],
        width: 320,
        determinism: true,
      })
    ).value;
  assert.equal(editCheck.valid, true, JSON.stringify(editCheck.diagnostics));
  await call('project_apply', edit.apply);
  const changed = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  assert.equal((await readFile(changed.value.output)).equals(imageBefore), false);
  const remove = (
    await call('effect_graph_plan', {
      revision: edit.candidateRevision,
      source: childFile,
      expectedHash: (await call('effect_graph_query', { source: { file: childFile } })).value.source
        .hash,
      actions: [{ type: 'outputs', outputs: { color: 'grade' } }],
    })
  ).value;
  const rejected = (await call('project_preflight', remove.candidate)).value;
  assert.equal(rejected.valid, false);
  await call('project_apply', remove.apply, 'VALIDATION_FAILED');
  assert.equal((await call('project_context')).value.revision, edit.candidateRevision);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, plan.candidateRevision);
  const png = (
    await call('frame_capture', {
      frame: 30,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/preview.png'),
    })
  ).value;
  const job = (
    await call('render_start', {
      revision: plan.candidateRevision,
      start: 30,
      end: 31,
      format: 'png',
      width: 640,
      height: 360,
      output: path.join(root, 'exports/parity'),
    })
  ).value;
  async function wait(id) {
    for (let i = 0; i < 300; i++) {
      const j = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        assert.equal(j.status, 'completed', JSON.stringify(j.error));
        return j;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('render deadline');
  }
  await wait(job.id);
  assert.equal(
    (await readFile(png.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    ),
    true,
  );
  const video = (
    await call('render_start', {
      revision: plan.candidateRevision,
      output: path.join(root, 'exports/graph-outputs.mp4'),
      width: 640,
      height: 360,
    })
  ).value;
  await wait(video.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'exports/graph-outputs.mp4')],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  const requestFile = path.join(root, 'query-request.json');
  await writeFile(requestFile, JSON.stringify({ source: { file: rootFile }, section: 'outputs' }));
  const cliValue = JSON.parse(
    execFileSync(
      executable,
      [cli, 'effect-graph-query', '--project', root, '--request', requestFile],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliValue.total, 2);
  await client.callTool({ name: 'tools_load', arguments: { names: ['effect_graph_query'] } });
  const direct = await client.callTool({
    name: 'effect_graph_query',
    arguments: { source: { file: rootFile }, output: 'matte' },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).total, 4);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, initial);
  assert.equal(await readFile(path.join(root, 'components/card.ts'), 'utf8'), source);
  report.checks = [
    'default compact discovery and plugin ownership',
    'selected root/subgraph outputs and channel/color-matrix native rendering',
    '24-node pages and explicit large parameter/schema opt-ins',
    'cached/no-cache random-seek identical pixels and measured compilation reduction',
    'changed nested resource invalidates actual app preview',
    'missing selected output rejects candidate without mutation',
    'generated component source preserved and exact shared undo',
    'native images without duplicated Base64; preview/export PNG equality',
    '60-frame MP4; current-service CLI and directly loaded MCP tool',
  ];
  report.output = path.join(root, 'exports/graph-outputs.mp4');
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
