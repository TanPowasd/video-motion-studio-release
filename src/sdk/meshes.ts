import { VmotionError } from '../core/model.js';
import { mat4Compose, mat4Inverse, type Mesh3D, type Vec3, type Transform3D } from './matrix3d.js';
const finite = (values: number[]) => {
  if (!values.every(Number.isFinite))
    throw new VmotionError('MESH3D_NONFINITE', 'Mesh coordinates must be finite');
};
const positive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0)
    throw new VmotionError('MESH3D_SIZE', `${name} must be positive`);
};
const segments = (value: number, min: number) => {
  if (!Number.isInteger(value) || value < min || value > 128)
    throw new VmotionError('MESH3D_SEGMENTS', `Segments must be integer ${min}–128`);
};
function checked(mesh: Mesh3D): Mesh3D {
  if (mesh.vertices.length > 100000 || mesh.faces.length > 5000)
    throw new VmotionError('MESH3D_LIMIT', 'Mesh budget: 100000 vertices and 5000 faces');
  return mesh;
}
export function sphereMesh(
  radius = 1,
  options: { widthSegments?: number; heightSegments?: number } = {},
): Mesh3D {
  positive(radius, 'Radius');
  const w = options.widthSegments ?? 24,
    h = options.heightSegments ?? 12;
  segments(w, 3);
  segments(h, 2);
  if (2 * w * (h - 1) > 5000)
    throw new VmotionError('MESH3D_LIMIT', 'Sphere tessellation exceeds 5000 triangles');
  const vertices: Vec3[] = [{ x: 0, y: radius, z: 0 }],
    faces: number[][] = [];
  for (let j = 1; j < h; j++)
    for (let i = 0; i < w; i++) {
      const theta = (j * Math.PI) / h,
        phi = (i * Math.PI * 2) / w;
      vertices.push({
        x: radius * Math.sin(theta) * Math.cos(phi),
        y: radius * Math.cos(theta),
        z: radius * Math.sin(theta) * Math.sin(phi),
      });
    }
  const bottom = vertices.length;
  vertices.push({ x: 0, y: -radius, z: 0 });
  const at = (j: number, i: number) => 1 + (j - 1) * w + ((i + w) % w);
  for (let i = 0; i < w; i++) {
    faces.push([0, at(1, i + 1), at(1, i)], [bottom, at(h - 1, i), at(h - 1, i + 1)]);
  }
  for (let j = 1; j < h - 1; j++)
    for (let i = 0; i < w; i++) {
      const a = at(j, i),
        b = at(j, i + 1),
        c = at(j + 1, i + 1),
        d = at(j + 1, i);
      faces.push([a, b, c], [a, c, d]);
    }
  return checked({ vertices, faces });
}
export function cylinderMesh(
  options: {
    radiusTop?: number;
    radiusBottom?: number;
    height?: number;
    radialSegments?: number;
    caps?: boolean;
  } = {},
): Mesh3D {
  const top = options.radiusTop ?? 1,
    bottom = options.radiusBottom ?? 1,
    height = options.height ?? 2,
    n = options.radialSegments ?? 24;
  positive(height, 'Height');
  segments(n, 3);
  if (![top, bottom].every((v) => Number.isFinite(v) && v >= 0) || top + bottom === 0)
    throw new VmotionError('MESH3D_SIZE', 'Radii must be nonnegative, with at least one positive');
  const vertices: Vec3[] = [],
    faces: number[][] = [],
    ring = (radius: number, y: number) => {
      const ids: number[] = [];
      if (radius === 0) {
        ids.push(vertices.length);
        vertices.push({ x: 0, y, z: 0 });
        return Array(n).fill(ids[0]) as number[];
      }
      for (let i = 0; i < n; i++) {
        ids.push(vertices.length);
        const angle = (i * 2 * Math.PI) / n;
        vertices.push({ x: radius * Math.cos(angle), y, z: radius * Math.sin(angle) });
      }
      return ids;
    },
    a = ring(top, height / 2),
    b = ring(bottom, -height / 2);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    if (top > 0) faces.push([a[i], a[next], b[next]]);
    if (bottom > 0) faces.push([a[i], b[next], b[i]]);
  }
  if (options.caps !== false)
    for (const [radius, ids, y, isTop] of [
      [top, a, height / 2, true],
      [bottom, b, -height / 2, false],
    ] as const) {
      if (!radius) continue;
      const center = vertices.length;
      vertices.push({ x: 0, y, z: 0 });
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        faces.push(isTop ? [center, ids[next], ids[i]] : [center, ids[i], ids[next]]);
      }
    }
  return checked({ vertices, faces });
}
export const coneMesh = (radius = 1, height = 2, radialSegments = 24) =>
  cylinderMesh({ radiusTop: 0, radiusBottom: radius, height, radialSegments });
