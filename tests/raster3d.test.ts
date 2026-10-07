import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareRasterScene, rasterize3D, type RasterRequest } from '../src/core/raster3d.js';
import { NativeEvaluator } from '../src/core/native.js';
import { scene3DLayer, type Camera3D } from '../src/sdk/matrix3d.js';
import { scene3dSchema } from '../src/core/scene3d-schema.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
const camera: Camera3D = {
    position: { x: 0, y: 0, z: 5 },
    target: { x: 0, y: 0, z: 0 },
    width: 128,
    height: 64,
    projection: 'orthographic',
    orthographicHeight: 4,
    near: 0.1,
    far: 20,
  },
  plane = {
    vertices: [
      { x: -1, y: -1, z: 0 },
      { x: 1, y: -1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: -1, y: 1, z: 0 },
    ],
    faces: [[0, 1, 2, 3]],
  },
  instances = [
    { id: 'red', mesh: plane, transform: { rotation: { x: 0, y: 45, z: 0 } }, color: '#ff0000' },
    { id: 'blue', mesh: plane, transform: { rotation: { x: 0, y: -45, z: 0 } }, color: '#0000ff' },
  ],
  data = () => scene3dSchema.parse({ camera, instances, options: { ambient: 1 }, samples: 4 }),
  rgba = (pixels: Buffer, x: number, y: number) =>
    Array.from(pixels.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
it('resolves crossing polygons per pixel instead of painting one whole face above the other', async () => {
  const prepared = prepareRasterScene('world', data(), 128, 64, true),
    native = new NativeEvaluator();
  try {
    const image = await native.raster3D(prepared.request);
    expect(image.backend).toBe('rust');
    expect(rgba(image.pixels, 58, 32)).toEqual([255, 0, 0, 255]);
    expect(rgba(image.pixels, 70, 32)).toEqual([0, 0, 255, 255]);
    expect(prepared.labels[image.faceIds![32 * 128 + 58]].instanceId).toBe('red');
    expect(prepared.labels[image.faceIds![32 * 128 + 70]].instanceId).toBe('blue');
    const reverse = await native.raster3D({
      ...prepared.request,
      triangles: [...prepared.request.triangles].reverse(),
    });
    expect(reverse.pixels.equals(image.pixels)).toBe(true);
    expect(reverse.faceIds).toEqual(image.faceIds);
  } finally {
    native.close();
  }
});
it('matches native and fallback buffers including antialiased edges, depth and face identity', async () => {
  const native = new NativeEvaluator();
  try {
    for (const samples of [1, 4] as const) {
      const request = prepareRasterScene('world', { ...data(), samples }, 127, 65, true).request,
        a = await native.raster3D(request),
        b = rasterize3D(request);
      expect(a.pixels.equals(b.pixels)).toBe(true);
      expect(a.faceIds).toEqual(b.faceIds);
      for (let i = 0; i < a.depth!.length; i++)
        if (a.faceIds![i] >= 0) expect(a.depth![i]).toBeCloseTo(b.depth![i], 5);
      if (samples === 4)
        expect([...a.pixels].some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
    }
  } finally {
    native.close();
  }
});
it('uses perspective-correct eye depth rather than affine interpolation of camera distance', async () => {
  const request: RasterRequest = {
      width: 8,
      height: 8,
      samples: 1,
      inspection: true,
      triangles: [
        {
          vertices: [
            [0, 0, -0.5, 1, 2],
            [8, 0, 0.5, 0.5, 4],
            [0, 8, 0.5, 0.5, 4],
          ],
          color: [255, 255, 255],
          faceId: 0,
        },
      ],
    },
    native = new NativeEvaluator();
  try {
    const image = await native.raster3D(request),
      expected = 2 / 0.8125;
    expect(image.depth![1 * 8 + 1]).toBeCloseTo(expected, 6);
    expect(image.depth![1 * 8 + 1]).not.toBeCloseTo(2 * 0.625 + 4 * 0.375, 4);
  } finally {
    native.close();
  }
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-raster-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function install() {
  const layer = scene3DLayer('depth-world', instances, camera, { ambient: 1 });
  await app.service.transact([
    { type: 'updateProject', patch: { width: 128, height: 64 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { background: 'transparent', duration: 10, nodes: [layer] },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 10,
        markers: [],
        tracks: [
          {
            id: 'v',
            name: '3D',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'c',
                sceneId: 'intro',
                start: 0,
                duration: 10,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    },
  ]);
  return layer;
}
it('persists depth scene JSON and native screenshots agree with PNG export after random frame access', async () => {
  await install();
  const first = await app.frame({ frame: 3 }),
    parsed = JSON.parse(await readFile(path.join(root, 'scenes/intro.json'), 'utf8'));
  expect(parsed.nodes[0].scene3d.samples).toBe(4);
  await app.frame({ frame: 0 });
  expect((await app.frame({ frame: 3 })).buffer.equals(first.buffer)).toBe(true);
  const output = path.join(root, 'exports/png'),
    job = app.renders.start(app.service.snapshot, { output, format: 'png', start: 3, end: 4 }),
    done = await app.renders.wait(job.id);
  expect(done.status, done.error).toBe('completed');
  expect((await readFile(path.join(output, 'frame-00000003.png'))).equals(first.buffer)).toBe(true);
  const image = await loadImage(first.buffer),
    canvas = createCanvas(128, 64);
  canvas.getContext('2d').drawImage(image, 0, 0);
  expect(Array.from(canvas.getContext('2d').getImageData(58, 32, 1, 1).data)).toEqual([
    255, 0, 0, 255,
  ]);
}, 30000);
it('provides agent color/depth/face images, pixel picks and tight projected selection bounds', async () => {
  await install();
  const revision = app.service.snapshot.revision,
    result = await app.dispatch('scene3dRender', {
      source: { sceneId: 'intro', nodeId: 'depth-world', frame: 3 },
      width: 128,
      picks: [
        { x: 58, y: 32 },
        { x: 70, y: 32 },
        { x: 0, y: 0 },
      ],
      inline: true,
      limit: 1,
    });
  expect(result.backend).toBe('rust');
  expect(result.images.map((i: any) => i.kind)).toEqual(['color', 'depth', 'face-id']);
  expect(result.picks.map((p: any) => p.face?.instanceId ?? null)).toEqual(['red', 'blue', null]);
  expect(result.faces.items).toHaveLength(1);
  expect(result.faces.total).toBe(2);
  expect(app.service.snapshot.revision).toBe(revision);
  const interaction = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 3),
    bounds = interaction.layers[0].bounds;
  expect(bounds.x).toBeCloseTo(64 - 16 / Math.sqrt(2));
  expect(bounds.y).toBeCloseTo(16);
  expect(bounds.width).toBeLessThan(128);
  const report = await app.dispatch('projectPreflight', {
    samples: [{ sceneId: 'intro', frame: 3 }],
    determinism: true,
    width: 160,
  });
  expect(report.valid).toBe(true);
}, 30000);
it('rejects invalid 3D data before replacing the valid project', async () => {
  const layer = await install(),
    revision = app.service.snapshot.revision;
  layer.scene3d!.instances[0].parentId = 'missing';
  await expect(
    app.service.transact([
      { type: 'updateNode', sceneId: 'intro', nodeId: 'depth-world', patch: layer },
    ]),
  ).rejects.toThrow('validation');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('evaluates numeric 3D channels without resending or modifying the original mesh', async () => {
  const layer = await install();
  layer.animations = [
    {
      property: 'scene3d.instances.0.transform.rotation.y',
      keys: [
        { frame: 0, value: 45, easing: 'linear' },
        { frame: 9, value: 70, easing: 'linear' },
      ],
    },
  ];
  await app.service.transact([
    { type: 'updateNode', sceneId: 'intro', nodeId: layer.id, patch: layer },
  ]);
  const evaluated = (
    await app.renderer.native.evaluate(app.service.snapshot.scenes[0].nodes, 4.5)
  )[0];
  expect(evaluated.scene3d!.instances[0].transform!.rotation!.y).toBeCloseTo(57.5);
  expect(evaluated.scene3d!.instances[0].mesh).toEqual(layer.scene3d!.instances[0].mesh);
  expect(app.service.snapshot.scenes[0].nodes[0].scene3d!.instances[0].transform!.rotation!.y).toBe(
    45,
  );
  const first = await app.frame({ frame: 0 });
  const middle = await app.frame({ frame: 4.5 });
  expect(middle.buffer.equals(first.buffer)).toBe(false);
}, 30000);
