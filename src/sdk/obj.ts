import { VmotionError } from '../core/model.js';
import type { MeshDocument } from '../core/mesh-document.js';
import type { Vec3 } from './matrix3d.js';
type Corner = { v: number; vt: number; vn: number };
const cross = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Ear clipping keeps concave OBJ silhouettes; fan triangulation would fill their notches. */
function triangulate(vertices: Vec3[], corners: Corner[], line: number): Corner[][] {
  let indices = corners.map((_, i) => i);
  if (corners[0].v === corners.at(-1)!.v) indices.pop();
  const points = indices.map((i) => vertices[corners[i].v]),
    origin = points[0],
    normal = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z - 2 * origin.z);
    normal.y += (a.z - b.z) * (a.x + b.x - 2 * origin.x);
    normal.z += (a.x - b.x) * (a.y + b.y - 2 * origin.y);
  }
  const length = Math.hypot(normal.x, normal.y, normal.z);
  const fail = (message: string): never => {
    throw new VmotionError('OBJ_FACE', message, { line, column: 1 });
  };
  if (!length || !Number.isFinite(length)) fail('Face is degenerate or has invalid coordinates');
  const max = Math.max(
    ...points.map((p) => Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z)),
  );
  if (
    points.some(
      (p) =>
        Math.abs(
          (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y + (p.z - origin.z) * normal.z,
        ) /
          length >
        max * 1e-7,
    )
  )
    fail('OBJ faces must be planar; triangulate non-planar faces in the source');
  const axis =
      Math.abs(normal.x) > Math.abs(normal.y)
        ? Math.abs(normal.x) > Math.abs(normal.z)
          ? 'x'
          : 'z'
        : Math.abs(normal.y) > Math.abs(normal.z)
          ? 'y'
          : 'z',
    projected = corners.map((c) => {
      const p = vertices[c.v];
      return axis === 'x'
        ? { x: p.y - origin.y, y: p.z - origin.z }
        : axis === 'y'
          ? { x: p.z - origin.z, y: p.x - origin.x }
          : { x: p.x - origin.x, y: p.y - origin.y };
    }),
    eps = max * max * 1e-12;
  // Remove zero-length and collinear corners before checking simple-polygon topology.
  let changed = true;
  while (changed && indices.length > 3) {
    changed = false;
    for (let j = 0; j < indices.length; j++) {
      const a = projected[indices[(j + indices.length - 1) % indices.length]],
        b = projected[indices[j]],
        c = projected[indices[(j + 1) % indices.length]];
      if (
        Math.abs(cross(a, b, c)) <= eps &&
        (b.x - a.x) * (b.x - c.x) + (b.y - a.y) * (b.y - c.y) <= eps
      ) {
        indices.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  const insideSegment = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    p: { x: number; y: number },
  ) =>
    Math.abs(cross(a, b, p)) <= eps &&
    p.x >= Math.min(a.x, b.x) - Math.sqrt(eps) &&
    p.x <= Math.max(a.x, b.x) + Math.sqrt(eps) &&
    p.y >= Math.min(a.y, b.y) - Math.sqrt(eps) &&
    p.y <= Math.max(a.y, b.y) + Math.sqrt(eps);
  for (let i = 0; i < indices.length; i++)
    for (let j = i + 1; j < indices.length; j++) {
      if (j === i + 1 || (i === 0 && j === indices.length - 1)) continue;
      const a = projected[indices[i]],
        b = projected[indices[(i + 1) % indices.length]],
        c = projected[indices[j]],
        d = projected[indices[(j + 1) % indices.length]],
        abC = cross(a, b, c),
        abD = cross(a, b, d),
        cdA = cross(c, d, a),
        cdB = cross(c, d, b);
      if (
        (abC * abD < 0 && cdA * cdB < 0) ||
        insideSegment(a, b, c) ||
        insideSegment(a, b, d) ||
        insideSegment(c, d, a) ||
        insideSegment(c, d, b)
      )
        fail('Self-intersecting or touching OBJ polygon');
    }
  const area = indices.reduce((sum, k, i) => {
      const a = projected[k],
        b = projected[indices[(i + 1) % indices.length]];
      return sum + a.x * b.y - b.x * a.y;
    }, 0),
    orientation = Math.sign(area);
  if (Math.abs(area) <= eps) fail('Face has zero area');
  const out: Corner[][] = [];
  while (indices.length > 3) {
    let found = false;
    for (let j = 0; j < indices.length; j++) {
      const ia = indices[(j + indices.length - 1) % indices.length],
        ib = indices[j],
        ic = indices[(j + 1) % indices.length],
        a = projected[ia],
        b = projected[ib],
        c = projected[ic];
      if (cross(a, b, c) * orientation <= eps) continue;
      if (
        indices.some(
          (k) =>
            k !== ia &&
            k !== ib &&
            k !== ic &&
            cross(a, b, projected[k]) * orientation >= -eps &&
            cross(b, c, projected[k]) * orientation >= -eps &&
            cross(c, a, projected[k]) * orientation >= -eps,
        )
      )
        continue;
      out.push([corners[ia], corners[ib], corners[ic]]);
      indices.splice(j, 1);
      found = true;
      break;
    }
    if (!found) fail('Cannot triangulate OBJ polygon');
  }
  out.push(indices.map((i) => corners[i]));
  return out;
}
export function parseOBJ(
  text: string,
  options: {
    name?: string;
    objects?: string[];
    groups?: string[];
    materials?: Record<string, string>;
  } = {},
): MeshDocument {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new VmotionError('OBJ_LIMIT', 'OBJ source exceeds 16MB');
  const vertices: Vec3[] = [],
    texcoords: Array<{ u: number; v: number }> = [],
    normals: Vec3[] = [],
    faces: number[][] = [],
    faceTexcoords: number[][] = [],
    faceNormals: number[][] = [],
    colors: string[] = [],
    groups: MeshDocument['groups'] = [],
    groupMap = new Map<string, number>(),
    warnings = new Set<string>();
  let hasMaterialColors = false,
    object = '',
    names: string[] = [],
    material = '',
    sourceFaces = 0;
  const index = (token: string, length: number, line: number, kind: string) => {
    if (!/^-?\d+$/.test(token) || Number(token) === 0)
      throw new VmotionError('OBJ_INDEX', `Invalid ${kind} index ${token}`, { line, column: 1 });
    const value = Number(token),
      at = value > 0 ? value - 1 : length + value;
    if (!Number.isSafeInteger(at) || at < 0 || at >= length)
      throw new VmotionError('OBJ_INDEX', `${kind} index ${token} is out of range`, {
        line,
        column: 1,
      });
    return at;
  };
  for (const [offset, raw] of text.split(/\r?\n/).entries()) {
    const line = offset + 1,
      parts = raw.replace(/#.*/, '').trim().split(/\s+/),
      command = parts.shift();
    if (!command) continue;
    const numbers = (min: number, max: number) => {
      if (parts.length < min || parts.length > max)
        throw new VmotionError('OBJ_FORMAT', `${command} expects ${min}–${max} values`, {
          line,
          column: 1,
        });
      const values = parts.map(Number);
      if (!values.every(Number.isFinite))
        throw new VmotionError('OBJ_NUMBER', 'OBJ coordinates must be finite', { line, column: 1 });
      return values;
    };
    if (command === 'v') {
      const v = numbers(3, 7),
        w = v.length === 4 ? v[3] : 1;
      if (!w)
        throw new VmotionError('OBJ_NUMBER', 'Homogeneous vertex W cannot be zero', {
          line,
          column: 1,
        });
      const point = { x: v[0] / w, y: v[1] / w, z: v[2] / w };
      if (!Object.values(point).every(Number.isFinite))
        throw new VmotionError('OBJ_NUMBER', 'Vertex overflow', { line, column: 1 });
      vertices.push(point);
      if (v.length > 4)
        warnings.add('OBJ per-vertex colors are not rendered; pass explicit material colors.');
    } else if (command === 'vt') {
      const v = numbers(1, 3);
      texcoords.push({ u: v[0], v: v[1] ?? 0 });
    } else if (command === 'vn') {
      const v = numbers(3, 3);
      normals.push({ x: v[0], y: v[1], z: v[2] });
    } else if (command === 'o') object = parts.join(' ');
    else if (command === 'g') names = parts;
    else if (command === 'usemtl') material = parts.join(' ');
    else if (command === 'mtllib')
      warnings.add(
        'MTL files and textures are not loaded automatically; pass explicit material colors.',
      );
    else if (command === 's')
      warnings.add('Smoothing groups are not applied; current renderer uses flat face lighting.');
    else if (command === 'f') {
      sourceFaces++;
      if (sourceFaces > 100000)
        throw new VmotionError('OBJ_LIMIT', 'OBJ source exceeds 100000 polygons', {
          line,
          column: 1,
        });
      if (parts.length < 3 || parts.length > 64)
        throw new VmotionError('OBJ_FACE', 'OBJ polygons require 3–64 corners', {
          line,
          column: 1,
        });
      const corners = parts.map((part) => {
        const refs = part.split('/');
        if (refs.length > 3 || !refs[0])
          throw new VmotionError('OBJ_INDEX', 'Invalid face reference', { line, column: 1 });
        return {
          v: index(refs[0], vertices.length, line, 'vertex'),
          vt: refs[1] ? index(refs[1], texcoords.length, line, 'texture') : -1,
          vn: refs[2] ? index(refs[2], normals.length, line, 'normal') : -1,
        };
      });
      if (
        (options.objects?.length && !options.objects.includes(object)) ||
        (options.groups?.length && !names.some((n) => options.groups!.includes(n)))
      )
        continue;
      const color = options.materials?.[material] ?? '#69b7ff';
      if (options.materials && Object.hasOwn(options.materials, material)) hasMaterialColors = true;
      if (!/^#[\da-f]{6}$/i.test(color))
        throw new VmotionError('MESH3D_COLOR', `Material ${material} requires #RRGGBB`);
      const key = JSON.stringify([object, names, material]);
      if (!groupMap.has(key)) {
        groupMap.set(key, groups.length);
        groups.push({ object, names: [...names], material, faces: [] });
      }
      const group = groups[groupMap.get(key)!];
      for (const triangle of triangulate(vertices, corners, line)) {
        if (faces.length >= 5000)
          throw new VmotionError(
            'MESH3D_LIMIT',
            'Selected OBJ geometry exceeds 5000 triangles; select fewer objects/groups',
            { line, column: 1 },
          );
        group.faces.push(faces.length);
        faces.push(triangle.map((c) => c.v));
        faceTexcoords.push(triangle.map((c) => c.vt));
        faceNormals.push(triangle.map((c) => c.vn));
        colors.push(color);
      }
    } else warnings.add(`Unsupported OBJ statement: ${command}`);
    if (vertices.length > 100000 || texcoords.length > 100000 || normals.length > 100000)
      throw new VmotionError('OBJ_LIMIT', 'OBJ attributes exceed 100000 entries', {
        line,
        column: 1,
      });
    if (warnings.size > 100)
      throw new VmotionError('OBJ_LIMIT', 'Too many unsupported OBJ statement types');
  }
  if (!faces.length)
    throw new VmotionError(
      'OBJ_EMPTY',
      'No supported faces matched the requested object/group selection',
    );
  const used = [...new Set(faces.flat())].sort((a, b) => a - b),
    remap = new Map(used.map((v, i) => [v, i])),
    compact = used.map((i) => vertices[i]);
  if (texcoords.length || normals.length)
    warnings.add(
      'Texture coordinates are stored but not rendered; normal references support smooth materials.',
    );
  return {
    version: 1,
    kind: 'mesh3d',
    name: options.name ?? 'Imported OBJ',
    mesh: {
      vertices: compact,
      faces: faces.map((face) => face.map((i) => remap.get(i)!)),
      ...(hasMaterialColors ? { colors } : {}),
    },
    groups,
    source: { format: 'obj', name: options.name ?? 'OBJ source' },
    warnings: [...warnings],
    ...(texcoords.length || normals.length
      ? { attributes: { texcoords, normals, faceTexcoords, faceNormals } }
      : {}),
  };
}
