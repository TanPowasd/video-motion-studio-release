import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { loadProject } from '../src/service/project.js';
let root: string, service: ProjectService;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-test-'));
  await initProject(root);
  service = await new ProjectService(root).open(false);
});
afterEach(async () => {
  await service?.close();
  await rm(root, { recursive: true, force: true });
});
describe('shared project transactions', () => {
  it('recovers old journal-backed undo history when opening a project without the new history index', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Legacy one' } },
    ]);
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Legacy two' } },
    ]);
    await service.close();
    await unlink(path.join(root, '.vmotion/undo/state.json'));
    service = await new ProjectService(root).open(false);
    expect(service.state().canUndo).toBe(true);
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('Legacy one');
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe(
      'The geometry of waves',
    );
  });
  it('undo sees an external edit arriving while the service is open and persists both history directions', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Saved' } },
    ]);
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'External live';
    await writeFile(file, JSON.stringify(scene));
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('Saved');
    await service.close();
    service = await new ProjectService(root).open(false);
    await service.redo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe(
      'External live',
    );
  });
  it('restores undo and redo across service restarts and ignores unchanged property edits', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'First' } },
    ]);
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Second' } },
    ]);
    await service.close();
    service = await new ProjectService(root).open(false);
    expect(service.state().canUndo).toBe(true);
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('First');
    await service.close();
    service = await new ProjectService(root).open(false);
    expect(service.state().canRedo).toBe(true);
    const revision = service.snapshot.revision;
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'First' } },
    ]);
    expect(service.snapshot.revision).toBe(revision);
    expect(service.state().canRedo).toBe(true);
    await service.redo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('Second');
    await service.undo();
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe(
      'The geometry of waves',
    );
  });
  it('records an external edit made while the editor was closed and preserves it for undo', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Saved' } },
    ]);
    await service.close();
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'Edited externally';
    await writeFile(file, JSON.stringify(scene));
    service = await new ProjectService(root).open(false);
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('Saved');
    await service.close();
    service = await new ProjectService(root).open(false);
    await service.redo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe(
      'Edited externally',
    );
  });
  it('does not consume redo history when the target fails validation', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Restore' } },
    ]);
    await service.undo();
    const revision = service.snapshot.revision;
    service.extraValidation = async (snapshot) =>
      snapshot.scenes[0].nodes.find((n) => n.id === 'title')?.text === 'Restore'
        ? [
            {
              severity: 'error',
              code: 'TEST_ERROR',
              message: 'Component dependency is unavailable',
            },
          ]
        : [];
    await expect(service.redo()).rejects.toThrow('history preserved');
    expect(service.snapshot.revision).toBe(revision);
    expect(service.state().canRedo).toBe(true);
    service.extraValidation = undefined;
    await service.redo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe('Restore');
  });
  it('undoes the creation of an unreferenced component file', async () => {
    await service.transact([
      { type: 'writeSource', path: 'components/new.ts', content: 'export const value = 1;' },
    ]);
    await service.undo();
    await expect(readFile(path.join(root, 'components/new.ts'), 'utf8')).rejects.toThrow();
    await service.redo();
    expect(await readFile(path.join(root, 'components/new.ts'), 'utf8')).toContain('value = 1');
  });
  it('persists edits and shares one undo/redo history', async () => {
    const revision = service.snapshot.revision;
    await service.transact(
      [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'A new idea' } }],
      revision,
    );
    expect((await loadProject(root)).scenes[0].nodes.find((n) => n.id === 'title')?.text).toBe(
      'A new idea',
    );
    await service.undo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')?.text).toBe(
      'The geometry of waves',
    );
    await service.redo();
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')?.text).toBe('A new idea');
  });
  it('rolls back an invalid batch completely', async () => {
    const before = await readFile(path.join(root, 'scenes/intro.json'), 'utf8');
    await expect(
      service.transact([
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: 'title',
          patch: { text: 'Should not save' },
        },
        { type: 'updateNode', sceneId: 'intro', nodeId: 'missing', patch: { x: 2 } },
      ]),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, 'scenes/intro.json'), 'utf8')).toBe(before);
  });
  it('merges external changes with unsaved independent edits', async () => {
    await service.transact(
      [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { x: 555 } }],
      undefined,
      false,
    );
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'External idea';
    await writeFile(file, JSON.stringify(scene));
    await service.reload();
    const node = service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!;
    expect(node.x).toBe(555);
    expect(node.text).toBe('External idea');
    expect(service.conflicts).toHaveLength(0);
    await service.save();
  });
  it('preserves and resolves a same-property conflict', async () => {
    await service.transact(
      [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { x: 555 } }],
      undefined,
      false,
    );
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').x = 777;
    await writeFile(file, JSON.stringify(scene));
    await service.reload();
    expect(service.conflicts).toHaveLength(1);
    expect(service.conflicts[0]).toMatchObject({ ours: 555, theirs: 777 });
    await expect(service.save()).rejects.toThrow('Resolve conflicts');
    await service.resolve(0, 'theirs');
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.x).toBe(777);
  });
  it('rejects cyclic parents and invalid operation types', async () => {
    await expect(
      service.transact([
        { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { parentId: 'title' } },
      ]),
    ).rejects.toThrow('validation');
    await expect(service.transact([{ type: 'unknown' } as any])).rejects.toThrow();
  });
  it('rejects stale revisions and future formats without writing them', async () => {
    await service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { x: 500 } },
    ]);
    await expect(
      service.transact(
        [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { x: 600 } }],
        'old',
      ),
    ).rejects.toThrow('changed');
    const file = path.join(root, 'project.vmotion.json'),
      project = JSON.parse(await readFile(file, 'utf8'));
    project.formatVersion = 99;
    await writeFile(file, JSON.stringify(project));
    await expect(service.reload()).rejects.toThrow('Unsupported');
    expect(JSON.parse(await readFile(file, 'utf8')).formatVersion).toBe(99);
  });
});
