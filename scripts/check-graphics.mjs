import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
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
const root = await mkdtemp(path.resolve('artifacts/graphics-'));
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
const client = new Client({ name: 'vmotion-graphics-real-client', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, schemas: [] };
const bytes = (v) => Buffer.byteLength(JSON.stringify(v)),
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function call(name, args = {}) {
  const r = await client.callTool(
    ['tools_search', 'tool_schema', 'tools_load'].includes(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return { value: parse(r), raw: r };
}
async function invalid(name, args, code) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, code);
}
const source =
  "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Graphics demo',parameters:{},render(){return [node({id:'label',type:'text',name:'Agent 路径文字',text:'稳定 ID 的文字与形状，让 Agent 组合更多视觉效果。',x:10,y:20,width:600,height:70,fontSize:18,fill:'#ffffff'}),node({id:'shape',type:'rect',name:'形状',x:220,y:180,width:160,height:70,fill:'#72ddc5'}),node({id:'open',type:'path',path:'M30 320L610 320',fill:'transparent',stroke:'#38546c',strokeWidth:1})]}});";
try {
  await client.connect(transport);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.initialCatalogBytes = bytes(initial);
  assert.ok(report.initialCatalogBytes < 16000);
  const search = (await call('tools_search', { query: '路径文字 形状 算子', limit: 8 })).value;
  assert.ok(search.items.some((t) => t.name === 'graphics_plan'));
  for (const name of ['graphics_inspect', 'graphics_plan']) {
    const compact = (await call('tool_schema', { name })).value,
      expanded = (await call('tool_schema', { name, format: 'expanded' })).value,
      cached = (await call('tool_schema', { name, ifHash: compact.schemaHash })).value;
    assert.equal(cached.notModified, true);
    assert.ok(bytes(cached) < 250);
    assert.equal(compact.schemaHash, expanded.schemaHash);
    report.schemas.push({
      name,
      compactBytes: bytes(compact),
      expandedBytes: bytes(expanded),
      cachedBytes: bytes(cached),
    });
  }
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/graphics.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'comp',
          type: 'component',
          component: 'components/graphics.ts',
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision;
  await invalid(
    'graphics_plan',
    {
      sceneId: 'intro',
      revision: 'stale',
      targets: [{ nodeId: 'comp/label', path: ['comp'], pathText: { path: 'M0 0L200 0' } }],
    },
    'REVISION_CONFLICT',
  );
  await invalid(
    'graphics_plan',
    {
      sceneId: 'intro',
      revision: before,
      targets: [
        {
          nodeId: 'comp/open',
          path: ['comp'],
          shapeActions: [{ type: 'append', item: { id: 'invalid', type: 'offset', amount: 4 } }],
        },
      ],
    },
    'VECTOR_OFFSET_OPEN',
  );
  await invalid(
    'graphics_inspect',
    { sceneId: 'intro', nodeId: 'comp', unexpected: true },
    'TOOL_ARGUMENTS',
  );
  assert.equal((await call('project_context')).value.revision, before);
  const plan = (
    await call('graphics_plan', {
      sceneId: 'intro',
      revision: before,
      targets: [
        {
          nodeId: 'comp/label',
          path: ['comp'],
          pathText: { path: 'M20 70Q280 0 580 80' },
          textActions: [
            {
              type: 'append',
              item: { id: 'range', selector: { shape: 'smooth' }, values: { y: 6 } },
            },
          ],
          keys: [
            {
              property: 'pathText.normalOffset',
              keys: [
                { frame: 0, value: 0 },
                { frame: 30, value: 8 },
                { frame: 59, value: 0 },
              ],
            },
          ],
        },
        {
          nodeId: 'comp/shape',
          path: ['comp'],
          shapeActions: [
            { type: 'append', item: { id: 'round', type: 'round', radius: 16 } },
            {
              type: 'append',
              item: {
                id: 'cut',
                type: 'boolean',
                operation: 'difference',
                paths: [{ path: 'M50 18H110V52H50Z' }],
              },
            },
            { type: 'append', item: { id: 'offset', type: 'offset', amount: 4 } },
            { type: 'append', item: { id: 'outline', type: 'outline', width: 3 } },
          ],
        },
      ],
    })
  ).value;
  report.planBytes = bytes(plan);
  assert.ok(report.planBytes < 2500);
  assert.equal((await call('project_context')).value.revision, before);
  const preflight = await call('project_preflight', plan.candidate);
  assert.equal(preflight.value.valid, true);
  assert.ok(preflight.raw.content.some((c) => c.type === 'image'));
  assert.ok(!JSON.stringify(preflight.value).includes('base64'));
  await call('project_apply', plan.apply);
  const current = (await call('project_context')).value.revision;
  assert.equal(current, plan.candidateRevision);
  const compact = (
      await call('graphics_inspect', {
        sceneId: 'intro',
        nodeId: 'comp/label',
        path: ['comp'],
        frame: 30,
      })
    ).value,
    full = (
      await call('graphics_inspect', {
        sceneId: 'intro',
        nodeId: 'comp/label',
        path: ['comp'],
        frame: 30,
        detail: true,
        includePath: true,
        limit: 256,
      })
    ).value,
    page2 = (
      await call('graphics_inspect', {
        sceneId: 'intro',
        nodeId: 'comp/label',
        path: ['comp'],
        frame: 30,
        offset: compact.units.nextOffset,
      })
    ).value;
  assert.equal(compact.units.items.length, 16);
  assert.ok(compact.units.total > 16);
  assert.equal(compact.pathText.normalOffset, 8);
  assert.equal(compact.pathText.path, undefined);
  assert.deepEqual(
    [...compact.units.items, ...page2.units.items].map((u) => u.text),
    full.units.items.map((u) => u.text),
  );
  report.inspectBytes = { compact: bytes(compact), full: bytes(full) };
  assert.ok(bytes(compact) < bytes(full));
  await writeFile(path.join(root, 'inspect.json'), JSON.stringify(full, null, 2));
  const cached = (
      await call('render_profile', { sceneId: 'intro', frames: [0, 30, 59], width: 640, repeat: 3 })
    ).value,
    baseline = (
      await call('render_profile', {
        sceneId: 'intro',
        frames: [0, 30, 59],
        width: 640,
        repeat: 3,
        graphicsCache: false,
      })
    ).value;
  assert.deepEqual(cached.frames, baseline.frames);
  assert.deepEqual(cached.determinism.mismatchFrames, []);
  assert.ok(cached.cache.typography.layout.hits > 0);
  assert.equal(baseline.cache.geometry.entries, 0);
  report.performance = {
    cachedMs: cached.summary.warmMeanMs,
    baselineMs: baseline.summary.warmMeanMs,
    cache: cached.cache.typography,
    geometry: cached.cache.geometry,
  };
  const frames = new Map();
  for (const frame of [59, 0, 30, 59, 30]) {
    const r = await call('frame_capture', { frame, width: 640, height: 360 }),
      img = r.raw.content.find((c) => c.type === 'image');
    assert.ok(img);
    if (frames.has(frame)) assert.equal(img.data, frames.get(frame));
    else frames.set(frame, img.data);
    await writeFile(path.join(root, `frame-${frame}.png`), Buffer.from(img.data, 'base64'));
  }
  await writeFile(
    path.join(root, 'inspect-request.json'),
    JSON.stringify({ sceneId: 'intro', nodeId: 'comp/label', path: ['comp'], frame: 30, limit: 2 }),
  );
  const cliInfo = JSON.parse(
    execFileSync(
      executable,
      [
        cli,
        'graphics-inspect',
        '--project',
        root,
        '--request',
        path.join(root, 'inspect-request.json'),
      ],
      { env, windowsHide: true, encoding: 'utf8' },
    ),
  );
  assert.equal(cliInfo.units.items.length, 2);
  assert.equal(cliInfo.pathText.normalOffset, 8);
  const output = path.join(root, 'graphics.mp4'),
    started = (await call('render_start', { output, format: 'mp4', revision: current })).value;
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await call('render_status', { id: started.id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'completed');
  const streams = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  ).streams;
  assert.equal(streams.find((s) => s.codec_type === 'video').nb_frames, '60');
  const edit = (
    await call('graphics_plan', {
      sceneId: 'intro',
      revision: current,
      targets: [
        {
          nodeId: 'comp/shape',
          path: ['comp'],
          shapeActions: [
            { type: 'copy', target: { id: 'round' }, id: 'round-copy', index: 0 },
            { type: 'move', target: { id: 'offset' }, to: 1 },
            { type: 'toggle', target: { id: 'round-copy' }, enabled: false },
          ],
        },
      ],
    })
  ).value;
  assert.equal((await call('project_preflight', edit.candidate)).value.valid, true);
  await call('project_apply', edit.apply);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, current);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  assert.equal(await readFile(path.join(root, 'components/graphics.ts'), 'utf8'), source);
  await call('tools_load', { categories: ['animation', 'vector'] });
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'graphics_inspect'));
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  report.checks = [
    'compact discovery/schema hash',
    'failed requests preserve project',
    'generated batch exact candidate and native image',
    'paged final glyph poses',
    'CLI parity',
    'cache baseline exact pixels',
    'random seek PNG parity',
    '60-frame MP4',
    'ID stack edits and two atomic undos',
    'source unchanged',
    'on-demand direct tools',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
