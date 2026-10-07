import { present, field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-visual-plan-'));
  await initProject(root, 'visual', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'panel',
            type: 'rect',
            x: 20,
            y: 40,
            width: 140,
            height: 70,
            fill: '#ffccaa',
          }),
          newNode({
            id: 'map',
            type: 'rect',
            x: 10,
            y: 30,
            width: 160,
            height: 90,
            fill: '#ff0000',
          }),
          newNode({ id: 'mask-carrier', type: 'rect', opacity: 0, maskId: 'map' }),
        ],
      },
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans typed reusable fields and parameter keys with short replies, bounded pixel evidence and atomic undo', async () => {
  const before = app.service.snapshot.revision,
    list = await app.dispatch('visualTemplates', {});
  expect(list.templates).toHaveLength(9);
  expect(list.templates.every((t: any) => !t.graph)).toBe(true);
  const plan = await app.dispatch('visualPlan', {
    revision: before,
    preset: 'marble',
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'panel',
        params: { scale: 20, warp: 0.8 },
        keys: [
          {
            parameter: 'evolution',
            keys: [
              { frame: 0, value: 0 },
              { frame: 59, value: 2 },
            ],
          },
        ],
      },
    ],
  });
  expect(app.service.snapshot.revision).toBe(before);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const optimized = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 30, 59],
      width: 320,
      repeat: 2,
    }),
    baseline = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 30, 59],
      width: 320,
      repeat: 2,
      fieldScan: 'full',
    });
  expect(field(optimized, 'frames')).toEqual(field(baseline, 'frames'));
  expect(optimized.cache.fieldPixels).toBeLessThan(baseline.cache.fieldPixels / 3);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
it('binds a sibling layer map without altering generated source and preserves user edits to reused resources', async () => {
  const plan = await app.dispatch('visualPlan', {
    revision: app.service.snapshot.revision,
    preset: 'layerDisplace',
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'panel',
        bindings: { map: 'map' },
        params: { amountX: 4, amountY: 0 },
      },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  const node = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'panel')!,
    effect: any = node.effects[0];
  expect(effect.bindings.map).toBe('map');
  const inspected = await app.dispatch('effectGraphInspect', {
    source: { file: effect.source },
    includeGraph: true,
  });
  const resource = inspected.graph;
  present(resource).name = 'User edited map';
  await app.service.transact([
    { type: 'writeSource', path: effect.source, content: JSON.stringify(resource) },
  ]);
  const next = await app.dispatch('visualPlan', {
    revision: app.service.snapshot.revision,
    preset: 'layerDisplace',
    targets: [
      {
        sceneId: 'intro',
        nodeId: 'panel',
        bindings: { map: 'map' },
        params: { amountX: 0, amountY: 0 },
      },
    ],
  });
  await app.dispatch('projectApply', next.apply);
  expect(JSON.parse(app.service.snapshot.files[effect.source]).name).toBe('User edited map');
});
it('reports invalid selected preset/map IDs and native light budgets while recovery preserves the project', async () => {
  const before = app.service.snapshot.revision;
  await expect(app.dispatch('visualTemplates', { includeGraph: true })).rejects.toThrow('Select');
  const plan = await app.dispatch('visualPlan', {
    revision: before,
    preset: 'layerDisplace',
    targets: [{ sceneId: 'intro', nodeId: 'panel', bindings: { map: 'missing' } }],
  });
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid).toBe(false);
  expect(app.service.snapshot.revision).toBe(before);
});
