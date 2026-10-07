import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/design-'));
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
const client = new Client({ name: 'design-resource-real-client', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, schemas: [] },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
async function call(name, args = {}) {
  const r = await client.callTool(
    ['tools_search', 'tool_schema', 'tools_load'].includes(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (r.isError) throw new Error(name + ': ' + JSON.stringify(r.content));
  return { value: parse(r), raw: r };
}
async function invalid(name, args, code) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, code);
}
async function revision() {
  return (await call('project_context')).value.revision;
}
async function commit(name, args) {
  const p = (await call(name, { revision: await revision(), ...args })).value,
    r = await call('project_preflight', p.candidate);
  assert.equal(r.value.valid, true, JSON.stringify(r.value.diagnostics));
  if (r.raw.content.some((c) => c.type === 'image')) report.candidatePicture = true;
  await call('project_apply', p.apply);
  assert.equal(await revision(), p.candidateRevision);
  return p;
}
const themeFile = 'components/themes/brand.json',
  source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'card',parameters:{title:{type:'string',default:'Card'},color:{type:'color',default:'#55aabb'},value:{type:'number',default:50,min:0,max:100}},render(ctx,p){return [node({id:'panel',type:'rect',width:290,height:170,fill:'#182d42'}),node({id:'label',type:'text',text:p.title,x:14,y:18,width:260,height:70,fontSize:26,fill:p.color}),node({id:'number',type:'text',text:String(Math.round(p.value)),x:14,y:104,width:260,height:55,fontSize:38,fill:p.color})]}});",
  def = {
    id: 'card',
    name: 'Agent card',
    version: 1,
    width: 290,
    height: 170,
    duration: 60,
    parameters: {
      title: { type: 'string', default: 'Card' },
      color: { type: 'color', default: '#55aabb' },
      value: { type: 'number', default: 50, min: 0, max: 100 },
    },
    ports: [
      { parameter: 'title', nodeId: 'content', property: 'params.title' },
      { parameter: 'color', nodeId: 'content', property: 'params.color' },
      { parameter: 'value', nodeId: 'content', property: 'params.value' },
    ],
  },
  nodes = [
    {
      id: 'content',
      type: 'component',
      component: 'components/card.ts',
      width: 290,
      height: 170,
      params: { title: 'Card', color: '#55aabb', value: 50 },
    },
  ];
