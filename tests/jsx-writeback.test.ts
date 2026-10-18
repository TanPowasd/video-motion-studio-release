import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { hash } from '../src/platform/project-files.js';

const run = promisify(execFile);
let root: string, app: Application;
const source = `
import { defineComponent, useClock, remap } from '@vmotion/sdk';
export default defineComponent({
  name: 'wb',
  parameters: {},
  render() {
    const { frame } = useClock();
    return (
      <group id="root" width={320} height={180}>
        <group id="row" style={{ display: 'flex', left: 10, top: 10, width: 300, gap: 10 }}>
          <rect id="a" style={{ width: 60, height: 40 }} fill="#335577" />
          <rect id="b" style={{ flexGrow: 1, height: 40 }} fill="#557733" />
        </group>
        <rect id="free" x={20} y={100} width={80} height={40} fill="#aa3355" />
        <text id="label" x={120} y={100} width={180} height={40} fontSize={24} fill="#ffffff" opacity={remap(frame, [0, 10], [0, 1])}>WB</text>
      </group>
    );
  },
});
`;
const overrides = {
  'root/row/a': { fill: '#ff0000', x: 99 },
  'root/free': { x: 30, radius: 6 },
  'root/label': { opacity: 0.5, fill: '#00ff00' },
};
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-jsxwb-'));
  await initProject(root);
  await mkdir(path.join(root, 'components'), { recursive: true });
  await writeFile(path.join(root, 'components/wb.tsx'), source);
  app = await new Application(root).open(false);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [newNode({ id: 'wb', type: 'component', component: 'components/wb.tsx', width: 320, height: 180, overrides })],
      },
    },
  ]);
}, 120000);
afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}, 60000);

const status = (props: Array<{ id: string; prop: string; status: string }>) =>
  Object.fromEntries(props.map((p) => [`${p.id}.${p.prop}`, p.status]));

it('MCP jsx_writeback_plan: unified plan contract, per-prop status, pixel-identical apply and undo', async () => {
  const before = app.service.snapshot.revision;
  const result = (await app.dispatch('agentToolInvoke', {
    name: 'jsx_writeback_plan',
    arguments: { sceneId: 'intro', nodeId: 'wb' },
  })) as Record<string, any>;
  const value = result.value ?? result;
  expect(value.effect).toBe('plan');
  expect(value.committed).toBe(false);
  expect(value.plan.planId).toMatch(/^[a-f0-9]{64}$/);
  expect(value.plan.candidateRevision).toBeTruthy();
  expect(value.plan.summary).toMatchObject({ operations: 1, files: 1 });
  expect(value.next).toMatch(/project_preflight/);
  expect(status(value.props)).toEqual({
    'root/row/a.fill': 'written',
    'root/row/a.x': 'layout',
    'root/free.x': 'written',
    'root/free.radius': 'written',
    'root/label.opacity': 'computed',
    'root/label.fill': 'written',
  });
  expect(value.summary).toMatchObject({ written: 4, kept: 2, file: 'components/wb.tsx' });
  // Same pixels as the overridden layer; one apply, one undo.
  const samples = { samples: [{ sceneId: 'intro', frame: 4 }], width: 320 };
  const current = await app.dispatch('projectPreflight', { revision: before, ...samples });
  const preflight = await app.dispatch('projectPreflight', { planId: value.plan.planId, ...samples });
  expect(preflight.valid).toBe(true);
  expect(preflight.samples[0].pixelHash).toBe(current.samples[0].pixelHash);
  await app.dispatch('projectApply', { planId: value.plan.planId });
  const written = await readFile(path.join(root, 'components/wb.tsx'), 'utf8');
  expect(written).toContain('fill="#ff0000"');
  expect(written).toContain('<rect id="free" x={30} y={100} width={80} height={40} fill="#aa3355" radius={6} />');
  expect(written).toContain('opacity={remap(frame, [0, 10], [0, 1])}');
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({
    'root/row/a': { x: 99 },
    'root/label': { opacity: 0.5 },
  });
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  expect(await readFile(path.join(root, 'components/wb.tsx'), 'utf8')).toBe(source);
}, 180000);

