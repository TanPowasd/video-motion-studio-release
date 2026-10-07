import { field } from './result-assertions.js';
import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { queryProjectDiagnostics } from '../src/service/project-diagnostics.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { hash } from '../src/service/project.js';
import { projectSchemaNames } from '../src/service/schemas.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { z } from 'zod';

function evidence() {
  return {
    snapshot: { revision: 'base', files: { 'scenes/a.json': 'original', 'deleted.ts': 'gone' } },
    diagnostics: Array.from({ length: 103 }, (_, i) => ({
      severity: i % 2 ? ('warning' as const) : ('error' as const),
      code: i % 2 ? 'SIZE' : 'TS2322',
      file: i % 2 ? 'scenes/a.json' : 'components/a.ts',
      path: '/nodes/@card/width',
      line: i + 1,
      column: 4,
      message: `Issue ${i}: ` + '详细证据'.repeat(300),
    })),
    conflicts: [
      {
        file: 'scenes/a.json',
        path: '/nodes/@card/text',
        base: 'old',
        ours: 'mine',
        theirs: 'external',
      },
    ],
    pendingFiles: { 'scenes/a.json': 'changed', 'new.ts': 'new' },
  };
}
it('pages bounded diagnostics and restores selected full messages without filtering summary counts', () => {
  const state = evidence(),
    before = JSON.stringify(state),
    query = (p: unknown) => queryProjectDiagnostics(state as any, p),
    first = query({});
  expect(first.items).toHaveLength(20);
  expect(first.nextOffset).toBe(20);
  expect(first.coverage).toEqual({ available: 103, filteredOut: 0, returned: 20, omitted: 83 });
  expect(first.summary).toEqual({ errors: 52, warnings: 51, conflicts: 1, pendingFiles: true });
  expect(first.items[0]).toMatchObject({
    index: 0,
    code: 'TS2322',
    line: 1,
    column: 4,
    messageTruncated: true,
  });
  const filtered = query({
    files: ['components/a.ts'],
    codes: ['TS2322'],
    severities: ['error'],
    offset: 50,
    limit: 2,
    detail: true,
  });
  expect(filtered.total).toBe(52);
  expect(filtered.nextOffset).toBeUndefined();
  expect(filtered.items).toEqual([
    { ...state.diagnostics[100], index: 100 },
    { ...state.diagnostics[102], index: 102 },
  ]);
  expect(query({ offset: 1000 }).items).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(state.diagnostics)) / 8,
  );
  expect(JSON.stringify(state)).toBe(before);
});
it('keeps both conflict versions opt-in and lists pending changes without source text', () => {
  const state = evidence(),
    query = (p: unknown) => queryProjectDiagnostics(state as any, p);
  expect(query({ section: 'conflicts' }).items).toEqual([
    { index: 0, file: 'scenes/a.json', path: '/nodes/@card/text' },
  ]);
  expect(query({ section: 'conflicts', detail: true }).items).toEqual([
    { ...state.conflicts[0], index: 0 },
  ]);
  const pending = query({ section: 'pendingFiles', limit: 1 });
  expect(pending.total).toBe(3);
  expect(pending.items).toEqual([{ file: 'scenes/a.json', status: 'modified' }]);
  const detailed = query({ section: 'pendingFiles', files: ['new.ts'], detail: true });
  expect(detailed.items).toEqual([
    {
      file: 'new.ts',
      status: 'added',
      beforeHash: null,
      afterHash: hash('new'),
      beforeBytes: 0,
      afterBytes: 3,
    },
  ]);
  expect(query({ section: 'pendingFiles', files: ['deleted.ts'] }).items).toEqual([
    { file: 'deleted.ts', status: 'deleted' },
  ]);
});
it('rejects stale revisions and invalid filters without altering evidence', () => {
  const state = evidence(),
    before = JSON.stringify(state);
  expect(() => queryProjectDiagnostics(state as any, { revision: 'stale' })).toThrow(
    /revision changed/,
  );
  for (const p of [
    { limit: 101 },
    { offset: -1 },
    { codes: [] },
    { section: 'conflicts', severities: ['error'] },
    { section: 'pendingFiles', codes: ['TS2322'] },
    { unexpected: true },
  ])
    expect(() => queryProjectDiagnostics(state as any, p)).toThrow();
  expect(JSON.stringify(state)).toBe(before);
});
it('offers every authoritative resource schema through the public tool, including previously omitted kinds', () => {
  const definition = toolDefinitions().find((t) => t.name === 'project_schema')!;
  for (const name of projectSchemaNames)
    expect(z.object(definition.schema).strict().parse({ name })).toEqual({ name });
  expect(projectSchemaNames).toEqual(
    expect.arrayContaining(['sound', 'audioMix', 'plugin', 'storyboard', 'textureSettings']),
  );
});
it('clears pending diagnostics when repair restores the active version without consuming shared history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-identical-repair-'));
  await initProject(root);
  const app = await new Application(root).open(false);
  try {
    const before = app.service.snapshot.revision,
      original = app.service.snapshot.files['scenes/intro.json'];
    await writeFile(path.join(root, 'scenes/intro.json'), '{ broken');
    await app.service.exclusive(() => app.service.reload());
    const request = {
        version: 'pending',
        revision: before,
        files: [
          {
            type: 'replace',
            path: 'scenes/intro.json',
            expectedHash: hash('{ broken'),
            content: original,
          },
        ],
      },
      checked = await app.dispatch('projectPreflight', request);
    expect(checked.valid).toBe(true);
    expect(checked.candidateRevision).toBe(before);
    const applied = await app.dispatch('projectApply', {
      ...request,
      expectedCandidateRevision: checked.candidateRevision,
    });
    expect(applied.revision).toBe(before);
    expect(field(applied, 'canUndo')).toBe(false);
    expect(app.service.pendingFiles).toBeUndefined();
    expect((await app.dispatch('projectDiagnostics')).summary).toEqual({
      errors: 0,
      warnings: 0,
      conflicts: 0,
      pendingFiles: false,
    });
    expect(await readFile(path.join(root, 'scenes/intro.json'), 'utf8')).toBe(original);
    let notifications = 0;
    app.service.on('change', () => notifications++);
    await app.service.transact([
      {
        type: 'editFiles',
        edits: [
          {
            type: 'replace',
            path: 'scenes/intro.json',
            expectedHash: hash(original),
            content: original,
          },
        ],
      },
    ]);
    expect(notifications).toBe(0);
    expect(app.service.state().canUndo).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
it('reports actual pending edits through the core module and repairs them with exact preflight, apply and undo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-diagnostics-'));
  await initProject(root);
  const app = await new Application(root).open(false);
  try {
    const before = app.service.snapshot.revision,
      file = 'scenes/intro.json',
      original = await readFile(path.join(root, file), 'utf8');
    await writeFile(path.join(root, file), '{ invalid');
    await app.service.exclusive(() => app.service.reload());
    const diagnostic = await app.dispatch('projectDiagnostics', { revision: before });
    expect(diagnostic.summary.pendingFiles).toBe(true);
    expect(diagnostic.summary.errors).toBeGreaterThan(0);
    expect(app.service.state().canUndo).toBe(false);
    const pending = await app.dispatch('projectDiagnostics', {
      section: 'pendingFiles',
      detail: true,
    });
    expect(pending.items[0]).toMatchObject({ file, afterHash: hash('{ invalid') });
    const repaired = JSON.parse(original);
    repaired.name = 'Repaired';
    const request = {
      version: 'pending',
      revision: before,
      files: [
        {
          type: 'replace',
          path: file,
          expectedHash: field(field(field(pending, 'items'), 0), 'afterHash'),
          content: JSON.stringify(repaired),
        },
      ],
    };
    const checked = await app.dispatch('projectPreflight', request);
    expect(checked.valid).toBe(true);
    await expect(
      app.dispatch('projectApply', { ...request, expectedCandidateRevision: 'wrong' }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_REVISION' });
    expect(await readFile(path.join(root, file), 'utf8')).toBe('{ invalid');
    const applied = await app.dispatch('projectApply', {
      ...request,
      expectedCandidateRevision: checked.candidateRevision,
    });
    expect(applied.revision).toBe(checked.candidateRevision);
    expect((await app.dispatch('projectDiagnostics')).summary).toMatchObject({
      errors: 0,
      conflicts: 0,
      pendingFiles: false,
    });
    await app.dispatch('undo');
    expect(app.service.snapshot.revision).toBe(before);
    await app.dispatch('redo');
    expect(app.service.snapshot.revision).toBe(applied.revision);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
