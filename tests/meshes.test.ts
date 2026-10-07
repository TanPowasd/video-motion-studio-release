import { present, field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  sphereMesh,
  cylinderMesh,
  coneMesh,
  torusMesh,
  planeMesh,
  surfaceMesh,
  inspectMesh,
  normalizeMesh,
  transformMesh,
} from '../src/sdk/meshes.js';
import { cubeMesh } from '../src/sdk/matrix3d.js';
import { parseOBJ } from '../src/sdk/obj.js';
import { meshDocumentSchema } from '../src/core/mesh-document.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { hash } from '../src/service/project.js';
import { prepareRasterScene, rasterize3D } from '../src/core/raster3d.js';
import { scene3dSchema } from '../src/core/scene3d-schema.js';
const concave =
  'o L-shape\ng silhouette\nusemtl coral\nv 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\nf -6 -5 -4 -3 -2 -1\n';
it('generates closed outward solids, correct seams and predictable tessellation budgets', () => {
  for (const mesh of [sphereMesh(), cylinderMesh(), coneMesh(), torusMesh()]) {
    const report = inspectMesh(mesh);
    expect(report.topology.closed).toBe(true);
    expect(report.signedVolume).toBeGreaterThan(0);
    expect(report.topology.degenerateFaces).toBe(0);
    for (const face of report.faceDetails) expect(face.area).toBeGreaterThan(0);
  }
  const box = inspectMesh(cubeMesh(2));
  expect(box.area).toBeCloseTo(24);
  expect(box.signedVolume).toBeCloseTo(8);
  expect(sphereMesh(1, { widthSegments: 8, heightSegments: 4 }).faces).toHaveLength(48);
  expect(() => sphereMesh(1, { widthSegments: 128, heightSegments: 128 })).toThrow('5000');
});
it('supports mathematical surfaces and winding-preserving baked reflection/normalization', () => {
  const mesh = surfaceMesh((x, z) => Math.sin(x) * Math.cos(z), {
      widthSegments: 8,
      depthSegments: 4,
    }),
    report = inspectMesh(mesh);
  expect(report.faces).toBe(64);
  expect(report.topology.boundaryEdges).toBe(24);
  expect(report.faceDetails.every((f) => f.normal.y > 0)).toBe(true);
  const normalized = inspectMesh(
    normalizeMesh(
      transformMesh(cubeMesh(2), {
        position: { x: 100, y: -20, z: 9 },
        scale: { x: 2, y: 1, z: 0.5 },
      }),
      2,
    ),
  );
  expect(normalized.bounds.center).toEqual({ x: 0, y: 0, z: 0 });
  expect(normalized.bounds.size.x).toBeCloseTo(2);
  expect(
    inspectMesh(transformMesh(cubeMesh(2), { scale: { x: -1, y: 1, z: 1 } })).signedVolume,
  ).toBeCloseTo(8);
  expect(() => surfaceMesh(() => NaN)).toThrow('finite');
});
it('triangulates a concave OBJ without filling its notch and preserves negative indices/groups/colors', () => {
  const doc = parseOBJ(concave, { materials: { coral: '#ff8869' } });
  expect(doc.mesh.faces).toHaveLength(4);
  expect(inspectMesh(doc.mesh).area).toBeCloseTo(3);
  expect(doc.mesh.colors).toEqual(Array(4).fill('#ff8869'));
  expect(doc.groups[0]).toMatchObject({
    object: 'L-shape',
    names: ['silhouette'],
    material: 'coral',
    faces: [0, 1, 2, 3],
  });
  expect(meshDocumentSchema.safeParse(doc).success).toBe(true);
});
it('preserves the empty notch of a U-shaped OBJ when rasterized', () => {
  const text =
      'v 0 0 0\nv 3 0 0\nv 3 3 0\nv 2 3 0\nv 2 1 0\nv 1 1 0\nv 1 3 0\nv 0 3 0\nf 1 2 3 4 5 6 7 8',
    doc = parseOBJ(text);
  expect(inspectMesh(doc.mesh).area).toBeCloseTo(7);
  const data = scene3dSchema.parse({
      camera: {
        position: { x: 1.5, y: 1.5, z: 5 },
        target: { x: 1.5, y: 1.5, z: 0 },
        width: 100,
        height: 100,
        projection: 'orthographic',
        orthographicHeight: 4,
      },
      instances: [{ id: 'model', mesh: doc.mesh }],
      options: { ambient: 1 },
      samples: 1,
    }),
    image = rasterize3D(prepareRasterScene('world', data, 100, 100).request);
  expect(image.pixels[(38 * 100 + 50) * 4 + 3]).toBe(0);
  expect(image.pixels[(38 * 100 + 25) * 4 + 3]).toBe(255);
  expect(image.pixels[(75 * 100 + 50) * 4 + 3]).toBe(255);
});
it('selects groups, compacts positions, preserves UV/normal corners and rejects source-index errors with locations', () => {
  const text =
    'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 9 9 9\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\ng kept\nf 1/1/1 2/2/1 3/3/1\ng omitted\nf 1 2 4';
  const doc = parseOBJ(text, { groups: ['kept'] });
  expect(doc.mesh.vertices).toHaveLength(3);
  expect(doc.attributes?.faceTexcoords).toEqual([[0, 1, 2]]);
  expect(doc.attributes?.faceNormals).toEqual([[0, 0, 0]]);
  expect(doc.warnings.length).toBeGreaterThan(0);
  try {
    parseOBJ('v 0 0 0\nf 1 2 3');
    throw new Error('Expected index error');
  } catch (e) {
    expect((e as any).code).toBe('OBJ_INDEX');
    expect((e as any).details.line).toBe(2);
  }
  expect(() => parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 1\nv 0 1 0\nf 1 2 3 4')).toThrow('planar');
  expect(() => parseOBJ(concave, { groups: ['missing'] })).toThrow('No supported faces');
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-mesh-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans/stores/imports/places a resource atomically and renders its pinned mesh data rather than changed disk bytes', async () => {
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('meshImport', {
      text: concave,
      materials: { coral: '#ff8869' },
      normalizeSize: 2,
      place: { sceneId: 'intro', nodeId: 'obj-model', color: '#ffffff', ambient: 1 },
    });
  expect(app.service.snapshot.revision).toBe(before);
  expect(field(plan.candidate, 'planId')).toHaveLength(64);
  expect(field(plan.candidate, 'operations')).toBeUndefined();
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  expect(checked.samples).toHaveLength(1);
  expect(checked.candidateRevision).toBe(plan.candidateRevision);
  await app.dispatch('projectApply', plan.apply);
  const node = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'obj-model')!;
  expect(node.scene3d!.instances[0].meshSource).toBe(plan.file);
  expect(node.scene3d!.instances[0].mesh).toBeUndefined();
  const image = await app.frame({ frame: 90, width: 320, height: 180 });
  const evidence = await app.dispatch('scene3dRender', {
    source: { sceneId: 'intro', nodeId: 'obj-model' },
    width: 320,
  });
  expect(evidence.backend).toBe('rust');
  expect(evidence.visiblePixels).toBeGreaterThan(100);
  const inspection = await app.dispatch('meshInspect', { source: { file: plan.file }, limit: 2 });
  expect(inspection.facePage.items).toHaveLength(2);
  expect(inspection.summary.area).toBeCloseTo(3);
  await writeFile(path.join(root, plan.file), '{}');
  expect(
    (await app.frame({ frame: 90, width: 320, height: 180 })).buffer.equals(image.buffer),
  ).toBe(true);
  await writeFile(path.join(root, plan.file), app.service.snapshot.files[plan.file]);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.scenes[0].nodes.some((n) => n.id === 'obj-model')).toBe(false);
  await expect(readFile(path.join(root, plan.file))).rejects.toThrow();
}, 30000);
it('shared resource edits update every instance, reject invalid/missing references and preserve random-frame evaluation', async () => {
  const plan = await app.dispatch('meshGenerate', {
    primitive: { kind: 'sphere', widthSegments: 8, heightSegments: 4 },
    file: 'components/meshes/shared.json',
    place: { sceneId: 'intro', nodeId: 'sphere' },
  });
  await app.dispatch('projectApply', plan.apply);
  const originalNode = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'sphere')!;
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { ...structuredClone(originalNode), id: 'sphere-copy', x: 500 },
    },
  ]);
  const revision = app.service.snapshot.revision,
    source = app.service.snapshot.files[plan.file],
    doc = JSON.parse(source);
  const first = await app.frame({ frame: 90, width: 320, height: 180 });
  const beforeCopy = await app.dispatch('scene3dRender', {
    source: { sceneId: 'intro', nodeId: 'sphere-copy' },
    width: 160,
    inline: true,
  });
  doc.mesh.colors = Array(doc.mesh.faces.length).fill('#ff0000');
  await app.dispatch('projectApply', {
    revision,
    files: [
      {
        type: 'replace',
        path: plan.file,
        expectedHash: hash(source),
        content: JSON.stringify(doc),
      },
    ],
  });
  expect(
    (await app.frame({ frame: 90, width: 320, height: 180 })).buffer.equals(first.buffer),
  ).toBe(false);
  const afterCopy = await app.dispatch('scene3dRender', {
    source: { sceneId: 'intro', nodeId: 'sphere-copy' },
    width: 160,
    inline: true,
  });
  expect(afterCopy.images[0].data).not.toBe(beforeCopy.images[0].data);
  const changed = app.service.snapshot.revision;
  await expect(
    app.dispatch('projectApply', {
      revision: changed,
      files: [
        {
          type: 'delete',
          path: plan.file,
          expectedHash: hash(app.service.snapshot.files[plan.file]),
        },
      ],
    }),
  ).rejects.toThrow('no project changes saved');
  expect(app.service.snapshot.revision).toBe(changed);
  const stable = await app.frame({ frame: 20, width: 320, height: 180 });
  await app.frame({ frame: 0, width: 320, height: 180 });
  expect(
    (await app.frame({ frame: 20, width: 320, height: 180 })).buffer.equals(stable.buffer),
  ).toBe(true);
}, 30000);
it('checks plan integrity/immutability, source hash and candidate revision without committing changed data', async () => {
  const revision = app.service.snapshot.revision,
    plan = await app.dispatch('meshGenerate', { primitive: { kind: 'torus' } });
  await expect(
    app.dispatch('projectPreflight', { ...plan.candidate, operations: [] }),
  ).rejects.toThrow('Do not replace');
  await writeFile(present(present(present(plan)).plan).file, '{}');
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toThrow('content check');
  await expect(
    app.dispatch('meshImport', { text: concave, sourceHash: '0'.repeat(64) }),
  ).rejects.toThrow('changed');
  expect(app.service.snapshot.revision).toBe(revision);
  const inline = await app.dispatch('meshGenerate', {
    primitive: { kind: 'box' },
    delivery: 'inline',
  });
  expect(field(inline.candidate, 'operations')).toHaveLength(1);
  expect(inline.plan).toBeUndefined();
});
it('pins exact OBJ bytes including a BOM, and rejects invalid encoding without project changes', async () => {
  const file = path.join(root, 'source.obj'),
    bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(concave)]);
  await writeFile(file, bytes);
  const plan = await app.dispatch('meshImport', { path: file, sourceHash: hash(bytes) });
  expect(plan.sourceHash).toBe(hash(bytes));
  const before = app.service.snapshot.revision;
  await writeFile(file, Buffer.from([255, 254, 253]));
  await expect(app.dispatch('meshImport', { path: file })).rejects.toThrow('UTF-8');
  expect(app.service.snapshot.revision).toBe(before);
});
it('checks mesh resources declared inside persisted component structure before allowing deletion', async () => {
  const plan = await app.dispatch('meshGenerate', {
    primitive: { kind: 'sphere', widthSegments: 8, heightSegments: 4 },
    place: { sceneId: 'intro', path: ['wave'], nodeId: 'in-component' },
  });
  await app.dispatch('projectApply', plan.apply);
  const revision = app.service.snapshot.revision;
  expect(
    app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'wave')!.structure!.added[0].scene3d!
      .instances[0].meshSource,
  ).toBe(plan.file);
  await expect(
    app.dispatch('projectApply', {
      files: [
        {
          type: 'delete',
          path: plan.file,
          expectedHash: hash(app.service.snapshot.files[plan.file]),
        },
      ],
    }),
  ).rejects.toThrow('no project changes saved');
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
it('collects resource-referenced geometry into a portable project without requiring the original OBJ', async () => {
  const plan = await app.dispatch('meshImport', {
    text: concave,
    place: { sceneId: 'intro', nodeId: 'packed-model' },
  });
  await app.dispatch('projectApply', plan.apply);
  const frame = await app.frame({ frame: 90, width: 320, height: 180 }),
    target = path.join(root, 'exports/packed');
  await app.dispatch('pack', { output: target });
  const packed = await new Application(target).open(false);
  try {
    expect(
      (await packed.frame({ frame: 90, width: 320, height: 180 })).buffer.equals(frame.buffer),
    ).toBe(true);
    expect(packed.service.snapshot.files[plan.file]).toBe(app.service.snapshot.files[plan.file]);
  } finally {
    await packed.close();
  }
}, 30000);
