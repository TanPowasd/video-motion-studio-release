import { z } from 'zod';
import { material3dSchema, light3dSchema } from './material3d-schema.js';
const number = z.number().finite();
export const vec3Schema = z.object({ x: number, y: number, z: number }).strict();
export const mat4Schema = z.array(number).length(16);
export const transform3dSchema = z
  .object({
    position: vec3Schema.optional(),
    rotation: vec3Schema.optional(),
    scale: vec3Schema.optional(),
    pivot: vec3Schema.optional(),
  })
  .strict();
export const camera3dSchema = z
  .object({
    position: vec3Schema,
    target: vec3Schema,
    up: vec3Schema.optional(),
    width: number.positive().max(3840),
    height: number.positive().max(2160),
    fov: number.min(0.01).max(178.99).optional(),
    near: number.positive().optional(),
    far: number.positive().optional(),
    projection: z.enum(['perspective', 'orthographic']).optional(),
    orthographicHeight: number.positive().optional(),
  })
  .strict();
export const mesh3dSchema = z
  .object({
    vertices: z.array(vec3Schema).max(100000),
    faces: z.array(z.array(z.number().int().nonnegative()).min(3).max(64)).max(5000),
    colors: z.array(z.string()).max(5000).optional(),
    cornerNormals: z.array(z.array(vec3Schema.nullable()).min(3).max(64)).max(5000).optional(),
  })
  .strict();
export const instance3dSchema = z
  .object({
    id: z.string().min(1).max(200),
    parentId: z.string().optional(),
    mesh: mesh3dSchema.optional(),
    meshSource: z.string().min(1).optional(),
    transform: transform3dSchema.optional(),
    matrix: mat4Schema.optional(),
    color: z.string().optional(),
    material: material3dSchema.optional(),
  })
  .strict();
export const scene3dLightingSchema = z
  .object({
    cullBackfaces: z.boolean().optional(),
    light: vec3Schema.optional(),
    ambient: number.min(0).max(1).optional(),
    lights: z.array(light3dSchema).max(8).optional(),
    exposure: number.min(0.01).max(16).optional(),
    toneMapping: z.enum(['none', 'reinhard', 'aces']).optional(),
  })
  .strict();
export const scene3dSchema = z
  .object({
    camera: camera3dSchema,
    instances: z.array(instance3dSchema).max(1000),
    options: scene3dLightingSchema.default({}),
    samples: z.union([z.literal(1), z.literal(4)]).default(4),
  })
  .strict();
export type Scene3DData = z.infer<typeof scene3dSchema>;
