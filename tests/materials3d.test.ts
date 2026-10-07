import { present, field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { standardMaterial, unlitMaterial } from '../src/sdk/materials3d.js';
import { cornerNormals, smoothMesh } from '../src/sdk/normals3d.js';
import { sphereMesh, transformMesh } from '../src/sdk/meshes.js';
import { cubeMesh, evaluateScene3D, scene3DLayer } from '../src/sdk/matrix3d.js';
import { scene3dSchema } from '../src/core/scene3d-schema.js';
import { prepareRasterScene, rasterize3D } from '../src/core/raster3d.js';
import { NativeEvaluator } from '../src/core/native.js';
import { shadeFragment, rasterMaterial, type RasterLighting } from '../src/core/shading3d.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
const camera = {
    position: { x: 0, y: 0, z: 5 },
    target: { x: 0, y: 0, z: 0 },
    width: 128,
    height: 96,
    near: 0.1,
    far: 20,
  },
  light: RasterLighting = {
    camera: [0, 0, 5],
    ambient: 0,
    exposure: 1,
    toneMapping: 'none',
    lights: [{ type: 'directional', vector: [0, 0, 1], color: [1, 1, 1], intensity: 1 }],
  };
it('averages smooth sphere corners while preserving cube hard edges and mirrored baked normal directions', () => {
  const cube = cubeMesh(),
    flat = cornerNormals(cube, 60),
    rounded = cornerNormals(cube, 180);
  expect(flat[1][0]).toEqual({ x: 0, y: 0, z: 1 });
  expect(rounded[1][0].x).toBeLessThan(0);
  expect(rounded[1][0].y).toBeLessThan(0);
  expect(rounded[1][0].z).toBeGreaterThan(0);
  const sphere = sphereMesh(1, { widthSegments: 12, heightSegments: 6 }),
    smooth = cornerNormals(sphere, 180),
    at = sphere.vertices[sphere.faces[3][1]],
    normal = smooth[3][1];
  expect(normal.x * at.x + normal.y * at.y + normal.z * at.z).toBeGreaterThan(0.95);
  const mirrored = transformMesh(smoothMesh(cube, 60), { scale: { x: -1, y: 2, z: 1 } });
  expect(mirrored.cornerNormals![1][0]).toEqual({ x: 0, y: 0, z: 1 });
});
it('uses inverse-transpose normals under nonuniform instance scales', () => {
  const mesh = {
      vertices: [
        { x: -1, y: -1, z: 0 },
        { x: 1, y: -1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      faces: [[0, 1, 2]],
      cornerNormals: [Array(3).fill({ x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 })],
    },
    report = evaluateScene3D(
      'world',
      [
        {
          id: 'model',
          mesh,
          material: standardMaterial(),
          transform: { scale: { x: 2, y: 1, z: 1 } },
        },
      ],
      camera,
    );
  expect(report.faces[0].vertices[0].normal!.x).toBeCloseTo(1 / Math.sqrt(5));
  expect(report.faces[0].vertices[0].normal!.y).toBeCloseTo(2 / Math.sqrt(5));
});
it('round-trips unlit sRGB, changes specular response with roughness and attenuates point lighting by distance', () => {
  const unlit = rasterMaterial(unlitMaterial('#804020'), '#804020');
  expect(shadeFragment(unlit, light, [0, 0, 0], [0, 0, -1])).toEqual([128, 64, 32]);
  const smooth = rasterMaterial(standardMaterial({ roughness: 0.1, color: '#888888' }), '#888888'),
    rough = rasterMaterial(standardMaterial({ roughness: 1, color: '#888888' }), '#888888');
  expect(shadeFragment(smooth, light, [0, 0, 0], [0, 0, 1])[0]).toBeGreaterThan(
    shadeFragment(rough, light, [0, 0, 0], [0, 0, 1])[0],
  );
  const point = (z: number): RasterLighting => ({
    ...light,
    lights: [{ type: 'point', vector: [0, 0, z], color: [1, 1, 1], intensity: 1 }],
  });
  expect(shadeFragment(rough, point(2), [0, 0, 0], [0, 0, 1])[0]).toBeGreaterThan(
    shadeFragment(rough, point(4), [0, 0, 0], [0, 0, 1])[0],
  );
});
it('matches native and fallback smooth materials, clipped varying attributes and depth/IDs', async () => {
  const native = new NativeEvaluator();
  try {
    for (const near of [0.1, 4.4]) {
      const data = scene3dSchema.parse({
          camera: { ...camera, near },
          instances: [
            {
              id: 'sphere',
              mesh: sphereMesh(1, { widthSegments: 12, heightSegments: 6 }),
              material: standardMaterial({ metallic: 0.6, roughness: 0.3, color: '#f0ba66' }),
            },
          ],
          options: {
            ambient: 0.1,
            lights: [
              { type: 'directional', direction: { x: 0.3, y: 0.6, z: 1 }, intensity: 3 },
              { type: 'point', position: { x: -2, y: 1, z: 3 }, color: '#668cff', intensity: 5 },
            ],
            toneMapping: 'aces',
          },
          samples: 4,
        }),
        request = prepareRasterScene('world', data, 128, 96, true).request,
        a = await native.raster3D(request),
        b = rasterize3D(request);
      expect(a.backend).toBe('rust');
      expect(a.faceIds).toEqual(b.faceIds);
      expect(a.depth).toEqual(b.depth);
      let maximum = 0;
      for (let i = 0; i < a.pixels.length; i++)
        maximum = Math.max(maximum, Math.abs(a.pixels[i] - b.pixels[i]));
      expect(maximum).toBeLessThanOrEqual(1);
      expect(a.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    }
  } finally {
    native.close();
  }
});
it('rejects invalid materials and keeps double-sided unlit back faces visible', () => {
  expect(() => standardMaterial({ roughness: 0 })).toThrow();
  const mesh = {
    vertices: [
      { x: -1, y: -1, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: -1, z: 0 },
    ],
    faces: [[0, 1, 2]],
  };
  expect(evaluateScene3D('w', [{ id: 'p', mesh }], camera).faces).toHaveLength(0);
  expect(
    evaluateScene3D(
      'w',
      [{ id: 'p', mesh, material: standardMaterial({ model: 'unlit', doubleSided: true }) }],
      camera,
    ).faces,
  ).toHaveLength(1);
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-material-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('persists material controls, animates roughness/exposure and preserves preview/export pixel identity', async () => {
  const node = scene3DLayer(
    'material-world',
    [
      {
        id: 'sphere',
        mesh: sphereMesh(1, { widthSegments: 12, heightSegments: 6 }),
        material: standardMaterial({ roughness: 0.2, metallic: 0.5, color: '#c3dbff' }),
      },
    ],
    camera,
    {
      lights: [{ type: 'directional', direction: { x: 0, y: 0, z: 1 }, intensity: 2 }],
      exposure: 1,
    },
  );
  node.animations = [
    {
      property: 'scene3d.instances.0.material.roughness',
      keys: [
        { frame: 0, value: 0.2, easing: 'linear' },
        { frame: 10, value: 1, easing: 'linear' },
      ],
    },
    {
      property: 'scene3d.options.exposure',
      keys: [
        { frame: 0, value: 1, easing: 'linear' },
        { frame: 10, value: 0.5, easing: 'linear' },
      ],
    },
  ];
  await app.service.transact([
    { type: 'updateProject', patch: { width: 128, height: 96 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { nodes: [node], background: 'transparent', duration: 11 },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 11,
        markers: [],
        tracks: [
          {
            id: 'v',
            name: 'Material',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'clip',
                sceneId: 'intro',
                start: 0,
                duration: 11,
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
  const first = await app.frame({ frame: 0 }),
    end = await app.frame({ frame: 10 });
  expect(first.buffer.equals(end.buffer)).toBe(false);
  const middle = await app.frame({ frame: 5 });
  await app.frame({ frame: 0 });
  expect((await app.frame({ frame: 5 })).buffer.equals(middle.buffer)).toBe(true);
  const output = path.join(root, 'exports/png'),
    job = app.renders.start(app.service.snapshot, { output, format: 'png', start: 5, end: 6 }),
    done = await app.renders.wait(job.id);
  expect(done.status, done.error).toBe('completed');
  expect((await readFile(path.join(output, 'frame-00000005.png'))).equals(middle.buffer)).toBe(
    true,
  );
}, 30000);
it('plans compact material edits by instance ID, preserves mesh resources and updates an existing numeric key', async () => {
  const mesh = await app.dispatch('meshGenerate', {
    primitive: { kind: 'sphere', widthSegments: 12, heightSegments: 6 },
    place: { sceneId: 'intro', nodeId: 'sphere-layer' },
  });
  await app.dispatch('projectApply', mesh.apply);
  const before = app.service.snapshot.revision,
    source = app.service.snapshot.files[mesh.file],
    plan = await app.dispatch('scene3dMaterials', {
      sceneId: 'intro',
      nodeId: 'sphere-layer',
      updates: [
        { instanceId: 'model', patch: { color: '#cc8833', metallic: 0.9, roughness: 0.2 } },
      ],
      options: {
        exposure: 1,
        lights: [{ type: 'directional', direction: { x: 0, y: 0, z: 1 }, intensity: 3 }],
      },
    });
  expect(app.service.snapshot.revision).toBe(before);
  expect(field(present(field(plan, 'candidate')), 'planId')).toHaveLength(64);
  expect(JSON.stringify(plan)).not.toContain('vertices');
  const checked = await app.dispatch('projectPreflight', field(plan, 'candidate'));
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', field(plan, 'apply'));
  expect(app.service.snapshot.files[mesh.file]).toBe(source);
  const info = await app.dispatch('scene3dMaterials', { sceneId: 'intro', nodeId: 'sphere-layer' });
  expect(present(present(present(info)).instances[0].material).metallic).toBe(0.9);
  await app.dispatch('animationEdit', {
    sceneId: 'intro',
    edits: [
      {
        nodeId: 'sphere-layer',
        actions: [
          {
            type: 'upsert',
            property: 'scene3d.instances.0.material.roughness',
            keys: [
              { frame: 0, value: 0.2, easing: 'linear' },
              { frame: 60, value: 0.8, easing: 'linear' },
            ],
          },
        ],
      },
    ],
  });
  const keyed = await app.dispatch('scene3dMaterials', {
    sceneId: 'intro',
    nodeId: 'sphere-layer',
    frame: 30,
    updates: [{ instanceId: 'model', patch: { roughness: 0.6 } }],
  });
  await app.dispatch('projectApply', field(keyed, 'apply'));
  const node = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'sphere-layer')!;
  expect(
    node.animations.find((a) => a.property.endsWith('roughness'))!.keys.map((k) => k.frame),
  ).toEqual([0, 30, 60]);
  expect(
    present(
      present(
        present(
          await app.dispatch('scene3dMaterials', {
            sceneId: 'intro',
            nodeId: 'sphere-layer',
            frame: 30,
          }),
        ),
      ).instances[0].material,
    ).roughness,
  ).toBe(0.6);
}, 30000);
it('plans material reset and rejects light-array replacement that would silently orphan its keys', async () => {
  const node = scene3DLayer(
    'world',
    [{ id: 'box', mesh: cubeMesh(), material: standardMaterial() }],
    camera,
    { lights: [{ type: 'point', position: { x: 2, y: 2, z: 4 }, intensity: 5 }] },
  );
  node.animations = [
    {
      property: 'scene3d.instances.0.material.metallic',
      keys: [
        { frame: 0, value: 0, easing: 'linear' },
        { frame: 60, value: 1, easing: 'linear' },
      ],
    },
    {
      property: 'scene3d.options.lights.0.intensity',
      keys: [
        { frame: 0, value: 5, easing: 'linear' },
        { frame: 60, value: 10, easing: 'linear' },
      ],
    },
  ];
  await app.service.transact([{ type: 'updateScene', sceneId: 'intro', patch: { nodes: [node] } }]);
  await expect(
    app.dispatch('scene3dMaterials', {
      sceneId: 'intro',
      nodeId: 'world',
      options: { lights: [] },
    }),
  ).rejects.toThrow('resetLightKeys');
  const plan = await app.dispatch('scene3dMaterials', {
    sceneId: 'intro',
    nodeId: 'world',
    updates: [{ instanceId: 'box', reset: true }],
    options: { lights: [] },
    resetLightKeys: true,
  });
  await app.dispatch('projectApply', field(plan, 'apply'));
  expect(app.service.snapshot.scenes[0].nodes[0].animations).toHaveLength(0);
  expect(app.service.snapshot.scenes[0].nodes[0].scene3d!.instances[0].material).toBeUndefined();
}, 30000);
