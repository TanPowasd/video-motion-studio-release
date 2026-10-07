import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
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
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/plugins-'));
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
    '6',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'real-plugin-agent', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] },
  parse = (r) =>
    r.structuredContent?.error ??
    r.structuredContent ??
    JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const directNames = new Set(['tools_search', 'tool_schema', 'tools_load']);
async function call(name, arguments_ = {}) {
  const r = await client.callTool(
    directNames.has(name)
      ? { name, arguments: arguments_ }
      : { name: 'tool_call', arguments: { name, arguments: arguments_ } },
  );
  if (r.isError) throw new Error(name + ':' + JSON.stringify(parse(r)));
  return { value: parse(r), raw: r };
}
async function rev() {
  return (await call('project_context')).value.revision;
}
async function commit(name, args = {}) {
  const plan = (await call(name, { revision: await rev(), ...args })).value,
    checked = await call('project_preflight', plan.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  if (checked.raw.content.some((c) => c.type === 'image')) report.candidatePicture = true;
  await call('project_apply', plan.apply);
  assert.equal(await rev(), plan.candidateRevision);
  return plan;
}
async function invalid(name, args, code) {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, code);
}
let notifications = 0;
try {
  await client.connect(transport);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.startupBytes = bytes(initial);
  client.setNotificationHandler(
    (await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema,
    () => {
      notifications++;
    },
  );
  const files = [
    'components/plugins/creative/plugin.json',
    'components/plugins/creative/tools.ts',
    'components/plugins/creative/card.ts',
    'components/themes/plugin-brand.json',
    'components/effects/plugin-shine.json',
  ];
  const contents = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(path.join('examples/plugin-lab', file), 'utf8'),
      ]),
    ),
  );
  const registered = await commit('plugins_plan', {
    files: files.map((file) => ({
      type: 'replace',
      path: file,
      content: contents[file],
      expectedHash: null,
    })),
    actions: [{ type: 'register', source: files[0] }],
  });
  report.registrationBytes = bytes(registered);
  const beforeCache = (await call('plugins_inspect', { id: 'example.creative' })).value.cache;
  for (let i = 0; i < 20; i++) await call('plugins_inspect', { id: 'example.creative' });
  const afterCache = (await call('plugins_inspect', { id: 'example.creative' })).value.cache;
  assert.equal(afterCache.contentDigests, beforeCache.contentDigests);
  assert.ok(afterCache.accountedBytes <= afterCache.budgetBytes);
  report.cacheReuse = {
    requests: 20,
    newContentDigests: afterCache.contentDigests - beforeCache.contentDigests,
    accountedBytes: afterCache.accountedBytes,
    budgetBytes: afterCache.budgetBytes,
  };
  assert.ok(report.registrationBytes < 5000);
  assert.equal((await client.listTools()).tools.length, 10);
  const search = (await call('tools_search', { pluginId: 'example.creative' })).value;
  assert.equal(search.total, 2);
  assert.ok(search.items.every((t) => t.plugin.id === 'example.creative'));
  report.discoveryBytes = bytes(search);
  const name = 'plugin.example.creative.compose',
    schema = (await call('tool_schema', { name })).value;
  assert.equal(schema.plugin.id, 'example.creative');
  const cached = (await call('tool_schema', { name, ifHash: schema.schemaHash })).value;
  assert.equal(cached.notModified, true);
  report.schemaBytes = bytes(schema);
  report.cachedSchemaBytes = bytes(cached);
  await call('tools_load', { names: [name], mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 11);
  const before = await rev(),
    plan = await commit(name, { title: '插件，让创作能力自由组合。' });
  report.planBytes = bytes(plan);
  assert.ok(report.planBytes < 2500);
  report.checks.push('typed plugin native candidate/exact commit');
  const inspected = (
    await call('plugin.example.creative.inspect', { _context: { sceneIds: ['intro'] } })
  ).value;
  assert.ok(inspected.result.scenes[0].layers > 6);
  report.queryBytes = bytes(inspected);
  const packageIndex = (await call('plugins_package', { id: 'example.creative', limit: 20 })).value;
  assert.ok(packageIndex.files.some((file) => file.path.endsWith('/tools.ts')));
  assert.ok(packageIndex.files.every((file) => /^[a-f0-9]{64}$/.test(file.hash)));
  report.packageBytes = bytes(packageIndex);
  const entryFile = await call('project_file_read', { path: files[1], lineCount: 200 });
  const codeChanged = contents[files[1]].replace("name:'可编程创作包'", "name:'代码更新'"),
    codePlan = await commit('plugins_plan', {
      files: [
        {
          type: 'replace',
          path: files[1],
          expectedHash: entryFile.value.hash,
          content: codeChanged,
        },
      ],
    }),
    updatedSchema = (await call('tool_schema', { name })).value;
  assert.notEqual(updatedSchema.plugin.hash, schema.plugin.hash);
  await invalid(name, { expectedPluginHash: schema.plugin.hash }, 'PLUGIN_CHANGED');
  report.codeHashChanged = true;
  const contextSchema = (
    await call('tool_schema', {
      name: 'plugin.example.creative.inspect',
      paths: ['_context.sceneIds'],
    })
  ).value;
  assert.equal(contextSchema.projection.partial, true);
  await invalid(name, { accent: 42 }, 'TOOL_ARGUMENTS');
  await invalid(name, { expectedPluginHash: '0'.repeat(64) }, 'PLUGIN_CHANGED');
  await invalid(name, { _context: { sceneIds: ['intro'] } }, 'PLUGIN_CONTEXT');
  await call('project_undo');
  assert.equal(await rev(), plan.candidateRevision);
  await call('project_redo');
  assert.equal(await rev(), codePlan.candidateRevision);
  report.checks.push('unknown/invalid/stale/context errors and one undo');
  const picture = await call('frame_capture', {
    sceneId: 'intro',
    frame: 90,
    width: 640,
    height: 360,
    output: path.join(root, 'frame.png'),
  });
  assert.equal(picture.raw.content.filter((c) => c.type === 'image').length, 1);
  assert.equal(picture.value.data, undefined);
  const schema2 = { ...JSON.parse(contents[files[0]]), version: '1.1.0' };
  const manifestHash = (await call('project_file_read', { path: files[0] })).value.hash;
  await commit('plugins_plan', {
    files: [
      {
        type: 'replace',
        path: files[0],
        expectedHash: manifestHash,
        content: JSON.stringify(schema2),
      },
    ],
  });
  const changed = (await call('tool_schema', { name, ifHash: schema.schemaHash })).value;
  assert.notEqual(changed.schemaHash, schema.schemaHash);
  assert.equal(changed.plugin.version, '1.1.0');
  await invalid(name, { expectedPluginHash: schema.plugin.hash }, 'PLUGIN_CHANGED');
  report.checks.push('live schema update/cache invalidation');
  await commit('plugins_plan', {
    actions: [{ type: 'toggle', id: 'example.creative', enabled: false }],
  });
  assert.equal((await call('tools_search', { pluginId: 'example.creative' })).value.total, 0);
  assert.equal((await client.listTools()).tools.length, 10);
  await invalid(name, {}, 'TOOL_NOT_FOUND');
  const off = await call('frame_capture', {
    sceneId: 'intro',
    frame: 90,
    width: 640,
    height: 360,
    output: path.join(root, 'disabled.png'),
  });
  assert.ok((await readFile(picture.value.output)).equals(await readFile(off.value.output)));
  await call('project_undo');
  assert.equal((await call('tools_search', { pluginId: 'example.creative' })).value.total, 2);
  report.checks.push(
    'disable removes tools, preserves component pixels and undo restores discovery',
  );
  const output = path.join(root, 'exports/plugin-short.mp4'),
    render = (
      await call('render_start', {
        format: 'mp4',
        output,
        revision: await rev(),
        start: 0,
        end: 60,

        width: 640,
        height: 360,
      })
    ).value;
  let status;
  for (let i = 0; i < 200; i++) {
    status = (await call('render_status', { id: render.id })).value;
    if (!['queued', 'running'].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  report.output = output;
  report.checks.push('60-frame MP4 and native image without duplicate Base64');
  const requestFile = path.join(root, 'query-request.json');
  await writeFile(requestFile, JSON.stringify({ _context: { sceneIds: ['intro'] } }));
  const cliResult = JSON.parse(
    execFileSync(
      executable,
      [
        cli,
        'tool-call',
        '--project',
        root,
        '--name',
        'plugin.example.creative.inspect',
        '--request',
        requestFile,
      ],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliResult.result.scenes.length, 1);
  const cliSchema = JSON.parse(
    execFileSync(
      executable,
      [cli, 'tool-schema', '--project', root, '--name', name, '--paths', 'title,accent'],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliSchema.projection.partial, true);
  report.cliSchemaBytes = bytes(cliSchema);
  report.checks.push('open-service CLI bridge and partial plugin schema');
  const timeoutManifest = 'components/plugins/timeout/plugin.json',
    timeoutEntry = 'components/plugins/timeout/tools.ts';
  await commit('plugins_plan', {
    files: [
      {
        type: 'replace',
        path: timeoutManifest,
        expectedHash: null,
        content: JSON.stringify({
          kind: 'vmotion-plugin',
          apiVersion: 1,
          id: 'example.timeout',
          name: '恢复验证',
          version: '1.0.0',
          entry: timeoutEntry,
          tools: [
            {
              id: 'probe',
              description: '验证有界worker恢复',
              mode: 'query',
              parameters: { stall: { type: 'boolean', default: false } },
            },
          ],
        }),
      },
      {
        type: 'replace',
        path: timeoutEntry,
        expectedHash: null,
        content:
          "import {definePlugin,definePluginTool} from '@vmotion/sdk';export default definePlugin({name:'恢复验证',tools:{probe:definePluginTool({parameters:{stall:{type:'boolean',default:false}},run(ctx,p){if(p.stall){for(;;){}}return {ready:true};}})}});",
      },
    ],
    actions: [{ type: 'register', source: timeoutManifest }],
  });
  const timeoutRevision = await rev();
  await invalid('plugin.example.timeout.probe', { stall: true }, 'COMPONENT_TIMEOUT');
  const recovered = await Promise.all([
    call('plugin.example.timeout.probe'),
    call('plugin.example.timeout.probe'),
  ]);
  assert.ok(recovered.every((r) => r.value.result.ready === true));
  assert.equal(await rev(), timeoutRevision);
  await commit('plugins_plan', { actions: [{ type: 'remove', id: 'example.timeout' }] });
  report.checks.push('infinite tool times out and fresh worker recovers without mutation');
  await commit('plugins_plan', {
    actions: [{ type: 'toggle', id: 'example.creative', enabled: true, pin: true }],
  });
  const pinnedRevision = await rev(),
    readEntry = (await call('project_file_read', { path: files[1] })).value,
    change = {
      type: 'replace',
      path: files[1],
      expectedHash: readEntry.hash,
      content: (await readFile(path.join(root, files[1]), 'utf8')) + '\n// explicit unlocked edit',
    };
  await invalid('plugins_plan', { revision: pinnedRevision, files: [change] }, 'PLUGIN_CHANGED');
  assert.equal(await rev(), pinnedRevision);
  await commit('plugins_plan', {
    files: [change],
    actions: [{ type: 'toggle', id: 'example.creative', enabled: true, pin: false }],
  });
  await call('project_undo');
  assert.equal(await rev(), pinnedRevision);
  report.checks.push('pinned package protection, explicit unpin and exact undo');
  assert.ok(notifications > 0);
  report.notifications = notifications;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