it('verification keeps props whose literal would change the output (layout box defined in another file)', async () => {
  await writeFile(
    path.join(root, 'components/item.tsx'),
    `export const Item = () => <rect id="item" width={50} height={20} fill="#123456" />;\n`,
  );
  await writeFile(
    path.join(root, 'components/host.tsx'),
    `import { defineComponent } from '@vmotion/sdk';
import { Item } from './item';
export default defineComponent({ name: 'host', parameters: {}, render: () => (
  <group id="row" style={{ display: 'flex', width: 300, justifyContent: 'center' }}>
    <Item />
  </group>
) });
`,
  );
  // host.tsx is the component; item.tsx holds the element, so only the verifier can see the layout.
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'host', type: 'component', component: 'components/host.tsx', width: 320, height: 180, overrides: { 'row/item': { width: 80, fill: '#ff00ff' } } }),
        ],
      },
    },
  ]);
  const plan = (await app.dispatch('jsxWriteBackPlan', { sceneId: 'intro', nodeId: 'host' })) as any;
  // The element lives in item.tsx, not the component entry: nothing to rewrite there.
  expect(status(plan.props)).toEqual({ 'row/item.width': 'no-target', 'row/item.fill': 'no-target' });
  expect(plan.unchanged).toBe(true);
  // Same file, but the flex container is not a lexical ancestor: static analysis misses it,
  // the render verification catches that width={80} would re-centre the item.
  const hostFile = 'components/host.tsx';
  await app.service.transact([
    {
      type: 'editFiles',
      edits: [
        {
          type: 'replace',
          path: hostFile,
          expectedHash: hash(app.service.snapshot.files[hostFile]),
          content: `import { defineComponent } from '@vmotion/sdk';
const Item = () => <rect id="item" width={50} height={20} fill="#123456" />;
export default defineComponent({ name: 'host', parameters: {}, render: () => (
  <group id="row" style={{ display: 'flex', width: 300, justifyContent: 'center' }}>
    <Item />
  </group>
) });
`,
        },
      ],
    },
  ]);
  const verified = (await app.dispatch('jsxWriteBackPlan', { sceneId: 'intro', nodeId: 'host' })) as any;
  expect(status(verified.props)).toEqual({ 'row/item.width': 'changed-output', 'row/item.fill': 'written' });
  const check = await app.dispatch('projectPreflight', { ...verified.candidate, samples: [{ sceneId: 'intro', frame: 0 }], width: 320 });
  const now = await app.dispatch('projectPreflight', { revision: app.service.snapshot.revision, samples: [{ sceneId: 'intro', frame: 0 }], width: 320 });
  expect(check.samples[0].pixelHash).toBe(now.samples[0].pixelHash);
}, 180000);

it('CLI jsx-writeback prints the plan and applies with --apply', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [newNode({ id: 'wb', type: 'component', component: 'components/wb.tsx', width: 320, height: 180, overrides: { 'root/free': { fill: '#0000ff' } } })],
      },
    },
  ]);
  await app.close();
  const cli = ['--import', 'tsx', path.resolve('src/cli/index.ts'), 'jsx-writeback', '--project', root, '--scene', 'intro', '--node', 'wb'];
  const planned = JSON.parse((await run(process.execPath, cli, { encoding: 'utf8', timeout: 120000 })).stdout);
  expect(status(planned.props)).toEqual({ 'root/free.fill': 'written' });
  const applied = JSON.parse((await run(process.execPath, [...cli, '--apply'], { encoding: 'utf8', timeout: 120000 })).stdout);
  expect(applied.summary.written).toBe(1);
  expect(await readFile(path.join(root, 'components/wb.tsx'), 'utf8')).toContain('fill="#0000ff"');
  app = await new Application(root).open(false);
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({});
}, 240000);
