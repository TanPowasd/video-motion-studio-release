import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'),
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
const root = await mkdtemp(path.resolve('artifacts/mcp-budget-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  windowsHide: true,
});
const client = new Client({ name: 'mcp-token-budget-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = {
    root,
    packaged,
    metric: 'JSON UTF-8 bytes and text characters; model-specific tokenization is not assumed',
    schemas: [],
  };
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text),
  bytes = (value) => Buffer.byteLength(JSON.stringify(value));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result;
}
try {
  await client.connect(transport);
  const initial = await client.listTools();
  assert.equal(initial.tools.length, 10);
  report.initialCatalogBytes = bytes(initial);
  assert.ok(report.initialCatalogBytes < 16000);
  for (const name of [
    'sound_plan',
    'component_query',
    'assets_query',
    'drawing_query',
    'project_diagnostics',
    'project_schema',
    'effect_graph_plan',
    'effect_graph_query',
    'render_compare',
    'render_profile',
    'render_start',
    'composition_edit_layers',
    'animation_layers_inspect',
    'animation_layers_plan',
    'project_references',
    'reference_plan',
    'reference_sample',
    'sequence_query',
    'color_scopes',
    'frame_compare',
    'layer_impact',
    'drivers_plan',
    'sequence_plan',
    'graphics_plan',
    'graphics_inspect',
    'tracking_analyze',
    'tracking_inspect',
    'tracking_plan',
    'theme_plan',
    'template_plan',
  ]) {
    const compact = parse(await call('tool_schema', { name })),
      expanded = parse(await call('tool_schema', { name, format: 'expanded' })),
      cached = parse(await call('tool_schema', { name, ifHash: compact.schemaHash }));
    assert.equal(compact.schemaHash, expanded.schemaHash);
    assert.equal(cached.notModified, true);
    assert.equal(cached.inputSchema, undefined);
    assert.ok(bytes(cached) < 250);
    assert.ok(bytes(compact) <= bytes(expanded) + 32);
    const unresolved = parse(await call('tool_schema', { name, ifHash: '0'.repeat(64) }));
    assert.equal(unresolved.schemaHash, compact.schemaHash);
    assert.ok(unresolved.inputSchema);
    const schema = compact.inputSchema,
      scan = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.$ref) {
          assert.ok(node.$ref.startsWith('#/'));
          let target = schema;
          for (const key of node.$ref.slice(2).split('/'))
            target = target?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
          assert.notEqual(target, undefined, `${name}: ${node.$ref}`);
        }
        for (const value of Object.values(node)) scan(value);
      };
    scan(schema);
    report.schemas.push({
      name,
      compactBytes: bytes(compact),
      expandedBytes: bytes(expanded),
      cachedBytes: bytes(cached),
      savedRatio: 1 - bytes(compact) / bytes(expanded),
    });
  }
  assert.ok(report.schemas.find((s) => s.name === 'sound_plan').savedRatio > 0.5);
  assert.ok(report.schemas.find((s) => s.name === 'effect_graph_plan').savedRatio > 0.6);
  assert.equal((await client.listTools()).tools.length, 10);
  const before = parse(await call('tool_call', { name: 'project_context', arguments: {} })),
    operation = [
      {
        type: 'updateNode',
        sceneId: 'intro',
        nodeId: 'title',
        patch: { text: 'Compact MCP edit' },
      },
    ],
    changed = await call('tool_call', {
      name: 'project_transact',
      arguments: { revision: before.revision, operations: operation },
    }),
    compact = parse(changed),
    full = await call('tool_call', { name: 'project_inspect', arguments: {}, response: 'full' });
  assert.equal(compact.snapshot, undefined);
  assert.ok(bytes(changed) < bytes(full) * 0.2);
  report.compactMutationBytes = bytes(changed);
  report.fullProjectBytes = bytes(full);
  const malformed = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'sound_plan',
      arguments: {
        items: [
          {
            assetId: 'bad',
            document: { kind: 'sound', version: 1, id: 'bad', name: 'bad', duration: -1 },
          },
        ],
      },
    },
  });
  assert.equal(malformed.isError, true);
  assert.equal(parse(malformed).code, 'TOOL_ARGUMENTS');
  assert.ok(bytes(malformed) < 5000);
  const picture = await call('tool_call', {
    name: 'frame_capture',
    arguments: { frame: 0, width: 160, height: 90 },
  });
  assert.ok(picture.content.some((c) => c.type === 'image'));
  assert.ok(!picture.content.find((c) => c.type === 'text').text.includes('base64'));
  assert.ok(!JSON.stringify(picture.structuredContent).includes('base64'));
  report.pictureMetadataBytes = bytes(picture.structuredContent);
  const shortSearch = parse(await call('tools_search', { query: 'graph' })),
    fullSearch = parse(await call('tools_search', { query: 'graph', detail: true }));
  assert.deepEqual(
    shortSearch.items.map((i) => i.name),
    fullSearch.items.map((i) => i.name),
  );
  report.searchBytes = bytes(shortSearch);
  report.searchDetailBytes = bytes(fullSearch);
  assert.ok(report.searchBytes < report.searchDetailBytes * 0.8);
  const shortSchema = parse(await call('tool_schema', { name: 'composition_edit_layers' })),
    fullSchema = parse(
      await call('tool_schema', { name: 'composition_edit_layers', detail: true }),
    );
  assert.deepEqual(shortSchema.inputSchema, fullSchema.inputSchema);
  assert.equal(shortSchema.schemaHash, fullSchema.schemaHash);
  assert.equal(shortSchema.description, undefined);
  assert.ok(fullSchema.description);
  report.schemaMetadataBytes = { compact: bytes(shortSchema), detail: bytes(fullSchema) };
  const projected = await call('tool_call', {
    name: 'project_inspect',
    arguments: {},
    response: 'full',
    fields: ['snapshot.project.name', 'snapshot.project.width'],
    media: false,
  });
  assert.equal(parse(projected).snapshot.project.width, 1920);
  assert.equal(parse(projected).resultProjection.partial, true);
  report.projectSelectedBytes = bytes(parse(projected));
  assert.ok(report.projectSelectedBytes < report.fullProjectBytes * 0.02);
  const missing = await call('tool_call', {
    name: 'project_context',
    arguments: {},
    fields: ['missing'],
    media: false,
  });
  assert.deepEqual(parse(missing).resultProjection.missing, ['missing']);
  assert.ok(parse(missing).revision);
  const suppressed = await call('tool_call', {
    name: 'frame_capture',
    arguments: { width: 160 },
    media: false,
    fields: ['output', 'revision'],
  });
  assert.equal(suppressed.content.filter((c) => c.type === 'image').length, 0);
  assert.equal(parse(suppressed).data, undefined);
  const beforeInvalid = parse(await call('project_context'));
  const unsafe = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'project_transact',
      arguments: { operations: [{ type: 'updateProject', patch: { name: 'must not save' } }] },
      fields: ['__proto__.x'],
    },
  });
  assert.equal(unsafe.isError, true);
  assert.equal(parse(await call('project_context')).revision, beforeInvalid.revision);
  await call('tools_load', { names: ['composition_edit_layers'] });
  const plan = await client.callTool({
    name: 'composition_edit_layers',
    arguments: {
      sceneId: 'intro',
      revision: beforeInvalid.revision,
      mode: 'plan',
      edits: [{ nodeId: 'subtitle', patch: { x: 100 } }],
    },
  });
  assert.notEqual(plan.isError, true);
  const candidate = parse(plan);
  assert.equal(parse(await call('project_context')).revision, beforeInvalid.revision);
  await call('tool_call', {
    name: 'project_preflight',
    arguments: candidate.candidate,
    media: false,
  });
  await call('tool_call', {
    name: 'project_apply',
    arguments: candidate.apply,
    fields: ['applied', 'revision', 'candidateRevision'],
  });
  assert.equal(parse(await call('project_context')).revision, candidate.candidateRevision);
  await call('tool_call', { name: 'project_undo' });
  assert.equal(parse(await call('project_context')).revision, beforeInvalid.revision);
  await call('tool_call', { name: 'project_undo', arguments: {} });
  assert.equal(
    parse(await call('tool_call', { name: 'project_context', arguments: {} })).revision,
    before.revision,
  );
  const loaded = parse(await call('tools_load', { names: ['sound_inspect'] }));
  assert.ok(loaded.enabled.includes('sound_inspect'));
  await call('tools_load', { mode: 'replace' });
  assert.equal((await client.listTools()).tools.length, 10);
  const cliSchema = JSON.parse(
    execFileSync(
      executable,
      [
        cli,
        'tool-schema',
        '--name',
        'sound_plan',
        '--if-hash',
        report.schemas[0] && parse(await call('tool_schema', { name: 'sound_plan' })).schemaHash,
      ],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliSchema.notModified, true);
  report.checks = [
    'short discovery/schema metadata with identical interfaces and full opt-in',
    'selected output paths/explicit missing/revision retention and media suppression',
    'unsafe output selection rejected before write; composition plan exact candidate and undo',
    '10-entry bounded startup',
    'exact schemas with valid local references',
    'unchanged-interface short cache response',
    'hash miss refresh',
    'selected heavy schemas shrink >50%',
    'compact mutation vs full project',
    'malformed input preserves revision',
    'native image without base64 in metadata/text',
    'direct tool opt-in and reset',
    'CLI cache parity',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
