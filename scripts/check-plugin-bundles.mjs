// Real external stdio MCP check for plugins_pack / plugins_install.
//   node scripts/check-plugin-bundles.mjs            (built dist/cli/index.mjs)
//   node scripts/check-plugin-bundles.mjs --dev      (src via tsx, no build needed)
//   node scripts/check-plugin-bundles.mjs --packaged (release/Vmotion)
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packaged = process.argv.includes('--packaged'),
  dev = process.argv.includes('--dev'),
  packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cliArgs = packaged
    ? [path.join(packageRoot, 'resources/app/dist/cli/index.mjs')]
    : dev
      ? [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli/index.ts')]
      : [path.resolve('dist/cli/index.mjs')],
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
const root = await mkdtemp(path.resolve('artifacts/plugin-bundles-'));
execFileSync(
  executable,
  [
    ...cliArgs,
    'init',
    '--project',
    root,
    '--template',
    'blank',
    '--width',
    '320',
    '--height',
    '180',
    '--duration',
    '1',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'real-plugin-bundle-agent', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [...cliArgs, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, dev, checks: [], bytes: {} },
  parse = (r) =>
    r.structuredContent?.error ??
    r.structuredContent ??
    JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v)),
  sha = (text) => createHash('sha256').update(text).digest('hex'),
  direct = new Set(['tools_search', 'tool_schema', 'tools_load']);
async function call(name, args = {}) {
  const r = await client.callTool(
    direct.has(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (r.isError) throw new Error(name + ':' + JSON.stringify(parse(r)));
  return { value: parse(r), raw: r };
}
const rev = async () => (await call('project_context')).value.revision;
async function commit(plan) {
  const checked = await call('project_preflight', plan.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  await call('project_apply', plan.apply);
  assert.equal(await rev(), plan.candidateRevision);
}
async function invalid(name, args, code) {
  const before = await rev();
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true, name + ' should fail');
  assert.equal(parse(r).code, code, JSON.stringify(parse(r)));
  assert.equal(await rev(), before, 'failed request must not change the project');
}
const check = (name) => {
  report.checks.push(name);
  console.log('ok -', name);
};
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 10);
  assert.ok(!listed.tools.some((t) => t.name.startsWith('plugins_')));
  report.bytes.startup = bytes(listed);
  check('compact catalog keeps 10 entries; pack/install are discovered on demand');

  const search = (await call('tools_search', { query: 'vmplugin', limit: 5 })).value;
  const names = search.items?.map((i) => i.name) ?? search.tools?.map((i) => i.name) ?? [];
  assert.ok(
    names.includes('plugins_install') && names.includes('plugins_pack'),
    JSON.stringify(names),
  );
  report.bytes.search = bytes(search);
  const schema = (await call('tool_schema', { name: 'plugins_install' })).value;
  report.bytes.installSchema = bytes(schema);
  const cached = (await call('tool_schema', { name: 'plugins_install', ifHash: schema.schemaHash }))
    .value;
  assert.equal(cached.notModified, true);
  report.bytes.installSchemaCached = bytes(cached);
  check('tools_search finds pack/install; tool_schema + ifHash cache');

  const lab = 'examples/plugin-lab',
    files = [
      'components/plugins/creative/plugin.json',
      'components/plugins/creative/tools.ts',
      'components/plugins/creative/card.ts',
      'components/themes/plugin-brand.json',
      'components/effects/plugin-shine.json',
    ],
    contents = Object.fromEntries(
      await Promise.all(files.map(async (f) => [f, await readFile(path.join(lab, f), 'utf8')])),
    );
  const registered = (
    await call('plugins_plan', {
      revision: await rev(),
      files: files.map((f) => ({
        type: 'replace',
        path: f,
        expectedHash: null,
        content: contents[f],
      })),
      actions: [{ type: 'register', source: files[0] }],
    })
  ).value;
  await commit(registered);
  const out1 = path.join(root, 'exports', 'a.vmplugin'),
    out2 = path.join(root, 'exports', 'b.vmplugin');
  const packed = (await call('plugins_pack', { id: 'example.creative', output: out1 })).value;
  const again = (await call('plugins_pack', { id: 'example.creative', output: out2 })).value;
  assert.equal(packed.sha256, again.sha256);
  assert.ok(!('base64' in packed));
  report.bytes.packResult = bytes(packed);
  report.bundle = { bytes: packed.bytes, sha256: packed.sha256, digest: packed.digest };
  check('plugins_pack is deterministic and returns compact metadata (no source/base64)');

  // Uninstall completely (registration + files), then reinstall from the bundle.
  const removal = (
    await call('plugins_plan', {
      revision: await rev(),
      actions: [{ type: 'remove', id: 'example.creative' }],
      files: files.map((f) => ({ type: 'delete', path: f, expectedHash: sha(contents[f]) })),
    })
  ).value;
  await commit(removal);
  const emptyRevision = await rev();
  const install = (
    await call('plugins_install', {
      revision: emptyRevision,
      source: { type: 'bundle', path: out1 },
      pin: true,
    })
  ).value;
  assert.equal(install.summary.install.plugins[0].change, 'install');
  report.bytes.installCandidate = bytes(install);
  await commit(install);
  const inspected = (await call('plugins_inspect', { origin: 'project' })).value;
  assert.equal(inspected.items[0].id, 'example.creative');
  assert.equal(inspected.items[0].pinned, 'content');
  assert.equal(inspected.items[0].contentHash, packed.plugins[0].contentHash);
  const plugTools = (await call('tools_search', { pluginId: 'example.creative' })).value;
  assert.ok(bytes(plugTools).length !== 0);
  check(
    'install from bundle -> preflight/apply restores identical content hash, pinned, tools discoverable',
  );
  await call('project_undo', {});
  assert.equal(await rev(), emptyRevision);
  check('one undo removes installed files and registration');

  // Negative requests never touch the project.
  const entries = unzipSync(new Uint8Array(await readFile(out1)));
  const evil = path.join(root, 'exports', 'evil.vmplugin');
  await writeFile(evil, zipSync({ ...entries, 'files/../../evil.ts': strToU8('x') }));
  await invalid(
    'plugins_install',
    { revision: await rev(), source: { type: 'bundle', path: evil } },
    'PLUGIN_BUNDLE_PATH',
  );
  const tampered = path.join(root, 'exports', 'tampered.vmplugin');
  await writeFile(
    tampered,
    zipSync({
      ...entries,
      'files/components/plugins/creative/card.ts': strToU8(contents[files[2]] + '//x'),
    }),
  );
  await invalid(
    'plugins_install',
    { revision: await rev(), source: { type: 'bundle', path: tampered } },
    'PLUGIN_BUNDLE_HASH',
  );
  const future = path.join(root, 'future');
  await mkdir(future, { recursive: true });
  await writeFile(
    path.join(future, 'plugin.json'),
    JSON.stringify({ ...JSON.parse(contents[files[0]]), apiVersion: 2 }),
  );
  await invalid(
    'plugins_install',
    { revision: await rev(), source: { type: 'folder', path: future } },
    'PLUGIN_API_VERSION',
  );
  await writeFile(
    path.join(future, 'plugin.json'),
    JSON.stringify({ ...JSON.parse(contents[files[0]]), id: 'vmotion.fake' }),
  );
  await invalid(
    'plugins_install',
    { revision: await rev(), source: { type: 'folder', path: future } },
    'PLUGIN_ID',
  );
  await invalid(
    'plugins_install',
    { revision: await rev(), source: { type: 'git', url: '--upload-pack=x' } },
    'PLUGIN_GIT',
  );
  check('traversal/hash/future API/reserved ID/bad git URL rejected without mutation');
  report.ok = true;
} finally {
  await client.close().catch(() => {});
  await writeFile('artifacts/plugin-bundles-mcp.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.bytes));
}
