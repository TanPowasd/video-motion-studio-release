import type { Node, Snapshot } from './model.js';
import { VmotionError } from './model.js';
import { evaluateNode } from './time.js';
import { contentTimeSchema, contextFramesSchema, type ContentTime } from './content-time-schema.js';
export { contentTimeSchema, contextFramesSchema };
export type { ContentTime };
export type ContentTiming = {
  parentFrame: number;
  rawFrame: number;
  sourceFrame: number;
  present: boolean;
  duration?: number;
  repeat: ContentTime['repeat'];
  mode: ContentTime['mode'];
  rate: number;
};
export const timeControlled = (node: Pick<Node, 'type'>) =>
  ['component', 'scene', 'video','program'].includes(node.type);
export function mapContentTime(
  mapping: ContentTime,
  parentFrame: number,
  sourceDuration?: number,
): ContentTiming {
  const rawFrame =
      mapping.mode === 'remap'
        ? mapping.frame
        : (parentFrame - mapping.anchor) * mapping.rate + mapping.offset,
    duration = mapping.duration ?? sourceDuration,
    repeat = mapping.repeat;
  if (!Number.isFinite(parentFrame) || !Number.isFinite(rawFrame) || Math.abs(rawFrame) > 1e9)
    throw new VmotionError('CONTENT_TIME_RANGE', 'Content frame is outside the finite time range');
  if (
    repeat !== 'continue' &&
    (duration === undefined || duration <= 0 || !Number.isFinite(duration))
  )
    throw new VmotionError(
      'CONTENT_TIME_DURATION',
      'Clamp, loop, pingpong and blank modes need a positive source duration',
    );
  let sourceFrame = rawFrame,
    present = rawFrame >= 0;
  if (duration !== undefined && repeat === 'clamp') {
    sourceFrame = Math.max(0, Math.min(Math.max(0, duration - 1), rawFrame));
    present = true;
  } else if (duration !== undefined && repeat === 'loop') {
    sourceFrame = ((rawFrame % duration) + duration) % duration;
    present = true;
  } else if (duration !== undefined && repeat === 'pingpong') {
    const last = Math.max(0, duration - 1),
      period = last * 2;
    const phase = period ? ((rawFrame % period) + period) % period : 0;
    sourceFrame = phase <= last ? phase : period - phase;
    present = true;
  } else if (duration !== undefined && repeat === 'blank')
    present = rawFrame >= 0 && rawFrame < duration;
  return {
    parentFrame,
    rawFrame,
    sourceFrame: Math.max(0, sourceFrame),
    present,
    duration,
    repeat,
    mode: mapping.mode,
    rate: mapping.rate,
  };
}
export function contentDuration(snapshot: Snapshot, node: Node): number | undefined {
  if (node.timeMapping.duration !== undefined) return node.timeMapping.duration;
  if (node.type === 'scene') return snapshot.scenes.find((s) => s.id === node.sceneId)?.duration;
  if (node.type === 'video') {
    const asset = snapshot.project.assets.find((a) => a.id === node.assetId),
      seconds = Number(asset?.metadata.duration);
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.max(
        1,
        Math.ceil((seconds * snapshot.project.fps.num) / snapshot.project.fps.den - 1e-8),
      );
  }
  return undefined;
}
export function contentTiming(
  snapshot: Snapshot,
  node: Node,
  parentFrame: number,
  alreadyEvaluated = false,
): ContentTiming {
  const current = alreadyEvaluated ? node : evaluateNode(node, parentFrame);
  const duration = contentDuration(snapshot, current),
    mapping =
      current.type === 'video' &&
      duration !== undefined &&
      current.timeMapping.repeat === 'continue'
        ? { ...current.timeMapping, repeat: 'clamp' as const }
        : current.timeMapping;
  return mapContentTime(mapping, parentFrame, duration);
}
