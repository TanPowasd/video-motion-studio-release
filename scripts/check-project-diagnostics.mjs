import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

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
const root = await mkdtemp(path.resolve('artifacts/project-diagnostics-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  windowsHide: true,
});
const client = new Client({ name: 'core-diagnostics-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = {
    root,
    packaged,
    metric: 'JSON UTF-8 bytes; no model-specific token estimate',
    checks: [],
  },
  bytes = (v) => Buffer.byteLength(JSON.stringify(v));
let step;
async function call(name, args = {}, { error, full = false } = {}) {
  step = name;
  const result = await client.callTool({
      name: 'tool_call',
      arguments: { name, arguments: args, response: full ? 'full' : 'compact' },
    }),
    value = JSON.parse(result.content.find((c) => c.type === 'text').text);
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(result.isError, true, JSON.stringify(value));
  return { result, value };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const modules = (await call('plugins_inspect', { limit: 50 })).value.items;
  assert.equal(modules.length, 18);
  assert.ok(modules.every((p) => p.runtime === 'module' && p.hostTools === 0));
  assert.equal(
    modules.reduce((n, p) => n + p.moduleTools, 0),
    147,
  );
  for (const name of [
    'sound',
    'soundInstrument',
    'soundEffect',
    'audioMix',
    'audioNormalization',
    'plugin',
    'pluginRegistration',
    'storyboard',
    'textureSettings',
  ]) {
    assert.equal((await call('project_schema', { name })).value.name, name);
  }
  await call('project_schema', { name: 'future' }, { error: 'TOOL_ARGUMENTS' });
  report.checks.push(
    '18 complete modules/147 capabilities; authoritative resource kinds accessible',
  );
  const original = (await call('project_context')).value.revision;
  await call('project_transact', {
    revision: original,
    save: false,
    operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { x: 555 } }],
  });
  const scenePath = path.join(root, 'scenes/intro.json'),
    scene = JSON.parse(await readFile(scenePath, 'utf8'));
  scene.nodes.find((n) => n.id === 'title').x = 777;
  await writeFile(scenePath, JSON.stringify(scene));
  await call('project_validate');
  const conflict = (await call('project_diagnostics', { section: 'conflicts' })).value,
    conflictDetail = (
      await call('project_diagnostics', {
        section: 'conflicts',
        files: ['scenes/intro.json'],
        detail: true,
      })
    ).value;
  assert.equal(conflict.total, 1);
  assert.equal(conflict.items[0].ours, undefined);
  assert.equal(conflictDetail.items[0].ours, 555);
  assert.equal(conflictDetail.items[0].theirs, 777);
  await call(
    'project_transact',
    { operations: [{ type: 'updateScene', sceneId: 'intro', patch: { name: 'Blocked' } }] },
    { error: 'UNRESOLVED_CONFLICTS' },
  );
  await call('project_resolve_conflict', { index: 999, choice: 'ours' }, { error: 'NOT_FOUND' });
  await call('project_resolve_conflict', { index: 0, choice: 'theirs' });
  const resolved = (await call('project_context')).value.revision;
  assert.equal((await call('project_diagnostics', { section: 'conflicts' })).value.total, 0);
  await call('project_undo');
  await call('project_redo');
  assert.equal((await call('project_context')).value.revision, resolved);
  report.checks.push(
    'actual concurrent same-field conflict preserves both values; resolve and shared undo/redo',
  );
  const manifestPath = path.join(root, 'project.vmotion.json'),
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets = Array.from({ length: 123 }, (_, i) => ({
    id: 'missing-' + i,
    name: 'Missing ' + i,
    type: 'image',
    path: `missing/asset-${i}.png`,
    metadata: {},
    managed: false,
  }));
  await writeFile(manifestPath, JSON.stringify(manifest));
  const validated = (await call('project_validate')).value;
  assert.equal(validated.valid, false);
  const first = (await call('project_diagnostics', { revision: resolved })).value,
    second = (await call('project_diagnostics', { offset: first.nextOffset })).value;
  assert.equal(first.total, 123);
  assert.equal(first.items.length, 20);
  assert.equal(second.items[0].index, 20);
  assert.equal(first.summary.pendingFiles, true);
  assert.equal(first.coverage.omitted, 103);
  const filtered = (
    await call('project_diagnostics', {
      files: ['missing/asset-5.png'],
      codes: ['MISSING_ASSET'],
      severities: ['error'],
      detail: true,
    })
  ).value;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.summary.errors, 123);
  await call('project_diagnostics', { revision: original }, { error: 'REVISION_CONFLICT' });
  for (const args of [
    { limit: 101 },
    { offset: -1 },
    { section: 'conflicts', codes: ['MISSING_ASSET'] },
    { typo: true },
  ])
    await call('project_diagnostics', args, { error: 'TOOL_ARGUMENTS' });
  assert.equal((await call('project_context')).value.revision, resolved);
  report.compactDiagnosticBytes = bytes(first);
  report.fullDiagnosticBytes = bytes(validated.diagnostics);
  assert.ok(report.compactDiagnosticBytes < report.fullDiagnosticBytes / 3);
  const pending = (await call('project_diagnostics', { section: 'pendingFiles', detail: true }))
    .value;
  assert.equal(pending.total, 1);
  const file = (
    await call('project_file_read', {
      path: 'project.vmotion.json',
      version: 'pending',
      lineCount: 1000,
    })
  ).value;
  assert.equal(pending.items[0].afterHash, file.hash);
  manifest.assets = [];
  const request = {
      version: 'pending',
      revision: resolved,
      files: [
        {
          type: 'replace',
          path: file.path,
          expectedHash: file.hash,
          content: JSON.stringify(manifest, null, 2) + '\n',
        },
      ],
    },
    checked = (await call('project_preflight', request)).value;
  assert.equal(checked.valid, true);
  assert.equal((await call('project_diagnostics')).value.summary.pendingFiles, true);
  await call(
    'project_apply',
    { ...request, expectedCandidateRevision: 'wrong' },
    { error: 'CANDIDATE_REVISION' },
  );
  const applied = (
    await call('project_apply', {
      ...request,
      expectedCandidateRevision: checked.candidateRevision,
    })
  ).value;
  assert.equal(applied.revision, checked.candidateRevision);
  assert.deepEqual((await call('project_diagnostics')).value.summary, {
    errors: 0,
    warnings: 0,
    conflicts: 0,
    pendingFiles: false,
  });
  const candidate = {
      revision: applied.revision,
      files: [
        {
          type: 'replace',
          path: 'components/sample-clock.ts',
          expectedHash: null,
          content:
            "import {defineComponent,rect} from '@vmotion/sdk'; export default defineComponent({name:'Clock',parameters:{value:{type:'number',default:10}},render:(ctx,p)=>[rect('box',{x:ctx.frame*2,y:p.value,width:16,height:16,fill:'#fff'})]});",
        },
      ],
      operations: [
        { type: 'updateProject', patch: { width: 320, height: 180 } },
        {
          type: 'updateScene',
          sceneId: 'intro',
          patch: {
            background: 'transparent',
            nodes: [
              {
                id: 'clock',
                type: 'component',
                component: 'components/sample-clock.ts',
                params: { value: 10 },
                width: 320,
                height: 180,
                timeMapping: { rate: 0, offset: 12 },
                animations: [
                  {
                    property: 'params.value',
                    keys: [
                      { frame: 0, value: 10, easing: 'linear' },
                      { frame: 60, value: 70, easing: 'linear' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      samples: [{ sceneId: 'intro', frame: 12, path: ['clock'], contextFrames: [20] }],
      width: 320,
      determinism: true,
    },
    preflight = await call('project_preflight', candidate);
  assert.equal(preflight.value.valid, true, JSON.stringify(preflight.value.diagnostics));
  assert.ok(preflight.result.content.some((c) => c.type === 'image'));
  await call('project_apply', {
    ...candidate,
    expectedCandidateRevision: preflight.value.candidateRevision,
  });
  const picture = await call('frame_sample', {
    frames: [12],
    sceneId: 'intro',
    path: ['clock'],
    contextFrames: [20],
    width: 320,
  });
  assert.ok(picture.result.content.some((c) => c.type === 'image'));
  assert.equal(picture.value.data, undefined);
  assert.ok(!JSON.stringify(picture.result.structuredContent).includes('base64'));
  const image = await loadImage(picture.value.output),
    sheet = createCanvas(image.width, image.height);
  sheet.getContext('2d').drawImage(image, 0, 0);
  assert.equal(sheet.getContext('2d').getImageData(25, 31, 1, 1).data[0], 255);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, applied.revision);
  report.checks.push(
    '123-error pagination/filter/full evidence; invalid requests preserve active files',
    'pending-file exact repair and candidate mismatch refusal',
    'retimed focused contact sheet retains ancestor parameter clock and native media',
    'new CLI command shares strict validation and current-service state',
  );
  const requestPath = path.join(root, 'diagnostics-request.json');
  await writeFile(
    requestPath,
    JSON.stringify({ section: 'diagnostics', revision: applied.revision }),
  );
  const cliResult = JSON.parse(
    execFileSync(
      executable,
      [cli, 'project-diagnostics', '--project', root, '--request', requestPath],
      { env, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(cliResult.revision, applied.revision);
  assert.equal(cliResult.summary.errors, 0);
  const loaded = await client.callTool({
    name: 'tools_load',
    arguments: { names: ['project_diagnostics'] },
  });
  assert.notEqual(loaded.isError, true);
  const direct = await client.callTool({ name: 'project_diagnostics', arguments: {} });
  assert.notEqual(direct.isError, true);
  assert.equal(JSON.parse(direct.content.find((c) => c.type === 'text').text).total, 0);
  report.passed = true;
} catch (e) {
  report.failedStep = step;
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
