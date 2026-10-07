import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AudioPluginHost,
  scanAudioPlugins,
  SoundPluginSession,
  pluginFingerprint,
} from '../src/media/audio-plugin-host.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { SoundRenderer, compileSound } from '../src/core/sound.js';
import { soundDocumentSchema } from '../src/core/sound-schema.js';
import { audioSourceFile } from '../src/media/sound-source.js';
import { AudioLiveService } from '../src/service/audio-live.js';
import { inspectSound } from '../src/service/sound.js';
const fixture = path.resolve('artifacts/audio-build/VST3/Release/vmotion-audio-fixture.vst3');
const synth = {
  format: 'vst3' as const,
  path: fixture,
  classId: '914A61E128FE4B22A4B63751C50BE933',
  parameters: { '1': 0.25 },
};
const gain = { ...synth, classId: 'B1D3C2817C8249E88DEA053AF81C7B62', parameters: { '1': 0.5 } };
it('enforces live instance limits even during concurrent opens and closes every process', async () => {
  const service = new AudioLiveService();
  try {
    const requests = await Promise.allSettled(
      Array.from({ length: 9 }, () =>
        service.command({ action: 'open', config: synth, blockSize: 256 }),
      ),
    );
    expect(requests.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    expect(requests.filter((r) => r.status === 'rejected')).toHaveLength(1);
  } finally {
    await service.close();
  }
  await expect(service.command({ action: 'query' })).rejects.toThrow('closed');
}, 30000);
it('scans real VST3 classes, processes native MIDI, saves/restores parameters and rejects unsupported AU', async () => {
  const scan = await scanAudioPlugins([fixture]);
  expect(scan.diagnostics).toEqual([]);
  expect(scan.plugins).toHaveLength(2);
  expect(scan.plugins[0].fingerprint).toBeTruthy();
  const host = new AudioPluginHost(),
    second = new AudioPluginHost();
  try {
    expect((await host.open(synth)).parameters[0].name).toBe('Gain');
    if (process.platform === 'win32') {
      expect((await host.request('editor', { show: true })).result).toEqual({ visible: true });
      await host.request('editor', { show: false });
    }
    const first = await host.process(256, 0, [{ status: 144, a: 69, b: 100, offset: 0 }]);
    expect(first.length).toBe(2048);
    expect(first.readFloatLE(8)).not.toBe(0);
    await host.process(256, 256, [], undefined, {}, { '1': 0.4 });
    const state = await host.state();
    expect(state.parameters['1']).toBe(0.4);
    await second.open({ ...synth, ...state, parameters: {} });
    const restored = await second.describe();
    expect(restored.parameters[0].value).toBe(0.4);
    const off = await host.process(256, 512, [{ status: 128, a: 69, b: 0, offset: 0 }]);
    expect(off.every((v) => v === 0)).toBe(true);
  } finally {
    await host.close();
    await second.close();
  }
  if (process.platform !== 'darwin')
    await expect(new AudioPluginHost().open({ ...synth, format: 'au' })).rejects.toThrow('macOS');
}, 30000);
it('keeps async plugin instrument/effect chains sample-identical to MIDI processing and retains mix gain', async () => {
  const doc = soundDocumentSchema.parse({
    kind: 'sound',
    version: 1,
    id: 'plugin',
    name: 'plugin',
    unit: 'seconds',
    duration: 0.1,
    tail: 0,
    tracks: [
      {
        id: 'lead',
        instrument: { ...synth, type: 'plugin' },
        events: [
          { id: 'a', at: 0, duration: 0.08, note: 69, velocity: 100 / 127 },
          { id: 'silent', at: 0.01, duration: 0.02, note: 69, velocity: 0 },
        ],
        effects: [
          { type: 'gain', db: -6 },
          { ...gain, type: 'plugin' },
        ],
      },
    ],
  });
  const renderer = new SoundRenderer(doc),
    session = new SoundPluginSession(doc),
    host = new AudioPluginHost();
  try {
    await host.open(synth);
    const direct = await host.process(1024, 0, [{ status: 144, a: 69, b: 100, offset: 0 }]);
    const block = await renderer.processAsync(1024, session.process);
    for (let i = 0; i < 1024; i++)
      expect(block.left[i]).toBeCloseTo(direct.readFloatLE(i * 8) * 10 ** (-6 / 20) * 0.5, 6);
  } finally {
    await session.close();
    await host.close();
  }
  expect(() =>
    compileSound({
      ...doc,
      tracks: [{ ...doc.tracks[0], events: [{ ...doc.tracks[0].events[0], endNote: 70 }] }],
    }),
  ).toThrow('integer MIDI');
}, 30000);
it('shares plugin export, preview and bounded live binary endpoint; preserves revision, state, undo and close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-vst-'));
  await initProject(root, 'plugins', {
    template: 'blank',
    durationSeconds: 1,
    width: 320,
    height: 180,
  });
  const app = await new Application(root).open(false);
  try {
    const before = app.service.snapshot.revision,
      doc = soundDocumentSchema.parse({
        kind: 'sound',
        version: 1,
        id: 'plugin',
        name: 'plugin',
        unit: 'seconds',
        duration: 0.25,
        tail: 0,
        tracks: [
          {
            id: 'lead',
            instrument: { ...synth, type: 'plugin' },
            events: [{ id: 'a', at: 0, duration: 0.2, note: 69 }],
          },
        ],
      });
    const plan = await app.dispatchTyped('soundPlan', {
      items: [{ assetId: 'plugin', document: doc }],
    });
    const preview = await app.dispatchTyped('soundPreview', {
      assetId: 'plugin',
      planId: plan.plan!.planId,
      inline: true,
    });
    expect(preview.metrics.rms).toBeGreaterThan(0.01);
    expect(app.service.snapshot.revision).toBe(before);
    await app.dispatchTyped('projectApply', plan.apply);
    const summarySnapshot = structuredClone(app.service.snapshot),
      source = summarySnapshot.project.assets[0].soundSource!;
    const large = soundDocumentSchema.parse(JSON.parse(summarySnapshot.files[source])),
      instrument = large.tracks[0].instrument;
    if (instrument.type !== 'plugin') throw new Error('Expected plugin');
    instrument.state = Buffer.alloc(512 * 1024).toString('base64');
    instrument.parameters = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [String(i), 0.5]),
    );
    summarySnapshot.files[source] = JSON.stringify(large);
    const compact = inspectSound(summarySnapshot, { assetId: 'plugin' }),
      full = inspectSound(summarySnapshot, { assetId: 'plugin', includeDocument: true });
    expect(JSON.stringify(compact).length).toBeLessThan(5000);
    expect(JSON.stringify(compact)).not.toContain(instrument.state);
    expect(full.document!.tracks[0].instrument).toEqual(instrument);
    expect(JSON.stringify(full).split(instrument.state)).toHaveLength(2);
    const wav = await audioSourceFile(
      root,
      app.service.snapshot,
      app.service.snapshot.project.assets[0],
    );
    expect((await readFile(wav)).length).toBe(44 + 12000 * 8);
    const opened = await app.dispatchTyped('audioLive', {
      action: 'open',
      config: synth,
      blockSize: 256,
    });
    if (!('sessionId' in opened) || !opened.sessionId) throw new Error('No live session');
    const pcm = await app.audioLive.block(opened.sessionId, {
      frames: 256,
      midi: [{ status: 144, a: 60, b: 100 }],
    });
    expect(pcm.length).toBe(2048);
    await app.dispatchTyped('audioLive', { action: 'panic', sessionId: opened.sessionId });
    expect(
      (await app.audioLive.block(opened.sessionId, { frames: 256 })).every((v) => v === 0),
    ).toBe(true);
    const state = await app.dispatchTyped('audioLive', {
      action: 'state',
      sessionId: opened.sessionId,
    });
    expect('state' in state && state.state).toBeTruthy();
    await app.dispatchTyped('audioLive', { action: 'close', sessionId: opened.sessionId });
    await expect(app.audioLive.block(opened.sessionId, { frames: 256 })).rejects.toThrow('expired');
    await app.dispatchTyped('undo', {});
    expect(app.service.snapshot.revision).toBe(before);
    await expect(pluginFingerprint({ ...synth, fingerprint: 'wrong' })).rejects.toThrow(
      'fingerprint',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
