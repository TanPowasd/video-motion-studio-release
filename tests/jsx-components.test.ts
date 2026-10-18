import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { planJsxWriteBack } from '../src/core/jsx-writeback.js';

let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-jsx-'));
  await initProject(root);
  app = await new Application(root).open(false);
}, 60000);
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
}, 60000);

// The same picture authored twice: JSX (.tsx, with a shared .tsx helper) and SDK builders (.ts).
const jsxHelper = `
import { springTo, useClock } from '@vmotion/sdk';
export function Dot({ index }: { index: number }) {
  const clock = useClock();
  const r = 6 + index * 2;
  return <ellipse id={'dot' + index} x={40 + index * 30} y={150 - springTo(clock, { from: 0, to: 40, start: index * 3 })} width={r * 2} height={r * 2} fill="#9fd3ff" />;
}
`;
const jsxEntry = `
import { defineComponent, useClock, remap, LocalTime, Steps, Step, Stage } from '@vmotion/sdk';
import { Dot } from './jsx-helper';
const Title = ({ label }: { label: string }) => {
  const { frame } = useClock();
  return <text id="title" x={20} y={12} width={280} height={40} fontSize={26} fontWeight={700} fill="#f3f6ff" opacity={remap(frame, [0, 10], [0, 1])}>{label}</text>;
};
export default defineComponent({
  name: 'JSX parity',
  parameters: { label: { type: 'string', default: 'JSX 组件' } },
  render(ctx, p) {
    return (
      <Stage id="stage" background="#0d1524">
        <group id="card" x={16} y={60} width={288} height={110}>
          <rect id="bg" width={288} height={110} style={{ borderRadius: 14, background: 'linear-gradient(90deg, #2b4a8a, #7b4fd6)', border: '2px solid #a9c1ff' }} />
          {[0, 1, 2, 3].map((i) => <Dot key={i} index={i} />)}
        </group>
        <LocalTime start={5}><Title label={p.label} /></LocalTime>
        <Steps>
          <Step duration={20}><rect id="beat" x={250} y={20} width={30} height={30} fill="#ff7a59" /></Step>
          <Step><rect id="beat" x={250} y={20} width={30} height={30} fill="#59ffb0" style={{ transform: 'rotate(45deg)' }} /></Step>
        </Steps>
      </Stage>
    );
  },
});
`;
// Builder equivalent spelled out flat so ids/parents match the JSX lowering exactly.
const tsFlat = `
import { defineComponent, rect, text, ellipse, linearGradient, springTo, remap } from '@vmotion/sdk';
export default defineComponent({
  name: 'TS parity',
  parameters: { label: { type: 'string', default: 'JSX 组件' } },
  render(ctx, p) {
    const out = [
      { ...rect('stage', {}), type: 'group' as const, x: 0, y: 0, width: ctx.width, height: ctx.height },
      rect('stage/background', { parentId: 'stage', width: ctx.width, height: ctx.height, fill: '#0d1524' }),
      { ...rect('stage/card', { parentId: 'stage', x: 16, y: 60, width: 288, height: 110 }), type: 'group' as const },
      rect('stage/card/bg', { parentId: 'stage/card', width: 288, height: 110, radius: 14, stroke: '#a9c1ff', strokeWidth: 2, gradient: linearGradient({ x: 0, y: 55 }, { x: 288, y: 55 }, ['#2b4a8a', '#7b4fd6']) }),
    ];
    for (const i of [0, 1, 2, 3]) {
      const r = 6 + i * 2;
      out.push(ellipse('stage/card/' + i + '/dot' + i, { parentId: 'stage/card', x: 40 + i * 30, y: 150 - springTo(ctx, { from: 0, to: 40, start: i * 3 }), width: r * 2, height: r * 2, fill: '#9fd3ff' }));
    }
    if (ctx.frame >= 5) {
      const local = { ...ctx, frame: ctx.frame - 5 };
      out.push(text('stage/title', p.label, { parentId: 'stage', x: 20, y: 12, width: 280, height: 40, fontSize: 26, fontWeight: 700, fill: '#f3f6ff', opacity: remap(local.frame, [0, 10], [0, 1]) }));
    }
    out.push(ctx.frame < 20
      ? rect('stage/beat', { parentId: 'stage', x: 250, y: 20, width: 30, height: 30, fill: '#ff7a59' })
      : rect('stage/beat', { parentId: 'stage', x: 250, y: 20, width: 30, height: 30, fill: '#59ffb0', rotation: 45, originX: 15, originY: 15 }));
    return out;
  },
});
`;

const request = (
  file: string,
  content: string,
  extra: Array<{ path: string; content: string }> = [],
) => ({
  revision: app.service.snapshot.revision,
  files: [
    ...extra.map((e) => ({
      type: 'replace' as const,
      path: e.path,
      expectedHash: null,
      content: e.content,
    })),
    { type: 'replace' as const, path: file, expectedHash: null, content },
  ],
  operations: [
    {
      type: 'updateScene' as const,
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'code', type: 'component', component: file, width: 320, height: 180 }),
        ],
      },
    },
  ],
  samples: [0, 8, 30].map((frame) => ({ sceneId: 'intro', frame })),
  width: 320,
  determinism: true,
});

