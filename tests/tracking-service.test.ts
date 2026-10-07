import { field, present } from './result-assertions.js';
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  rename,
  stat,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { readTrackingAnalysis } from '../src/service/tracking-jobs.js';
import { evaluateNode } from '../src/core/time.js';
import { transform, nodeMatrix, multiply } from '../src/core/interaction.js';
import { VideoDecoder } from '../src/media/ffmpeg.js';
let fixture: string, root: string, app: Application;
const points = [
  { id: 'tl', x: 65, y: 50 },
  { id: 'tr', x: 210, y: 50 },
  { id: 'br', x: 210, y: 125 },
  { id: 'bl', x: 65, y: 125 },
];
beforeAll(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'vmotion-track-fixture-'));
  await mkdir(path.join(fixture, 'frames'));
  for (let frame = 0; frame < 24; frame++) {
    const canvas = createCanvas(320, 180),
      ctx = canvas.getContext('2d'),
      data = ctx.createImageData(320, 180),
      dx = frame,
      dy = Math.floor(frame / 4);
    for (let y = 0; y < 180; y++)
      for (let x = 0; x < 320; x++) {
        const px = x - dx,
          py = y - dy,
          v = Math.round(
            125 +
              39 * Math.sin(px * 0.31) +
              32 * Math.sin(py * 0.39) +
              28 * Math.sin((px + py) * 0.19),
          ),
          i = (y * 320 + x) * 4;
        data.data[i] = v;
        data.data[i + 1] = v;
        data.data[i + 2] = v;
        data.data[i + 3] = 255;
      }
    ctx.putImageData(data, 0, 0);
    await writeFile(
      path.join(fixture, `frames/${String(frame).padStart(3, '0')}.png`),
      await canvas.encode('png'),
    );
    canvas.width = 1;
  }
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-framerate',
      '30',
      '-i',
      path.join(fixture, 'frames/%03d.png'),
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'bgra',
      path.join(fixture, 'source.mkv'),
    ],
    { windowsHide: true },
  );
});
afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-track-test-'));
  await initProject(root, 'Tracking', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 1,
  });
  await copyFile(path.join(fixture, 'source.mkv'), path.join(root, 'source.mkv'));
  app = await new Application(root).open(false);
  await app.dispatch('import', { path: path.join(root, 'source.mkv'), type: 'video', copy: false });
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('decodes direct frame buffers with identical pixels and one-copy accounting versus concatenation', async () => {
  const direct = new VideoDecoder(path.join(root, 'source.mkv'), 320, 180, { num: 30, den: 1 }),
    baseline = new VideoDecoder(
      path.join(root, 'source.mkv'),
      320,
      180,
      { num: 30, den: 1 },
      { framing: 'concat' },
    );
  try {
    for (const frame of [0, 1, 2, 3, 4, 5, 12, 13, 4])
      expect((await direct.frame(frame)).equals(await baseline.frame(frame))).toBe(true);
    const a = direct.diagnostics(),
      b = baseline.diagnostics();
    expect(a.copiedBytes).toBe(a.decodedFrames * 320 * 180 * 4);
    expect(a.concatenations).toBe(0);
    expect(b.copiedBytes).toBeGreaterThan(a.copiedBytes * 1.8);
    expect(a.cachedBytes).toBeLessThanOrEqual(8 * 320 * 180 * 4);
  } finally {
    await direct.close();
    await baseline.close();
  }
});
async function analyze(end = 24) {
  const asset = app.service.snapshot.project.assets[0],
    job = await app.dispatch('trackingAnalyze', {
      action: 'start',
      wait: true,
      request: {
        assetId: asset.id,
        end,
        width: 320,
        settings: { levels: 3 },
        points: points.map((p) => ({ id: p.id, seeds: [{ frame: 0, x: p.x, y: p.y }] })),
      },
    });
  expect(field(job, 'status')).toBe('completed');
  return job;
}
it('converts letterbox, different parent transforms and source content-time retiming into output-local keys', async () => {
  const job = await analyze(),
    asset = app.service.snapshot.project.assets[0];
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'src-parent', type: 'group', x: 20, rotation: 10 }),
          newNode({
            id: 'footage',
            type: 'video',
            parentId: 'src-parent',
            assetId: asset.id,
            width: 240,
            height: 160,
            timeMapping: { rate: 2, offset: 2 },
          }),
          newNode({
            id: 'target-parent',
            type: 'group',
            x: 60,
            y: 20,
            rotation: -20,
            scaleX: 0.7,
            scaleY: 0.9,
          }),
          newNode({
            id: 'label',
            type: 'rect',
            parentId: 'target-parent',
            x: 30,
            y: 40,
            width: 10,
            height: 10,
          }),
        ],
      },
    },
  ]);
  const plan = await app.dispatch('trackingPlan', {
    analysisId: field(job, 'analysisId'),
    revision: app.service.snapshot.revision,
    bindings: [
      {
        sceneId: 'intro',
        sourceNodeId: 'footage',
        targetNodeId: 'label',
        mode: 'point',
        pointIds: ['tl'],
        endFrame: 10,
      },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  const nodes = app.service.snapshot.scenes[0].nodes,
    target0 = transform(multiply(nodeMatrix(nodes[2]), nodeMatrix(evaluateNode(nodes[3], 0))), {
      x: 0,
      y: 0,
    }),
    target9 = transform(multiply(nodeMatrix(nodes[2]), nodeMatrix(evaluateNode(nodes[3], 9))), {
      x: 0,
      y: 0,
    });
  const sourceMatrix = nodeMatrix(nodes[0]),
    s0 = transform(sourceMatrix, {
      x: (65 + 2) * 0.75,
      y: Math.floor(2 / 4) * 0.75 + 50 * 0.75 + 12,
    }),
    s9 = transform(sourceMatrix, {
      x: (65 + 20) * 0.75,
      y: Math.floor(20 / 4) * 0.75 + 50 * 0.75 + 12,
    });
  expect(target9.x - target0.x).toBeCloseTo(s9.x - s0.x, 0);
  expect(target9.y - target0.y).toBeCloseTo(s9.y - s0.y, 0);
});
it('tracks displayed pixels of rotated phone-style video sources', async () => {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      path.join(root, 'source.mkv'),
      '-c:v',
      'libx264',
      '-crf',
      '10',
      path.join(root, 'plain.mp4'),
    ],
    { windowsHide: true },
  );
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-display_rotation',
      '90',
      '-i',
      path.join(root, 'plain.mp4'),
      '-c',
      'copy',
      path.join(root, 'rotated.mp4'),
    ],
    { windowsHide: true },
  );
  await app.dispatch('import', { path: path.join(root, 'rotated.mp4'), type: 'video' });
  const asset = app.service.snapshot.project.assets.at(-1)!,
    job = await app.dispatch('trackingAnalyze', {
      wait: true,
      request: {
        assetId: asset.id,
        end: 16,
        width: 320,
        points: [{ id: 'phone', seeds: [{ frame: 0, x: 60, y: 250 }] }],
      },
    });
  expect(field(job, 'status'), JSON.stringify(field(job, 'error'))).toBe('completed');
  const doc = await readTrackingAnalysis(root, present(field(job, 'analysisId')));
  expect(doc.source.width).toBe(180);
  expect(doc.source.height).toBe(320);
  expect(doc.points[0].samples[12].status).toBe('tracked');
  expect(Math.abs(doc.points[0].samples[12].y! - 250)).toBeCloseTo(12, 0);
});
it('streams a video in a worker with compact job progress, pixel evidence and source locks released', async () => {
  const before = app.service.snapshot.revision,
    job = await analyze(),
    doc = await readTrackingAnalysis(root, present(field(job, 'analysisId')));
  expect(doc.points[0].samples[12].x).toBeCloseTo(77, 0);
  expect(doc.points[0].samples[12].y).toBeCloseTo(53, 0);
  expect(app.service.snapshot.revision).toBe(before);
  expect(present(field(job, 'metrics')).frameCalls).toBe(24);
  expect(present(field(job, 'metrics')).peakBufferBytes).toBeLessThan(8 * 1024 * 1024);
  const info = await app.dispatch('trackingInspect', {
    analysisId: field(job, 'analysisId'),
    limit: 2,
    frames: [0, 12, 23],
  });
  expect(info.points.total).toBe(4);
  expect(info.points.items).toHaveLength(2);
  expect(info.points.items[0].lost).toBe(0);
  const evidence = await app.dispatch('trackingEvidence', {
    analysisId: field(job, 'analysisId'),
    frames: [0, 12, 23],
    inline: true,
    width: 320,
  });
  expect(evidence.data).toBeTruthy();
  expect(evidence.samples.every((s: any) => s.visible === 4)).toBe(true);
  await rename(path.join(root, 'source.mkv'), path.join(root, 'renamed.mkv'));
  await rename(path.join(root, 'renamed.mkv'), path.join(root, 'source.mkv'));
});
it('accepts byte-identical copied footage using its captured digest and rebases the candidate metadata check', async () => {
  const job = await analyze(),
    doc = await readTrackingAnalysis(root, present(field(job, 'analysisId')));
  expect(doc.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
  await copyFile(path.join(fixture, 'source.mkv'), path.join(root, 'source.mkv'));
  const stamp = await stat(path.join(root, 'source.mkv'));
  await utimes(path.join(root, 'source.mkv'), stamp.atime, new Date(stamp.mtimeMs + 2000));
  const plan = await app.dispatch('trackingPlan', {
    analysisId: field(job, 'analysisId'),
    revision: app.service.snapshot.revision,
  });
  expect((await app.dispatch('projectPreflight', plan.candidate)).valid).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const saved = JSON.parse(app.service.snapshot.files[plan.resource.file]);
  expect(saved.source.contentHash).toBe(doc.source.contentHash);
  expect(saved.source.fingerprint).not.toBe(doc.source.fingerprint);
});
it('batches generated point attachment and native corner pin with exact candidate/undo and source preservation', async () => {
  const asset = app.service.snapshot.project.assets[0],
    source = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'tracked',parameters:{},render(){return [node({id:'footage',type:'video',assetId:${JSON.stringify(asset.id)},width:320,height:180}),node({id:'label',type:'text',text:'跟随',fontSize:14,x:70,y:25,width:50,height:30}),node({id:'insert',type:'rect',x:0,y:0,width:320,height:180,fill:'#77ccaa'})]}});`;
  await app.service.transact([
    { type: 'writeSource', path: 'components/shot.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'comp',
        type: 'component',
        component: 'components/shot.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const job = await analyze(),
    before = app.service.snapshot.revision,
    plan = await app.dispatch('trackingPlan', {
      analysisId: field(job, 'analysisId'),
      revision: before,
      bindings: [
        {
          sceneId: 'intro',
          path: ['comp'],
          sourceNodeId: 'comp/footage',
          targetNodeId: 'comp/label',
          mode: 'point',
          pointIds: ['tl'],
          endFrame: 24,
        },
        {
          sceneId: 'intro',
          path: ['comp'],
          sourceNodeId: 'comp/footage',
          targetNodeId: 'comp/insert',
          mode: 'cornerPin',
          pointIds: points.map((p) => p.id),
          endFrame: 24,
        },
      ],
    });
  expect(JSON.stringify(plan).length).toBeLessThan(4000);
  expect(app.service.snapshot.revision).toBe(before);
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.revision).toBe(plan.candidateRevision);
  const scope = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 12, ['comp']),
    label = evaluateNode(
      scope.scene.nodes.find((n) => n.id === 'comp/label')!,
      12,
    ),
    insert = evaluateNode(
      scope.scene.nodes.find((n) => n.id === 'comp/insert')!,
      12,
    );
  expect(label.matrix[4]).toBeCloseTo(12, 0);
  expect(label.matrix[5]).toBeCloseTo(3, 0);
  expect(insert.effects[0].type).toBe('cornerPin');
  if (insert.effects[0].type === 'cornerPin')
    expect(insert.effects[0].corners[0].x).toBeCloseTo(77 / 320, 2);
  expect(await readFile(path.join(root, 'components/shot.ts'), 'utf8')).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
it('stabilizes actual video pixels and preserves ordinary TRS keys and exact random frame evaluation', async () => {
  const asset = app.service.snapshot.project.assets[0];
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: newNode({
        id: 'footage',
        type: 'video',
        assetId: asset.id,
        width: 320,
        height: 180,
        animations: [
          {
            property: 'opacity',
            keys: [
              { frame: 0, value: 1 },
              { frame: 23, value: 1 },
            ],
          },
        ],
      }),
    },
  ]);
  const job = await analyze(),
    before = app.service.snapshot.revision,
    reference = await app.frame({ frame: 0, width: 320, height: 180 }),
    plan = await app.dispatch('trackingPlan', {
      analysisId: field(job, 'analysisId'),
      revision: before,
      bindings: [
        {
          sceneId: 'intro',
          sourceNodeId: 'footage',
          targetNodeId: 'footage',
          mode: 'stabilize',
          model: 'translation',
          pointIds: points.map((p) => p.id),
          endFrame: 24,
        },
      ],
    });
  expect((await app.dispatch('projectPreflight', plan.candidate)).valid).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const n = app.service.snapshot.scenes[0].nodes[0];
  expect(n.animations.some((a) => a.property === 'opacity')).toBe(true);
  expect(evaluateNode(n, 12).matrix[4]).toBeCloseTo(-12, 0);
  const beforeCanvas = await import('@napi-rs/canvas').then((m) => m.loadImage(reference.buffer)),
    c = createCanvas(320, 180),
    ctx = c.getContext('2d');
  ctx.drawImage(beforeCanvas, 0, 0);
  const a = ctx.getImageData(40, 30, 220, 120).data;
  const render = await app.renderer.render(app.service.snapshot, 12),
    b = render.getContext('2d').getImageData(40, 30, 220, 120).data;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]);
  expect(total / (220 * 120)).toBeLessThan(2);
  const hashes = new Map<number, Buffer>();
  for (const frame of [23, 0, 12, 23, 12]) {
    const image = (await app.frame({ frame, width: 320, height: 180 })).buffer;
    if (hashes.has(frame)) expect(image.equals(hashes.get(frame)!)).toBe(true);
    else hashes.set(frame, image);
  }
  render.width = 1;
  c.width = 1;
});
it('rejects lost/conflicting motion, supports explicit hold and manual resources, and cancels jobs', async () => {
  const job = await analyze(),
    asset = app.service.snapshot.project.assets[0];
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'footage', type: 'video', assetId: asset.id, width: 320, height: 180 },
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'label', type: 'rect', width: 10, height: 10 },
    },
  ]);
  const before = app.service.snapshot.revision,
    save = await app.dispatch('trackingPlan', {
      analysisId: field(job, 'analysisId'),
      revision: before,
      edits: [{ pointId: 'tl', frame: 12, x: null, y: null }],
    });
  await app.dispatch('projectApply', save.apply);
  const revision = app.service.snapshot.revision,
    binding = {
      sceneId: 'intro',
      sourceNodeId: 'footage',
      targetNodeId: 'label',
      mode: 'point',
      pointIds: ['tl'],
      endFrame: 24,
    };
  await expect(
    app.dispatch('trackingPlan', { file: save.resource.file, revision, bindings: [binding] }),
  ).rejects.toMatchObject({ code: 'TRACKING_LOST' });
  expect(app.service.snapshot.revision).toBe(revision);
  const hold = await app.dispatch('trackingPlan', {
    file: save.resource.file,
    revision,
    bindings: [{ ...binding, loss: 'hold' }],
  });
  expect(hold.bindings[0].heldSamples).toBe(1);
  await app.dispatch('projectApply', hold.apply);
  await expect(
    app.dispatch('trackingPlan', {
      file: save.resource.file,
      revision: app.service.snapshot.revision,
      bindings: [{ ...binding, loss: 'hold' }],
    }),
  ).rejects.toMatchObject({ code: 'TRACKING_CHANNEL_EXISTS' });
  const cancel = await app.dispatch('trackingAnalyze', {
    request: { assetId: asset.id, end: 24, width: 320 },
  });
  await app.dispatch('trackingAnalyze', { action: 'cancel', id: field(cancel, 'id') });
  expect((await app.tracking.wait(present(field(cancel, 'id')))).status).toBe('cancelled');
  await writeFile(path.join(root, 'source.mkv'), Buffer.from('changed'));
  await expect(
    app.dispatch('trackingPlan', {
      analysisId: field(job, 'analysisId'),
      revision: app.service.snapshot.revision,
    }),
  ).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
});
