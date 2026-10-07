import path from 'node:path';
import { z } from 'zod';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { scene3dSchema, type Scene3DData } from '../core/scene3d-schema.js';
import { prepareRasterScene } from '../core/raster3d.js';
import { NativeEvaluator } from '../core/native.js';
import { evaluateNode } from '../core/time.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import type { Renderer } from '../core/renderer.js';
import { atomicWrite, hash, safePath } from './project.js';
import { resolveSceneMeshes } from '../core/mesh-resources.js';

export const scene3dRenderSchema = z
  .object({
    source: z.union([
      z.object({ scene: scene3dSchema, id: z.string().default('world') }).strict(),
      z
        .object({
          sceneId: z.string(),
          nodeId: z.string(),
          path: z.array(z.string()).max(32).default([]),
          frame: z.number().finite().nonnegative().default(0),
          contextFrames: contextFramesSchema.default([]),
        })
        .strict(),
    ]),
    revision: z.string().optional(),
    width: z.number().int().min(16).max(1280).default(640),
    samples: z.union([z.literal(1), z.literal(4)]).optional(),
    picks: z
      .array(
        z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).strict(),
      )
      .max(100)
      .default([]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export async function inspectRasterScene(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = scene3dRenderSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before 3D inspection');
  let id: string,
    data: Scene3DData,
    opacity = 1;
  if ('scene' in request.source) {
    id = request.source.id;
    data = request.source.scene;
  } else {
    const source = request.source,
      scope = await renderer.inspectComposition(
        snapshot,
        source.sceneId,
        source.frame,
        source.path,
        source.contextFrames,
      ),
      rawNode = scope.scene.nodes.find((n) => n.id === source.nodeId),
      node = rawNode ? evaluateNode(rawNode, source.frame) : undefined;
    if (!node || node.type !== 'scene3d' || !node.scene3d)
      throw new VmotionError('SCENE3D_SOURCE', 'Selected layer is not a depth-buffer 3D scene');
    id = node.id;
    data = node.scene3d;
    opacity = node.opacity;
  }
  if (request.samples) data = { ...data, samples: request.samples };
  const scale = Math.min(request.width / data.camera.width, 720 / data.camera.height),
    width = Math.max(1, Math.round(data.camera.width * scale)),
    height = Math.max(1, Math.round(data.camera.height * scale)),
    prepared = prepareRasterScene(id, resolveSceneMeshes(snapshot, data), width, height, true),
    native = new NativeEvaluator();
  const start = performance.now();
  try {
    const raster = await native.raster3D(prepared.request),
      pixels = Uint8ClampedArray.from(raster.pixels),
      depth = raster.depth!,
      faceIds = raster.faceIds!,
      depthPixels = new Uint8ClampedArray(pixels.length),
      idPixels = new Uint8ClampedArray(pixels.length),
      counts = new Uint32Array(prepared.labels.length);
    let min = Infinity,
      max = -Infinity,
      visible = 0;
    for (let i = 0; i < depth.length; i++)
      if (faceIds[i] >= 0) {
        min = Math.min(min, depth[i]);
        max = Math.max(max, depth[i]);
        visible++;
        counts[faceIds[i]]++;
      }
    for (let i = 0; i < depth.length; i++) {
      pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * opacity);
      if (faceIds[i] < 0) continue;
      const value = Math.round(255 * (max === min ? 1 : 1 - (depth[i] - min) / (max - min))),
        code = faceIds[i] + 1;
      depthPixels.set([value, value, value, 255], i * 4);
      idPixels.set([code & 255, (code >> 8) & 255, (code >> 16) & 255, 255], i * 4);
    }
    const key = hash(JSON.stringify([snapshot.revision, id, data, width, height])).slice(0, 24),
      base = request.output
        ? path.resolve(request.output)
        : safePath(root, `.vmotion/scene3d/${key}`),
      images: Array<{
        kind: 'color' | 'depth' | 'face-id';
        output: string;
        mimeType: string;
        data?: string;
      }> = [];
    for (const [kind, bytes] of [
      ['color', pixels],
      ['depth', depthPixels],
      ['face-id', idPixels],
    ] as const) {
      const canvas = createCanvas(width, height);
      canvas.getContext('2d').putImageData(new ImageData(bytes, width, height), 0, 0);
      const buffer = await canvas.encode('png'),
        output = base + '-' + kind + '.png';
      canvas.width = 1;
      canvas.height = 1;
      await atomicWrite(output, buffer);
      images.push({
        kind,
        output,
        mimeType: 'image/png',
        ...(request.inline ? { data: buffer.toString('base64') } : {}),
      });
    }
    const picks = request.picks.map((p) => {
      if (p.x >= width || p.y >= height)
        throw new VmotionError('SCENE3D_PICK', 'Pick must be within evidence image pixels', {
          ...p,
          width,
          height,
        });
      const i = p.y * width + p.x,
        index = faceIds[i];
      return {
        ...p,
        coverage: raster.pixels[i * 4 + 3] / 255,
        depth: index >= 0 ? depth[i] : null,
        face: index >= 0 ? prepared.labels[index] : null,
      };
    });
    const faces = prepared.labels.map((label, i) => ({ ...label, visiblePixels: counts[i] })),
      labelsOutput = base + '-labels.json';
    await atomicWrite(
      labelsOutput,
      JSON.stringify({ width, height, revision: snapshot.revision, id, faces }, null, 2) + '\n',
    );
    return {
      revision: snapshot.revision,
      id,
      width,
      height,
      backend: raster.backend,
      samples: data.samples,
      materials: data.instances
        .filter((i) => i.material)
        .map((i) => ({ instanceId: i.id, material: i.material })),
      lighting: data.options,
      triangles: raster.triangles,
      stats: prepared.stats,
      bounds: prepared.bounds,
      visiblePixels: visible,
      depthRange: visible ? { near: min, far: max } : null,
      faces: {
        total: faces.length,
        offset: request.offset,
        items: faces.slice(request.offset, request.offset + request.limit),
        truncated: request.offset + request.limit < faces.length,
        output: labelsOutput,
      },
      picks,
      images,
      renderMs: Math.round(performance.now() - start),
      limitations: [
        'Inspection is local to this 3D layer; outer masks, effects and other timeline layers are not composited.',
        'At antialiased boundaries, the ID/depth describes the nearest covered sample; color may include multiple faces.',
      ],
    };
  } finally {
    native.close();
  }
}
