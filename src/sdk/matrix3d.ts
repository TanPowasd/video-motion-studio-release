import { newNode, VmotionError, type Node } from '../core/model.js';
import { matrixInverse } from './linear-algebra.js';
import { scene3dSchema, type Scene3DData } from '../core/scene3d-schema.js';
import {
  material3dSchema,
  light3dSchema,
  type Material3D,
  type ResolvedMaterial3D,
  type Light3D,
} from '../core/material3d-schema.js';
import { cornerNormals } from './normals3d.js';

export type Mat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Transform3D {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  pivot?: Vec3;
}
export interface Camera3D {
  position: Vec3;
  target: Vec3;
  up?: Vec3;
  width: number;
  height: number;
  fov?: number;
  near?: number;
  far?: number;
  projection?: 'perspective' | 'orthographic';
  orthographicHeight?: number;
}
const vec = (v: Vec3) => {
  if (![v.x, v.y, v.z].every(Number.isFinite))
    throw new VmotionError('MATRIX3D_NONFINITE', '3D coordinates must be finite');
  return v;
};
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(length) || length < 1e-12)
    throw new VmotionError(
      'CAMERA3D_BASIS',
      'Camera position/target and up direction must define an independent basis',
    );
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
function checked(m: Mat4): Mat4 {
  if (m.length !== 16 || !m.every(Number.isFinite))
    throw new VmotionError('MATRIX3D_SHAPE', 'Expected 16 finite row-major matrix coefficients');
  return m;
}
export const mat4Identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  checked(a);
  checked(b);
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 4; j++) out[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return checked(out as unknown as Mat4);
}
export function mat4Inverse(a: Mat4): Mat4 {
  checked(a);
  return checked(
    matrixInverse(
      Array.from({ length: 4 }, (_, i) => a.slice(i * 4, i * 4 + 4)),
    ).flat() as unknown as Mat4,
  );
}
export function mat4Compose(options: Transform3D = {}): Mat4 {
  const p = vec(options.position ?? { x: 0, y: 0, z: 0 }),
    r = vec(options.rotation ?? { x: 0, y: 0, z: 0 }),
    s = vec(options.scale ?? { x: 1, y: 1, z: 1 }),
    pivot = vec(options.pivot ?? { x: 0, y: 0, z: 0 }),
    [rx, ry, rz] = [r.x, r.y, r.z].map((v) => ((v % 360) * Math.PI) / 180),
    [cx, cy, cz] = [rx, ry, rz].map(Math.cos),
    [sx, sy, sz] = [rx, ry, rz].map(Math.sin);
  const rotation: Mat4 = [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    0,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    0,
    -sy,
    cy * sx,
    cy * cx,
    0,
    0,
    0,
    0,
    1,
  ];
  const out = [...rotation];
  for (let i = 0; i < 3; i++) {
    out[i * 4] *= s.x;
    out[i * 4 + 1] *= s.y;
    out[i * 4 + 2] *= s.z;
    out[i * 4 + 3] =
      [p.x, p.y, p.z][i] -
      out[i * 4] * pivot.x -
      out[i * 4 + 1] * pivot.y -
      out[i * 4 + 2] * pivot.z;
  }
  return checked(out as unknown as Mat4);
}
export function mat4LookAt(position: Vec3, target: Vec3, up?: Vec3): Mat4 {
  vec(position);
  vec(target);
  if (up) vec(up);
  const forward = normalize(sub(target, position)),
    preferred = up ?? (Math.abs(forward.y) > 0.999 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }),
    right = normalize(cross(forward, preferred)),
    vertical = cross(right, forward);
  return [
    right.x,
    right.y,
    right.z,
    -dot(right, position),
    vertical.x,
    vertical.y,
    vertical.z,
    -dot(vertical, position),
    -forward.x,
    -forward.y,
    -forward.z,
    dot(forward, position),
    0,
    0,
    0,
    1,
  ];
}
export function mat4Perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
  if (
    ![fov, aspect, near, far].every(Number.isFinite) ||
    fov <= 0 ||
    fov >= 179 ||
    aspect <= 0 ||
    near <= 0 ||
    far <= near
  )
    throw new VmotionError(
      'CAMERA3D_RANGE',
      'Use FOV (0,179), positive aspect/near and far > near',
    );
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    (2 * far * near) / (near - far),
    0,
    0,
    -1,
    0,
  ];
}
export function mat4Orthographic(width: number, height: number, near: number, far: number): Mat4 {
  if (
    ![width, height, near, far].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    near <= 0 ||
    far <= near
  )
    throw new VmotionError(
      'CAMERA3D_RANGE',
      'Orthographic dimensions/near must be positive and far > near',
    );
  return [
    2 / width,
    0,
    0,
    0,
    0,
    2 / height,
    0,
    0,
    0,
    0,
    -2 / (far - near),
    -(far + near) / (far - near),
    0,
    0,
    0,
    1,
  ];
}
export interface Projected3D {
  x: number;
  y: number;
  depth: number;
  scale: number;
  visible: boolean;
  clip: [number, number, number, number];
}
const homogeneous = (m: Mat4, p: Vec3): [number, number, number, number] => [
  m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
  m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
  m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15],
];
/** Prepare camera once per frame; combine model/view/projection once per object, never per vertex. */
export function prepareCamera3D(camera: Camera3D) {
  if (
    ![camera.width, camera.height].every(Number.isFinite) ||
    camera.width <= 0 ||
    camera.height <= 0
  )
    throw new VmotionError('CAMERA3D_RANGE', 'Viewport dimensions must be positive');
  const near = camera.near ?? 0.1,
    far = camera.far ?? 10000,
    fov = camera.fov ?? 50,
    view = mat4LookAt(camera.position, camera.target, camera.up),
    aspect = camera.width / camera.height,
    projection =
      camera.projection === 'orthographic'
        ? mat4Orthographic(
            (camera.orthographicHeight ?? 10) * aspect,
            camera.orthographicHeight ?? 10,
            near,
            far,
          )
        : mat4Perspective(fov, aspect, near, far),
    viewProjection = mat4Multiply(projection, view),
    focal = (camera.height * projection[5]) / 2;
  // Copy scalar state: callers can mutate their camera after preparation without changing results.
  const width = camera.width,
    height = camera.height,
    orthographic = camera.projection === 'orthographic';
  const projectPoints = (points: readonly Vec3[], model: Mat4 = mat4Identity()): Projected3D[] => {
    if (points.length > 100000)
      throw new VmotionError('MESH3D_LIMIT', 'At most 100000 vertices per batch');
    const mv = mat4Multiply(view, model),
      mvp = mat4Multiply(projection, mv);
    return points.map((point) => {
      vec(point);
      const clip = homogeneous(mvp, point),
        depth = -(mv[8] * point.x + mv[9] * point.y + mv[10] * point.z + mv[11]),
        w = clip[3],
        denominator = w || 1;
      if (!clip.every(Number.isFinite) || !Number.isFinite(depth))
        throw new VmotionError('MATRIX3D_NONFINITE', 'Projection overflow');
      const x = width / 2 + ((clip[0] / denominator) * width) / 2,
        y = height / 2 - ((clip[1] / denominator) * height) / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new VmotionError('MATRIX3D_NONFINITE', 'Screen coordinate overflow');
      return {
        x,
        y,
        depth,
        scale: orthographic ? focal : focal / Math.max(depth, 1e-8),
        visible:
          w > 0 && Math.abs(clip[0]) <= w && Math.abs(clip[1]) <= w && Math.abs(clip[2]) <= w,
        clip,
      };
    });
  };
  return {
    view,
    projection,
    viewProjection,
    width,
    height,
    near,
    far,
    projectPoints,
    project: (point: Vec3, model?: Mat4) => projectPoints([point], model)[0],
  };
}

