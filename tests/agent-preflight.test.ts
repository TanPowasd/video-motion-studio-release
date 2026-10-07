import { present, field } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { hash } from '../src/service/project.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-agent-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const entry =
  "import {defineComponent,rect} from '@vmotion/sdk';import {offset} from './virtual/helper';export default defineComponent({name:'Candidate',parameters:{},render(ctx){return [rect('box',{x:offset+ctx.frame,y:10,width:40,height:40,fill:'#79b6ff'})];}});";
const candidate = () => ({
  revision: app.service.snapshot.revision,
  files: [
    {
      type: 'replace',
      path: 'components/virtual/helper.ts',
      expectedHash: null,
      content: 'export const offset:number = 10;',
    },
    { type: 'replace', path: 'components/candidate.ts', expectedHash: null, content: entry },
  ],
  operations: [
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/candidate.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ],
  samples: [
    { sceneId: 'intro', frame: 0 },
    { sceneId: 'intro', frame: 30 },
  ],
  width: 160,
  determinism: true,
});
it('checks brand-new virtual imports and frame pictures without saving, then applies the same candidate with one undo', async () => {
  const before = app.service.snapshot.revision,
    request = candidate(),
    preview = await app.dispatch('projectPreflight', { ...request, inline: true });
  expect(preview.valid).toBe(true);
  expect(preview.samples.map((s: any) => s.status)).toEqual(['passed', 'passed']);
  expect(present(present(present(preview)).data).length).toBeGreaterThan(100);
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.state().canUndo).toBe(false);
  await expect(stat(path.join(root, 'components/candidate.ts'))).rejects.toThrow();
  const applied = await app.dispatch('projectApply', {
    ...request,
    expectedCandidateRevision: preview.candidateRevision,
  });
  expect(applied.revision).toBe(preview.candidateRevision);
  expect(applied.applied).toBe(true);
  expect(field(applied, 'snapshot')).toBeUndefined();
  expect(await readFile(path.join(root, 'components/virtual/helper.ts'), 'utf8')).toContain(
    'offset',
  );
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  await expect(stat(path.join(root, 'components/virtual/helper.ts'))).rejects.toThrow();
}, 30000);
it('reports TypeScript line/column and JSON property locations without touching project files', async () => {
  const before = app.service.snapshot.revision,
    source = app.service.snapshot.files['components/wave.ts'],
    typed = await app.dispatch('projectPreflight', {
      files: [
        {
          type: 'replace',
          path: 'components/wave.ts',
          expectedHash: hash(source),
          content: 'const broken: number = "wrong";\nexport default broken;',
        },
      ],
    });
  expect(typed.valid).toBe(false);
  expect(
    typed.diagnostics.some(
      (d: any) =>
        d.code.startsWith('TS') && d.file.endsWith('wave.ts') && d.line === 1 && d.column > 0,
    ),
  ).toBe(true);
  const json = app.service.snapshot.files['scenes/intro.json'],
    bad = { ...JSON.parse(json), nodes: [{ id: 'bad', type: 'rect', width: -1 }] },
    format = await app.dispatch('projectPreflight', {
      files: [
        {
          type: 'replace',
          path: 'scenes/intro.json',
          expectedHash: hash(json),
          content: JSON.stringify(bad),
        },
      ],
    });
  expect(
    format.diagnostics.some(
      (d: any) => d.file === 'scenes/intro.json' && d.path === '/nodes/0/width',
    ),
  ).toBe(true);
  expect(app.service.snapshot.revision).toBe(before);
  expect(await readFile(path.join(root, 'components/wave.ts'), 'utf8')).toBe(source);
});
it('runtime failures and stateful frame rendering fail preflight and cannot be applied', async () => {
  const before = app.service.snapshot.revision,
    request = candidate();
  request.files[1].content = entry.replace(
    'return [rect',
    'if(ctx.frame>=20)throw new Error("frame failed");return [rect',
  );
  const report = await app.dispatch('projectPreflight', request);
  expect(report.valid).toBe(false);
  expect(report.samples.map((s: any) => s.status)).toEqual(['passed', 'failed']);
  expect(
    report.diagnostics.some(
      (d: any) =>
        d.code === 'COMPONENT_RUNTIME' &&
        d.file === 'components/candidate.ts' &&
        d.line > 0 &&
        d.column > 0 &&
        d.path.includes('30f'),
    ),
  ).toBe(true);
  await expect(app.dispatch('projectApply', request)).rejects.toThrow('no project changes saved');
  expect(app.service.snapshot.revision).toBe(before);
  const unstable = candidate();
  unstable.files[1].content =
    "import {defineComponent,rect} from '@vmotion/sdk';let tick=0;export default defineComponent({name:'Stateful',parameters:{},render(){return [rect('box',{x:tick++*100,y:10,width:100,height:100})];}});";
  const repeated = await app.dispatch('projectPreflight', unstable);
  expect(repeated.valid).toBe(false);
  expect(repeated.diagnostics.some((d: any) => d.code === 'NONDETERMINISTIC_FRAME')).toBe(true);
}, 30000);
it('rejects stale file hashes, ambiguous substitutions and a candidate hash mismatch atomically', async () => {
  const source = app.service.snapshot.files['components/wave.ts'],
    before = app.service.snapshot.revision,
    stale = await app.dispatch('projectPreflight', {
      files: [
        {
          type: 'replace',
          path: 'components/wave.ts',
          expectedHash: '0'.repeat(64),
          content: source,
        },
      ],
    });
  expect(stale.valid).toBe(false);
  expect(stale.diagnostics[0].code).toBe('FILE_HASH_CONFLICT');
  const ambiguous = await app.dispatch('projectPreflight', {
    files: [
      {
        type: 'text',
        path: 'components/wave.ts',
        expectedHash: hash(source),
        replacements: [{ before: 'node', after: 'rect' }],
      },
    ],
  });
  expect(ambiguous.diagnostics[0].code).toBe('TEXT_MATCH');
  await expect(
    app.dispatch('projectApply', { ...candidate(), expectedCandidateRevision: 'wrong' }),
  ).rejects.toThrow('differs from the inspected preflight');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.state().canUndo).toBe(false);
}, 30000);
it('cannot validate a deleted import using the old module left on disk', async () => {
  await app.dispatch('projectApply', candidate());
  const source = app.service.snapshot.files['components/virtual/helper.ts'],
    revision = app.service.snapshot.revision,
    report = await app.dispatch('projectPreflight', {
      files: [{ type: 'delete', path: 'components/virtual/helper.ts', expectedHash: hash(source) }],
      samples: [{ sceneId: 'intro', frame: 0 }],
      width: 160,
    });
  expect(report.valid).toBe(false);
  expect(report.diagnostics.some((d: any) => d.code.startsWith('TS'))).toBe(true);
  expect(await readFile(path.join(root, 'components/virtual/helper.ts'), 'utf8')).toBe(source);
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
it('queries paginated metadata and file ranges instead of dumping all project source', async () => {
  const context = await app.dispatch('projectContext', { sceneId: 'intro', limit: 1 });
  expect(context.files.items).toHaveLength(1);
  expect(context.files.items[0].hash).toHaveLength(64);
  expect(present(present(present(context)).scene).nodes).toHaveLength(1);
  expect(field(context, 'snapshot')).toBeUndefined();
  expect(JSON.stringify(context)).not.toContain('defineComponent({');
  const file = await app.dispatch('projectFileRead', {
    path: 'components/wave.ts',
    startLine: 3,
    lineCount: 2,
  });
  expect(file.content.split('\n')).toHaveLength(2);
  expect(file.nextLine).toBe(5);
  expect(file.hash).toBe(hash(app.service.snapshot.files['components/wave.ts']));
});
it('creates a scene JSON and its manifest reference in the same batch and undoes both files together', async () => {
  const manifest = app.service.snapshot.files['project.vmotion.json'],
    project = JSON.parse(manifest),
    revision = app.service.snapshot.revision;
  project.scenes.push('scenes/second.json');
  const request = {
    revision,
    files: [
      {
        type: 'replace',
        path: 'project.vmotion.json',
        expectedHash: hash(manifest),
        content: JSON.stringify(project, null, 2) + '\n',
      },
      {
        type: 'replace',
        path: 'scenes/second.json',
        expectedHash: null,
        content: JSON.stringify({
          id: 'second',
          name: 'Second',
          duration: 90,
          background: '#101b2b',
          nodes: [{ id: 'label', type: 'text', text: 'New scene' }],
        }),
      },
    ],
  };
  const report = await app.dispatch('projectPreflight', request);
  expect(report.valid).toBe(true);
  expect(
    report.changes.some((c: any) => c.path === 'scenes/second.json' && c.status === 'added'),
  ).toBe(true);
  await app.dispatch('projectApply', {
    ...request,
    expectedCandidateRevision: report.candidateRevision,
  });
  expect(app.service.snapshot.scenes.find((s) => s.id === 'second')?.nodes[0].text).toBe(
    'New scene',
  );
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  await expect(stat(path.join(root, 'scenes/second.json'))).rejects.toThrow();
});
it('rejects simultaneous semantic/file edits of one file instead of silently overwriting one change', async () => {
  const source = app.service.snapshot.files['scenes/intro.json'],
    before = app.service.snapshot.revision,
    report = await app.dispatch('projectPreflight', {
      operations: [
        { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { text: 'Semantic' } },
      ],
      files: [
        { type: 'replace', path: 'scenes/intro.json', expectedHash: hash(source), content: source },
      ],
    });
  expect(report.valid).toBe(false);
  expect(report.diagnostics[0].code).toBe('FILE_EDITS');
  expect(app.service.snapshot.revision).toBe(before);
});
it('repairs pending malformed JSON and TypeScript while retaining the last good preview and undo history', async () => {
  const revision = app.service.snapshot.revision,
    scene = app.service.snapshot.files['scenes/intro.json'],
    source = app.service.snapshot.files['components/wave.ts'],
    before = await app.frame({ sceneId: 'intro', frame: 90, width: 160, height: 90 });
  await writeFile(path.join(root, 'scenes/intro.json'), '{"id":');
  await writeFile(path.join(root, 'components/wave.ts'), 'broken TypeScript {{{');
  await app.service.reload();
  expect(app.service.pendingFiles).toBeDefined();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(
    (await app.frame({ sceneId: 'intro', frame: 90, width: 160, height: 90 })).buffer.equals(
      before.buffer,
    ),
  ).toBe(true);
  const pending = await app.dispatch('projectFileRead', {
    path: 'scenes/intro.json',
    version: 'pending',
  });
  expect(pending.content).toBe('{"id":');
  const request = {
    version: 'pending',
    revision,
    files: [
      { type: 'replace', path: 'scenes/intro.json', expectedHash: pending.hash, content: scene },
      {
        type: 'replace',
        path: 'components/wave.ts',
        expectedHash: hash('broken TypeScript {{{'),
        content: source.replace('default: 100', 'default: 120'),
      },
    ],
    samples: [{ sceneId: 'intro', frame: 90 }],
    width: 160,
  };
  const preview = await app.dispatch('projectPreflight', request);
  expect(preview.valid).toBe(true);
  expect(app.service.pendingFiles).toBeDefined();
  await app.dispatch('projectApply', {
    ...request,
    expectedCandidateRevision: preview.candidateRevision,
  });
  expect(app.service.pendingFiles).toBeUndefined();
  expect(await readFile(path.join(root, 'scenes/intro.json'), 'utf8')).toBe(scene);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
