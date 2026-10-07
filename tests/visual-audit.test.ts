import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { boundsPolygon, clipPolygon, polygonArea } from '../src/core/geometry.js';
import {
  auditFrame,
  auditMotion,
  visualOptionsSchema,
  auditGeometry,
} from '../src/core/visual-audit.js';
import { newNode } from '../src/core/model.js';
import { identity, nodeMatrix, type InteractionLayer } from '../src/core/interaction.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
const layer = (id: string, options: Partial<InteractionLayer> = {}): InteractionLayer => ({
  node: newNode({ id, type: 'text', text: 'Text' }),
  path: [],
  matrix: identity,
  parentMatrix: identity,
  bounds: { x: 0, y: 0, width: 80, height: 20 },
  clips: [],
  container: false,
  opacity: 1,
  ...options,
});
const defaults = visualOptionsSchema.parse({});
it('clips convex polygons accurately with rotation and mirrored winding', () => {
  const subject = boundsPolygon({ x: 0, y: 0, width: 100, height: 50 }, identity),
    clip = boundsPolygon({ x: 25, y: 0, width: 50, height: 50 }, identity);
  expect(polygonArea(clipPolygon(subject, clip))).toBe(2500);
  expect(polygonArea(clipPolygon(subject, clip.reverse()))).toBe(2500);
  const rotated = boundsPolygon(
    { x: 0, y: 0, width: 10, height: 10 },
    nodeMatrix(newNode({ id: 'r', type: 'rect', x: 5, y: 5, rotation: 45 })),
  );
  expect(polygonArea(rotated)).toBeCloseTo(100);
  expect(
    polygonArea(
      clipPolygon(rotated, boundsPolygon({ x: -10, y: -10, width: 50, height: 50 }, identity)),
    ),
  ).toBeCloseTo(100);
});
it('reports actual clipping/overflow and keeps inherited transparent layers out of collision checks', () => {
  const clipped = layer('clipped', {
      matrix: [1, 0, 0, 1, 170, 40],
      clips: [{ matrix: identity, bounds: { x: 0, y: 0, width: 220, height: 100 } }],
    }),
    hidden = layer('hidden', { opacity: 0.01 });
  const report = auditFrame([clipped, hidden], 200, 100, 0, defaults);
  expect(report.findings.map((f) => f.code)).toEqual(['TEXT_CLIPPED', 'TEXT_OUTSIDE_CANVAS']);
  expect(report.findings.find((f) => f.code === 'TEXT_CLIPPED')?.ratio).toBeCloseTo(0.375);
  expect(report.findings.find((f) => f.code === 'TEXT_OUTSIDE_CANVAS')?.ratio).toBeCloseTo(0.4);
});
it('uses text run polygons instead of a giant box and respects paint order for opaque rectangle coverage', () => {
  const a = layer('a', {
      bounds: { x: 0, y: 0, width: 200, height: 80 },
      contentPolygons: [boundsPolygon({ x: 0, y: 0, width: 80, height: 20 }, identity)],
    }),
    b = layer('b', { matrix: [1, 0, 0, 1, 0, 50] }),
    cover = layer('cover', {
      node: newNode({ id: 'cover', type: 'rect', fill: '#123456' }),
      bounds: { x: 0, y: 0, width: 80, height: 20 },
    });
  expect(auditFrame([a, b], 300, 100, 0, defaults).findings).toHaveLength(0);
  const collision = layer('collision');
  expect(
    auditFrame(
      [a, collision],
      300,
      100,
      0,
      visualOptionsSchema.parse({ nodeIds: ['collision'] }),
    ).findings.find((f) => f.code === 'TEXT_OVERLAP')?.nodeId,
  ).toBe('collision');
  expect(
    auditFrame([cover, a], 300, 100, 0, defaults).findings.some((f) => f.code === 'TEXT_COVERED'),
  ).toBe(false);
  expect(
    auditFrame([a, cover], 300, 100, 0, defaults).findings.find((f) => f.code === 'TEXT_COVERED')
      ?.ratio,
  ).toBe(1);
  expect(
    auditFrame([a, { ...cover, uncertainty: ['mask'] }], 300, 100, 0, defaults).findings.some(
      (f) => f.code === 'TEXT_COVERED',
    ),
  ).toBe(false);
});
it('detects adjacent-frame motion jumps while respecting IDs and ignores deliberate background motion', () => {
  const before = auditGeometry([layer('text')], 500, 200),
    after = auditGeometry([layer('text', { matrix: [1, 0, 0, 1, 300, 0] })], 500, 200),
    findings = auditMotion(before, after, 29, 30, 30, 500, 200, defaults);
  expect(findings[0].code).toBe('MOTION_JUMP');
  expect(findings[0].metrics?.distancePixels).toBe(300);
  expect(auditMotion(before, after, 0, 300, 30, 500, 200, defaults)).toHaveLength(0);
  expect(
    auditFrame(
      [layer('a'), layer('b')],
      500,
      200,
      0,
      visualOptionsSchema.parse({ ignoreNodeIds: ['b'] }),
    ).findings,
  ).toHaveLength(0);
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-visual-audit-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('native Chinese text truncation uses the same line breaking as rendering and audit preserves active history', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'title',
            type: 'text',
            name: '中文标题',
            text: '这里是第一行\n这里是第二行\n这里是第三行',
            x: 20,
            y: 30,
            width: 250,
            height: 25,
            fontSize: 24,
          }),
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    report = await app.dispatch('visualAudit', {
      sceneId: 'intro',
      frames: [0, 30],
      inline: true,
      width: 320,
    });
  expect(report.summary.status).toBe('failed');
  expect(
    present(
      present(present(present(report)).findings.find((f: any) => f.code === 'TEXT_TRUNCATED'))
        .metrics,
    ).renderedLines,
  ).toBe(1);
  expect(present(present(present(report)).data).length).toBeGreaterThan(100);
  expect(app.service.snapshot.revision).toBe(revision);
  const preflight = await app.dispatch('projectPreflight', {
    visual: true,
    samples: [{ sceneId: 'intro', frame: 0 }],
    width: 160,
  });
  expect(preflight.valid).toBe(false);
  expect(preflight.diagnostics.some((d: any) => d.code === 'TEXT_TRUNCATED')).toBe(true);
  await expect(
    app.dispatch('projectApply', {
      visual: true,
      operations: [
        { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { fill: '#ffcc88' } },
      ],
      samples: [{ sceneId: 'intro', frame: 0 }],
      width: 160,
    }),
  ).rejects.toThrow('no project changes saved');
  expect(app.service.snapshot.revision).toBe(revision);
  await app.service.undo();
  expect(app.service.snapshot.project.width).toBe(1920);
});
it('caps evidence findings and explicitly reports incomplete checks instead of claiming a clean scene', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'a',
            type: 'text',
            text: 'A\nA',
            x: 300,
            y: 30,
            width: 100,
            height: 20,
            fontSize: 24,
          }),
          newNode({
            id: 'b',
            type: 'text',
            text: 'B',
            x: 300,
            y: 30,
            width: 100,
            height: 40,
            fontSize: 24,
          }),
        ],
      },
    },
  ]);
  const report = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0],
    images: false,
    options: { maxFindings: 1 },
  });
  expect(report.findings).toHaveLength(1);
  expect(report.summary.omitted).toBeGreaterThan(0);
  expect(report.summary.incomplete).toBe(true);
});
it('generated animated text reports stable IDs/owner paths and produces annotated frame evidence', async () => {
  const source =
    "import {defineComponent,text,rect} from '@vmotion/sdk';export default defineComponent({name:'Bad layout',parameters:{},render(ctx){return [text('a','标题',{x:20+(ctx.frame>=30?180:0),y:30,width:180,height:50,fontSize:28}),text('b','标题',{x:20,y:30,width:180,height:50,fontSize:28}),rect('cover',{x:20,y:30,width:120,height:40,fill:'#112233'})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/layout.ts', content: source },
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/layout.ts',
            width: 320,
            height: 180,
          }),
        ],
      },
    },
  ]);
  const report = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 29, 30],
    options: { maxStepFraction: 0.1 },
    width: 320,
  });
  expect(
    report.findings.some(
      (f: any) =>
        f.code === 'TEXT_OVERLAP' &&
        f.nodeId === 'code/a' &&
        f.relatedNodeId === 'code/b' &&
        f.path[0] === 'code',
    ),
  ).toBe(true);
  expect(
    report.findings.some((f: any) => f.code === 'TEXT_COVERED' && f.relatedNodeId === 'code/cover'),
  ).toBe(true);
  expect(report.findings.some((f: any) => f.code === 'MOTION_JUMP' && f.frame === 30)).toBe(true);
  expect(report.summary.status).toBe('review');
  expect(report.evidenceFrames).toEqual([0, 29, 30]);
  expect(report.objects.some((o: any) => o.nodeId === 'code/a')).toBe(true);
}, 30000);
it('reports inherited clips/opacity and definite runtime failures instead of clearing the report', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'g', type: 'group', opacity: 0.05 }),
          newNode({ id: 'hidden', parentId: 'g', type: 'text', text: 'hidden', x: 500 }),
        ],
      },
    },
  ]);
  expect(
    (await app.dispatch('visualAudit', { sceneId: 'intro', frames: [0], images: false })).findings,
  ).toHaveLength(0);
  const source =
    "import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Runtime',parameters:{},render(ctx){if(ctx.frame>5)throw new Error('audit runtime');return [rect('r')];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/runtime.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [newNode({ id: 'code', type: 'component', component: 'components/runtime.ts' })],
      },
    },
  ]);
  const report = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 10],
    images: false,
  });
  expect(report.summary.status).toBe('failed');
  expect(report.findings.some((f: any) => f.code === 'FRAME_ERROR' && f.frame === 10)).toBe(true);
  expect(report.diagnostics[0].message).toContain('audit runtime');
});
