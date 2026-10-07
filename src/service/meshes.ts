import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { meshDocumentSchema, type MeshDocument } from '../core/mesh-document.js';
import { meshResource } from '../core/mesh-resources.js';
import { camera3dSchema, mesh3dSchema, transform3dSchema } from '../core/scene3d-schema.js';
import { contextFramesSchema } from '../core/content-time.js';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { cubeMesh, scene3DLayer, mat4Compose } from '../sdk/matrix3d.js';
import {
  sphereMesh,
  cylinderMesh,
  coneMesh,
  torusMesh,
  planeMesh,
  normalizeMesh,
  inspectMesh,
  meshBounds3D,
  transformMesh,
} from '../sdk/meshes.js';
import { parseOBJ } from '../sdk/obj.js';
import { hash } from './project.js';
import { applyOperations } from './operations.js';
import { compositionStructure } from './structure.js';
import { material3dSchema } from '../core/material3d-schema.js';
import { storeAgentPlan } from './agent-plans.js';
const positive = z.number().finite().positive(),
  segments = z.number().int().min(1).max(128),
  color = z.string().regex(/^#[\da-f]{6}$/i),
  revision = z.string().optional();
export const meshPrimitiveSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('box'),
      width: positive.default(2),
      height: positive.default(2),
      depth: positive.default(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sphere'),
      radius: positive.default(1),
      widthSegments: segments.min(3).default(24),
      heightSegments: segments.min(2).default(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cylinder'),
      radiusTop: z.number().finite().nonnegative().default(1),
      radiusBottom: z.number().finite().nonnegative().default(1),
      height: positive.default(2),
      radialSegments: segments.min(3).default(24),
      caps: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cone'),
      radius: positive.default(1),
      height: positive.default(2),
      radialSegments: segments.min(3).default(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal('torus'),
      radius: positive.default(1),
      tube: positive.default(0.3),
      radialSegments: segments.min(3).default(32),
      tubularSegments: segments.min(3).default(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plane'),
      width: positive.default(4),
      depth: positive.default(4),
      widthSegments: segments.default(1),
      depthSegments: segments.default(1),
    })
    .strict(),
]);
const placeSchema = z
  .object({
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeId: z.string().optional(),
    instanceId: z.string().default('model'),
    camera: camera3dSchema.optional(),
    transform: transform3dSchema.optional(),
    material: material3dSchema.optional(),
    color: color.default('#69b7ff'),
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    width: positive.max(3840).optional(),
    height: positive.max(2160).optional(),
    ambient: z.number().min(0).max(1).default(0.35),
    samples: z.union([z.literal(1), z.literal(4)]).default(4),
    cullBackfaces: z.boolean().default(true),
  })
  .strict();
const resourceFields = {
  name: z.string().min(1).max(200).optional(),
  file: z.string().max(400).optional(),
  expectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  revision,
  normalizeSize: positive.optional(),
  place: placeSchema.optional(),
  delivery: z.enum(['stored', 'inline']).default('stored'),
};
export const meshGenerateSchema = z
  .object({ ...resourceFields, primitive: meshPrimitiveSchema })
  .strict();
export const meshImportSchema = z
  .object({
    ...resourceFields,
    path: z.string().optional(),
    text: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    objects: z.array(z.string()).max(1000).optional(),
    groups: z.array(z.string()).max(1000).optional(),
    materials: z.record(color).default({}),
  })
  .strict()
  .refine(
    (r) => (r.path !== undefined) !== (r.text !== undefined),
    'Provide exactly one OBJ path or text',
  );
export const meshInspectSchema = z
  .object({
    source: z.union([
      z.object({ file: z.string() }).strict(),
      z.object({ mesh: mesh3dSchema }).strict(),
    ]),
    revision,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(50),
    includeVertices: z.boolean().default(false),
  })
  .strict();
function checkRevision(snapshot: Snapshot, expected?: string) {
  if (expected && expected !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before the mesh operation', {
      expected,
      actual: snapshot.revision,
    });
}
async function candidate(
  renderer: Renderer,
  root: string,
  snapshot: Snapshot,
  document: MeshDocument,
  request: z.infer<typeof meshGenerateSchema> | z.infer<typeof meshImportSchema>,
) {
  checkRevision(snapshot, request.revision);
  if (request.normalizeSize)
    document = {
      ...document,
      mesh: mesh3dSchema.parse(normalizeMesh(document.mesh, request.normalizeSize)),
    };
  document = meshDocumentSchema.parse(document);
  const summary = inspectMesh(document.mesh),
    file = request.file ?? `components/meshes/${randomUUID()}.json`;
  if (
    !file.startsWith('components/') ||
    !file.endsWith('.json') ||
    file.includes('\\') ||
    file.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new VmotionError(
      'MESH3D_SOURCE',
      'Resource file must be a normalized components/*.json path',
    );
  const content = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new VmotionError(
      'MESH3D_LIMIT',
      'Serialized mesh resource exceeds the 8MB file-edit budget',
    );
  const operations: Operation[] = [
    {
      type: 'editFiles',
      edits: [{ type: 'replace', path: file, expectedHash: request.expectedHash ?? null, content }],
    },
  ];
  let planned = applyOperations(root, snapshot, operations),
    placement: unknown;
  if (request.place) {
    const p = request.place,
      scope = await renderer.inspectComposition(
        planned,
        p.sceneId,
        p.frame,
        p.path,
        p.contextFrames,
      ),
      bounds = meshBounds3D(document.mesh),
      m = mat4Compose(p.transform),
      center = bounds.center,
      target = {
        x: m[0] * center.x + m[1] * center.y + m[2] * center.z + m[3],
        y: m[4] * center.x + m[5] * center.y + m[6] * center.z + m[7],
        z: m[8] * center.x + m[9] * center.y + m[10] * center.z + m[11],
      },
      radius = Math.max(
        1e-4,
        bounds.radius *
          Math.max(
            Math.hypot(m[0], m[4], m[8]),
            Math.hypot(m[1], m[5], m[9]),
            Math.hypot(m[2], m[6], m[10]),
          ),
      ),
      width = p.width ?? scope.width,
      height = p.height ?? scope.height,
      angle = Math.min(
        (50 * Math.PI) / 180,
        2 * Math.atan((Math.tan((25 * Math.PI) / 180) * width) / height),
      ),
      distance = (radius / Math.sin(angle / 2)) * 1.25,
      camera = p.camera ?? {
        position: {
          x: target.x + (distance * 3) / Math.sqrt(38),
          y: target.y + (distance * 2) / Math.sqrt(38),
          z: target.z + (distance * 5) / Math.sqrt(38),
        },
        target,
        width,
        height,
        fov: 50,
        near: radius * 0.005,
        far: radius * 100,
      },
      node = scene3DLayer(
        p.nodeId ?? randomUUID(),
        [
          {
            id: p.instanceId,
            meshSource: file,
            transform: p.transform,
            color: p.color,
            material: p.material,
          },
        ],
        camera,
        { ambient: p.ambient, samples: p.samples, cullBackfaces: p.cullBackfaces },
      );
    node.name = document.name;
    node.x = p.x;
    node.y = p.y;
    node.width = width;
    node.height = height;
    const edit = await compositionStructure(
      renderer,
      planned,
      p.sceneId,
      p.frame,
      p.path,
      { type: 'add', node },
      p.contextFrames,
    );
    operations.push(...edit.operations);
    planned = applyOperations(root, snapshot, operations);
    placement = {
      sceneId: p.sceneId,
      path: p.path,
      nodeId: edit.selection[0],
      instanceId: p.instanceId,
      camera,
    };
  }
  const samples = request.place
    ? [
        {
          sceneId: request.place.sceneId,
          frame: request.place.frame,
          path: request.place.path,
          contextFrames: request.place.contextFrames,
        },
      ]
    : [];
  const input = { revision: snapshot.revision, operations, samples, width: 320, determinism: true };
  const stored = request.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  const { faceDetails, ...stats } = summary;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: planned.revision,
    file,
    fileHash: hash(content),
    name: document.name,
    summary: stats,
    groups: document.groups.map((g) => ({ ...g, faces: g.faces.length })),
    warnings: document.warnings,
    placement,
    componentImport: `import model from '${'./' + file.slice('components/'.length)}'; // pass model.mesh to scene3DLayer`,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: stored
      ? { planId: stored.planId, expectedCandidateRevision: planned.revision }
      : { ...input, expectedCandidateRevision: planned.revision },
  };
}
export async function generateMesh(
  renderer: Renderer,
  root: string,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = meshGenerateSchema.parse(raw),
    p = request.primitive;
  let mesh;
  switch (p.kind) {
    case 'box':
      mesh = transformMesh(cubeMesh(1), { scale: { x: p.width, y: p.height, z: p.depth } });
      break;
    case 'sphere':
      mesh = sphereMesh(p.radius, p);
      break;
    case 'cylinder':
      mesh = cylinderMesh(p);
      break;
    case 'cone':
      mesh = coneMesh(p.radius, p.height, p.radialSegments);
      break;
    case 'torus':
      mesh = torusMesh(p.radius, p.tube, p);
      break;
    case 'plane':
      mesh = planeMesh(p.width, p.depth, p.widthSegments, p.depthSegments);
      break;
  }
  return candidate(
    renderer,
    root,
    snapshot,
    {
      version: 1,
      kind: 'mesh3d',
      name: request.name ?? p.kind,
      mesh: mesh3dSchema.parse(mesh),
      source: { format: 'primitive', name: p.kind },
      groups: [],
      warnings: [],
    },
    request,
  );
}
export async function importMesh(
  renderer: Renderer,
  root: string,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = meshImportSchema.parse(raw);
  checkRevision(snapshot, request.revision);
  let text = request.text,
    sourceHash: string;
  if (request.path) {
    const file = path.resolve(request.path),
      info = await stat(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new VmotionError('OBJ_LIMIT', 'OBJ source must be a file up to 16MB');
    const bytes = await readFile(file);
    if (bytes.length > 16 * 1024 * 1024)
      throw new VmotionError('OBJ_LIMIT', 'OBJ source grew beyond 16MB before import');
    sourceHash = hash(bytes);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new VmotionError('OBJ_ENCODING', 'OBJ source must be valid UTF-8', { file });
    }
  } else sourceHash = hash(text!);
  if (request.sourceHash && request.sourceHash !== sourceHash)
    throw new VmotionError('FILE_HASH_CONFLICT', 'OBJ source changed before import', {
      expected: request.sourceHash,
      actual: sourceHash,
      file: request.path,
    });
  let document: MeshDocument;
  try {
    document = parseOBJ(text!, {
      name: request.name ?? (request.path ? path.basename(request.path) : 'Imported OBJ'),
      objects: request.objects,
      groups: request.groups,
      materials: request.materials,
    });
  } catch (e) {
    if (e instanceof VmotionError && request.path)
      throw new VmotionError(e.code, e.message, { ...(e.details as object), file: request.path });
    throw e;
  }
  document.source = { ...document.source, hash: sourceHash };
  return { ...(await candidate(renderer, root, snapshot, document, request)), sourceHash };
}
export function inspectMeshResource(snapshot: Snapshot, raw: unknown) {
  const request = meshInspectSchema.parse(raw);
  checkRevision(snapshot, request.revision);
  const document =
      'file' in request.source ? meshResource(snapshot, request.source.file) : undefined,
    mesh = document?.mesh ?? ('mesh' in request.source ? request.source.mesh : undefined)!;
  const { faceDetails, ...summary } = inspectMesh(mesh),
    faces = faceDetails.slice(request.offset, request.offset + request.limit).map((f) => ({
      ...f,
      indices: mesh.faces[f.index],
      color: mesh.colors?.[f.index],
      ...(request.includeVertices
        ? { vertices: mesh.faces[f.index].map((i) => mesh.vertices[i]) }
        : {}),
    }));
  return {
    revision: snapshot.revision,
    ...(document
      ? {
          name: document.name,
          source: document.source,
          groups: document.groups.map((g) => ({ ...g, faces: g.faces.length })),
          warnings: document.warnings,
        }
      : {}),
    summary,
    facePage: {
      total: faceDetails.length,
      offset: request.offset,
      items: faces,
      truncated: request.offset + request.limit < faceDetails.length,
    },
  };
}
