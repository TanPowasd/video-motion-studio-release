import { z } from 'zod';
import { material3dSchema, light3dSchema } from '../core/material3d-schema.js';
import {
  mat4Compose,
  mat4Multiply,
  mat4Inverse,
  prepareCamera3D,
  evaluateScene3D,
  type Mat4,
} from '../sdk/matrix3d.js';
const number = z.number().finite(),
  vec3 = z.object({ x: number, y: number, z: number }).strict(),
  matrix = z.array(number).length(16),
  transform = z
    .object({
      position: vec3.optional(),
      rotation: vec3.optional(),
      scale: vec3.optional(),
      pivot: vec3.optional(),
    })
    .strict();
export const camera3dSchema = z
  .object({
    position: vec3,
    target: vec3,
    up: vec3.optional(),
    width: number.positive().max(3840),
    height: number.positive().max(2160),
    fov: number.optional(),
    near: number.optional(),
    far: number.optional(),
    projection: z.enum(['perspective', 'orthographic']).optional(),
    orthographicHeight: number.optional(),
  })
  .strict();
export const matrix3dSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('compose'), transform }).strict(),
  z.object({ operation: z.literal('multiply'), a: matrix, b: matrix }).strict(),
  z.object({ operation: z.literal('inverse'), matrix }).strict(),
  z
    .object({
      operation: z.literal('project'),
      camera: camera3dSchema,
      points: z.array(vec3).min(1).max(10000),
      model: matrix.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scene'),
      camera: camera3dSchema,
      id: z.string().default('world'),
      instances: z
        .array(
          z
            .object({
              id: z.string().min(1),
              parentId: z.string().optional(),
              transform: transform.optional(),
              matrix: matrix.optional(),
              color: z.string().optional(),
              material: material3dSchema.optional(),
              mesh: z
                .object({
                  vertices: z.array(vec3).max(10000),
                  faces: z.array(z.array(z.number().int().nonnegative()).min(3).max(64)).max(5000),
                  colors: z.array(z.string()).max(5000).optional(),
                  cornerNormals: z
                    .array(z.array(vec3.nullable()).min(3).max(64))
                    .max(5000)
                    .optional(),
                })
                .strict(),
            })
            .strict(),
        )
        .max(128),
      options: z
        .object({
          cullBackfaces: z.boolean().optional(),
          light: vec3.optional(),
          ambient: number.optional(),
          stroke: z.string().optional(),
          strokeWidth: number.optional(),
          opacity: number.optional(),
          lights: z.array(light3dSchema).max(8).optional(),
          exposure: number.min(0.01).max(16).optional(),
          toneMapping: z.enum(['none', 'reinhard', 'aces']).optional(),
        })
        .strict()
        .optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
      includeGeometry: z.boolean().default(false),
      includeNodes: z.boolean().default(false),
    })
    .strict(),
]);
export function matrix3d(raw: unknown) {
  const request = matrix3dSchema.parse(raw),
    start = performance.now();
  let result: unknown;
  switch (request.operation) {
    case 'compose':
      result = { matrix: mat4Compose(request.transform) };
      break;
    case 'multiply':
      result = { matrix: mat4Multiply(request.a as unknown as Mat4, request.b as unknown as Mat4) };
      break;
    case 'inverse':
      result = { matrix: mat4Inverse(request.matrix as unknown as Mat4) };
      break;
    case 'project': {
      const prepared = prepareCamera3D(request.camera);
      result = {
        view: prepared.view,
        projection: prepared.projection,
        viewProjection: prepared.viewProjection,
        points: prepared.projectPoints(request.points, request.model as Mat4 | undefined),
      };
      break;
    }
    case 'scene': {
      const evaluated = evaluateScene3D(
          request.id,
          request.instances as Parameters<typeof evaluateScene3D>[1],
          request.camera,
          request.options,
        ),
        faces = evaluated.faces.slice(request.offset, request.offset + request.limit);
      result = {
        stats: evaluated.stats,
        bounds: evaluated.bounds,
        matrices: evaluated.matrices,
        offset: request.offset,
        total: evaluated.faces.length,
        faces: faces.map(({ points, vertices, ...f }) => ({
          ...f,
          ...(request.includeGeometry ? { points, vertices } : {}),
        })),
        ...(request.includeNodes
          ? { nodes: evaluated.nodes.slice(request.offset, request.offset + request.limit) }
          : {}),
        truncated: request.offset + request.limit < evaluated.faces.length,
      };
      break;
    }
  }
  return {
    operation: request.operation,
    convention:
      'row-major 4x4; column vectors; right-handed world; view looks down -Z; NDC depth [-1,1]; screen Y down',
    result,
    computeMs: performance.now() - start,
  };
}
