import { z } from 'zod';
import { mesh3dSchema, vec3Schema } from './scene3d-schema.js';
export const meshDocumentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('mesh3d'),
    name: z.string().min(1),
    mesh: mesh3dSchema,
    groups: z
      .array(
        z
          .object({
            object: z.string(),
            names: z.array(z.string()),
            material: z.string(),
            faces: z.array(z.number().int().nonnegative()).max(5000),
          })
          .strict(),
      )
      .max(5000)
      .default([]),
    source: z
      .object({
        format: z.enum(['obj', 'primitive']),
        name: z.string(),
        hash: z.string().optional(),
      })
      .strict(),
    attributes: z
      .object({
        texcoords: z
          .array(z.object({ u: z.number().finite(), v: z.number().finite() }).strict())
          .max(100000),
        normals: z.array(vec3Schema).max(100000),
        faceTexcoords: z.array(z.array(z.number().int()).length(3)).max(5000),
        faceNormals: z.array(z.array(z.number().int()).length(3)).max(5000),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()).max(100).default([]),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (!doc.mesh.faces.length || !doc.mesh.vertices.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Mesh resource must contain vertices and faces',
        path: ['mesh'],
      });
    for (const [i, face] of doc.mesh.faces.entries())
      if (face.some((index) => index >= doc.mesh.vertices.length))
        ctx.addIssue({
          code: 'custom',
          message: 'Vertex index exceeds the resource vertex array',
          path: ['mesh', 'faces', i],
        });
    if (
      doc.mesh.cornerNormals &&
      (doc.mesh.cornerNormals.length !== doc.mesh.faces.length ||
        doc.mesh.cornerNormals.some((n, i) => n.length !== doc.mesh.faces[i].length))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Corner normals must match mesh faces',
        path: ['mesh', 'cornerNormals'],
      });
    for (const [i, group] of doc.groups.entries())
      if (group.faces.some((index) => index >= doc.mesh.faces.length))
        ctx.addIssue({
          code: 'custom',
          message: 'Group face index is out of range',
          path: ['groups', i, 'faces'],
        });
    if (doc.attributes) {
      if (
        doc.attributes.faceTexcoords.length !== doc.mesh.faces.length ||
        doc.attributes.faceNormals.length !== doc.mesh.faces.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Corner attributes must match triangle count',
          path: ['attributes'],
        });
      for (const key of ['faceTexcoords', 'faceNormals'] as const) {
        const count =
          key === 'faceTexcoords' ? doc.attributes.texcoords.length : doc.attributes.normals.length;
        if (doc.attributes[key].some((face) => face.some((index) => index < -1 || index >= count)))
          ctx.addIssue({
            code: 'custom',
            message: 'Corner attribute index is out of range',
            path: ['attributes', key],
          });
      }
    }
  });
export type MeshDocument = z.infer<typeof meshDocumentSchema>;
