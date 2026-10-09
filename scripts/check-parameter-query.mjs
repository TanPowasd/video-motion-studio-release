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
const root = await mkdtemp(path.resolve('artifacts/parameter-query-'));
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
const client = new Client({ name: 'parameter-query-real-client', version: '1.0.0' }),
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
  const result = await client.callTool(
    ['tools_search', 'tool_schema', 'tools_load'].includes(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (result.isError) throw new Error(name + ':' + JSON.stringify(parse(result)));
  return { value: parse(result), content: result.content };
}
async function revision() {
  return (await call('project_context')).value.revision;
}
async function invalid(name, args, code) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, code);
}
const source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'参数化数据卡',parameters:{origin:{type:'vec2',default:{x:20,y:10}},label:{type:'string',default:'默认标题'},series:{type:'array',items:{type:'number',default:2},default:Array.from({length:1600},(_,i)=>i)},style:{type:'object',default:{size:22},properties:{size:{type:'number',default:12},color:{type:'color',default:'#67abcd'}}}},render(ctx,p){return [node({id:'title',type:'text',text:p.label,x:p.origin.x,y:20,width:220,height:80,fontSize:p.style.size,fill:p.style.color})]}});`,
  wrapper = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'嵌套数据卡',parameters:{},render(){return [node({id:'inner',type:'component',component:'components/data.ts',width:280,height:110})]}});`;