export interface Mesh3D {
  vertices: readonly Vec3[];
  faces: readonly (readonly number[])[];
  colors?: readonly string[];
  cornerNormals?: readonly (readonly (Vec3 | null)[])[];
}
export interface MeshInstance3D {
  id: string;
  mesh?: Mesh3D;
  meshSource?: string;
  parentId?: string;
  transform?: Transform3D;
  matrix?: Mat4;
  color?: string;
  material?: Material3D;
}
export interface Scene3DOptions {
  cullBackfaces?: boolean;
  light?: Vec3;
  ambient?: number;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  lights?: Light3D[];
  exposure?: number;
  toneMapping?: 'none' | 'reinhard' | 'aces';
}
interface ClipVertex {
  clip: [number, number, number, number];
  depth: number;
  world?: Vec3;
  normal?: Vec3;
}
function clipFace(input: ClipVertex[]) {
  let polygon = input;
  for (const plane of [0, 1, 2, 3, 4, 5]) {
    const axis = Math.floor(plane / 2),
      sign = plane % 2 ? -1 : 1,
      old = polygon;
    polygon = [];
    if (!old.length) break;
    const distance = (v: ClipVertex) => v.clip[3] + sign * v.clip[axis];
    for (let i = 0; i < old.length; i++) {
      const a = old[i],
        b = old[(i + 1) % old.length],
        da = distance(a),
        db = distance(b);
      if (da >= 0) polygon.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        polygon.push({
          clip: a.clip.map((v, j) => v + t * (b.clip[j] - v)) as ClipVertex['clip'],
          depth: a.depth + t * (b.depth - a.depth),
          ...(a.world && b.world
            ? {
                world: {
                  x: a.world.x + t * (b.world.x - a.world.x),
                  y: a.world.y + t * (b.world.y - a.world.y),
                  z: a.world.z + t * (b.world.z - a.world.z),
                },
              }
            : {}),
          ...(a.normal && b.normal
            ? {
                normal: {
                  x: a.normal.x + t * (b.normal.x - a.normal.x),
                  y: a.normal.y + t * (b.normal.y - a.normal.y),
                  z: a.normal.z + t * (b.normal.z - a.normal.z),
                },
              }
            : {}),
        });
      }
    }
  }
  return polygon;
}
function shade(color: string, amount: number) {
  if (!/^#[\da-f]{6}$/i.test(color))
    throw new VmotionError('MESH3D_COLOR', 'Mesh colors must be #RRGGBB');
  return (
    '#' +
    [1, 3, 5]
      .map((i) =>
        Math.round(parseInt(color.slice(i, i + 2), 16) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function evaluateScene3D(
  id: string,
  instances: readonly MeshInstance3D[],
  camera: Camera3D,
  options: Scene3DOptions = {},
) {
  if (
    !id ||
    instances.length > 1000 ||
    new Set(instances.map((o) => o.id)).size !== instances.length ||
    instances.some((o) => !o.id)
  )
    throw new VmotionError('SCENE3D_IDS', 'Use unique nonempty instance IDs, up to 1000 objects');
  const prepared = prepareCamera3D(camera),
    byId = new Map(instances.map((o) => [o.id, o])),
    models = new Map<string, Mat4>(),
    visiting = new Set<string>(),
    light = normalize(vec(options.light ?? { x: -0.4, y: 0.8, z: 1 })),
    ambient = options.ambient ?? 0.3;
  if (options.lights)
    options.lights.forEach((light) => {
      const parsed = light3dSchema.parse(light);
      if (parsed.type === 'directional') normalize(parsed.direction);
    });
  if (
    options.exposure !== undefined &&
    (!Number.isFinite(options.exposure) || options.exposure < 0.01 || options.exposure > 16)
  )
    throw new VmotionError('SCENE3D_EXPOSURE', 'Exposure must be .01–16');
  if (!Number.isFinite(ambient) || ambient < 0 || ambient > 1)
    throw new VmotionError('SCENE3D_LIGHT', 'Ambient must be 0–1');
  if (
    options.opacity !== undefined &&
    (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1)
  )
    throw new VmotionError('SCENE3D_OPACITY', 'Opacity must be 0–1');
  if (
    options.strokeWidth !== undefined &&
    (!Number.isFinite(options.strokeWidth) || options.strokeWidth < 0)
  )
    throw new VmotionError('SCENE3D_STROKE', 'Stroke width must be nonnegative');
  const modelFor = (objectId: string): Mat4 => {
    if (models.has(objectId)) return models.get(objectId)!;
    const object = byId.get(objectId);
    if (!object) throw new VmotionError('SCENE3D_PARENT', 'Parent object does not exist');
    if (visiting.has(objectId) || visiting.size >= 32)
      throw new VmotionError('SCENE3D_CYCLE', '3D hierarchy is cyclic or too deep');
    if (object.matrix && object.transform)
      throw new VmotionError(
        'SCENE3D_TRANSFORM',
        'Choose a matrix or a TRS transform for each object',
      );
    visiting.add(objectId);
    const local = object.matrix ?? mat4Compose(object.transform),
      world = object.parentId ? mat4Multiply(modelFor(object.parentId), local) : checked(local);
    visiting.delete(objectId);
    models.set(objectId, world);
    return world;
  };
  const faces: Array<{
    id: string;
    instanceId: string;
    face: number;
    depth: number;
    points: Array<{ x: number; y: number }>;
    vertices: Array<{
      x: number;
      y: number;
      z: number;
      inverseW: number;
      depth: number;
      world?: Vec3;
      normal?: Vec3;
    }>;
    fill: string;
    baseColor: string;
    material?: ResolvedMaterial3D;
  }> = [];
  let vertices = 0,
    inputFaces = 0,
    clippedFaces = 0,
    culledFaces = 0;
  for (const instance of instances) {
    const model = modelFor(instance.id),
      mesh = instance.mesh,
      material = instance.material ? material3dSchema.parse(instance.material) : undefined;
    if (!mesh)
      throw new VmotionError(
        'MESH3D_SOURCE',
        `Instance ${instance.id} needs inline mesh data; project renderers resolve meshSource before evaluation`,
      );
    if (
      mesh.cornerNormals &&
      (mesh.cornerNormals.length !== mesh.faces.length ||
        mesh.cornerNormals.some((n, i) => n.length !== mesh.faces[i].length))
    )
      throw new VmotionError('MESH3D_NORMAL', 'Corner normal rows must match faces');
    const smooth =
        material?.shading === 'smooth'
          ? (mesh.cornerNormals ?? cornerNormals(mesh, material.creaseAngle))
          : undefined,
      generated = smooth?.some((face) => face.some((n) => n === null))
        ? cornerNormals(mesh, material!.creaseAngle)
        : undefined;
    let normalMatrix: Mat4 | undefined;
    if (smooth)
      try {
        normalMatrix = mat4Inverse(model);
      } catch (e) {
        if (!(e instanceof VmotionError && e.code === 'MATRIX_SINGULAR')) throw e;
      }
    vertices += mesh.vertices.length;
    inputFaces += mesh.faces.length;
    if (vertices > 100000 || inputFaces > 5000)
      throw new VmotionError('MESH3D_LIMIT', 'Scene budget: 100000 vertices and 5000 faces');
    const projected = prepared.projectPoints(mesh.vertices, model),
      world = mesh.vertices.map((p) => {
        const v = homogeneous(model, p);
        return { x: v[0], y: v[1], z: v[2] };
      });
    // Models are affine. Perspective belongs in the camera projection, not object transforms.
    if (model[12] !== 0 || model[13] !== 0 || model[14] !== 0 || model[15] !== 1)
      throw new VmotionError('SCENE3D_MODEL', 'Object model matrices must be affine');
    const determinant =
        model[0] * (model[5] * model[10] - model[6] * model[9]) -
        model[1] * (model[4] * model[10] - model[6] * model[8]) +
        model[2] * (model[4] * model[9] - model[5] * model[8]),
      orientation = determinant < 0 ? -1 : 1;
    for (const [index, indices] of mesh.faces.entries()) {
      if (
        indices.length < 3 ||
        indices.length > 64 ||
        indices.some((i) => !Number.isInteger(i) || i < 0 || i >= mesh.vertices.length)
      )
        throw new VmotionError('MESH3D_FACE', 'Faces require 3–64 valid vertex indices');
      const a = world[indices[0]],
        b = world[indices[1]],
        c = world[indices[2]],
        normalRaw = cross(sub(b, a), sub(c, a)),
        normalLength = Math.hypot(normalRaw.x, normalRaw.y, normalRaw.z);
      if (normalLength < 1e-12) {
        culledFaces++;
        continue;
      }
      const normal = {
        x: (orientation * normalRaw.x) / normalLength,
        y: (orientation * normalRaw.y) / normalLength,
        z: (orientation * normalRaw.z) / normalLength,
      };
      const towardCamera =
        camera.projection === 'orthographic'
          ? sub(camera.position, camera.target)
          : sub(camera.position, a);
      if (
        !material?.doubleSided &&
        options.cullBackfaces !== false &&
        dot(normal, towardCamera) <= 0
      ) {
        culledFaces++;
        continue;
      }
      const polygon = clipFace(
        indices.map((i, j) => {
          let shadingNormal = normal;
          const original = smooth?.[index][j] ?? generated?.[index][j];
          if (original && normalMatrix) {
            vec(original);
            const m = normalMatrix,
              n = {
                x: m[0] * original.x + m[4] * original.y + m[8] * original.z,
                y: m[1] * original.x + m[5] * original.y + m[9] * original.z,
                z: m[2] * original.x + m[6] * original.y + m[10] * original.z,
              },
              length = Math.hypot(n.x, n.y, n.z);
            if (length > 1e-12)
              shadingNormal = { x: n.x / length, y: n.y / length, z: n.z / length };
          }
          return {
            clip: projected[i].clip,
            depth: projected[i].depth,
            ...(material ? { world: world[i], normal: shadingNormal } : {}),
          };
        }),
      );
      if (polygon.length < 3) {
        clippedFaces++;
        continue;
      }
      if (polygon.length !== indices.length || indices.some((i) => !projected[i].visible))
        clippedFaces++;
      const points = polygon.map((v) => ({
        x: prepared.width / 2 + ((v.clip[0] / v.clip[3]) * prepared.width) / 2,
        y: prepared.height / 2 - ((v.clip[1] / v.clip[3]) * prepared.height) / 2,
      }));
      faces.push({
        id: `${id}/${instance.id}/face-${index}`,
        instanceId: instance.id,
        face: index,
        depth: polygon.reduce((sum, v) => sum + v.depth, 0) / polygon.length,
        points,
        vertices: polygon.map((v, i) => ({
          ...points[i],
          z: v.clip[2] / v.clip[3],
          inverseW: 1 / v.clip[3],
          depth: v.depth,
          ...(v.world ? { world: v.world } : {}),
          ...(v.normal ? { normal: v.normal } : {}),
        })),
        baseColor: material?.color ?? mesh.colors?.[index] ?? instance.color ?? '#69b7ff',
        material,
        fill: shade(
          material?.color ?? mesh.colors?.[index] ?? instance.color ?? '#69b7ff',
          ambient + (1 - ambient) * Math.max(0, dot(normal, light)),
        ),
      });
    }
  }
  // Global far-to-near order across all objects, with stable IDs as tie breakers.
  faces.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id, 'en'));
  const nodes: Node[] = faces.map((face) =>
    newNode({
      id: face.id,
      type: 'path',
      name: `${face.instanceId} / face ${face.face}`,
      path: face.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') + 'Z',
      fill: face.fill,
      stroke: options.stroke ?? 'transparent',
      strokeWidth: options.strokeWidth ?? 0,
      opacity: options.opacity ?? 1,
    }),
  );
  let bounds: { x: number; y: number; right: number; bottom: number } | undefined;
  for (const face of faces)
    for (const p of face.points) {
      if (!bounds) bounds = { x: p.x, y: p.y, right: p.x, bottom: p.y };
      else {
        bounds.x = Math.min(bounds.x, p.x);
        bounds.y = Math.min(bounds.y, p.y);
        bounds.right = Math.max(bounds.right, p.x);
        bounds.bottom = Math.max(bounds.bottom, p.y);
      }
    }
  return {
    nodes,
    faces,
    matrices: {
      view: prepared.view,
      projection: prepared.projection,
      viewProjection: prepared.viewProjection,
      models: Object.fromEntries(models),
    },
    stats: {
      objects: instances.length,
      vertices,
      inputFaces,
      visibleFaces: faces.length,
      clippedFaces,
      culledFaces,
    },
    bounds,
  };
}
export const scene3D = (
  id: string,
  instances: readonly MeshInstance3D[],
  camera: Camera3D,
  options: Scene3DOptions = {},
) => evaluateScene3D(id, instances, camera, options).nodes;
export const mesh3D = (
  id: string,
  mesh: Mesh3D,
  camera: Camera3D,
  options: Scene3DOptions & Transform3D = {},
) => scene3D(id, [{ id: 'mesh', mesh, transform: options }], camera, options);
export const project3DBatch = (points: readonly Vec3[], camera: Camera3D, model?: Mat4) =>
  prepareCamera3D(camera).projectPoints(points, model);
/** Persistent depth-buffer layer; native renderer rasterizes it at preview/export resolution. */
export function scene3DLayer(
  id: string,
  instances: readonly MeshInstance3D[],
  camera: Camera3D,
  options: Pick<Scene3DOptions, 'cullBackfaces' | 'light' | 'ambient' | 'opacity'> & {
    samples?: 1 | 4;
    lights?: Light3D[];
    exposure?: number;
    toneMapping?: 'none' | 'reinhard' | 'aces';
  } = {},
) {
  const { samples = 4, opacity = 1, ...lighting } = options;
  const scene3d = scene3dSchema.parse({ camera, instances, options: lighting, samples });
  return newNode({
    id,
    type: 'scene3d',
    name: '3D scene',
    width: camera.width,
    height: camera.height,
    opacity,
    scene3d,
  });
}
export type { Scene3DData };
export function cubeMesh(size = 1): Mesh3D {
  if (!Number.isFinite(size) || size <= 0)
    throw new VmotionError('MESH3D_SIZE', 'Cube size must be positive');
  const h = size / 2;
  return {
    vertices: [
      { x: -h, y: -h, z: -h },
      { x: h, y: -h, z: -h },
      { x: h, y: h, z: -h },
      { x: -h, y: h, z: -h },
      { x: -h, y: -h, z: h },
      { x: h, y: -h, z: h },
      { x: h, y: h, z: h },
      { x: -h, y: h, z: h },
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
    ],
  };
}
