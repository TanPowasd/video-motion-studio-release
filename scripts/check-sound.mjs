import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const root = await mkdtemp(path.resolve('artifacts/sound-batch-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '3'],
  { env, windowsHide: true },
);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523.251:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    path.join(root, 'sample.wav'),
  ],
  { windowsHide: true },
);
const client = new Client({ name: 'sound-batch-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] };
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = JSON.parse(result.content.find((b) => b.type === 'text').text);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, content: result.content };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const guide = await call('agent_guide', { topic: 'sound' }),
    library = await call('sound_library');
  const discovered = await client.callTool({ name: 'tools_search', arguments: { limit: 1 } });
  assert.equal(
    guide.value.discovery.availableCapabilities,
    JSON.parse(discovered.content.find((b) => b.type === 'text').text).total,
  );
  assert.ok(library.value.presets.bell);
  const audioModule = (await call('plugins_inspect', { id: 'vmotion.audio' })).value;
  assert.equal(audioModule.items[0].runtime, 'module');
  assert.equal(audioModule.items[0].moduleTools, 15);
  assert.equal(audioModule.items[0].hostTools, 0);
  const audioDiscovery = await client.callTool({
      name: 'tools_search',
      arguments: { pluginId: 'vmotion.audio', limit: 20 },
    }),
    audioTools = JSON.parse(audioDiscovery.content.find((b) => b.type === 'text').text).items;
  assert.equal(audioTools.length, 15);
  for (const tool of audioTools) assert.equal(tool.plugin.id, 'vmotion.audio');
  report.moduleTools = audioTools.map((t) => t.name);
  await call('asset_import', { path: path.join(root, 'sample.wav'), type: 'audio', copy: true });
  const context = (await call('project_context')).value,
    imported = (await call('project_inspect')).value.snapshot.project.assets.find(
      (a) => a.type === 'audio',
    );
  const waveform = await call('audio_waveform', { assetId: imported.id }),
    analysis = await call('audio_analyze', { assetId: imported.id, duration: 1, rate: 10 });
  assert.ok(waveform.value);
  assert.equal(analysis.value.assetId, imported.id);
  report.waveform = true;
  report.analysis = true;
  const source =
    "import {defineComponent,text,rect} from '@vmotion/sdk';export default defineComponent({name:'Audio evidence',parameters:{},render(ctx){return [text('title','音乐与音效制作',{x:32,y:28,width:560,height:45,fontSize:30}),rect('meter',{x:32,y:100,width:Math.max(4,(ctx.audio?.rms??0)*1000),height:28,fill:'#7cdbc0'}),text('label','真实音频驱动画面 · 编辑工程保持可修改',{x:32,y:158,width:560,height:40,fontSize:20})]}});";
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/audio.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'meter',
          type: 'component',
          component: 'components/audio.ts',
          audioAssetId: imported.id,
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    document = {
      kind: 'sound',
      version: 1,
      id: 'music',
      name: 'Agent music & sound effects',
      unit: 'beats',
      duration: 3,
      tail: 0.5,
      tempo: [{ beat: 0, bpm: 120 }],
      tracks: [
        {
          id: 'bell',
          name: '合成旋律',
          instrument: library.value.presets.bell,
          events: [
            { id: 'c', at: 0, duration: 0.7, note: 60 },
            { id: 'e', at: 1, duration: 0.7, note: 64 },
            { id: 'g', at: 2, duration: 0.7, note: 67 },
          ],
          sends: [{ busId: 'room', db: -12 }],
          automation: [
            {
              property: 'pan',
              keys: [
                { at: 0, value: -0.5 },
                { at: 3, value: 0.5 },
              ],
            },
          ],
        },
        {
          id: 'sample',
          name: '采样加工',
          instrument: {
            type: 'sample',
            assetId: imported.id,
            sourceDuration: 1,
            rootNote: 72,
            gain: 0.5,
          },
          events: [{ id: 'sample-a', at: 0.5, duration: 1, note: 76 }],
          effects: [
            { type: 'filter', mode: 'lowpass', frequency: 3000 },
            { type: 'chorus', rate: 0.8, depth: 0.003, delay: 0.02, mix: 0.2 },
          ],
        },
        {
          id: 'kick',
          name: '音效',
          instrument: library.value.presets.kick,
          events: [
            { id: 'impact', at: 0, duration: 0.2, note: 33, velocity: 0.8 },
            { id: 'impact2', at: 2, duration: 0.2, note: 33, velocity: 0.7 },
          ],
        },
      ],
      buses: [{ id: 'room', effects: [{ type: 'reverb', seconds: 1, mix: 1 }] }],
      master: {
        effects: [
          { type: 'compressor', thresholdDb: -16, ratio: 2, kneeDb: 6, attack: 0.01, release: 0.1 },
          { type: 'limiter', ceilingDb: -2 },
        ],
      },
    };
  const plan = await call('sound_plan', {
    revision: before,
    items: [
      {
        assetId: 'music',
        document,
        placement: { trackId: 'music-track', createTrack: '乐曲', start: 0 },
      },
    ],
  });
  assert.equal((await call('project_context')).value.revision, before);
  const candidate = await call('sound_preview', {
    planId: plan.value.plan.planId,
    revision: before,
    assetId: 'music',
    sampleCount: 96000,
  });
  assert.ok(candidate.content.some((b) => b.type === 'audio'));
  assert.ok(candidate.value.metrics.rms > 0.005);
  assert.ok(candidate.value.fullMix.peak <= 10 ** (-2 / 20) + 1e-6);
  assert.equal(candidate.value.fullMix.clippedSampleRatio, 0);
  const checked = await call('project_preflight', plan.value.candidate);
  assert.equal(checked.value.valid, true);
  await call('project_apply', plan.value.apply);
  const pageBase = (await call('project_context')).value.revision,
    pageState = (await call('project_inspect')).value.snapshot,
    sequence = pageState.sequences.find((s) => s.id === pageState.project.activeSequence);
  await call('project_transact', {
    revision: pageBase,
    operations: [
      {
        type: 'updateSequence',
        sequenceId: sequence.id,
        patch: {
          duration: 400,
          tracks: [
            ...sequence.tracks,
            {
              id: 'pagination',
              name: '分页压力',
              type: 'audio',
              muted: false,
              clips: Array.from({ length: 100 }, (_, i) => ({
                id: 'page-' + i,
                assetId: 'music',
                start: i * 3,
                duration: 1,
                sourceIn: 0,
                speed: 1,
                volume: 0.5,
                fadeIn: 0,
                fadeOut: 0,
              })),
            },
          ],
        },
      },
    ],
  });
  const page = (await call('audio_timeline')).value,
    full = (await call('audio_timeline', { includeAll: true })).value;
  assert.equal(page.clips.length, 24);
  assert.equal(page.nextOffset, 24);
  assert.ok(full.clips.length >= 100);
  assert.deepEqual(page.clips, full.clips.slice(0, 24));
  const secondPage = (await call('audio_timeline', { offset: 24 })).value;
  assert.deepEqual(secondPage.clips, full.clips.slice(24, 48));
  report.timelineBytes = {
    paged: Buffer.byteLength(JSON.stringify(page)),
    full: Buffer.byteLength(JSON.stringify(full)),
    totalClips: page.totalClips,
  };
  assert.ok(report.timelineBytes.paged < report.timelineBytes.full * 0.3);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, pageBase);
  const revision = (await call('project_context')).value.revision,
    accepted = await call('sound_preview', { assetId: 'music', sampleCount: 96000 });
  assert.equal(
    accepted.content.find((b) => b.type === 'audio').data,
    candidate.content.find((b) => b.type === 'audio').data,
  );
  const range = await call('sound_preview', {
      assetId: 'music',
      startSample: 30011,
      sampleCount: 17555,
    }),
    fullWave = Buffer.from(accepted.content.find((b) => b.type === 'audio').data, 'base64'),
    rangeWave = Buffer.from(range.content.find((b) => b.type === 'audio').data, 'base64');
  assert.deepEqual(
    rangeWave.subarray(44),
    fullWave.subarray(44 + 30011 * 4, 44 + (30011 + 17555) * 4),
  );
  const timeline = await call('audio_preview', { sampleCount: 96000 });
  assert.equal(
    timeline.content.find((b) => b.type === 'audio').data,
    accepted.content.find((b) => b.type === 'audio').data,
  );
  const originalSource = (await call('project_file_read', { path: 'components/audio.ts' })).value
    .hash;
  await call('project_transact', {
    operations: [
      { type: 'updateNode', sceneId: 'intro', nodeId: 'meter', patch: { audioAssetId: 'music' } },
    ],
  });
  await call('frame_capture', { frame: 20, width: 640, height: 360 });
  await call('frame_capture', { frame: 2, width: 640, height: 360 });
  await call('frame_capture', { frame: 20, width: 640, height: 360 });
  assert.equal(
    (await call('project_file_read', { path: 'components/audio.ts' })).value.hash,
    originalSource,
  );
  const info = await call('sound_inspect', { assetId: 'music', limit: 2 });
  assert.equal(info.value.events.total, 6);
  assert.equal(info.value.events.hasMore, true);
  const bad = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'sound_plan',
      arguments: {
        items: [
          {
            assetId: 'music',
            actions: [
              {
                type: 'settings',
                patch: {
                  buses: [
                    { id: 'room', effects: [{ type: 'reverb', seconds: 1, mix: 1 }] },
                    { id: 'a', busId: 'b' },
                    { id: 'b', busId: 'a' },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(bad.content.find((b) => b.type === 'text').text).code, 'SOUND_BUS_CYCLE');
  const midi = path.join(root, 'exports/music.mid');
  await call('sound_midi', { action: 'export', assetId: 'music', output: midi });
  const midiPlan = await call('sound_midi', {
    action: 'import',
    assetId: 'midi-copy',
    input: midi,
  });
  assert.equal(midiPlan.value.midi.notes, 6);
  const wait = async (id) => {
    for (let i = 0; i < 300; i++) {
      const state = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(state.status)) {
        assert.equal(state.status, 'completed', state.error);
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Render timeout');
  };
  const used = (await call('project_context')).value.revision;
  for (const format of ['wav', 'mp4']) {
    const job = await call('render_start', {
      revision: used,
      format,
      output: path.join(root, `exports/sound-batch.${format}`),
    });
    await wait(job.value.id);
  }
  const output = path.join(root, 'exports/sound-batch.mp4'),
    probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 90);
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
  const wav = path.join(root, 'exports/sound-batch.wav'),
    pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', wav, '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1'],
      { windowsHide: true },
    );
  let maxError = 0;
  for (let i = 0; i < 96000 * 2; i++)
    maxError = Math.max(
      maxError,
      Math.abs(pcm.readInt16LE(i * 2) - fullWave.readInt16LE(44 + i * 2)),
    );
  assert.ok(maxError <= 2, `WAV quantization error ${maxError}`);
  await call('frame_sample', {
    frames: [0, 15, 30, 60, 89],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  await call('project_undo'); // meter audio source update
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_apply', plan.value.apply);
  const patternBase = (await call('project_context')).value.revision;
  const patternPlan = await call('sound_plan', {
    items: [
      {
        assetId: 'patterns',
        document: {
          kind: 'sound',
          version: 1,
          id: 'patterns',
          name: 'Reusable patterns',
          duration: 4,
          tail: 0.25,
          tracks: [{ id: 'bell', instrument: library.value.presets.bell, events: [] }],
          patterns: [
            {
              id: 'phrase',
              name: 'Phrase',
              length: 2,
              channels: [
                {
                  trackId: 'bell',
                  events: [
                    { id: 'c', at: 0, duration: 0.5, note: 60 },
                    { id: 'g', at: 1, duration: 0.5, note: 67 },
                  ],
                },
              ],
            },
          ],
          arrangement: [{ id: 'repeat', patternId: 'phrase', at: 0, repeats: 2 }],
          master: { effects: [{ type: 'limiter' }] },
        },
      },
    ],
  });
  const scoreExport = await call('sound_export', {
    assetId: 'patterns',
    planId: patternPlan.value.plan.planId,
  });
  assert.equal(scoreExport.value.duration, 2.25);
  assert.equal(scoreExport.content.filter((b) => b.type === 'audio').length, 0);
  assert.ok(!JSON.stringify(scoreExport.value).includes('base64'));
  assert.equal((await call('project_context')).value.revision, patternBase);
  await call('sound_midi', {
    action: 'export',
    assetId: 'patterns',
    planId: patternPlan.value.plan.planId,
    output: path.join(root, 'exports/patterns.mid'),
  });
  const invalidExport = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'sound_export',
      arguments: {
        assetId: 'patterns',
        planId: patternPlan.value.plan.planId,
        output: path.join(root, 'project.vmotion.json'),
      },
    },
  });
  assert.equal(invalidExport.isError, true);
  const schema = await client.callTool({
    name: 'tool_schema',
    arguments: { name: 'sound_export' },
  });
  const schemaValue = JSON.parse(schema.content.find((b) => b.type === 'text').text);
  assert.ok(schemaValue.schemaHash);
  const cached = await client.callTool({
    name: 'tool_schema',
    arguments: { name: 'sound_export', ifHash: schemaValue.schemaHash },
  });
  assert.ok(JSON.parse(cached.content.find((b) => b.type === 'text').text).notModified);
  await call('project_preflight', patternPlan.value.candidate);
  await call('project_apply', patternPlan.value.apply);
  const patternInfo = (await call('sound_inspect', { assetId: 'patterns', limit: 2 })).value;
  assert.equal(patternInfo.events.total, 4);
  assert.equal(patternInfo.patterns[0].eventCount, 2);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, patternBase);
  await call('project_redo');
  assert.equal((await call('sound_inspect', { assetId: 'patterns' })).value.events.total, 4);
  report.musicMcp = {
    startupBytes: Buffer.byteLength(JSON.stringify(await client.listTools())),
    exportBytes: Buffer.byteLength(JSON.stringify(scoreExport.value)),
    schemaBytes: Buffer.byteLength(JSON.stringify(schemaValue)),
    cachedSchemaBytes: Buffer.byteLength(JSON.stringify(cached)),
    checks: [
      'linked pattern expansion',
      'full candidate WAV/MIDI without apply',
      'protected source',
      'conditional schema hash',
      'single undo/redo',
      'no inline Base64 duplication',
    ],
  };
  report.output = output;
  report.audio = wav;
  report.revision = used;
  report.maxWavQuantizationError = maxError;
  report.checks = [
    'compact discovery + sound guide',
    'synth+sample+drum batch',
    'candidate audition before commit',
    'RMS/peak/clipping evidence',
    'sample dependencies pinned',
    'candidate/accepted/timeline audio parity',
    'random seek retains effect history',
    'stable note paging',
    'bus-cycle recovery',
    'MIDI round trip + omission reports',
    'source preserved + audio-driven frame',
    '90-frame AAC MP4 + PCM WAV',
    'WAV sample accuracy within two 16-bit units',
    'score+placement atomic undo',
    '15 tools use audio builtin registry',
    'waveform and spectrum evidence',
    '100-clip paging matches full sample positions and one undo',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
