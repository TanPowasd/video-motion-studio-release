import { it, expect, beforeEach, afterEach } from 'vitest';
import { particleState, particleField } from '../src/core/particle-field.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
it('solves gravity and drag analytically with stable birth IDs under random seeking', () => {
  const settings = {
    mode: 'burst' as const,
    count: 2,
    lifetime: { min: 10, max: 10 },
    speed: { min: 1, max: 1 },
    direction: 0,
    spread: 0,
    gravity: { x: 0, y: 10 },
    fadeIn: 0,
    fadeOut: 0,
  };
  const before = particleState(settings, 2);
  expect(before.records[0]).toMatchObject({ x: 2, y: 20, vx: 1, vy: 20 });
  particleState(settings, 7);
  expect(particleState(settings, 2)).toEqual(before);
  const drag = particleState({ ...settings, drag: 2, gravity: { x: 0, y: 0 } }, 1).records[0];
  expect(drag.x).toBeCloseTo((1 - Math.exp(-2)) / 2);
  const tiny = particleState({ ...settings, drag: 1e-10 }, 2).records[0];
  expect(tiny.y).toBeCloseTo(20, 6);
});
it('uses birth-time emission origins, uniform disk bounds and explicit live/scan caps', () => {
  const state = particleState(
    { rate: 2, lifetime: { min: 10, max: 10 }, speed: { min: 0, max: 0 }, gravity: { x: 0, y: 0 } },
    2,
    { originAt: (birth) => ({ x: birth * 100, y: 0 }) },
  );
  expect(state.records.find((record) => record.index === 3)).toMatchObject({ birth: 1.5, x: 150 });
  const disk = particleState(
    {
      mode: 'burst',
      count: 300,
      emission: 'disk',
      area: { x: 20, y: 10 },
      speed: { min: 0, max: 0 },
      gravity: { x: 0, y: 0 },
    },
    0,
  );
  for (const record of disk.records)
    expect((record.x / 20) ** 2 + (record.y / 10) ** 2).toBeLessThanOrEqual(1.000001);
  const capped = particleState({ mode: 'burst', count: 2000, maxAlive: 16 }, 0);
  expect(capped.records).toHaveLength(16);
  expect(capped.truncated).toBe(true);
  expect(particleState({ rate: 0 }, 4).records).toEqual([]);
  expect(() => particleState({ lifetime: { min: 5, max: 2 } }, 2)).toThrow();
});
it('creates velocity-aligned streaks, lifetime fade and linear-light tint without accumulated state', () => {
  const settings = {
    mode: 'burst' as const,
    count: 1,
    lifetime: { min: 2, max: 2 },
    speed: { min: 100, max: 100 },
    direction: 0,
    spread: 0,
    gravity: { x: 0, y: 0 },
    size: { min: 2, max: 2 },
    shape: 'streak' as const,
    fadeIn: 0,
    fadeOut: 0,
    colors: ['#ff0000'],
    endColor: '#0000ff',
    tintEnd: true,
  };
  const node = particleField('field', { seconds: 1 }, settings)[0];
  expect(node.rotation).toBe(0);
  expect(node.fill).toBe('#bc00bc');
  expect(node.id).toBe('field/0');
  expect(node.width).toBeGreaterThanOrEqual(node.height);
  expect(particleField('field', { seconds: 2 }, settings)).toEqual([]);
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-particles-'));
  await initProject(root, 'particles', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans a parameter-editable emitter in a generated scope, preflights native frames and atomically undoes source and structure', async () => {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/outer.ts',
      content:
        "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Outer',parameters:{},render(){return [node({id:'group',type:'group',width:320,height:180})]}});",
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'outer',
        type: 'component',
        component: 'components/outer.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    plan = await app.dispatch('particlesPlan', {
      revision,
      sceneId: 'intro',
      path: ['outer'],
      nodeId: 'sparks',
      settings: {
        mode: 'burst',
        count: 20,
        speed: { min: 20, max: 40 },
        gravity: { x: 0, y: 20 },
        fadeIn: 0,
      },
      effects: [{ type: 'echo', count: 3, spacing: 2 }],
    });
  expect(app.service.snapshot.revision).toBe(revision);
  expect(plan.nodeId).toBe('outer/sparks');
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  expect(checked.data).toBeTruthy();
  await app.dispatch('projectApply', plan.apply);
  const metadata = await app.dispatch('componentParameters', {
    sceneId: 'intro',
    path: ['outer'],
    nodeId: 'outer/sparks',
  });
  expect(metadata.values.count).toBe(20);
  const image = await app.frame({ sceneId: 'intro', frame: 15, width: 320, height: 180 });
  expect(image.buffer.length).toBeGreaterThan(100);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.files[plan.source]).toBeUndefined();
});
