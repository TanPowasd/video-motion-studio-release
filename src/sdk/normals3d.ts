import { VmotionError } from '../core/model.js';
import type { Mesh3D, Vec3 } from './matrix3d.js';
/** Area-weighted normals per corner keep hard creases without splitting positional topology. */
export function cornerNormals(mesh: Mesh3D, creaseAngle = 60): Vec3[][] {
  if (!Number.isFinite(creaseAngle) || creaseAngle < 0 || creaseAngle > 180)
    throw new VmotionError('MESH3D_NORMAL', 'Crease angle must be 0–180 degrees');
  const adjacent = Array.from({ length: mesh.vertices.length }, () => [] as number[]),
    normals = mesh.faces.map((face, index) => {
      if (
        face.length < 3 ||
        face.some((i) => !Number.isInteger(i) || i < 0 || i >= mesh.vertices.length)
      )
        throw new VmotionError('MESH3D_FACE', 'Invalid normal-generation face indices');
      const n = { x: 0, y: 0, z: 0 },
        a = mesh.vertices[face[0]];
      for (let i = 1; i + 1 < face.length; i++) {
        const b = mesh.vertices[face[i]],
          c = mesh.vertices[face[i + 1]],
          x = b.x - a.x,
          y = b.y - a.y,
          z = b.z - a.z,
          X = c.x - a.x,
          Y = c.y - a.y,
          Z = c.z - a.z;
        n.x += y * Z - z * Y;
        n.y += z * X - x * Z;
        n.z += x * Y - y * X;
      }
      for (const i of new Set(face)) adjacent[i].push(index);
      return n;
    }),
    lengths = normals.map((n) => Math.hypot(n.x, n.y, n.z)),
    threshold = Math.cos((creaseAngle * Math.PI) / 180);
  if (lengths.some((n) => !Number.isFinite(n)))
    throw new VmotionError('MESH3D_NORMAL', 'Normal calculation overflow');
  return mesh.faces.map((face, i) =>
    face.map((vertex) => {
      const sum = { x: 0, y: 0, z: 0 },
        own = normals[i],
        length = lengths[i];
      for (const other of adjacent[vertex]) {
        const n = normals[other],
          size = lengths[other];
        if (!size || !length) continue;
        if ((own.x * n.x + own.y * n.y + own.z * n.z) / (length * size) >= threshold - 1e-12) {
          sum.x += n.x;
          sum.y += n.y;
          sum.z += n.z;
        }
      }
      const size = Math.hypot(sum.x, sum.y, sum.z);
      return size
        ? { x: sum.x / size, y: sum.y / size, z: sum.z / size }
        : length
          ? { x: own.x / length, y: own.y / length, z: own.z / length }
          : { x: 0, y: 0, z: 0 };
    }),
  );
}
export function smoothMesh(mesh: Mesh3D, creaseAngle = 60): Mesh3D {
  return { ...mesh, cornerNormals: cornerNormals(mesh, creaseAngle) };
}
