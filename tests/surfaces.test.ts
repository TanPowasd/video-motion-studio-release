import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertSurfaceMethod, surfaceManifest } from '../src/service/surfaces.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { serveHttp } from '../src/service/http.js';
import { publishableSource } from '../scripts/export-public-release.js';
it('shares one project between direct UI edits and external Agent interfaces', () => {
  expect(surfaceManifest.studio.workspaces).toContain('code');
  expect(surfaceManifest.agent.path).toBe('/agent/');
  expect(surfaceManifest.agent.interfacesOnly).toBe(true);
  expect(() => assertSurfaceMethod('studio', 'agentToolInvoke')).toThrow('automation');
  expect(() => assertSurfaceMethod('studio', 'projectFileRead')).toThrow('automation');
  expect(() => assertSurfaceMethod('studio', 'projectApply')).not.toThrow();
  expect(() => assertSurfaceMethod('agent', 'projectFileRead')).not.toThrow();
  expect(() => assertSurfaceMethod('legacy', 'agentToolInvoke')).not.toThrow();
});
it('publishes an explicit product snapshot including both licensed UIs and excluding user/output data', async () => {
  for (const file of [
    'src/editor/main.tsx',
    'src/agent-editor/main.tsx',
    'scripts/build-audio.ps1',
    'tests/core.test.ts',
    'examples/science/project.vmotion.json',
    'LICENSE',
  ])
    expect(publishableSource(file), file).toBe(true);
  for (const file of [
    'productions/you-become-stars/author.ts',
    'release/Vmotion.exe',
    '.env.local',
    'err.txt',
    'node_modules/a/index.js',
    'examples/science/exports/video.mp4',
    'docs/WORK-STATUS.md',
    'artifacts/secrets.json',
  ])
    expect(publishableSource(file), file).toBe(false);
  expect(await readFile('src/editor/LICENSE', 'utf8')).toContain('Apache License');
  expect(await readFile('src/agent-editor/LICENSE', 'utf8')).toContain('Apache License');
});
it('serves independent Agent HTML/discovery and preserves Studio/Agent transaction and undo parity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-surfaces-'));
  await initProject(root, 'split', { template: 'blank', durationSeconds: 2 });
  const clientDirectory = path.join(root, 'build/client');
  await mkdir(clientDirectory, { recursive: true });
  await mkdir(path.join(root, 'build/agent'), { recursive: true });
  await writeFile(path.join(clientDirectory, 'index.html'), '<title>Vmotion Studio</title>');
  await writeFile(
    path.join(root, 'build/agent/index.html'),
    '<title>Vmotion Agent Workbench</title><script src="/agent/assets/entry.js"></script>',
  );
  const app = await new Application(root).open(false),
    server = await serveHttp(app, 0, clientDirectory);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server');
  const url = `http://127.0.0.1:${address.port}`;
  const rpc = async (endpoint: string, method: string, params: unknown = {}) =>
    (
      await fetch(url + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
    ).json();
  try {
    expect(await (await fetch(url + '/api/surfaces')).json()).toEqual(surfaceManifest);
    const html = await (await fetch(url + '/agent/')).text();
    expect(html).toContain('/agent/assets/');
    expect(html).not.toContain('Vmotion Studio</title>');
    expect((await rpc('/api/studio/rpc', 'projectContext')).error.code).toBe('SURFACE_METHOD');
    expect((await rpc('/api/agent/rpc', 'projectContext')).result.project.name).toBe('split');
    const search = await (
      await fetch(url + '/api/agent/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'search', request: { query: 'audio', limit: 2 } }),
      })
    ).json();
    expect(search.result.items).toHaveLength(2);
    const before = app.service.snapshot.revision,
      planned = await rpc('/api/agent/rpc', 'projectPreflight', {
        revision: before,
        operations: [{ type: 'updateProject', patch: { name: 'agent edit' } }],
      });
    expect(planned.result.valid).toBe(true);
    await rpc('/api/agent/rpc', 'projectApply', {
      revision: before,
      operations: [{ type: 'updateProject', patch: { name: 'agent edit' } }],
      expectedCandidateRevision: planned.result.candidateRevision,
    });
    expect((await rpc('/api/studio/rpc', 'state')).result.snapshot.project.name).toBe('agent edit');
    await rpc('/api/studio/rpc', 'undo');
    expect(app.service.snapshot.revision).toBe(before);
    expect((await rpc('/api/rpc', 'projectContext')).result.revision).toBe(before);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