export function torusMesh(
  radius = 1,
  tube = 0.3,
  options: { radialSegments?: number; tubularSegments?: number } = {},
): Mesh3D {
  positive(radius, 'Radius');
  positive(tube, 'Tube radius');
  if (tube >= radius)
    throw new VmotionError('MESH3D_SIZE', 'Tube radius must be smaller than torus radius');
  const n = options.radialSegments ?? 32,
    m = options.tubularSegments ?? 12;
  segments(n, 3);
  segments(m, 3);
  if (2 * n * m > 5000)
    throw new VmotionError('MESH3D_LIMIT', 'Torus tessellation exceeds 5000 triangles');
  const vertices: Vec3[] = [],
    faces: number[][] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const u = (i * 2 * Math.PI) / n,
        v = (j * 2 * Math.PI) / m,
        r = radius + tube * Math.cos(v);
      vertices.push({ x: r * Math.cos(u), y: tube * Math.sin(v), z: r * Math.sin(u) });
    }
  const at = (i: number, j: number) => ((i + n) % n) * m + ((j + m) % m);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      faces.push([a, d, c], [a, c, b]);
    }
  return checked({ vertices, faces });
}
export function surfaceMesh(
  fn: (x: number, z: number) => number,
  options: { width?: number; depth?: number; widthSegments?: number; depthSegments?: number } = {},
): Mesh3D {
  const width = options.width ?? 4,
    depth = options.depth ?? 4,
    w = options.widthSegments ?? 16,
    h = options.depthSegments ?? 16;
  positive(width, 'Width');
  positive(depth, 'Depth');
  segments(w, 1);
  segments(h, 1);
  if (2 * w * h > 5000)
    throw new VmotionError('MESH3D_LIMIT', 'Surface tessellation exceeds 5000 triangles');
  const vertices: Vec3[] = [],
    faces: number[][] = [];
  for (let j = 0; j <= h; j++)
    for (let i = 0; i <= w; i++) {
      const x = (i / w - 0.5) * width,
        z = (j / h - 0.5) * depth,
        y = fn(x, z);
      finite([x, y, z]);
      vertices.push({ x, y, z });
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const a = j * (w + 1) + i,
        b = a + 1,
        c = b + w + 1,
        d = a + w + 1;
      faces.push([a, d, c], [a, c, b]);
    }
  return checked({ vertices, faces });
}
export const planeMesh = (width = 4, depth = 4, widthSegments = 1, depthSegments = 1) =>
  surfaceMesh(() => 0, { width, depth, widthSegments, depthSegments });
