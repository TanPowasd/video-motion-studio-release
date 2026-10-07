import { it, expect } from 'vitest';
import {
  mat4Identity,
  mat4Compose,
  mat4Multiply,
  mat4Inverse,
  prepareCamera3D,
  evaluateScene3D,
  scene3D,
  cubeMesh,
  type Camera3D,
} from '../src/sdk/matrix3d.js';
import { project3D } from '../src/sdk/effects.js';
import { matrix3d } from '../src/service/matrix3d.js';
const camera: Camera3D = {
  position: { x: 0, y: 0, z: 5 },
  target: { x: 0, y: 0, z: 0 },
  width: 200,
  height: 100,
  fov: 90,
  near: 1,
  far: 20,
};
it('keeps outward face culling and lighting when an instance is mirrored by a negative scale', () => {
  const mesh = cubeMesh(),
    normal = evaluateScene3D('world', [{ id: 'cube', mesh }], camera),
    mirrored = evaluateScene3D(
      'world',
      [{ id: 'cube', mesh, transform: { scale: { x: -1, y: 1, z: 1 } } }],
      camera,
    );
  expect(normal.faces.map((f) => f.face)).toEqual([1]);
  expect(mirrored.faces.map((f) => f.face)).toEqual([1]);
  expect(mirrored.faces[0].fill).toBe(normal.faces[0].fill);
});
it('composes 4x4 TRS/pivot matrices and inverts them without mixing row/column conventions', () => {
  const model = mat4Compose({
      position: { x: 2, y: 3, z: 4 },
      rotation: { x: 0, y: 0, z: 90 },
      scale: { x: 2, y: 3, z: 4 },
    }),
    expected = [0, -3, 0, 2, 2, 0, 0, 3, 0, 0, 4, 4, 0, 0, 0, 1];
  model.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));
  mat4Multiply(model, mat4Inverse(model)).forEach((v, i) =>
    expect(v).toBeCloseTo(mat4Identity()[i], 10),
  );
  const pivot = mat4Compose({
    position: { x: 7, y: 8, z: 9 },
    pivot: { x: 1, y: 2, z: 3 },
    rotation: { x: 23, y: 17, z: 61 },
    scale: { x: 2, y: 3, z: 4 },
  });
  for (let i = 0; i < 3; i++)
    expect(
      pivot[i * 4] + 2 * pivot[i * 4 + 1] + 3 * pivot[i * 4 + 2] + pivot[i * 4 + 3],
    ).toBeCloseTo([7, 8, 9][i]);
});
it('uses prepared camera matrices for batch perspective/orthographic projection and immutable camera state', () => {
  const config = structuredClone(camera),
    prepared = prepareCamera3D(config);
  config.position.z = 100;
  config.width = 1000;
  const result = prepared.projectPoints([
    { x: 1, y: 1, z: 0 },
    { x: 1, y: 1, z: 3 },
    { x: 0, y: 0, z: 6 },
  ]);
  expect(result[0].x).toBeCloseTo(110);
  expect(result[0].y).toBeCloseTo(40);
  expect(result[1].x).toBeCloseTo(125);
  expect(result[1].depth).toBe(2);
  expect(result[2].visible).toBe(false);
  const ortho = prepareCamera3D({ ...camera, projection: 'orthographic', orthographicHeight: 10 }),
    points = ortho.projectPoints([
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 1, z: 3 },
    ]);
  expect(points[0].x).toBe(points[1].x);
  expect(points[0].y).toBe(points[1].y);
  expect(project3D({ x: 1, y: 1, z: 0 }, camera).x).toBeCloseTo(result[0].x);
  expect(project3D({ x: 100, y: 0, z: 0 }, camera).visible).toBe(true);
  expect(prepared.project({ x: 100, y: 0, z: 0 }).visible).toBe(false);
});
it('clips faces crossing the near and side planes instead of dropping partially visible triangles', () => {
  const evaluated = evaluateScene3D(
    'world',
    [
      {
        id: 'triangle',
        mesh: {
          vertices: [
            { x: -0.5, y: -0.5, z: -0.5 },
            { x: 0.5, y: -0.5, z: -2 },
            { x: 0, y: 0.5, z: -2 },
          ],
          faces: [[0, 1, 2]],
        },
      },
    ],
    { ...camera, position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 } },
  );
  expect(evaluated.stats.visibleFaces).toBe(1);
  expect(evaluated.stats.clippedFaces).toBe(1);
  expect(evaluated.faces[0].points).toHaveLength(4);
  expect(evaluated.faces[0].depth).toBeGreaterThanOrEqual(1);
  for (const p of evaluated.faces[0].points) {
    expect(p.x).toBeGreaterThanOrEqual(-1e-9);
    expect(p.x).toBeLessThanOrEqual(200 + 1e-9);
    expect(p.y).toBeGreaterThanOrEqual(-1e-9);
    expect(p.y).toBeLessThanOrEqual(100 + 1e-9);
  }
});
it('shares parent matrices, culls back faces and sorts all object faces globally with stable IDs', () => {
  const mesh = cubeMesh(2),
    instances = [
      {
        id: 'parent',
        mesh: { vertices: [], faces: [] },
        transform: { position: { x: 2, y: 0, z: 0 } },
      },
      {
        id: 'near',
        parentId: 'parent',
        mesh,
        transform: { position: { x: -2, y: 0, z: 1 } },
        color: '#ffffff',
      },
      { id: 'far', mesh, transform: { position: { x: 0, y: 0, z: -2 } }, color: '#ffffff' },
    ],
    result = evaluateScene3D('world', instances, camera);
  expect(result.stats.visibleFaces).toBe(2);
  expect(result.faces.map((f) => f.instanceId)).toEqual(['far', 'near']);
  expect(result.matrices.models.near[3]).toBe(0);
  expect(result.faces[0].id).toBe('world/far/face-1');
  expect(scene3D('world', instances, camera)).toEqual(result.nodes);
  const rotated = evaluateScene3D('world', [{ id: 'box', mesh }], {
    ...camera,
    position: { x: 5, y: 3, z: 6 },
  });
  expect(rotated.stats.visibleFaces).toBe(3);
});
it('rejects bad camera bases, missing parents, cycles, invalid indices and ambiguous transforms', () => {
  expect(() => prepareCamera3D({ ...camera, target: camera.position })).toThrow(
    'independent basis',
  );
  expect(() => prepareCamera3D({ ...camera, up: { x: 0, y: 0, z: 1 } })).toThrow(
    'independent basis',
  );
  expect(() =>
    evaluateScene3D('w', [{ id: 'a', parentId: 'absent', mesh: cubeMesh() }], camera),
  ).toThrow('does not exist');
  expect(() =>
    evaluateScene3D(
      'w',
      [
        { id: 'a', parentId: 'b', mesh: cubeMesh() },
        { id: 'b', parentId: 'a', mesh: cubeMesh() },
      ],
      camera,
    ),
  ).toThrow('cyclic');
  expect(() =>
    evaluateScene3D(
      'w',
      [{ id: 'a', mesh: { vertices: [{ x: 0, y: 0, z: 0 }], faces: [[0, 1, 2]] } }],
      camera,
    ),
  ).toThrow('indices');
  expect(() =>
    evaluateScene3D(
      'w',
      [{ id: 'a', mesh: cubeMesh(), matrix: mat4Identity(), transform: {} }],
      camera,
    ),
  ).toThrow('matrix or');
});
it('returns bounded agent evidence for mesh geometry and model/view/projection matrices', () => {
  const result: any = matrix3d({
    operation: 'scene',
    camera,
    instances: [{ id: 'cube', mesh: cubeMesh() }],
    includeGeometry: true,
    includeNodes: true,
    limit: 1,
  });
  expect(result.result.stats.visibleFaces).toBe(1);
  expect(result.result.nodes[0].type).toBe('path');
  expect(result.result.matrices.viewProjection).toHaveLength(16);
  expect(result.result.faces[0].points).toHaveLength(4);
});
