import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  rename,
  mkdir,
  writeFile,
  readFile,
  utimes,
  copyFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
import { videoProxy } from '../src/media/proxy-cache.js';
let root: string, app: Application, assetId: string, source: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-media-workflow-'));
  await initProject(root, 'media', {
    template: 'blank',
    width: 640,
    height: 360,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
  source = path.join(root, 'source.mkv');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=2',
    '-c:v',
    'ffv1',
    source,
  ]);
  await app.dispatch('import', { path: source, type: 'video' });
  assetId = app.service.snapshot.project.assets[0].id;
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { nodes: [newNode({ id: 'video', type: 'video', assetId, width: 640, height: 360 })] },
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('runs cancellable proxy tasks and uses source-checked proxies only in auto previews while native evidence remains original', async () => {
  const before = await app.frame({ sceneId: 'intro', frame: 20, width: 640, height: 360 }),
    job = app.proxies.start(app.service.snapshot, assetId, 640),
    done = await app.proxies.wait(job.id);
  expect(done.status, done.error).toBe('completed');
  expect((await app.dispatch('mediaStatus', {})).assets.items[0].proxy.status).toBe('ready');
  const preview = await app.frame({
    sceneId: 'intro',
    frame: 20,
    width: 640,
    height: 360,
    mediaQuality: 'auto',
  });
  expect(preview.media!.proxyCount).toBe(1);
  expect(preview.buffer).toEqual(before.buffer);
  const reused = app.proxies.start(app.service.snapshot, assetId, 640),
    reuseResult = await app.proxies.wait(reused.id);
  expect(reuseResult.status).toBe('completed');
  expect(reuseResult.stage).toBe('reused');
  const original = await app.frame({ sceneId: 'intro', frame: 20, width: 640, height: 360 });
  expect(original.media!.proxyCount).toBe(0);
  expect(original.buffer).toEqual(before.buffer);
  const small = await app.frame({
    sceneId: 'intro',
    frame: 20,
    width: 320,
    height: 180,
    mediaQuality: 'auto',
  });
  expect(small.media!.decodePixels).toBe(320 * 180);
  const cancel = app.proxies.start(app.service.snapshot, assetId, 320);
  app.proxies.cancel(cancel.id);
  expect((await app.proxies.wait(cancel.id)).status).toBe('cancelled');
  expect(app.proxies.active).toBe(0);
});
it('invalidates proxy selection when source metadata changes and preserves original export pixels', async () => {
  const job = app.proxies.start(app.service.snapshot, assetId, 320);
  expect((await app.proxies.wait(job.id)).status).toBe('completed');
  expect(
    await videoProxy(root, app.service.snapshot, app.service.snapshot.project.assets[0]),
  ).toBeDefined();
  const time = new Date(Date.now() + 1000);
  await utimes(source, time, time);
  expect(
    await videoProxy(root, app.service.snapshot, app.service.snapshot.project.assets[0]),
  ).toBeUndefined();
  const frame = await app.frame({
    sceneId: 'intro',
    frame: 5,
    width: 320,
    height: 180,
    mediaQuality: 'auto',
  });
  expect(frame.media!.proxyCount).toBe(0);
});
it('recovers missing source paths via exact relink candidates with stable IDs, fresh metadata and one undo', async () => {
  const moved = path.join(root, 'moved.mkv');
  await rename(source, moved);
  const status = await app.dispatch('mediaStatus', {});
  expect(status.assets.items[0].status).toBe('missing-or-invalid');
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('mediaRelinkPlan', {
      items: [{ assetId, path: moved, expectedPath: 'source.mkv' }],
    });
  expect(app.service.snapshot.revision).toBe(before);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.project.assets[0].id).toBe(assetId);
  expect(app.service.snapshot.scenes[0].nodes[0].assetId).toBe(assetId);
  expect(app.service.snapshot.project.assets[0].path).toBe('moved.mkv');
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
it('requires explicit metadata replacement, rejects too-short used sources, and detects changed candidates before apply', async () => {
  const other = path.join(root, 'other.mkv');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-c:v',
    'ffv1',
    other,
  ]);
  await expect(
    app.dispatch('mediaRelinkPlan', { items: [{ assetId, path: other }] }),
  ).rejects.toThrow('differs');
  const plan = await app.dispatch('mediaRelinkPlan', {
    items: [{ assetId, path: other, policy: 'replace' }],
  });
  await writeFile(other, Buffer.alloc(10));
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toThrow('no project changes');
  const short = path.join(root, 'short.mkv');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=0.5',
    '-c:v',
    'ffv1',
    short,
  ]);
  await app.dispatch('assetPlace', {
    assetId,
    sequenceId: 'main',
    trackId: 'visual',
    frame: 0,
    duration: 60,
  });
  await expect(
    app.dispatch('mediaRelinkPlan', { items: [{ assetId, path: short, policy: 'replace' }] }),
  ).rejects.toThrow('shorter');
});
