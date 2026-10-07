import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, mkdtemp, cp, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged'),
  pkg = path.resolve('release/Vmotion');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/audio-plugins-'));
const plugin = path.join(root + '-plugins', 'External Plugins 空格', 'vmotion-audio-fixture.vst3');
await cp(path.resolve('artifacts/audio-build/VST3/Release/vmotion-audio-fixture.vst3'), plugin, {
  recursive: true,
});
const runtime = packaged ? path.join(pkg, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(pkg, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
  ...(packaged
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        ESBUILD_BINARY_PATH: path.join(pkg, 'resources/compiler/esbuild.exe'),
        PATH: path.join(process.env.SystemRoot, 'System32'),
        Path: path.join(process.env.SystemRoot, 'System32'),
        VMOTION_AUDIO_HOST: '',
      }
    : {}),
};
execFileSync(
  runtime,
  [cli, 'init', '--project', root, '--width', '320', '--height', '180', '--duration', '2'],
  { env, windowsHide: true },
);
const client = new Client({ name: 'audio-plugin-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: runtime,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
const report = { root, packaged, checks: [] };
const parse = (r) => JSON.parse(r.content.find((b) => b.type === 'text').text);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.ok(!r.isError, JSON.stringify(parse(r)));
  return { result: parse(r), content: r.content };
};
try {
  await client.connect(transport);
  const startup = await client.listTools();
  assert.equal(startup.tools.length, 10);
  report.startupBytes = Buffer.byteLength(JSON.stringify(startup));
  const scan = (await call('audio_plugins', { action: 'scan', paths: [plugin] })).result;
  assert.equal(scan.plugins.length, 2, JSON.stringify(scan));
  assert.equal(scan.diagnostics.length, 0);
  const p = scan.plugins[0],
    config = {
      format: p.format,
      path: p.path,
      classId: p.classId,
      name: p.name,
      fingerprint: p.fingerprint,
      parameters: { 1: 0.25 },
    };
  const inspect = (await call('audio_plugins', { action: 'inspect', config })).result;
  assert.equal(inspect.description.parameters[0].name, 'Gain');
  report.inspectBytes = Buffer.byteLength(JSON.stringify(inspect));
  const schema = parse(
    await client.callTool({ name: 'tool_schema', arguments: { name: 'audio_live' } }),
  );
  assert.ok(schema.schemaHash);
  const cached = parse(
    await client.callTool({
      name: 'tool_schema',
      arguments: { name: 'audio_live', ifHash: schema.schemaHash },
    }),
  );
  assert.equal(cached.notModified, true);
  report.schemaBytes = Buffer.byteLength(JSON.stringify(schema));
  report.cachedSchemaBytes = Buffer.byteLength(JSON.stringify(cached));
  const live = (await call('audio_live', { action: 'open', config, blockSize: 512 })).result;
  assert.ok(live.sessionId);
  assert.equal(live.description.latencySamples, 0);
  await call('audio_live', { action: 'parameters', sessionId: live.sessionId, values: { 1: 0.4 } });
  await call('audio_live', { action: 'editor', sessionId: live.sessionId, show: true });
  await call('audio_live', { action: 'editor', sessionId: live.sessionId, show: false });
  const state = (await call('audio_live', { action: 'state', sessionId: live.sessionId })).result;
  assert.ok(state.state);
  await call('audio_live', { action: 'panic', sessionId: live.sessionId });
  await call('audio_live', { action: 'close', sessionId: live.sessionId });
  const before = (await call('project_context')).result.revision;
  const doc = {
    kind: 'sound',
    version: 1,
    id: 'vst-score',
    name: 'VST3 score',
    unit: 'seconds',
    duration: 1,
    tail: 0,
    tracks: [
      {
        id: 'lead',
        instrument: {
          ...config,
          type: 'plugin',
          state: (() => {
            const bytes = Buffer.alloc(512 * 1024);
            Buffer.from(state.state, 'base64').copy(bytes);
            return bytes.toString('base64');
          })(),
        },
        events: [{ id: 'a', at: 0.1, duration: 0.6, note: 69, velocity: 0.8 }],
        effects: [
          {
            format: 'vst3',
            path: plugin,
            classId: scan.plugins[1].classId,
            type: 'plugin',
            parameters: { 1: 0.5 },
          },
        ],
      },
    ],
  };
  const plan = (
    await call('sound_plan', {
      items: [
        {
          assetId: doc.id,
          document: doc,
          placement: { trackId: 'music', createTrack: 'Music', start: 0 },
        },
      ],
    })
  ).result;
  const preview = await call('sound_preview', {
    assetId: doc.id,
    planId: plan.plan.planId,
    sampleCount: 48000,
  });
  assert.ok(preview.result.metrics.rms > 0.01);
  assert.equal(preview.content.filter((c) => c.type === 'audio').length, 1);
  assert.ok(!JSON.stringify(preview.result).includes('base64'));
  const output = (await call('sound_export', { assetId: doc.id, planId: plan.plan.planId })).result;
  assert.equal((await stat(output.output)).size, 44 + 48000 * 8);
  assert.equal((await call('project_context')).result.revision, before);
  for (const [name, args] of [
    ['audio_plugins', { action: 'inspect', config: { ...config, classId: 'missing' } }],
    ['audio_live', { action: 'parameters', sessionId: live.sessionId, values: { 1: 2 } }],
    [
      'sound_plan',
      {
        items: [
          {
            assetId: doc.id,
            document: {
              ...doc,
              tracks: [
                {
                  ...doc.tracks[0],
                  instrument: { ...doc.tracks[0].instrument, fingerprint: 'changed' },
                },
              ],
            },
          },
        ],
      },
    ],
  ]) {
    const rejected = await client.callTool({
      name: 'tool_call',
      arguments: { name, arguments: args },
    });
    assert.equal(rejected.isError, true);
    assert.equal((await call('project_context')).result.revision, before);
  }
  if (process.platform !== 'darwin') {
    const rejected = await client.callTool({
      name: 'tool_call',
      arguments: { name: 'audio_plugins', arguments: { action: 'scan', format: 'au' } },
    });
    assert.equal(rejected.isError, true);
  }
  assert.equal((await call('project_preflight', plan.candidate)).result.valid, true);
  await call('project_apply', plan.apply);
  const compact = (await call('sound_inspect', { assetId: doc.id })).result;
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 5000);
  assert.ok(!JSON.stringify(compact).includes(doc.tracks[0].instrument.state));
  const full = (await call('sound_inspect', { assetId: doc.id, includeDocument: true })).result;
  assert.equal(full.document.tracks[0].instrument.state, doc.tracks[0].instrument.state);
  assert.equal(JSON.stringify(full).split(doc.tracks[0].instrument.state).length, 2);
  report.compactSoundBytes = Buffer.byteLength(JSON.stringify(compact));
  report.explicitSoundBytes = Buffer.byteLength(JSON.stringify(full));
  assert.equal(
    (await call('sound_preview', { assetId: doc.id, sampleCount: 48000 })).content.find(
      (c) => c.type === 'audio',
    ).data,
    preview.content.find((c) => c.type === 'audio').data,
  );
  await call('project_undo');
  assert.equal((await call('project_context')).result.revision, before);
  await call('project_redo');
  assert.equal((await call('sound_inspect', { assetId: doc.id })).result.events.total, 1);
  report.checks = [
    'isolated native VST3 scan in Chinese path',
    'normalized parameters + editor/state/close',
    'conditional schema hashes',
    'synth+external effect full candidate',
    'native audio once without Base64 duplication',
    'missing class/bad parameters/fingerprint/platform rejection',
    'preview/export/shared timeline source',
    'exact candidate apply + one undo/redo',
    'packaged runtime without development PATH',
  ];
  report.exportBytes = Buffer.byteLength(JSON.stringify(output));
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
