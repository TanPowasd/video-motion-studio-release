import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  command = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
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
const root = await mkdtemp(path.resolve('artifacts/library-'));
execFileSync(
  command,
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
const client = new Client({ name: 'library-real-agent', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function call(name, args = {}) {
  const r = await client.callTool(
    ['tools_search', 'tool_schema', 'tools_load'].includes(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (r.isError) throw new Error(name + ':' + JSON.stringify(parse(r)));
  return { value: parse(r), content: r.content };
}
async function rev() {
  return (await call('project_context')).value.revision;
}
async function invalid(name, args, code) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, code);
}
try {
  await client.connect(transport);
  const startup = await client.listTools();
  assert.equal(startup.tools.length, 10);
  report.startupBytes = bytes(startup);
  report.modules = {};
  for (const [id, count, runtime] of [
    ['vmotion.media', 12, 'module'],
    ['vmotion.drawing', 8, 'module'],
    ['vmotion.composition', 10, 'module'],
    ['vmotion.tracking', 4, 'module'],
  ]) {
    const item = (await call('plugins_inspect', { id })).value.items[0];
    assert.equal(item.moduleTools, count);
    assert.equal(item.runtime, runtime);
    report.modules[id] = { moduleTools: item.moduleTools, hostTools: item.hostTools };
  }
  report.schemas = [];
  for (const name of ['assets_query', 'drawing_query']) {
    const schema = (await call('tool_schema', { name })).value,
      cached = (await call('tool_schema', { name, ifHash: schema.schemaHash })).value;
    assert.equal(cached.notModified, true);
    report.schemas.push({ name, bytes: bytes(schema), cachedBytes: bytes(cached) });
  }
  const imageFile = path.join(root, 'source.png');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x254563:s=128x72',
      '-frames:v',
      '1',
      imageFile,
    ],
    { windowsHide: true },
  );
  await call('asset_import', { path: imageFile, type: 'image', copy: true });
  const registered = (await call('assets_query', { detail: true })).value.items[0];
  assert.equal(registered.type, 'image');
  assert.equal(registered.width, undefined);
  assert.equal(registered.metadata.width, 128);
  await call('project_transact', {
    revision: await rev(),
    operations: Array.from({ length: 100 }, (_, i) => ({
      type: 'addAsset',
      asset: {
        id: 'library-' + i,
        name: '图像 素材 ' + i,
        path: imageFile,
        type: 'image',
        managed: false,
        metadata: { width: 128, height: 72, description: 'x'.repeat(2000) },
      },
    })),
  });
  const query = (await call('assets_query')).value,
    full = (await call('assets_query', { limit: 100, detail: true })).value;
  assert.equal(query.items.length, 24);
  assert.equal(query.nextOffset, 24);
  assert.equal(query.total, 101);
  assert.equal(query.items[0].path, undefined);
  report.assetsBytes = { compact: bytes(query), full: bytes(full) };
  assert.ok(report.assetsBytes.compact < report.assetsBytes.full * 0.03);
  const filtered = (
    await call('assets_query', {
      types: ['image'],
      query: '图像 素材',
      managed: false,
      offset: 30,
      limit: 4,
    })
  ).value;
  assert.deepEqual(
    filtered.items.map((i) => i.id),
    ['library-30', 'library-31', 'library-32', 'library-33'],
  );
  await invalid('assets_query', { ids: ['missing'] }, 'MISSING_ASSET');
  report.checks.push('asset import, compact paging and full metadata opt-in');
  const created = (await call('drawing_create', { name: '图层与笔迹', width: 640, height: 360 }))
      .value,
    id = created.document.id,
    layerId = created.document.layers[0].id;
  const points = Array.from({ length: 100 }, (_, i) => ({
    x: 80 + i * 4,
    y: 90 + Math.sin(i / 10) * 10,
    pressure: 0.2 + i / 125,
  }));
  await call('drawing_edit', {
    id,
    revision: await rev(),
    operations: Array.from({ length: 40 }, (_, i) => ({
      type: 'stroke',
      layerId,
      stroke: {
        id: 'stroke-' + i,
        color: i % 2 ? '#68ceef' : '#dcb875',
        width: 3,
        points: points.map((p) => ({ ...p, y: p.y + i * 3 })),
      },
    })),
  });
  const drawingBase = await rev(),
    summary = (await call('drawing_query', { id })).value,
    document = (await call('drawing_get', { id })).value;
  assert.equal(summary.strokes.total, 40);
  assert.equal(summary.strokes.items.length, 16);
  assert.equal(summary.strokes.items[0].points, undefined);
  const pointPage = (
    await call('drawing_query', {
      id,
      layerIds: [layerId],
      strokeIds: ['stroke-8'],
      includePoints: true,
      pointOffset: 50,
      pointLimit: 6,
    })
  ).value;
  assert.deepEqual(
    pointPage.strokes.items[0].points.items,
    document.document.layers[0].strokes[8].points.slice(50, 56),
  );
  report.drawingBytes = { compact: bytes(summary), full: bytes(document) };
  assert.ok(report.drawingBytes.compact < report.drawingBytes.full * 0.03);
  await invalid('drawing_query', { id, layerIds: ['missing'] }, 'NOT_FOUND');
  await invalid('drawing_query', { id, revision: 'old' }, 'REVISION_CONFLICT');
  assert.equal(await rev(), drawingBase);
  const frame = await call('drawing_frame', {
    id,
    width: 640,
    height: 360,
    output: path.join(root, 'drawing.png'),
  });
  assert.equal(frame.content.filter((c) => c.type === 'image').length, 1);
  assert.equal(frame.value.data, undefined);
  const published = (await call('drawing_publish', { id, layerIds: [layerId] })).value.asset;
  assert.equal((await call('assets_query', { ids: [published.id] })).value.items[0].editable, true);
  await call('asset_place', {
    assetId: published.id,
    sceneId: 'intro',
    x: 0,
    y: 0,
    width: 640,
    height: 360,
  });
  const opened = (await call('drawing_open_asset', { assetId: published.id })).value.document;
  assert.notEqual(opened.id, id);
  assert.equal((await call('drawing_query', { id: opened.id })).value.strokes.total, 40);
  await call('project_undo');
  report.checks.push(
    'drawing point paging, native evidence, selected-layer publication and editable reopen',
  );
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'stable',parameters:{},render(){return [node({id:'label',type:'text',text:'插件让创作可持续',x:40,y:45,width:400,height:90,fontSize:32})]}});";
  await call('project_transact', {
    revision: await rev(),
    operations: [
      { type: 'writeSource', path: 'components/title.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'title',
          type: 'component',
          component: 'components/title.ts',
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const beforeEdit = await rev();
  await call('composition_edit_layer', {
    revision: beforeEdit,
    sceneId: 'intro',
    path: ['title'],
    frame: 12,
    contextFrames: [12],
    nodeId: 'title/label',
    patch: { fill: '#f9e2b1' },
  });
  const scope = (
    await call('composition_inspect', {
      sceneId: 'intro',
      path: ['title'],
      frame: 12,
      contextFrames: [12],
    })
  ).value;
  assert.equal(scope.scene.nodes[0].fill, '#f9e2b1');
  assert.equal(await readFile(path.join(root, 'components/title.ts'), 'utf8'), source);
  await call('project_undo');
  assert.equal(await rev(), beforeEdit);
  await call('composition_structure_batch', {
    revision: beforeEdit,
    sceneId: 'intro',
    actions: [
      {
        path: [],
        action: {
          type: 'add',
          node: { id: 'box-a', type: 'rect', x: 10, y: 10, width: 20, height: 20 },
        },
      },
      {
        path: [],
        action: {
          type: 'add',
          node: { id: 'box-b', type: 'ellipse', x: 40, y: 10, width: 20, height: 20 },
        },
      },
    ],
  });
  const graph = (
    await call('composition_interactions', {
      sceneId: 'intro',
      frame: 0,
      nodeIds: ['box-a', 'box-b'],
    })
  ).value;
  assert.equal(graph.layers.length, 2);
  await call('project_undo');
  assert.equal(await rev(), beforeEdit);
  report.checks.push('generated composition edit/source preservation and atomic structural batch');
  await call('tools_load', { names: ['drawing_query', 'assets_query'], mode: 'replace' });
  const direct = await client.callTool({
    name: 'drawing_query',
    arguments: { id, strokeIds: ['stroke-2'] },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).strokes.total, 1);
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  const argsFile = path.join(root, 'query.json');
  await writeFile(argsFile, JSON.stringify({ id, strokeIds: ['stroke-2'] }));
  const cliResult = JSON.parse(
    execFileSync(
      command,
      [cli, 'tool-call', '--project', root, '--name', 'drawing_query', '--request', argsFile],
      { env, windowsHide: true, encoding: 'utf8' },
    ),
  );
  assert.equal(cliResult.strokes.total, 1);
  report.checks.push('direct loaded tools and open-service CLI parity');
  const output = path.join(root, 'exports/library.mp4'),
    job = (
      await call('render_start', {
        revision: await rev(),
        format: 'mp4',

        output,
        start: 0,
        end: 60,
        width: 640,
        height: 360,
      })
    ).value;
  for (let i = 0; i < 200; i++) {
    const status = (await call('render_status', { id: job.id })).value;
    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
      assert.equal(status.status, 'completed', status.error);
      break;
    }
    if (i === 199) throw new Error('Render timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
  report.output = output;
  report.checks.push('60-frame MP4 with library drawing and programmable title');
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
