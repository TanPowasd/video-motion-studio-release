import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'),
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
const root = await mkdtemp(path.resolve('artifacts/gpu-effects-'));
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
    '1920',
    '--height',
    '1080',
    '--duration',
    '2',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'hardware-render-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = {
    root,
    packaged,
    metric:
      'Local render wall time including GPU transport/readback; JSON UTF-8 bytes, not model tokens',
    checks: [],
    benchmarks: [],
  },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function call(name, args = {}, error) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(r);
  if (error) {
    assert.equal(r.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(r.isError, true, JSON.stringify(value));
  return { value, result: r };
}
async function wait(id) {
  for (let i = 0; i < 500; i++) {
    const job = (await call('render_status', { id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      assert.equal(job.status, 'completed', job.error);
      return job;
    }
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error('Render timeout');
}
const matrix = [
    0.84, 0.04, 0.03, 0, 0.025, 0.015, 0.94, 0.01, 0, 0.013, 0.02, 0.035, 0.88, 0, 0.019, 0, 0, 0,
    1, 0,
  ],
  graph = {
    kind: 'effect-graph',
    version: 1,
    name: 'Fused GPU grade',
    nodes: [
      { id: 'source', type: 'input' },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 'grade' + i,
        type: 'colorMatrix',
        input: i ? 'grade' + (i - 1) : 'source',
        matrix,
      })),
    ],
    output: 'grade7',
  };
const component =
  "import{defineComponent,node,linearGradient,defineEffectGraph}from'@vmotion/sdk';export default defineComponent({name:'Hardware evidence',parameters:{},render(ctx){return[node({id:'moving',type:'rect',x:800+Math.sin(ctx.seconds)*100,y:280,width:400,height:250,gradient:linearGradient({x:0,y:0},{x:400,y:250},['#77d4b2','#6b9ceb','#b48cdb']),effects:[{id:'grade',type:'effectGraph',graph:defineEffectGraph(" +
  JSON.stringify(graph) +
  '),params:{},bindings:{}}]})]}});';
try {
  await client.connect(transport);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.startupCatalogBytes = bytes(initial);
  report.schemas = [];
  for (const name of ['render_profile', 'render_compare', 'render_start']) {
    const schema = parse(await client.callTool({ name: 'tool_schema', arguments: { name } })),
      cached = parse(
        await client.callTool({
          name: 'tool_schema',
          arguments: { name, ifHash: schema.schemaHash },
        }),
      );
    assert.equal(cached.notModified, true);
    report.schemas.push({ name, bytes: bytes(schema), cachedBytes: bytes(cached) });
  }
  await call('project_transact', {
    operations: [
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#101c2d',
          nodes: [
            {
              id: 'screen',
              type: 'rect',
              width: 1920,
              height: 1080,
              fill: '#65c29f',
              effects: [{ id: 'grade', type: 'effectGraph', graph, params: {}, bindings: {} }],
            },
          ],
        },
      },
    ],
  });
  const revision = (await call('project_context')).value.revision;
  for (const [width, repeat, order] of [
    [1280, 3, 'baseline-first'],
    [1920, 3, 'optimized-first'],
    [3840, 2, 'baseline-first'],
  ]) {
    const result = (
      await call('render_compare', {
        revision,
        sceneId: 'intro',
        frames: [0],
        repeat,
        width,
        height: (width * 9) / 16,
        pixelTolerance: 2,
        order,
        baseline: { gpu: 'cpu', graphOptimize: true, graphRegions: true, graphTileRows: 128 },
        optimized: { gpu: 'gpu' },
      })
    ).value;
    assert.equal(result.equivalence.matched, true);
    assert.equal(result.equivalence.maximum8bit, 0);
    assert.equal(result.optimized.gpu.adapter.hardware, true);
    assert.equal(result.optimized.gpu.adapter.backend, 'Dx12');
    assert.equal(result.optimized.gpu.requests, repeat);
    assert.equal(result.optimized.gpu.stages, 8 * repeat);
    assert.equal(result.optimized.gpu.surfaceAllocations, 1);
    assert.equal(result.optimized.gpu.correctedPixels, 0);
    assert.equal(result.optimized.gpu.fallbacks, 0);
    assert.equal(result.optimized.graph.fused, 7 * repeat);
    assert.ok(result.optimized.graph.readbackPixels < result.baseline.graph.readbackPixels);
    assert.ok(result.optimized.gpu.retainedBytes <= result.optimized.gpu.bufferBudgetBytes);
    report.benchmarks.push({
      width,
      height: (width * 9) / 16,
      repeat,
      order,
      equivalence: result.equivalence,
      difference: result.difference,
      gpu: result.optimized.gpu,
      responseBytes: bytes(result),
    });
  }
  await call('render_profile', { gpu: 'invalid' }, 'TOOL_ARGUMENTS');
  await call('render_start', { gpu: 'invalid' }, 'TOOL_ARGUMENTS');
  await call('render_compare', { pixelTolerance: 0.5 }, 'TOOL_ARGUMENTS');
  await call('render_profile', { revision: 'old', gpu: 'gpu' }, 'REVISION_CONFLICT');
  await call(
    'render_compare',
    { frames: [0, 1, 2, 3], repeat: 4, width: 3840, height: 2160, pixelTolerance: 2 },
    'RENDER_COMPARE_BUDGET',
  );
  assert.equal((await call('project_context')).value.revision, revision);
  // Use generated source and animation for exact candidates, sparse output, and real export parity.
  const sourceRequest = {
    revision,
    files: [{ type: 'replace', path: 'components/gpu.ts', expectedHash: null, content: component }],
    operations: [
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          nodes: [
            {
              id: 'code',
              type: 'component',
              component: 'components/gpu.ts',
              width: 1920,
              height: 1080,
            },
          ],
        },
      },
    ],
    samples: [
      { sceneId: 'intro', frame: 0 },
      { sceneId: 'intro', frame: 30 },
    ],
    width: 320,
  };
  const checked = (await call('project_preflight', sourceRequest)).value;
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  await call('project_apply', {
    ...sourceRequest,
    expectedCandidateRevision: checked.candidateRevision,
  });
  const original = (await call('project_context')).value.revision;
  const sampled = (
    await call('render_compare', {
      revision: original,
      sceneId: 'intro',
      frames: [30, 0, 59],
      repeat: 2,
      width: 1280,
      height: 720,
      pixelTolerance: 2,
      baseline: { gpu: 'cpu', graphOptimize: true },
      optimized: { gpu: 'gpu' },
      detail: true,
    })
  ).value;
  assert.equal(sampled.equivalence.matched, true);
  assert.ok(sampled.optimized.gpu.requests > 0);
  assert.deepEqual(sampled.optimized.determinism.mismatchFrames, []);
  report.animated = {
    equivalence: sampled.equivalence,
    gpu: sampled.optimized.gpu,
    difference: sampled.difference,
  };
  const plan = (
    await call('visual_repair_plan', {
      revision: original,
      sceneId: 'intro',
      frame: 30,
      frames: [0, 30, 59],
      targets: [{ nodeId: 'code/moving', actions: [{ type: 'move', delta: { x: 30, y: 15 } }] }],
    })
  ).value;
  const candidate = (
    await call('render_profile', {
      revision: original,
      planId: plan.candidate.planId,
      sceneId: 'intro',
      frames: [0, 30],
      width: 1280,
      gpu: 'gpu',
    })
  ).value;
  assert.equal(candidate.revision, plan.candidateRevision);
  assert.ok(candidate.cache.gpu.requests > 0);
  assert.equal(await readFile(path.join(root, 'components/gpu.ts'), 'utf8'), component);
  await call('project_preflight', plan.candidate);
  await call('project_apply', plan.apply);
  const image = await call('frame_capture', {
    frame: 30,
    width: 1280,
    height: 720,
    output: path.join(root, 'exports/preview.png'),
  });
  assert.equal(image.result.content.filter((c) => c.type === 'image').length, 1);
  assert.equal(image.value.data, undefined);
  const png = (
    await call('render_start', {
      revision: plan.candidateRevision,
      gpu: 'gpu',
      format: 'png',
      start: 30,
      end: 31,
      width: 1280,
      height: 720,
      output: path.join(root, 'exports/parity'),
    })
  ).value;
  const finalPng = await wait(png.id);
  assert.ok(finalPng.gpu.requests > 0);
  assert.equal(finalPng.gpu.fallbacks, 0);
  assert.ok(
    (await readFile(image.value.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    ),
  );
  const video = (
      await call('render_start', {
        revision: plan.candidateRevision,
        gpu: 'gpu',
        width: 1280,
        height: 720,
        output: path.join(root, 'exports/gpu.mp4'),
      })
    ).value,
    finalVideo = await wait(video.id);
  assert.ok(finalVideo.gpu.requests >= 60);
  assert.equal(finalVideo.gpu.fallbacks, 0);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', finalVideo.output],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  const requestFile = path.join(root, 'gpu-profile.json');
  await writeFile(
    requestFile,
    JSON.stringify({ sceneId: 'intro', width: 1280, frames: [30], gpu: 'gpu' }),
  );
  const cliResult = JSON.parse(
    execFileSync(
      exe,
      [cli, 'render-profile', '--project', root, '--request', requestFile, '--json'],
      { env, windowsHide: true, encoding: 'utf8' },
    ),
  );
  assert.equal(cliResult.cache.gpu.adapter.hardware, true);
  await client.callTool({ name: 'tools_load', arguments: { names: ['render_profile'] } });
  const direct = await client.callTool({
    name: 'render_profile',
    arguments: { sceneId: 'intro', width: 1280, gpu: 'gpu' },
  });
  assert.notEqual(direct.isError, true);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, original);
  assert.equal(await readFile(path.join(root, 'components/gpu.ts'), 'utf8'), component);
  report.checks = [
    '10-entry compact startup and conditional GPU schemas',
    'hardware DX12 / 720p 1080p UHD paired timings incl binary transport / exact benchmark pixels',
    'fused eight-stage chain / one allocation / bounded buffers / no fallback or CPU correction in benchmark',
    'negative modes/versions/tolerance/memory budgets preserve project',
    'generated moving source / repeat random frames / explicit tolerance / correction counts',
    'exact candidate preflight/apply/source preservation/one undo',
    'native image one time / exact GPU preview-export PNG / 60-frame MP4',
    'packaged CLI current service and directly loaded tools',
  ];
  report.output = finalVideo.output;
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
