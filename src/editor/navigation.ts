export interface CompositionRoute {
  sceneId: string;
  path: string[];
  workspace: 'editing' | 'animation' | 'drawing';
  drawingId?: string;
  contextFrames?: number[];
}
export function readCompositionRoute(): CompositionRoute {
  try {
    const raw = window.location.hash.slice(1),
      [route, query] = raw.split('?');
    if (route.startsWith('/drawing/'))
      return {
        sceneId: '',
        path: [],
        workspace: 'drawing',
        drawingId: decodeURIComponent(route.slice('/drawing/'.length)),
      };
    if (!route.startsWith('/composition/')) return { sceneId: '', path: [], workspace: 'editing' };
    const sceneId = decodeURIComponent(route.slice('/composition/'.length)),
      path = JSON.parse(new URLSearchParams(query).get('path') ?? '[]'),
      contextFrames = JSON.parse(new URLSearchParams(query).get('context') ?? '[]');
    if (!Array.isArray(path) || path.length > 32 || path.some((id) => typeof id !== 'string'))
      throw new Error('Invalid composition route');
    if (
      !Array.isArray(contextFrames) ||
      contextFrames.length > path.length ||
      contextFrames.some(
        (frame) => typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0,
      )
    )
      throw new Error('Invalid parent frames');
    return { sceneId, path, contextFrames, workspace: 'animation' };
  } catch {
    return { sceneId: '', path: [], workspace: 'editing' };
  }
}
export const compositionUrl = (sceneId: string, path: string[], contextFrames: number[] = []) =>
  `#/composition/${encodeURIComponent(sceneId)}${path.length ? `?path=${encodeURIComponent(JSON.stringify(path))}${contextFrames.length ? `&context=${encodeURIComponent(JSON.stringify(contextFrames))}` : ''}` : ''}`;