try {
  await client.connect(transport);
  const startup = await client.listTools();
  assert.equal(startup.tools.length, 10);
  report.startupBytes = bytes(startup);
  const modules = {};
  for (const [id, count, runtime] of [
    ['vmotion.3d', 5, 'module'],
    ['vmotion.vector', 8, 'module'],
    ['vmotion.animation', 14, 'module'],
  ]) {
    const item = (await call('plugins_inspect', { id })).value.items[0];
    assert.equal(item.moduleTools, count);
    assert.equal(item.runtime, runtime);
    modules[id] = { moduleTools: item.moduleTools, hostTools: item.hostTools };
  }
  report.modules = modules;
  const discovery = (await call('tools_search', { query: '参数 查询' })).value;
  assert.ok(discovery.items.some((t) => t.name === 'component_query'));
  const schema = (await call('tool_schema', { name: 'component_query' })).value,
    cached = (await call('tool_schema', { name: 'component_query', ifHash: schema.schemaHash }))
      .value;
  assert.equal(cached.notModified, true);
  report.schemaBytes = bytes(schema);
  report.cachedSchemaBytes = bytes(cached);
  await call('project_transact', {
    revision: await revision(),
    operations: [
      { type: 'writeSource', path: 'components/data.ts', content: source },
      { type: 'writeSource', path: 'components/wrapper.ts', content: wrapper },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'data',
          type: 'component',
          component: 'components/data.ts',
          name: '数据',
          x: 20,
          y: 30,
          width: 280,
          height: 110,
        },
      },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'wrapper',
          type: 'component',
          component: 'components/wrapper.ts',
          name: '嵌套',
          x: 340,
          y: 30,
          width: 280,
          height: 110,
        },
      },
    ],
  });
  const base = await revision(),
    full = (await call('component_parameters', { sceneId: 'intro', nodeId: 'data' })).value,
    compact = (await call('component_query', { sceneId: 'intro', nodeId: 'data' })).value;
  assert.equal(compact.channels.total, full.channelCount);
  assert.equal(compact.parameters.items.find((p) => p.path === 'series').value.length, 1600);
  assert.equal(compact.channels.items.length, 32);
  assert.ok(bytes(compact) < bytes(full) * 0.1);
  report.resultBytes = { compact: bytes(compact), full: bytes(full) };
  const late = (
    await call('component_query', {
      sceneId: 'intro',
      nodeId: 'data',
      paths: ['series'],
      channelOffset: 1200,
      channelLimit: 8,
    })
  ).value;
  assert.equal(late.channels.items[0].path, 'series.1200');
  assert.equal(late.channels.nextOffset, 1208);
  assert.equal(await revision(), base);
  report.checks.push('compact array preview and late channel paging without mutation');
  await call('component_parameters_edit', {
    revision: base,
    sceneId: 'intro',
    nodeId: 'data',
    keys: [
      { path: 'origin.x', frame: 0, value: 20 },
      { path: 'origin.x', frame: 30, value: 80 },
    ],
  });
  const keyed = (
    await call('component_query', {
      sceneId: 'intro',
      nodeId: 'data',
      frame: 15,
      paths: ['origin.x', 'style.size'],
      includeSchema: true,
    })
  ).value;
  assert.equal(keyed.parameters.items[0].evaluated, 50);
  assert.equal(keyed.parameters.items[0].defaultValue, 20);
  assert.equal(keyed.parameters.items[1].defaultValue, 22);
  const beforeGenerated = await revision();
  await call('component_parameters_edit', {
    revision: beforeGenerated,
    sceneId: 'intro',
    nodeId: 'wrapper/inner',
    path: ['wrapper'],
    frame: 15,
    contextFrames: [15],
    updates: [{ path: 'label', value: '生成组件仍可编辑' }],
  });
  const generated = (
    await call('component_query', {
      sceneId: 'intro',
      nodeId: 'wrapper/inner',
      path: ['wrapper'],
      contextFrames: [15],
      frame: 15,
      paths: ['label'],
    })
  ).value;
  assert.equal(generated.parameters.items[0].evaluated, '生成组件仍可编辑');
  assert.equal(await readFile(path.join(root, 'components/wrapper.ts'), 'utf8'), wrapper);
  await call('project_undo');
  assert.equal(await revision(), beforeGenerated);
  report.checks.push('native keyed/default values and generated owner edit/one undo');
  await invalid(
    'component_query',
    { sceneId: 'intro', nodeId: 'data', paths: ['series.90000'] },
    'PARAMETER_PATH',
  );
  await invalid(
    'component_query',
    { sceneId: 'intro', nodeId: 'data', revision: 'stale' },
    'REVISION_CONFLICT',
  );
  await invalid(
    'component_query',
    { sceneId: 'intro', nodeId: 'data', paths: ['__proto__.x'] },
    'TOOL_ARGUMENTS',
  );
  const template = (
    await call('template_plan', {
      revision: await revision(),
      publish: {
        definition: {
          id: 'query-card',
          name: '模板参数',
          version: 1,
          width: 280,
          height: 110,
          duration: 60,
          parameters: {
            title: { type: 'string', default: '模板标题' },
            size: { type: 'number', default: 24, min: 12, max: 40 },
          },
          ports: [
            { parameter: 'title', nodeId: 'label', property: 'text' },
            { parameter: 'size', nodeId: 'label', property: 'fontSize' },
          ],
        },
        nodes: [
          { id: 'label', type: 'text', text: '模板标题', fontSize: 24, width: 260, height: 90 },
        ],
      },
      placements: [
        { sceneId: 'intro', nodeId: 'template', x: 30, y: 200, params: { title: '模板自定义' } },
      ],
    })
  ).value;
  const checked = await call('project_preflight', template.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  assert.ok(checked.content.some((c) => c.type === 'image'));
  await call('project_apply', template.apply);
  const queryTemplate = (
    await call('component_query', {
      sceneId: 'intro',
      nodeId: 'template',
      paths: ['title', 'size'],
    })
  ).value;
  assert.equal(queryTemplate.parameters.items[0].value, '模板自定义');
  assert.ok(queryTemplate.source.endsWith('manifest.json'));
  report.checks.push('template port values use the same compact projection');
  await call('tools_load', { names: ['component_query'], mode: 'replace' });
  const direct = await client.callTool({
    name: 'component_query',
    arguments: { sceneId: 'intro', nodeId: 'data', paths: ['origin.x'], frame: 15 },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).parameters.items[0].evaluated, 50);
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  const argsFile = path.join(root, 'query.json');
  await writeFile(
    argsFile,
    JSON.stringify({ sceneId: 'intro', nodeId: 'data', paths: ['origin.x'], frame: 15 }),
  );
  const cliValue = JSON.parse(
    execFileSync(
      command,
      [cli, 'tool-call', '--project', root, '--name', 'component_query', '--request', argsFile],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliValue.parameters.items[0].evaluated, 50);
  report.checks.push('direct loaded tool and open-service CLI parity');
  const frame = await call('frame_capture', {
    frame: 15,
    width: 640,
    height: 360,
    output: path.join(root, 'preview.png'),
  });
  assert.equal(frame.content.filter((c) => c.type === 'image').length, 1);
  assert.equal(frame.value.data, undefined);
  const output = path.join(root, 'exports/parameter-query.mp4'),
    job = (
      await call('render_start', {
        revision: await revision(),
        format: 'mp4',

        output,
        width: 640,
        height: 360,
        start: 0,
        end: 60,
      })
    ).value;
  for (let i = 0; i < 200; i++) {
    const state = (await call('render_status', { id: job.id })).value;
    if (['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert.equal(state.status, 'completed', state.error);
      break;
    }
    if (i === 199) throw new Error('Render timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    Number(
      JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).streams.find((s) => s.codec_type === 'video').nb_frames,
    ),
    60,
  );
  report.output = output;
  report.checks.push('native candidate/frame and 60-frame MP4');
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
