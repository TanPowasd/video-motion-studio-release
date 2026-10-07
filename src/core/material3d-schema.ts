import { z } from 'zod';
const hex = z.string().regex(/^#[\da-f]{6}$/i),
  number = z.number().finite(),
  vec = z.object({ x: number, y: number, z: number }).strict();
export const material3dSchema = z
  .object({
    model: z.enum(['standard', 'unlit']).default('standard'),
    color: hex.optional(),
    metallic: number.min(0).max(1).default(0),
    roughness: number.min(0.05).max(1).default(0.5),
    emissive: hex.default('#000000'),
    emissiveIntensity: number.min(0).max(8).default(0),
    shading: z.enum(['flat', 'smooth']).default('smooth'),
    creaseAngle: number.min(0).max(180).default(60),
    doubleSided: z.boolean().default(false),
  })
  .strict();
export const light3dSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('directional'),
      direction: vec,
      color: hex.default('#ffffff'),
      intensity: number.min(0).max(100).default(3),
    })
    .strict(),
  z
    .object({
      type: z.literal('point'),
      position: vec,
      color: hex.default('#ffffff'),
      intensity: number.min(0).max(1000).default(10),
      range: number.positive().optional(),
    })
    .strict(),
]);
export type Material3D = z.input<typeof material3dSchema>;
export type ResolvedMaterial3D = z.infer<typeof material3dSchema>;
export type Light3D = z.input<typeof light3dSchema>;
