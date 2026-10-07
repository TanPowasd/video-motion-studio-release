import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Application } from '../src/service/application.js';
import {
  projectFolder,
  projectRoot,
  rememberProject,
  availableRecent,
  readRecent,
} from '../src/desktop/projects.js';
import { serveHttp } from '../src/service/http.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-creation-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('creates an editable blank project with exact settings, agent instructions and a usable scene clip', async () => {
  await initProject(root, '自己的电影', {
    template: 'blank',
    width: 1280,
    height: 720,
    fps: { num: 30000, den: 1001 },
    durationSeconds: 20,
  });
  const snapshot = await loadProject(root);
  expect(snapshot.project).toMatchObject({
    name: '自己的电影',
    width: 1280,
    height: 720,
    fps: { num: 30000, den: 1001 },
  });
  expect(snapshot.scenes[0].nodes).toEqual([]);
  expect(snapshot.sequences[0].duration).toBe(599);
  expect(snapshot.sequences[0].tracks[0].clips[0]).toMatchObject({
    sceneId: 'intro',
    duration: 599,
  });
  expect(await readdir(path.join(root, 'components'))).toEqual([]);
  expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('project_preflight');
  const app = await new Application(root).open(false);
  try {
    expect((await app.dispatch('validate')).diagnostics).toEqual([]);
    await app.dispatch('transact', {
      operations: [
        {
          type: 'addNode',
          sceneId: 'intro',
          node: { id: 'hello', type: 'text', text: '开始创作', x: 20, y: 20 },
        },
      ],
    });
    expect((await app.frame({ frame: 0, width: 320, height: 180 })).buffer.length).toBeGreaterThan(
      100,
    );
    await app.dispatch('undo');
    expect(app.service.snapshot.scenes[0].nodes).toEqual([]);
  } finally {
    await app.close();
  }
});
it('rejects invalid settings before touching disk and preserves existing project files', async () => {
  await expect(initProject(root, 'bad', { template: 'blank', width: 5000 })).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  await writeFile(path.join(root, 'keep.txt'), 'do not overwrite');
  await expect(initProject(root, 'blank', { template: 'blank' })).rejects.toThrow('empty');
  expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('do not overwrite');
  expect(await readdir(root)).toEqual(['keep.txt']);
});
it('retains the science template when requested and fits it into alternate canvas sizes', async () => {
  await initProject(root, 'wave', { template: 'science', width: 1280, height: 720 });
  const snapshot = await loadProject(root);
  expect(snapshot.scenes[0].nodes.find((node) => node.id === 'title')?.parentId).toBe(
    'template-layout',
  );
  expect(snapshot.scenes[0].nodes[0]).toMatchObject({ scaleX: 2 / 3, scaleY: 2 / 3 });
  expect(await readFile(path.join(root, 'components/wave.ts'), 'utf8')).toContain(
    'defineComponent',
  );
});
it('validates Windows project folder names and accepts a project manifest path', () => {
  for (const name of ['..', 'CON', 'a/b', 'a\\b', 'a:b', 'NUL.txt', 'name.', 'LPT1', 'trailing '])
    expect(() => projectFolder(root, name)).toThrow();
  expect(projectFolder(root, '我的动画')).toBe(path.join(root, '我的动画'));
  expect(projectRoot(path.join(root, 'project.vmotion.json'))).toBe(root);
});
it('persists recent projects, deduplicates reopens, bounds history and flags missing folders', async () => {
  const file = path.join(root, 'history.json');
  for (let i = 0; i < 14; i++) await rememberProject(file, path.join(root, String(i)), String(i));
  await mkdir(path.join(root, '8'));
  await writeFile(path.join(root, '8', 'project.vmotion.json'), '{}');
  await rememberProject(file, path.join(root, '8'), '重命名项目');
  const entries = await availableRecent(file);
  expect(entries).toHaveLength(12);
  expect(entries[0]).toMatchObject({ name: '重命名项目', available: true });
  expect(entries[1].available).toBe(false);
  expect(entries.filter((entry) => entry.root === path.join(root, '8'))).toHaveLength(1);
  await writeFile(file, 'broken preferences');
  expect(await readRecent(file)).toEqual([]);
});
it('serves the home without opening or auto-creating a demo and refuses project RPCs', async () => {
  await writeFile(path.join(root, 'index.html'), '<div id="root">home</div>');
  const server = await serveHttp(undefined, 0, root),
    address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  try {
    const url = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(url)).text()).toContain('home');
    const response = await fetch(url + '/api/rpc', { method: 'POST', body: '{}' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('NO_PROJECT');
    expect(await readdir(root)).toEqual(['index.html']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
