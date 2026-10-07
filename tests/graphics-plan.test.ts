import { field, present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { Renderer } from '../src/core/renderer.js';
let app: Application, root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-graphics-'));
  await initProject(root, 'graphics', {
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
it('batches generated text and shape edits with exact preflight, paged poses, one undo and preserved code', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'graphics',parameters:{},render(){return [node({id:'label',type:'text',text:'路径文字动画',fontSize:20,x:20,y:20,width:200,height:40,fill:'#ffffff'}),node({id:'shape',type:'rect',width:50,height:50,x:200,y:100,fill:'#66bbff'})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/graphics.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'comp',
        type: 'component',
        component: 'components/graphics.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    plan = await app.dispatch('graphicsPlan', {
      sceneId: 'intro',
      revision,
      targets: [
        {
          path: ['comp'],
          nodeId: 'comp/label',
          pathText: { path: 'M0 20L250 20' },
          textActions: [
            {
              type: 'append',
              item: { id: 'sweep', values: { y: 4 }, selector: { shape: 'smooth' } },
            },
          ],
          keys: [
            {
              property: 'pathText.offset',
              keys: [
                { frame: 0, value: 0 },
                { frame: 30, value: 10 },
              ],
            },
          ],
        },
        {
          path: ['comp'],
          nodeId: 'comp/shape',
          shapeActions: [
            { type: 'append', item: { id: 'round', type: 'round', radius: 8 } },
            { type: 'append', item: { id: 'expand', type: 'offset', amount: 3 } },
          ],
        },
      ],
    });
  expect(app.service.snapshot.revision).toBe(revision);
  expect(JSON.stringify(plan).length).toBeLessThan(2000);
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  expect(checked.data).toBeTruthy();
  await app.dispatch('projectApply', plan.apply);
  const info = await app.dispatch('graphicsInspect', {
    sceneId: 'intro',
    path: ['comp'],
    nodeId: 'comp/label',
    frame: 15,
    limit: 2,
  });
  expect(present(field(info, 'units')).total).toBe(6);
  expect(present(field(info, 'units')).items).toHaveLength(2);
  expect(present(field(info, 'units')).nextOffset).toBe(2);
  expect(present(field(info, 'units')).items[0].x).toBeCloseTo(5, 3);
  expect(present(field(info, 'pathText')).path).toBeUndefined();
  expect(present(field(info, 'metrics')).truncatedCharacters).toBe(0);
  const shape = await app.dispatch('graphicsInspect', {
    sceneId: 'intro',
    path: ['comp'],
    nodeId: 'comp/shape',
  });
  expect(present(field(shape, 'geometry')).path).toBeUndefined();
  expect(shape.localBounds.x).toBe(-3);
  expect(app.service.snapshot.files['components/graphics.ts']).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('rejects stale revisions, invalid types and open offsets without changing files/history', async () => {
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('graphicsPlan', {
      sceneId: 'intro',
      revision: 'stale',
      targets: [{ nodeId: 'none', pathText: { path: 'M0 0L200 0' } }],
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await app.service.transact([
    { type: 'addNode', sceneId: 'intro', node: { id: 'open', type: 'path', path: 'M0 0L200 0' } },
  ]);
  const current = app.service.snapshot.revision;
  await expect(
    app.dispatch('graphicsPlan', {
      sceneId: 'intro',
      revision: current,
      targets: [
        {
          nodeId: 'open',
          shapeActions: [{ type: 'append', item: { id: 'offset', type: 'offset', amount: 3 } }],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'VECTOR_OFFSET_OPEN' });
  expect(app.service.snapshot.revision).toBe(current);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('renders random frames with identical pixels with/without caches and selection encloses path glyph ink', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        background: '#000000',
        nodes: [
          newNode({
            id: 'text',
            type: 'text',
            text: 'ABC文字',
            fontSize: 22,
            fill: '#ffffff',
            pathText: { path: 'M20 80Q160 130 290 70' },
            textAnimators: [
              { id: 'range', selector: { shape: 'triangle' }, values: { y: 3, scaleX: 1.2 } },
            ],
            animations: [
              {
                property: 'pathText.offset',
                keys: [
                  { frame: 0, value: 0 },
                  { frame: 30, value: 5 },
                ],
              },
            ],
          }),
          newNode({
            id: 'shape',
            type: 'rect',
            x: 120,
            y: 20,
            width: 50,
            height: 30,
            shapeOperators: [{ id: 'round', type: 'round', radius: 8 }],
          }),
        ],
      },
    },
  ]);
  const uncached = new Renderer(root, { graphicsCache: false });
  try {
    const hashes = new Map<number, Buffer>();
    for (const frame of [30, 0, 10, 30, 10]) {
      const a = await app.renderer.render(app.service.snapshot, frame),
        b = await uncached.render(app.service.snapshot, frame),
        pixels = Buffer.from(a.getContext('2d').getImageData(0, 0, 320, 180).data);
      expect(pixels.equals(Buffer.from(b.getContext('2d').getImageData(0, 0, 320, 180).data))).toBe(
        true,
      );
      if (hashes.has(frame)) expect(pixels.equals(hashes.get(frame)!)).toBe(true);
      else hashes.set(frame, pixels);
      a.width = 1;
      b.width = 1;
    }
    expect(app.renderer.typography.report().layout.hits).toBeGreaterThan(0);
    expect(uncached.typography.report().layout.entries).toBe(0);
    const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0),
      layer = graph.layers.find((l) => l.node.id === 'text')!,
      canvas = await app.renderer.render(app.service.snapshot, 0),
      g = canvas.getContext('2d'),
      pixels = g.getImageData(0, 0, 320, 180).data;
    for (let y = 65; y < 150; y++)
      for (let x = 0; x < 320; x++) {
        if (pixels[(y * 320 + x) * 4] > 128)
          expect(
            x >= layer.bounds.x - 2 &&
              x <= layer.bounds.x + layer.bounds.width + 2 &&
              y >= layer.bounds.y - 2 &&
              y <= layer.bounds.y + layer.bounds.height + 2,
          ).toBe(true);
      }
    canvas.width = 1;
  } finally {
    await uncached.close();
  }
});
