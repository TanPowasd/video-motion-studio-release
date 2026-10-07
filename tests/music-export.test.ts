import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { serveHttp } from '../src/service/http.js';
import { newMusic } from '../src/editor/music/music-model.js';
import { pcmWave } from '../src/media/audio.js';
import { hash } from '../src/platform/project-files.js';

it('exports the exact unsaved full score and MIDI, streams seekable WAV and preserves source/undo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-music-'));
  await initProject(root, 'music', { template: 'blank', durationSeconds: 10 });
  const app = await new Application(root).open(false),
    server = await serveHttp(app, 0);
  try {
    const before = app.service.snapshot.revision,
      doc = newMusic('music');
    doc.arrangement = [{ id: 'c', patternId: 'pattern-1', at: 0, repeats: 1 }];
    doc.duration = 4;
    const plan = await app.dispatchTyped('soundPlan', {
      items: [{ assetId: doc.id, document: doc }],
    });
    const output = await app.dispatchTyped('soundExport', {
      assetId: doc.id,
      planId: plan.plan!.planId,
    });
    const midi = await app.dispatchTyped('soundMidi', {
      action: 'export',
      assetId: doc.id,
      planId: plan.plan!.planId,
      output: path.join(root, 'exports/music.mid'),
    });
    expect('bytes' in midi && midi.bytes! > 50).toBe(true);
    expect(app.service.snapshot.revision).toBe(before);
    const wav = await readFile(output.output);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.length).toBe(44 + 3 * 48000 * 8);
    expect(output.duration).toBe(3);
    const audition = await app.dispatchTyped('soundPreview', {
      assetId: doc.id,
      planId: plan.plan!.planId,
      inline: true,
    });
    expect(hash(pcmWave(wav.subarray(44)))).toBe(hash(Buffer.from(audition.data!, 'base64')));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server');
    const url = `http://127.0.0.1:${address.port}${output.playbackUrl}`;
    const response = await fetch(url, { headers: { Range: 'bytes=44-83' } });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wav.subarray(44, 84));
    expect((await fetch(url, { headers: { Range: 'bytes=-20' } })).status).toBe(206);
    expect((await fetch(url, { headers: { Range: 'bytes=99999999-' } })).status).toBe(416);
    await app.dispatchTyped('projectApply', plan.apply);
    await expect(
      app.dispatchTyped('soundExport', {
        assetId: 'music',
        output: path.join(root, 'project.vmotion.json'),
      }),
    ).rejects.toThrow();
    await expect(
      app.dispatchTyped('soundExport', {
        assetId: 'music',
        output: path.join(root, 'components/sounds/music.json'),
      }),
    ).rejects.toThrow();
    await app.dispatchTyped('undo', {});
    expect(app.service.snapshot.revision).toBe(before);
    await expect(app.dispatchTyped('soundExport', { assetId: 'music' })).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
