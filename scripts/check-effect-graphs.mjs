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
const root = await mkdtemp(path.resolve('artifacts/effect-graphs-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--name',
    'Agent 节点图',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, stdio: 'pipe', windowsHide: true },
);
const client = new Client({ name: 'effect-graph-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
const report = { root, packaged },
  parse = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, content: result.content };
}
const source = `import {defineComponent,node,group} from '@vmotion/sdk';export default defineComponent({name:'Graph sources',parameters:{},render(ctx){return [
node({id:'heading',type:'text',text:'Agent 编排 · 多输入节点图',x:24,y:20,width:590,height:48,fontSize:26,fontWeight:700,fill:'#e8f1ff'}),
...group('content',[node({id:'base',type:'rect',width:550,height:200,fill:'#172844'}),node({id:'word',type:'text',text:'EFFECT GRAPH',x:30,y:58,width:490,height:80,fontSize:46,fontWeight:700,fill:'#b7d7ff'})],{x:45,y:96,width:550,height:200}),
node({id:'matte',type:'rect',x:45,y:96,width:550,height:200,fill:'#fff'}),node({id:'mask-carrier',type:'rect',opacity:0,maskId:'matte'})]}});`;
const child = {
  kind: 'effect-graph',
  version: 1,
  name: 'Reusable branch',
  parameters: { radius: { type: 'number', default: 4, min: 0, max: 30 } },
  nodes: [
    { id: 'source', type: 'input' },
    {
      id: 'glow',
      type: 'pass',
      input: 'source',
      effect: { type: 'glow', color: '#718cff', radius: 4, intensity: 1.2, threshold: 0.4 },
    },
  ],
  links: [{ nodeId: 'glow', property: 'effect.radius', parameter: 'radius' }],
  output: 'glow',
};
const graph = {
  kind: 'effect-graph',
  version: 1,
  name: 'Agent pipeline',
  parameters: {
    mix: { type: 'number', default: 0.6, min: 0, max: 1 },
    evolution: { type: 'number', default: 0 },
    radius: { type: 'number', default: 4, min: 0, max: 30 },
  },
  nodes: [
    { id: 'source', type: 'input' },
    { id: 'matte', type: 'input', slot: 'matte' },
    { id: 'noise', type: 'noise', scale: 35, seed: 13 },
    { id: 'warp', type: 'displace', input: 'source', map: 'noise', amountX: 7, amountY: 7 },
    {
      id: 'child',
      type: 'subgraph',
      source: 'components/effects/child.json',
      inputs: { source: 'warp' },
    },
    { id: 'mask', type: 'mask', input: 'child', matte: 'matte' },
    {
      id: 'out',
      type: 'blend',
      foreground: 'mask',
      background: 'source',
      mode: 'screen',
      opacity: 0.6,
    },
  ],
  links: [
    { nodeId: 'noise', property: 'evolution', parameter: 'evolution' },
    { nodeId: 'out', property: 'opacity', parameter: 'mix' },
    { nodeId: 'child', property: 'params.radius', parameter: 'radius' },
  ],
  output: 'out',
};
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/source.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'gallery',
          type: 'component',
          component: 'components/source.ts',
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    sourceHash = (await call('project_file_read', { path: 'components/source.ts' })).value.hash,
    planned = await call('effect_graph_plan', {
      revision: before,
      source: 'components/effects/root.json',
      graph,
      resources: [{ file: 'components/effects/child.json', graph: child }],
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'gallery/content',
          path: ['gallery'],
          effectId: 'pipeline',
          bindings: { matte: 'matte' },
          params: { radius: 6 },
          keys: [
            {
              parameter: 'evolution',
              keys: [
                { frame: 0, value: 0, easing: 'linear' },
                { frame: 59, value: 1.5, easing: 'linear' },
              ],
            },
          ],
        },
      ],
    });
  assert.equal((await call('project_context')).value.revision, before);
  assert.ok(planned.value.candidate.planId);
  assert.equal(planned.value.summary.resources.length, 2);
  const checked = await call('project_preflight', planned.value.candidate);
  assert.equal(checked.value.valid, true);
  assert.ok(checked.content.some((block) => block.type === 'image'));
  const applied = await call('project_apply', planned.value.apply);
  const info = await call('effect_graph_inspect', {
    source: {
      sceneId: 'intro',
      nodeId: 'gallery/content',
      path: ['gallery'],
      effectId: 'pipeline',
      frame: 29.5,
    },
    nodeIds: ['child/glow'],
    includeValues: true,
  });
  assert.equal(info.value.nodes.length, 1);
  assert.equal(info.value.nodes[0].values.effect.radius, 6);
  assert.equal(info.value.parameters.evolution, 0.75);
  assert.equal(
    (await call('project_file_read', { path: 'components/source.ts' })).value.hash,
    sourceHash,
  );
  const reviewed = await call('effect_graph_inspect', {
      source: { file: 'components/effects/root.json' },
    }),
    edit = await call('effect_graph_plan', {
      revision: applied.value.revision,
      source: 'components/effects/root.json',
      expectedHash: reviewed.value.resources[0].hash,
      actions: [{ type: 'update', nodeId: 'warp', patch: { amountX: 12 } }],
    });
  const editedCheck = await call('project_preflight', {
    ...edit.value.candidate,
    samples: [0, 30, 59].map((frame) => ({ sceneId: 'intro', frame })),
  });
  assert.equal(editedCheck.value.valid, true);
  await call('project_apply', edit.value.apply);
  assert.equal(
    (
      await call('effect_graph_inspect', {
        source: { file: 'components/effects/root.json' },
        nodeIds: ['warp'],
        includeValues: true,
      })
    ).value.nodes[0].values.amountX,
    12,
  );
  const latest = (await call('project_context')).value.revision;
  const invalid = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'effect_graph_plan',
      arguments: {
        revision: latest,
        source: 'components/effects/root.json',
        expectedHash: reviewed.value.resources[0].hash,
        actions: [{ type: 'remove', nodeId: 'noise' }],
      },
    },
  });
  assert.equal(invalid.isError, true);
  const frames = await call('frame_sample', {
    frames: [0, 15, 30, 59],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  assert.ok(frames.content.some((block) => block.type === 'image'));
  const preview = await call('frame_capture', { frame: 30, width: 640, height: 360 }),
    png = await call('render_start', {
      revision: latest,
      format: 'png',
      start: 30,
      end: 31,
      output: path.join(root, 'exports/parity'),
    }),
    waitJob = async (id) => {
      for (let i = 0; i < 200; i++) {
        const job = (await call('render_status', { id })).value;
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          assert.equal(job.status, 'completed', job.error);
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('Render timeout');
    };
  await waitJob(png.value.id);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    Buffer.from(preview.content.find((block) => block.type === 'image').data, 'base64'),
  );
  const output = path.join(root, 'exports/effect-graphs.mp4'),
    render = await call('render_start', { revision: latest, output });
  await waitJob(render.value.id);
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_frames), 60);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, applied.value.revision);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_apply', planned.value.apply);
  await call('project_apply', edit.value.apply);
  report.output = output;
  report.revision = latest;
  report.checks = [
    'multi-input branched graph',
    'nested reusable resource',
    'linked graph parameter keys',
    'generated owner overrides',
    'node-filtered inspection',
    'hash-protected short node edit',
    'failed rewiring preserves source',
    'native image blocks',
    'PNG parity',
    '60-frame MP4',
    'atomic graph+attachment undo',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
