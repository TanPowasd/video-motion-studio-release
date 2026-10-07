import { field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { useCacheFile } from '../src/media/proxy-cache.js';
import { hash, json } from '../src/service/project.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-cache-workflow-'));
  await initProject(root, 'cache', { template: 'blank' });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function file(relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}
it('reclaims only named generated caches from a fixed plan and preserves source/history/candidates/checkpoints', async () => {
  await file('.vmotion/media-evidence/old.png', 'generated');
  await file('.vmotion/agent-plans/preserved.json', 'candidate');
  await file('.vmotion/renders/checkpoint.json', 'checkpoint');
  await file('.vmotion/history/preserved.json', 'history');
  const before = app.service.snapshot.revision,
    inspect = await app.dispatch('cacheInspect', {});
  expect(inspect.totalBytes).toBe(9);
  const plan = await app.dispatch('cachePlan', { maxBytes: 0, minAgeSeconds: 0 });
  expect(plan.fileCount).toBe(1);
  expect(await readFile(path.join(root, '.vmotion/media-evidence/old.png'), 'utf8')).toBe(
    'generated',
  );
  const result = await app.dispatch('cacheApply', plan.apply);
  expect(field(result, 'reclaimedBytes')).toBe(9);
  expect(app.service.snapshot.revision).toBe(before);
  for (const name of [
    'agent-plans/preserved.json',
    'renders/checkpoint.json',
    'history/preserved.json',
  ])
    expect((await stat(path.join(root, '.vmotion', name))).isFile()).toBe(true);
});
it('excludes leased and registered media, and rechecks newly referenced/changed files on apply', async () => {
  const busy = await file('.vmotion/media-evidence/busy.png', 'busy'),
    original = await file('.vmotion/media-evidence/original.png', 'original'),
    changed = await file('.vmotion/media-evidence/change.png', 'old');
  const release = useCacheFile(busy);
  await app.service.transact([
    {
      type: 'addAsset',
      asset: {
        id: 'original',
        name: 'original',
        path: '.vmotion/media-evidence/original.png',
        type: 'image',
        managed: false,
        metadata: {},
      },
    },
  ]);
  const plan = await app.dispatch('cachePlan', { maxBytes: 0, minAgeSeconds: 0 });
  expect(plan.leasedFiles).toBe(1);
  expect(plan.referencedFiles).toBe(1);
  expect(plan.fileCount).toBe(1);
  await writeFile(changed, 'changed content');
  const result = await app.dispatch('cacheApply', plan.apply);
  expect(field(result, 'reclaimedBytes')).toBe(0);
  expect(field(result, 'skipped')[0].reason).toBe('changed');
  expect(await readFile(original, 'utf8')).toBe('original');
  release();
});
it('skips directory junctions and refuses rewritten plans reaching protected groups', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vmotion-cache-outside-'));
  try {
    await mkdir(path.join(root, '.vmotion/media-evidence'), { recursive: true });
    await writeFile(path.join(outside, 'asset.txt'), 'preserve');
    await symlink(outside, path.join(root, '.vmotion/media-evidence/external'), 'junction');
    const inspect = await app.dispatch('cacheInspect', {});
    expect(inspect.skippedLinks).toHaveLength(1);
    const malicious = json({
        kind: 'cache-cleanup',
        version: 1,
        root,
        files: [{ file: '.vmotion/history/preserved.json', bytes: 3, mtimeMs: 1 }],
      }),
      id = hash(malicious);
    await file(`.vmotion/cache-plans/${id}.json`, malicious);
    await expect(app.dispatch('cacheApply', { planId: id })).rejects.toThrow('protected');
    expect(await readFile(path.join(outside, 'asset.txt'), 'utf8')).toBe('preserve');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it('skips targets registered after planning and retains a proxy bundle while its reader is leased', async () => {
  await file('.vmotion/media-evidence/new.png', 'new');
  const plan = await app.dispatch('cachePlan', { maxBytes: 0, minAgeSeconds: 0 });
  await app.service.transact([
    {
      type: 'addAsset',
      asset: {
        id: 'new',
        name: 'new',
        path: '.vmotion/media-evidence/new.png',
        type: 'image',
        managed: false,
        metadata: {},
      },
    },
  ]);
  const result = await app.dispatch('cacheApply', plan.apply);
  expect(field(result, 'skipped')[0].reason).toBe('project-reference');
  const video = await file('.vmotion/proxies-v2/abc/video.mkv', 'proxy');
  await file('.vmotion/proxies-v2/abc/record.json', 'record');
  await file(
    '.vmotion/proxies-v2/index-test.json',
    JSON.stringify({ output: '.vmotion/proxies-v2/abc/video.mkv' }),
  );
  const release = useCacheFile(video);
  try {
    const proxyPlan = await app.dispatch('cachePlan', {
      groups: ['proxies-v2'],
      maxBytes: 0,
      minAgeSeconds: 0,
    });
    expect(proxyPlan.leasedFiles).toBe(3);
    expect(proxyPlan.fileCount).toBe(0);
  } finally {
    release();
  }
});
