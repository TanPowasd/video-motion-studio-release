import { z } from 'zod';
import { material3dSchema } from '../core/material3d-schema.js';
import { scene3dLightingSchema, scene3dSchema } from '../core/scene3d-schema.js';
import { contextFramesSchema } from '../core/content-time.js';
import { evaluateNode } from '../core/time.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
export const scene3dMaterialsSchema = z
  .object({
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    revision: z.string().optional(),
    updates: z
      .array(
        z
          .object({
            instanceId: z.string(),
            patch: material3dSchema.partial().optional(),
            reset: z.boolean().default(false),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    options: scene3dLightingSchema.partial().optional(),
    resetLightKeys: z.boolean().default(false),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export async function materialEdits(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = scene3dMaterialsSchema.parse(raw);
  if (request.resetLightKeys && !request.options?.lights)
    throw new VmotionError('LIGHT_ANIMATION', 'resetLightKeys requires a replacement lights array');
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before material inspection/edit');
  const scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    node = scope.scene.nodes.find((n) => n.id === request.nodeId);
  if (!node || node.type !== 'scene3d' || !node.scene3d)
    throw new VmotionError('SCENE3D_SOURCE', 'Select a scene3d layer for materials');
  const evaluated = evaluateNode(node, request.frame),
    report = {
      revision: snapshot.revision,
      nodeId: node.id,
      instances: evaluated.scene3d!.instances.map((i, index) => ({
        id: i.id,
        meshSource: i.meshSource,
        legacyFlat: !i.material,
        material: i.material ? material3dSchema.parse(i.material) : null,
        numericPrefix: `scene3d.instances.${index}.material`,
      })),
      options: evaluated.scene3d!.options,
      numericFields: ['metallic', 'roughness', 'emissiveIntensity', 'creaseAngle'],
      limitations: [
        'No textures, shadow maps, environment reflection or world-space transparency.',
      ],
    };
  if (!request.updates.length && !request.options) return { request, report };
  const data = structuredClone(node.scene3d),
    animations = structuredClone(node.animations);
  const updateKey = (property: string, value: number) => {
    const channel = animations.find((a) => a.property === property);
    if (channel) {
      const at = Math.round(request.frame);
      channel.keys = channel.keys.filter((k) => k.frame !== at);
      channel.keys.push({ frame: at, value, easing: 'linear' });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
  };
  for (const update of request.updates) {
    const index = data.instances.findIndex((i) => i.id === update.instanceId);
    if (index < 0)
      throw new VmotionError('NOT_FOUND', `3D instance ${update.instanceId} is missing`);
    const instance = data.instances[index],
      prefix = `scene3d.instances.${index}.material.`;
    if (update.reset) {
      instance.material = undefined;
      for (let i = animations.length - 1; i >= 0; i--)
        if (animations[i].property.startsWith(prefix)) animations.splice(i, 1);
      continue;
    }
    instance.material = material3dSchema.parse({ ...instance.material, ...update.patch });
    for (const [key, value] of Object.entries(update.patch ?? {}))
      if (typeof value === 'number') updateKey(prefix + key, value);
  }
  if (request.options) {
    if (
      request.options.lights &&
      animations.some((a) => a.property.startsWith('scene3d.options.lights.')) &&
      !request.resetLightKeys
    )
      throw new VmotionError(
        'LIGHT_ANIMATION',
        'Replacing the light array requires resetLightKeys=true when it has numeric channels',
      );
    if (request.resetLightKeys)
      for (let i = animations.length - 1; i >= 0; i--)
        if (animations[i].property.startsWith('scene3d.options.lights.')) animations.splice(i, 1);
    data.options = { ...data.options, ...request.options };
    const updateNested = (value: unknown, prefix: string) => {
      if (typeof value === 'number') updateKey(prefix, value);
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) updateNested(item, prefix + '.' + key);
    };
    updateNested(request.options, 'scene3d.options');
  }
  const patch = { scene3d: scene3dSchema.parse(data), animations },
    planned = evaluateNode({ ...node, ...patch }, request.frame).scene3d!;
  return {
    request,
    report,
    planned: {
      instances: planned.instances.map((i) => ({ id: i.id, material: i.material ?? null })),
      options: planned.options,
    },
    patch,
  };
}
