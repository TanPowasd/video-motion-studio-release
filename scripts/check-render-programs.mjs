import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const packageRoot = path.resolve('release/Vmotion'),
  exe = path.join(packageRoot, 'Vmotion.exe'),
  cli = path.join(packageRoot, 'resources/app/dist/cli/index.mjs');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/render-programs-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      typeof value === 'string' && !/^(?:VMOTION_|ESBUILD_|NODE_|ELECTRON_|PATH$)/i.test(key),
  ),
);
env.Path = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
env.ELECTRON_RUN_AS_NODE = '1';
const run = (args) =>
  JSON.parse(
    execFileSync(exe, [cli, ...args], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
run([
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
  '2',
]);
const transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  client = new Client({ name: 'program-renderer-external-agent', version: '1' });
const parse = (result) =>
  result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === 'text').text);
const call = async (name, args = {}, options = {}) => {
  const result = await client.callTool({
    name: 'tool_call',
    arguments: { name, arguments: args, ...options },
  });
  if (result.isError) throw Error(JSON.stringify(result.content));
  return { result, value: parse(result) };
};
const report = { root, checks: [] };
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 10);
  report.catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
  const before = (await call('project_context')).value.revision;
  await call('project_schema', { name: 'renderProgram' });
  const files = [
    {
      path: 'components/renderers/waves.py',
      content: await readFile('scripts/fixtures/program-wave.py', 'utf8'),
    },
    {
      path: 'components/renderers/raymarch.wgsl',
      content: await readFile('scripts/fixtures/program-raymarch.wgsl', 'utf8'),
    },
    ...['python', 'wgsl'].map((backend) => ({
      path: `components/renderers/${backend}.json`,
      content: JSON.stringify({
        kind: 'render-program',
        version: 1,
        name: backend,
        backend,
        entry: `components/renderers/${backend === 'python' ? 'waves.py' : 'raymarch.wgsl'}`,
        uniforms: backend === 'wgsl' ? ['speed'] : [],
        parameters: { speed: { type: 'number', default: 1 } },
      }),
    })),
  ].map((file) => ({ type: 'replace', expectedHash: null, ...file }));
  const candidate = {
    revision: before,
    files,
    operations: [
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'py',
          type: 'program',
          programSource: 'components/renderers/python.json',
          width: 160,
          height: 180,
        },
      },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'shader',
          type: 'program',
          programSource: 'components/renderers/wgsl.json',
          x: 160,
          width: 160,
          height: 180,
        },
      },
    ],
    samples: [
      { sceneId: 'intro', frame: 30 },
      { sceneId: 'intro', frame: 0 },
      { sceneId: 'intro', frame: 30 },
    ],
    width: 320,
    determinism: true,
  };
  const checked = (await call('project_preflight', candidate, { media: false })).value;
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  assert.equal(checked.samples[0].pixelHash, checked.samples[2].pixelHash);
  assert.equal((await call('project_context')).value.revision, before);
  const applied = (
    await call('project_apply', {
      ...candidate,
      expectedCandidateRevision: checked.candidateRevision,
    })
  ).value;
  assert.equal(applied.applied, true);
  const shot = await call('frame_capture', {
    frame: 30,
    width: 320,
    height: 180,
    output: path.join(root, 'exports/preview.png'),
  });
  assert.equal(shot.result.content.filter((content) => content.type === 'image').length, 1);
  assert.ok(!JSON.stringify(shot.value).includes('"data"'));
  const profile = (
    await call('render_profile', {
      sceneId: 'intro',
      frames: [30, 0, 30],
      width: 320,
      height: 180,
      repeat: 2,
      gpu: 'auto',
      detail: true,
    })
  ).value;
  assert.ok(JSON.stringify(profile).includes('workerStarts'));
  report.profile = profile;
  const invalid = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'project_apply',
      arguments: {
        revision: applied.revision,
        files: [
          {
            type: 'replace',
            path: 'components/renderers/python.json',
            expectedHash: createHash('sha256').update(files[2].content).digest('hex'),
            content: JSON.stringify({
              kind: 'render-program',
              version: 1,
              name: 'invalid',
              backend: 'python',
              entry: '../outside.py',
            }),
          },
        ],
      },
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal((await call('project_context')).value.revision, applied.revision);
  const job = (
    await call('render_start', {
      revision: applied.revision,
      format: 'png',
      start: 30,
      end: 31,
      width: 320,
      height: 180,
      gpu: 'gpu',
      output: path.join(root, 'exports/frames'),
    })
  ).value;
  for (let i = 0; i < 200; i++) {
    const status = (await call('render_status', { id: job.id })).value;
    if (status.status === 'completed') break;
    if (status.status === 'failed') throw Error(JSON.stringify(status.error));
    if (i === 199) throw Error('Renderer export timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    (await readFile(path.join(root, 'exports/preview.png'))).equals(
      await readFile(path.join(root, 'exports/frames/frame-00000030.png')),
    ),
  );
  const packed = run(['pack', '--project', root, '--output', path.join(root, 'collected')]);
  assert.ok(packed);
  assert.equal(
    await readFile(path.join(root, 'collected/components/renderers/waves.py'), 'utf8'),
    files[0].content,
  );
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_redo');
  assert.equal((await call('project_context')).value.revision, applied.revision);
  report.checks = [
    '10 compact entries and renderer resource schema',
    'stdio candidate with Python/WGSL source and three random-seek frames',
    'bundled Python with PATH restricted to Windows',
    'pinned dependencies and exact candidate apply/undo/redo',
    'source-guarded negative request leaves project unchanged',
    'native media exactly once',
    'warm worker and GPU profile',
    'exact preview/export PNG',
    'pack includes Python/WGSL source',
  ];
  report.passed = true;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    catalogBytes: report.catalogBytes,
    checks: report.checks,
  }),
);
