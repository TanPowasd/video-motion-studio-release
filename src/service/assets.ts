import { randomUUID } from 'node:crypto';
import { VmotionError, type Operation, type Snapshot } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { compositionStructure } from './structure.js';
import { soundResource } from '../media/sound-source.js';
export async function placeAsset(renderer: Renderer, snapshot: Snapshot, params: any) {
  const asset = snapshot.project.assets.find((a) => a.id === params.assetId);
  if (!asset) throw new VmotionError('NOT_FOUND', '素材不存在');
  if (asset.type === 'font') throw new VmotionError('ASSET_TYPE', '字体通过文字图层的字体属性使用');
  const operations: Operation[] = [],
    id = randomUUID();
  if (params.sequenceId) {
    const sequence = snapshot.sequences.find((s) => s.id === params.sequenceId);
    if (!sequence) throw new VmotionError('NOT_FOUND', '序列不存在');
    const kind = asset.type === 'audio' ? 'audio' : 'video';
    if (params.trackId && !sequence.tracks.some((t) => t.id === params.trackId))
      throw new VmotionError('NOT_FOUND', '目标轨道不存在');
    let track =
      sequence.tracks.find((t) => t.id === params.trackId) ??
      sequence.tracks.find((t) => t.type === kind);
    if (track && track.type !== kind)
      throw new VmotionError(
        'TRACK_TYPE',
        kind === 'audio' ? '请将音频放入音轨' : '请将画稿放入视频轨道',
      );
    if (!track) {
      track = {
        id: randomUUID(),
        name: kind === 'audio' ? '音频' : '视频',
        type: kind,
        muted: false,
        clips: [],
      };
      operations.push({ type: 'addTrack', sequenceId: sequence.id, track });
    }
    const start = Math.max(0, Math.min(sequence.duration - 1, Math.round(params.frame ?? 0))),
      assetSeconds = asset.soundSource
        ? soundResource(snapshot, asset).duration
        : Number(asset.metadata.duration),
      defaultSeconds = Number.isFinite(assetSeconds) && assetSeconds > 0 ? assetSeconds : 5,
      duration = Math.max(
        1,
        Math.min(
          sequence.duration - start,
          Math.round(
            params.duration ??
              (defaultSeconds * snapshot.project.fps.num) / snapshot.project.fps.den,
          ),
        ),
      );
    operations.push({
      type: 'addClip',
      sequenceId: sequence.id,
      trackId: track.id,
      clip: {
        id,
        assetId: asset.id,
        start,
        duration,
        sourceIn: 0,
        speed: 1,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
      },
    });
    return { operations, clipId: id, trackId: track.id };
  }
  if (asset.type === 'audio') throw new VmotionError('TRACK_TYPE', '音频请加入剪辑音轨');
  const sceneId = params.sceneId ?? snapshot.scenes[0]?.id,
    path = params.path ?? [],
    scope = await renderer.inspectComposition(
      snapshot,
      sceneId,
      params.frame ?? 0,
      path,
      params.contextFrames ?? [],
    ),
    sourceWidth = Number(asset.metadata.width ?? scope.width),
    sourceHeight = Number(asset.metadata.height ?? scope.height),
    scale = Math.min(1, scope.width / sourceWidth, scope.height / sourceHeight),
    width = params.width ?? sourceWidth * scale,
    height = params.height ?? sourceHeight * scale,
    x =
      params.x === undefined
        ? (scope.width - width) / 2
        : params.anchor === 'center'
          ? params.x - width / 2
          : params.x,
    y =
      params.y === undefined
        ? (scope.height - height) / 2
        : params.anchor === 'center'
          ? params.y - height / 2
          : params.y;
  const originalDrawing =
    asset.type === 'drawing'
      ? snapshot.scenes
          .flatMap((s) => s.nodes)
          .find((n) => n.type === 'drawing' && n.assetId === asset.id && n.strokeWidth > 0)
      : undefined;
  const edit = await compositionStructure(
    renderer,
    snapshot,
    sceneId,
    params.frame ?? 0,
    path,
    {
      type: 'add',
      node: {
        id,
        type: asset.type,
        name: asset.name,
        assetId: asset.id,
        x,
        y,
        width,
        height,
        start: Math.round(params.frame ?? 0),
        ...(originalDrawing
          ? { stroke: originalDrawing.stroke, strokeWidth: originalDrawing.strokeWidth }
          : {}),
      } as any,
    },
    params.contextFrames ?? [],
  );
  return { operations: edit.operations, nodeId: edit.selection[0], selection: edit.selection };
}
