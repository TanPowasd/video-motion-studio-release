import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { evaluateNode } from '../src/core/time.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-review-'));
  await initProject(root, 'review', {
    template: 'blank',
    width: 640,
    height: 360,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans batch layout repair, preserves motion trajectories, preflights exact pictures and shares one undo', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'text',
            type: 'text',
            text: '第一行文字\n第二行文字\n第三行文字',
            x: 20,
            y: 20,
            width: 220,
            height: 10,
            fontSize: 24,
          }),
          newNode({
            id: 'outside',
            type: 'text',
            text: '边界',
            x: -70,
            y: 210,
            width: 140,
            height: 40,
            fontSize: 24,
            animations: [
              {
                property: 'x',
                keys: [
                  { frame: 0, value: -70, easing: 'bezier', bezier: [0.2, 0.1, 0.8, 0.9] },
                  { frame: 59, value: -30, easing: 'linear' },
                ],
              },
            ],
          }),
        ],
      },
    },
  ]);
  const original = app.service.snapshot,
    rev = original.revision;
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 30, 59],
    images: false,
  });
  expect(
    present(
      present(present(audit)).findings.find((finding: any) => finding.code === 'TEXT_TRUNCATED'),
    ).locator,
  ).toMatchObject({ sceneId: 'intro', nodeId: 'text', frame: 0 });
  expect(audit.findings[0].id).toMatch(/^[a-f0-9]{24}$/);
  const plan = await app.dispatch('visualRepairPlan', {
    sceneId: 'intro',
    revision: rev,
    frame: 0,
    frames: [0, 30, 59],
    targets: [
      { nodeId: 'text', actions: [{ type: 'fitText' }] },
      { nodeId: 'outside', actions: [{ type: 'insideCanvas', padding: 12 }] },
    ],
  });
  expect(plan.before.summary.errors).toBeGreaterThan(0);
  expect(plan.after.summary.errors).toBe(0);
  expect(plan.after.findings.some((finding: any) => finding.code === 'TEXT_OUTSIDE_CANVAS')).toBe(
    false,
  );
  expect(plan.candidate.planId).toBeTruthy();
  expect(app.service.snapshot.revision).toBe(rev);
  const check = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(check.valid).toBe(true);
  expect(check.data).toBeTruthy();
  await app.dispatch('projectApply', plan.apply);
  const moved = app.service.snapshot.scenes[0].nodes.find((node) => node.id === 'outside')!,
    base = original.scenes[0].nodes.find((node) => node.id === 'outside')!;
  expect(moved.animations[0].keys).toHaveLength(2);
  expect(moved.animations[0].keys[0].bezier).toEqual([0.2, 0.1, 0.8, 0.9]);
  const offset = evaluateNode(moved, 0).x - evaluateNode(base, 0).x;
  expect(evaluateNode(moved, 30).x - evaluateNode(base, 30).x).toBeCloseTo(offset);
  const accepted = app.service.snapshot.revision;
  await expect(
    app.dispatch('render', {
      revision: rev,
      format: 'png',
      output: path.join(root, 'exports/stale'),
      start: 0,
      end: 1,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(app.renders.jobs.size).toBe(0);
  const job = await app.dispatch('render', {
    revision: accepted,
    format: 'png',
    output: path.join(root, 'exports/checked'),
    start: 0,
    end: 1,
    width: 320,
    height: 180,
  });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  expect(job.revision).toBe(accepted);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(rev);
});
it('repairs generated layers under transformed parents without rewriting code or losing sibling overrides', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk'; export default defineComponent({name:'review',parameters:{},render(){return [node({id:'a',type:'text',text:'第一行\\n第二行',x:-30,y:30,width:180,height:8,fontSize:24}),node({id:'b',type:'text',text:'另一行\\n下一行',x:80,y:100,width:180,height:8,fontSize:24})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/review.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'component',
        type: 'component',
        component: 'components/review.ts',
        x: 30,
        y: 30,
        width: 400,
        height: 260,
        scaleX: 1.1,
        scaleY: 0.9,
        rotation: 10,
      },
    },
  ]);
  const rev = app.service.snapshot.revision,
    code = app.service.snapshot.files['components/review.ts'];
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 30),
    before = graph.layers.find((layer) => layer.node.id === 'component/a')!;
  const plan = await app.dispatch('visualRepairPlan', {
    sceneId: 'intro',
    revision: rev,
    frame: 30,
    frames: [30],
    targets: [
      {
        nodeId: 'component/a',
        actions: [{ type: 'fitText' }, { type: 'move', delta: { x: 40, y: 10 } }],
      },
      { nodeId: 'component/b', actions: [{ type: 'fitText' }] },
    ],
  });
  expect(plan.after.summary.errors).toBe(0);
  const check = await app.dispatch('projectPreflight', plan.candidate);
  expect(check.valid).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const rootNode = app.service.snapshot.scenes[0].nodes[0];
  expect(rootNode.overrides.a.height).toBeGreaterThan(8);
  expect(rootNode.overrides.b.height).toBeGreaterThan(8);
  expect(app.service.snapshot.files['components/review.ts']).toBe(code);
  const after = (
    await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 30)
  ).layers.find((layer) => layer.node.id === 'component/a')!;
  expect(after.matrix[4] - before.matrix[4]).toBeCloseTo(40);
  expect(after.matrix[5] - before.matrix[5]).toBeCloseTo(10);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(rev);
});
it('supports a current-frame key repair while retaining existing easing and rejecting stale/infeasible requests', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'box',
        type: 'rect',
        width: 80,
        height: 60,
        animations: [
          {
            property: 'x',
            keys: [
              { frame: 0, value: 0, easing: 'bezier', bezier: [0.1, 0, 0.8, 1] },
              { frame: 59, value: 200, easing: 'linear' },
            ],
          },
        ],
      },
    },
  ]);
  const rev = app.service.snapshot.revision;
  await expect(
    app.dispatch('visualRepairPlan', {
      sceneId: 'intro',
      revision: 'old',
      targets: [{ nodeId: 'box', actions: [{ type: 'move', delta: { x: 2, y: 0 } }] }],
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    app.dispatch('visualRepairPlan', {
      sceneId: 'intro',
      revision: rev,
      targets: [{ nodeId: 'box', actions: [{ type: 'insideCanvas', padding: 180 }] }],
    }),
  ).rejects.toMatchObject({ code: 'VISUAL_REPAIR_FIT' });
  expect(app.service.snapshot.revision).toBe(rev);
  const plan = await app.dispatch('visualRepairPlan', {
    sceneId: 'intro',
    revision: rev,
    frame: 0,
    frames: [0],
    targets: [
      { nodeId: 'box', mode: 'currentKey', actions: [{ type: 'move', delta: { x: 10, y: 0 } }] },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  const node = app.service.snapshot.scenes[0].nodes[0];
  expect(node.animations[0].keys[0]).toMatchObject({
    value: 10,
    easing: 'bezier',
    bezier: [0.1, 0, 0.8, 1],
  });
  expect(node.animations[0].keys[1].value).toBe(200);
});
it('fits unrevealed complete text and returns a stable locator for repeatable findings', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'reveal',
        type: 'text',
        text: '第一行\n第二行\n第三行',
        fontSize: 24,
        width: 200,
        height: 8,
        reveal: 0,
      },
    },
  ]);
  const rev = app.service.snapshot.revision;
  const plan = await app.dispatch('visualRepairPlan', {
    sceneId: 'intro',
    revision: rev,
    frames: [0],
    targets: [{ nodeId: 'reveal', actions: [{ type: 'fitText' }] }],
  });
  expect(plan.changes[0].values.height).toBeGreaterThan(80);
  await expect(
    app.dispatch('visualRepairPlan', {
      sceneId: 'intro',
      revision: rev,
      frames: [0],
      targets: [{ nodeId: 'reveal', actions: [{ type: 'fitText', maxHeight: 20 }] }],
    }),
  ).rejects.toMatchObject({ code: 'VISUAL_REPAIR_FIT' });
});
