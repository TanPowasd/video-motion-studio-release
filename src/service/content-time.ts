import { z } from 'zod';
import {
  contentTimeSchema,
  contextFramesSchema,
  contentTiming,
  timeControlled,
} from '../core/content-time.js';
import { keyframeSchema, VmotionError, type Snapshot } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
export const timeInspectSchema = z
  .object({
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    frames: z.array(z.number().finite().min(0).max(1e9)).max(120).default([]),
  })
  .strict();
export const timeEditSchema = timeInspectSchema
  .omit({ frames: true })
  .extend({
    revision: z.string().optional(),
    settings: contentTimeSchema.partial().default({}),
    keys: z.array(keyframeSchema).max(1000).optional(),
    reset: z.boolean().default(false),
    preset: z.enum(['freeze', 'reverse', 'normal']).optional(),
  })
  .strict();
async function target(
  renderer: Renderer,
  snapshot: Snapshot,
  request: z.output<typeof timeInspectSchema>,
) {
  const scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    node = scope.scene.nodes.find((n) => n.id === request.nodeId);
  if (!node || !timeControlled(node))
    throw new VmotionError(
      'CONTENT_TIME_TYPE',
      'Time controls require a video, component or scene reference',
    );
  return { node, scope };
}
export async function inspectContentTime(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = timeInspectSchema.parse(raw),
    { node, scope } = await target(renderer, snapshot, request);
  return {
    revision: snapshot.revision,
    nodeId: node.id,
    path: request.path,
    contextFrames: request.contextFrames,
    settings: node.timeMapping,
    channels: node.animations.filter((a) => a.property.startsWith('timeMapping.')),
    samples: (request.frames.length ? request.frames : [request.frame]).map((frame) =>
      contentTiming(snapshot, node, frame),
    ),
    parentDuration: scope.scene.duration,
    limitations: [
      'Content clocks retime visuals; scene/video audio routing is not automatically retimed by these layer controls.',
      'Mapped fractional content time is evaluated continuously; editable keyframes are placed at integer source frames.',
    ],
  };
}
export async function editContentTime(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = timeEditSchema.parse(raw),
    { node, scope } = await target(renderer, snapshot, { ...request, frames: [] });
  let mapping = request.reset
      ? contentTimeSchema.parse({})
      : { ...node.timeMapping, ...request.settings },
    animations = structuredClone(node.animations).filter(
      (a) => !request.reset || !a.property.startsWith('timeMapping.'),
    );
  for(const [key,value]of Object.entries(request.settings)){
    if(typeof value!=='number')continue;
    const channel=animations.find((a)=>a.property===`timeMapping.${key}`);
    if(channel){const at=Math.round(request.frame);channel.keys=channel.keys.filter((k)=>k.frame!==at);
      channel.keys.push({frame:at,value,easing:'linear'});channel.keys.sort((a,b)=>a.frame-b.frame);}
  }
  if (request.preset) {
    const timing = contentTiming(snapshot, node, request.frame),
      duration = timing.duration;
    if (request.preset === 'freeze')
      mapping = {
        ...mapping,
        mode: 'linear',
        anchor: request.frame,
        offset: timing.sourceFrame,
        rate: 0,
      };
    else if (request.preset === 'reverse') {
      if (!duration)
        throw new VmotionError('CONTENT_TIME_DURATION', 'Reverse preset needs a source duration');
      mapping = {
        ...mapping,
        mode: 'linear',
        anchor: request.frame,
        offset: Math.max(0, duration - 1),
        rate: -1,
        repeat: 'clamp',
      };
    } else mapping = contentTimeSchema.parse({});
    animations = animations.filter((a) => !a.property.startsWith('timeMapping.'));
  }
  if (request.keys) {
    if (!request.keys.length)
      throw new VmotionError('CONTENT_TIME_KEYS', 'Provide at least one remap key');
    if (new Set(request.keys.map((k) => k.frame)).size !== request.keys.length)
      throw new VmotionError('DUPLICATE_KEYFRAME', 'Remap key times must be distinct');
    mapping = { ...mapping, mode: 'remap', frame: request.keys[0].value };
    animations = animations.filter((a) => a.property !== 'timeMapping.frame');
    animations.push({
      property: 'timeMapping.frame',
      keys: [...request.keys].sort((a, b) => a.frame - b.frame),
    });
  }
  mapping = contentTimeSchema.parse(mapping);
  const changed = { ...node, timeMapping: mapping, animations };
  for (const frame of new Set([
    request.frame,
    0,
    scope.scene.duration - 1,
    ...animations
      .filter((a) => a.property.startsWith('timeMapping.'))
      .flatMap((a) => a.keys.map((k) => k.frame)),
  ]))
    contentTiming(snapshot, changed, frame);
  return {
    request,
    nodeId: node.id,
    patch: { timeMapping: mapping, animations },
    sample: contentTiming(snapshot, changed, request.frame),
  };
}