it('a .tsx component preflights, applies atomically with one undo, and renders pixel-identical to the .ts builder version', async () => {
  const before = app.service.snapshot.revision;
  const jsxRequest = request('components/parity.tsx', jsxEntry, [
    { path: 'components/jsx-helper.tsx', content: jsxHelper },
  ]);
  const jsxPreview = await app.dispatch('projectPreflight', jsxRequest);
  expect(jsxPreview.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
  expect(jsxPreview.valid).toBe(true);
  const tsPreview = await app.dispatch('projectPreflight', request('components/parity.ts', tsFlat));
  expect(tsPreview.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
  expect(jsxPreview.samples.map((s: any) => s.pixelHash)).toEqual(
    tsPreview.samples.map((s: any) => s.pixelHash),
  );
  expect(new Set(jsxPreview.samples.map((s: any) => s.pixelHash)).size).toBe(3);

  const applied = await app.dispatch('projectApply', {
    ...jsxRequest,
    expectedCandidateRevision: jsxPreview.candidateRevision,
  });
  expect(applied.applied).toBe(true);
  expect(await readFile(path.join(root, 'components/parity.tsx'), 'utf8')).toContain('<Stage');
  const entry = app.service.journal.tail().at(-1)!;
  expect(entry.files).toEqual(
    expect.arrayContaining(['components/parity.tsx', 'components/jsx-helper.tsx']),
  );

  // Generated JSX nodes have stable ids, so visual edits are stable-ID overrides like .ts components.
  const generated = await app.renderer.generatedNodes(
    app.service.snapshot,
    app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'code')!,
    30,
  );
  expect(generated.map((n) => n.id)).toEqual(
    expect.arrayContaining([
      'stage',
      'stage/card/bg',
      'stage/card/2/dot2',
      'stage/title',
      'stage/beat',
    ]),
  );
  await app.service.transact([
    {
      type: 'updateNode',
      sceneId: 'intro',
      nodeId: 'code',
      patch: { overrides: { 'stage/card/bg': { fill: '#ff0000', radius: 2 } } },
    },
  ]);
  const edited = await app.renderer.generatedNodes(
    app.service.snapshot,
    app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'code')!,
    30,
  );
  expect(edited.find((n) => n.id === 'stage/card/bg')?.radius).toBe(2);
  const journal = app.service.journal.tail().at(-1)!;
  expect(journal.targets?.some((t: any) => t.id === 'code')).toBe(true);

  // Opt-in write-back: literal overrides become JSX attributes; same pixels, override cleared.
  const sample = { samples: [{ sceneId: 'intro', frame: 30 }], width: 320 };
  const overridden = await app.dispatch('projectPreflight', {
    revision: app.service.snapshot.revision,
    ...sample,
  });
  const plan = planJsxWriteBack(app.service.snapshot, 'intro', 'code');
  expect(plan.report).toEqual([{ id: 'stage/card/bg', written: ['fill', 'radius'], skipped: [] }]);
  const writeBack = {
    revision: app.service.snapshot.revision,
    files: plan.files,
    operations: plan.operations,
    ...sample,
  };
  const promoted = await app.dispatch('projectPreflight', writeBack);
  expect(promoted.valid).toBe(true);
  expect(promoted.samples[0].pixelHash).toBe(overridden.samples[0].pixelHash);
  await app.dispatch('projectApply', {
    ...writeBack,
    expectedCandidateRevision: promoted.candidateRevision,
  });
  const written = await readFile(path.join(root, 'components/parity.tsx'), 'utf8');
  expect(written).toContain('fill="#ff0000" radius={2}');
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'code')!.overrides).toEqual({});

  await app.service.undo();
  await app.service.undo();
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  await expect(stat(path.join(root, 'components/parity.tsx'))).rejects.toThrow();
}, 120000);

it('preflight reports JSX misuse with file/line and alternatives, and does not save', async () => {
  const bad = `
import { defineComponent } from '@vmotion/sdk';
export default defineComponent({
  name: 'bad',
  parameters: {},
  render() {
    return <div style={{ display: 'flex' }}><span>hi</span></div>;
  },
});
`;
  const preview = await app.dispatch('projectPreflight', request('components/bad.tsx', bad));
  expect(preview.valid).toBe(false);
  const html = preview.diagnostics.find((d: any) => d.code === 'JSX_HTML_ELEMENT');
  expect(html).toMatchObject({ severity: 'error', file: 'components/bad.tsx', line: 7 });
  expect(html?.message).toMatch(/<group>/);
  await expect(stat(path.join(root, 'components/bad.tsx'))).rejects.toThrow();

  // A runtime-only mistake (dynamic tag) still fails at the sampled frame with a JSX code.
  const dynamic = `
import { defineComponent } from '@vmotion/sdk';
const Tag = ['d', 'iv'].join('') as 'group';
export default defineComponent({ name: 'dyn', parameters: {}, render: () => <Tag id="x" /> });
`;
  const runtime = await app.dispatch('projectPreflight', request('components/dyn.tsx', dynamic));
  expect(runtime.valid).toBe(false);
  expect(runtime.diagnostics.map((d: any) => d.code)).toContain('JSX_HTML_ELEMENT');
}, 120000);

it('auto-id warnings do not block apply', async () => {
  const source = `
import { defineComponent } from '@vmotion/sdk';
export default defineComponent({ name: 'w', parameters: {}, render: () => <><rect x={4} /><rect x={40} /></> });
`;
  const req = request('components/warn.tsx', source),
    preview = await app.dispatch('projectPreflight', req);
  expect(preview.valid).toBe(true);
  expect(
    preview.diagnostics.some((d: any) => d.code === 'JSX_AUTO_ID' && d.severity === 'warning'),
  ).toBe(true);
  const applied = await app.dispatch('projectApply', {
    ...req,
    expectedCandidateRevision: preview.candidateRevision,
  });
  expect(applied.applied).toBe(true);
}, 120000);