try {
  await client.connect(transport);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.startupBytes = bytes(initial);
  assert.ok(report.startupBytes < 16000);
  const found = (await call('tools_search', { query: '模板 升级', limit: 8 })).value;
  assert.ok(found.items.some((t) => t.name === 'template_plan'));
  for (const name of ['theme_plan', 'template_plan', 'template_inspect']) {
    const a = (await call('tool_schema', { name })).value,
      b = (await call('tool_schema', { name, format: 'expanded' })).value,
      c = (await call('tool_schema', { name, ifHash: a.schemaHash })).value;
    assert.equal(c.notModified, true);
    assert.ok(bytes(c) < 250);
    report.schemas.push({
      name,
      compactBytes: bytes(a),
      expandedBytes: bytes(b),
      cachedBytes: bytes(c),
    });
  }
  const paths = [
      'revision',
      'delivery',
      'publish.definition',
      'publish.capture',
      'publish.allowSharedCode',
      'publish.migrations',
    ],
    projected = (await call('tool_schema', { name: 'template_plan', paths })).value,
    fullSchema = (await call('tool_schema', { name: 'template_plan' })).value;
  assert.equal(projected.projection.partial, true);
  assert.ok(bytes(projected) < bytes(fullSchema) * 0.1);
  assert.equal(
    (
      await call('tool_schema', {
        name: 'template_plan',
        paths: [...paths].reverse(),
        ifHash: projected.schemaHash,
      })
    ).value.notModified,
    true,
  );
  const badProjection = await client.callTool({
    name: 'tool_schema',
    arguments: { name: 'template_plan', paths: ['publish.badField'] },
  });
  assert.equal(badProjection.isError, true);
  assert.equal(parse(badProjection).code, 'TOOL_SCHEMA_PATH');
  report.projectedSchemaBytes = { selected: bytes(projected), full: bytes(fullSchema) };
  await call('project_transact', {
    operations: [{ type: 'writeSource', path: 'components/card.ts', content: source }],
  });
  const before = await revision();
  const one = await commit('template_plan', {
    publish: { definition: def, nodes },
    placements: [
      { sceneId: 'intro', nodeId: 'a', x: 10, y: 20 },
      { sceneId: 'intro', nodeId: 'b', x: 330, y: 20, params: { title: 'Custom', value: 80 } },
    ],
  });
  report.publishPlanBytes = bytes(one);
  assert.ok(report.publishPlanBytes < 2500);
  await commit('theme_plan', {
    source: themeFile,
    expectedHash: null,
    document: {
      kind: 'theme',
      version: 1,
      id: 'brand',
      name: 'Brand',
      tokens: [{ id: 'accent', type: 'color', value: '#55bbcc' }],
    },
    targets: [
      { sceneId: 'intro', nodeId: 'a', links: { 'params.color': 'accent' } },
      { sceneId: 'intro', nodeId: 'b', links: { 'params.color': 'accent' } },
    ],
  });
  await call('component_parameters_edit', {
    sceneId: 'intro',
    nodeId: 'b',
    keys: [
      { path: 'value', frame: 0, value: 40 },
      { path: 'value', frame: 30, value: 80 },
    ],
  });
  await call('composition_edit_layer', {
    sceneId: 'intro',
    path: ['b', 'b/content'],
    nodeId: 'b/content/label',
    patch: { fill: '#ffaa55' },
  });
  const themeInfo = (await call('theme_inspect', { source: themeFile })).value;
  assert.equal(themeInfo.tokens.items[0].value, '#55bbcc');
  const context = (await call('project_context')).value,
    themeEntry = context.files.items.find((f) => f.path === themeFile);
  const themeChanged = await commit('theme_plan', {
    source: themeFile,
    expectedHash: themeEntry.hash,
    changes: [{ type: 'set', token: { id: 'accent', type: 'color', value: '#55dd88' } }],
  });
  report.themePlanBytes = bytes(themeChanged);
  const role = (await call('component_parameters', { sceneId: 'intro', nodeId: 'a', frame: 15 }))
    .value;
  assert.equal(role.evaluated.color, '#55dd88');
  const prior = await revision(),
    two = await commit('template_plan', {
      publish: {
        definition: {
          ...def,
          version: 2,
          parameters: {
            ...def.parameters,
            title: { type: 'string', default: 'Version 2' },
            value: { type: 'number', default: 70, min: 0, max: 100 },
          },
        },
        nodes,
      },
      upgrades: [
        { sceneId: 'intro', nodeId: 'a' },
        { sceneId: 'intro', nodeId: 'b' },
      ],
    });
  report.upgradePlanBytes = bytes(two);
  assert.ok(report.upgradePlanBytes < 4500);
  const a = (await call('component_parameters', { sceneId: 'intro', nodeId: 'a' })).value,
    b = (await call('component_parameters', { sceneId: 'intro', nodeId: 'b', frame: 15 })).value;
  assert.equal(a.values.title, 'Version 2');
  assert.equal(b.values.title, 'Custom');
  assert.equal(b.evaluated.value, 60);
  const inspected = (await call('template_inspect', { target: { sceneId: 'intro', nodeId: 'b' } }))
    .value;
  assert.ok(inspected.instance.overrides.includes('content/label'));
  assert.equal(inspected.template.version, 2);
  assert.equal(inspected.template.files, undefined);
  report.inspectBytes = bytes(inspected);
  await invalid(
    'template_plan',
    { revision: await revision(), publish: { definition: { ...def, version: 2 }, nodes } },
    'TEMPLATE_VERSION_EXISTS',
  );
  await invalid(
    'template_plan',
    {
      revision: await revision(),
      publish: { definition: { ...def, version: 3, parameters: {}, ports: [] }, nodes },
      upgrades: [{ sceneId: 'intro', nodeId: 'b' }],
    },
    'TEMPLATE_CONFLICT',
  );
  const current = await revision();
  const cached = (
      await call('render_profile', { sceneId: 'intro', frames: [0, 30, 59], width: 640, repeat: 3 })
    ).value,
    baseline = (
      await call('render_profile', {
        sceneId: 'intro',
        frames: [0, 30, 59],
        width: 640,
        repeat: 3,
        resourceCache: false,
      })
    ).value;
  assert.deepEqual(cached.frames, baseline.frames);
  assert.deepEqual(cached.determinism.mismatchFrames, []);
  assert.ok(cached.cache.templates.prepares < baseline.cache.templates.prepares);
  assert.ok(cached.cache.themes.resolutions < baseline.cache.themes.resolutions);
  report.performance = {
    cachedMs: cached.summary.warmMeanMs,
    baselineMs: baseline.summary.warmMeanMs,
    cachedTemplates: cached.cache.templates,
    uncachedTemplates: baseline.cache.templates,
    cachedThemes: cached.cache.themes,
    uncachedThemes: baseline.cache.themes,
  };
  const img = await call('frame_capture', { frame: 30, width: 640, height: 360 });
  await writeFile(
    path.join(root, 'frame-30.png'),
    Buffer.from(img.raw.content.find((c) => c.type === 'image').data, 'base64'),
  );
  const output = path.join(root, 'design.mp4'),
    render = (await call('render_start', { output, format: 'mp4', revision: current })).value;
  let done;
  for (let i = 0; i < 100; i++) {
    done = (await call('render_status', { id: render.id })).value;
    if (!['queued', 'running'].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(done.status, 'completed');
  assert.equal(
    JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ).streams.find((s) => s.codec_type === 'video').nb_frames,
    '60',
  );
  await call('project_undo');
  assert.equal(await revision(), prior);
  await call('project_redo');
  assert.equal(await revision(), current);
  const detach = await commit('template_plan', { detach: [{ sceneId: 'intro', nodeId: 'b' }] });
  const local = (
    await call('template_inspect', { target: { sceneId: 'intro', nodeId: 'b' }, detail: true })
  ).value;
  assert.equal(local.instance.mode, 'local');
  const privateCode = Object.keys(local.template.files).find((f) => f.endsWith('card.ts'));
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: privateCode, content: source.replace('Card', 'Private') },
    ],
  });
  assert.equal(await readFile(path.join(root, 'components/card.ts'), 'utf8'), source);
  await writeFile(
    path.join(root, 'inspect-request.json'),
    JSON.stringify({ target: { sceneId: 'intro', nodeId: 'b' } }),
  );
  const cliInfo = JSON.parse(
    execFileSync(
      executable,
      [
        cli,
        'template-inspect',
        '--project',
        root,
        '--request',
        path.join(root, 'inspect-request.json'),
      ],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliInfo.instance.mode, 'local');
  await call('tools_load', { categories: ['composition'] });
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'template_plan'));
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  report.checks = [
    'compact discovery/schema hash',
    'pinned source publication',
    'typed parameter and live theme updates',
    'key/custom override preservation',
    'selective version upgrades',
    'conflicts preserve project',
    'native exact candidate evidence',
    'cached/uncached exact pixels and reduced prepares',
    '60-frame MP4',
    'undo/redo exact revision',
    'private editable copy preserves author files',
    'CLI parity',
    'on-demand tools',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
