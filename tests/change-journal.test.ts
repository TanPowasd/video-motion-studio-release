import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { parseFiles } from '../src/service/project.js';
import {
  CHANGE_JOURNAL_FILE,
  diffSnapshots,
  withChangeOrigin,
} from '../src/service/change-journal.js';
import { assertSurfaceMethod } from '../src/service/surfaces.js';

let root: string, service: ProjectService;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-journal-'));
  await initProject(root);
  service = await new ProjectService(root).open(false);
});
afterEach(async () => {
  await service?.close();
  await rm(root, { recursive: true, force: true });
});
const title = { type: 'updateNode', sceneId: 'intro', nodeId: 'title' } as const;

describe('change journal (origin metadata)', () => {
  it('diffs snapshots at stable-ID level: nodes, scenes, fields', () => {
    const before = service.snapshot,
      files = { ...before.files },
      scene = JSON.parse(files['scenes/intro.json']);
    scene.nodes.find((n: any) => n.id === 'title').text = 'Changed';
    scene.nodes.find((n: any) => n.id === 'title').y = 99;
    files['scenes/intro.json'] = JSON.stringify(scene, null, 2) + '\n';
    const after = parseFiles(files),
      diff = diffSnapshots(before, after);
    expect(diff.files).toEqual(['scenes/intro.json']);
    const node = diff.targets.find((t) => t.kind === 'node')!;
    expect(node).toMatchObject({ change: 'changed', id: 'title', sceneId: 'intro' });
    expect(node.fields?.sort()).toEqual(['text', 'y']);
    expect(node.values?.y?.[1]).toBe(99);
    expect(node.values?.text).toEqual(['The geometry of waves', 'Changed']);
    expect(diff.truncated).toBe(false);
  });

  it('attributes UI (default), MCP (context) and undo to the same shared history', async () => {
    await service.transact([{ ...title, patch: { text: 'By hand' } }]);
    await withChangeOrigin({ kind: 'mcp', client: 'claude-code', tool: 'graphics_plan', intent: '更舒展' }, () =>
      service.transact([{ ...title, patch: { text: 'By agent' } }]),
    );
    await service.undo();
    const [ui, mcp, undo] = service.journal.tail();
    expect(ui).toMatchObject({ kind: 'ui', action: 'edit' });
    expect(mcp).toMatchObject({
      kind: 'mcp',
      client: 'claude-code',
      tool: 'graphics_plan',
      intent: '更舒展',
      action: 'edit',
      previous: ui.revision,
    });
    expect(mcp.targets[0]).toMatchObject({ kind: 'node', id: 'title', fields: ['text'] });
    expect(undo).toMatchObject({ kind: 'ui', action: 'undo', revision: ui.revision });
    // No-op edits are not journalled; the project files themselves are untouched by the journal.
    await service.transact([{ ...title, patch: { text: 'By hand' } }]);
    expect(service.journal.tail()).toHaveLength(3);
    expect(Object.keys(service.snapshot.files).some((f) => f.includes('changes'))).toBe(false);
  });

  it('records direct file edits as file origin and persists across reopen', async () => {
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'Edited on disk';
    await writeFile(file, JSON.stringify(scene, null, 2) + '\n');
    await service.exclusive(() => service.reload());
    const entry = service.journal.tail().at(-1)!;
    expect(entry).toMatchObject({ kind: 'file', action: 'external', files: ['scenes/intro.json'] });
    await service.close();
    service = await new ProjectService(root).open(false);
    expect(service.journal.tail().at(-1)!.id).toBe(entry.id);
  });

  it('adopts the origin another process recorded for the revision it wrote', async () => {
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'Written by MCP process';
    const text = JSON.stringify(scene, null, 2) + '\n',
      revision = parseFiles({ ...service.snapshot.files, 'scenes/intro.json': text }).revision;
    await mkdir(path.join(root, '.vmotion'), { recursive: true });
    await writeFile(
      path.join(root, CHANGE_JOURNAL_FILE),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'other',
            at: Date.now(),
            kind: 'mcp',
            client: 'cursor',
            tool: 'project_apply',
            action: 'edit',
            revision,
            previous: service.snapshot.revision,
            files: ['scenes/intro.json'],
            targets: [],
            pid: process.pid + 1,
          },
        ],
      }),
    );
    await writeFile(file, text);
    await service.exclusive(() => service.reload());
    expect(service.journal.tail().at(-1)).toMatchObject({
      kind: 'mcp',
      client: 'cursor',
      tool: 'project_apply',
      action: 'external',
    });
    await service.journal.flush();
    const disk = JSON.parse(await readFile(path.join(root, CHANGE_JOURNAL_FILE), 'utf8'));
    expect(disk.entries.map((e: any) => e.id)).toContain('other');
  });

  it('holds MCP edits while the person paused AI; UI edits continue', async () => {
    service.setAgentHold(true);
    await expect(
      withChangeOrigin({ kind: 'mcp', tool: 'project_apply' }, () =>
        service.transact([{ ...title, patch: { text: 'Agent while paused' } }]),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_ON_HOLD' });
    await expect(
      withChangeOrigin({ kind: 'mcp' }, () => service.undo()),
    ).rejects.toMatchObject({ code: 'AGENT_ON_HOLD' });
    await service.transact([{ ...title, patch: { text: 'Human while paused' } }]);
    service.setAgentHold(false);
    await withChangeOrigin({ kind: 'mcp' }, () =>
      service.transact([{ ...title, patch: { text: 'Agent resumed' } }]),
    );
    expect(service.journal.tail().map((e) => e.kind)).toEqual(['ui', 'mcp']);
    // An agent cannot lift its own pause through the automation surfaces.
    expect(() => assertSurfaceMethod('agent', 'agentHold')).toThrow();
    expect(() => assertSurfaceMethod('studio', 'agentHold')).not.toThrow();
  });
});