export function meshBounds3D(mesh: Mesh3D) {
  if (!mesh.vertices.length) throw new VmotionError('MESH3D_EMPTY', 'Mesh contains no vertices');
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of mesh.vertices) {
    finite([v.x, v.y, v.z]);
    for (const axis of ['x', 'y', 'z'] as const) {
      min[axis] = Math.min(min[axis], v[axis]);
      max[axis] = Math.max(max[axis], v[axis]);
    }
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center = { x: min.x + size.x / 2, y: min.y + size.y / 2, z: min.z + size.z / 2 };
  finite([...Object.values(size), ...Object.values(center)]);
  return { min, max, size, center, radius: Math.hypot(size.x, size.y, size.z) / 2 };
}
export function transformMesh(mesh: Mesh3D, transform: Transform3D): Mesh3D {
  const m = mat4Compose(transform),
    vertices = mesh.vertices.map((v) => ({
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3],
      y: m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7],
      z: m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11],
    }));
  vertices.forEach((v) => finite([v.x, v.y, v.z]));
  const determinant =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  let inverse: ReturnType<typeof mat4Inverse> | undefined;
  if (mesh.cornerNormals)
    try {
      inverse = mat4Inverse(m);
    } catch (e) {
      if (!(e instanceof VmotionError && e.code === 'MATRIX_SINGULAR')) throw e;
    }
  const normals = mesh.cornerNormals?.map((row) => {
    const values = row.map((n) => {
      if (!n || !inverse) return null;
      const v = {
          x: inverse[0] * n.x + inverse[4] * n.y + inverse[8] * n.z,
          y: inverse[1] * n.x + inverse[5] * n.y + inverse[9] * n.z,
          z: inverse[2] * n.x + inverse[6] * n.y + inverse[10] * n.z,
        },
        length = Math.hypot(v.x, v.y, v.z);
      return length ? { x: v.x / length, y: v.y / length, z: v.z / length } : null;
    });
    return determinant < 0 ? values.reverse() : values;
  });
  return {
    ...mesh,
    vertices,
    faces: mesh.faces.map((face) => (determinant < 0 ? [...face].reverse() : [...face])),
    ...(mesh.colors ? { colors: [...mesh.colors] } : {}),
    ...(normals ? { cornerNormals: normals } : {}),
  };
}
export function normalizeMesh(mesh: Mesh3D, size = 2): Mesh3D {
  positive(size, 'Target size');
  const bounds = meshBounds3D(mesh),
    extent = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  if (!extent) throw new VmotionError('MESH3D_EMPTY', 'Mesh has zero spatial extent');
  return transformMesh(mesh, {
    pivot: bounds.center,
    scale: { x: size / extent, y: size / extent, z: size / extent },
  });
}
export function inspectMesh(mesh: Mesh3D) {
  checked(mesh);
  const bounds = meshBounds3D(mesh),
    edges = new Map<string, { count: number; direction: number }>(),
    details: Array<{ index: number; area: number; normal: Vec3; center: Vec3 }> = [];
  let area = 0,
    volume = 0,
    degenerateFaces = 0;
  for (const [index, face] of mesh.faces.entries()) {
    if (
      face.length < 3 ||
      face.length > 64 ||
      face.some((i) => !Number.isInteger(i) || i < 0 || i >= mesh.vertices.length)
    )
      throw new VmotionError('MESH3D_FACE', `Invalid indices in face ${index}`);
    const origin = mesh.vertices[face[0]],
      normal = { x: 0, y: 0, z: 0 },
      center = { x: 0, y: 0, z: 0 };
    let faceArea = 0;
    for (let i = 1; i + 1 < face.length; i++) {
      const b = mesh.vertices[face[i]],
        c = mesh.vertices[face[i + 1]],
        bx = b.x - origin.x,
        by = b.y - origin.y,
        bz = b.z - origin.z,
        cx = c.x - origin.x,
        cy = c.y - origin.y,
        cz = c.z - origin.z,
        n = { x: by * cz - bz * cy, y: bz * cx - bx * cz, z: bx * cy - by * cx };
      faceArea += Math.hypot(n.x, n.y, n.z) / 2;
      normal.x += n.x;
      normal.y += n.y;
      normal.z += n.z;
      // Use a common reference point to limit cancellation for translated models.
      const a0 = {
          x: origin.x - bounds.center.x,
          y: origin.y - bounds.center.y,
          z: origin.z - bounds.center.z,
        },
        b0 = { x: b.x - bounds.center.x, y: b.y - bounds.center.y, z: b.z - bounds.center.z },
        c0 = { x: c.x - bounds.center.x, y: c.y - bounds.center.y, z: c.z - bounds.center.z };
      volume +=
        (a0.x * (b0.y * c0.z - b0.z * c0.y) +
          a0.y * (b0.z * c0.x - b0.x * c0.z) +
          a0.z * (b0.x * c0.y - b0.y * c0.x)) /
        6;
    }
    const length = Math.hypot(normal.x, normal.y, normal.z);
    if (length) {
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;
    } else degenerateFaces++;
    for (let i = 0; i < face.length; i++) {
      const a = face[i],
        b = face[(i + 1) % face.length],
        key = a < b ? `${a}:${b}` : `${b}:${a}`,
        entry = edges.get(key) ?? { count: 0, direction: 0 };
      entry.count++;
      entry.direction += a < b ? 1 : -1;
      edges.set(key, entry);
      const v = mesh.vertices[a];
      center.x += v.x / face.length;
      center.y += v.y / face.length;
      center.z += v.z / face.length;
    }
    area += faceArea;
    details.push({ index, area: faceArea, normal, center });
  }
  finite([area, volume]);
  const boundaryEdges = [...edges.values()].filter((e) => e.count === 1).length,
    nonManifoldEdges = [...edges.values()].filter((e) => e.count > 2).length,
    inconsistentEdges = [...edges.values()].filter(
      (e) => e.count === 2 && e.direction !== 0,
    ).length;
  return {
    vertices: mesh.vertices.length,
    faces: mesh.faces.length,
    triangles: mesh.faces.reduce((sum, f) => sum + f.length - 2, 0),
    bounds,
    area,
    signedVolume: volume,
    topology: {
      edges: edges.size,
      boundaryEdges,
      nonManifoldEdges,
      inconsistentEdges,
      degenerateFaces,
      closed:
        mesh.faces.length > 0 &&
        boundaryEdges === 0 &&
        nonManifoldEdges === 0 &&
        inconsistentEdges === 0 &&
        degenerateFaces === 0,
    },
    faceDetails: details,
  };
}
