import type { Node, Snapshot } from './model.js';
export type SceneLink = {
  kind: 'layer' | 'structure' | 'override' | 'clip' | 'declared';
  sourceSceneId?: string;
  sequenceId?: string;
  sceneId: string;
  nodeId?: string;
  location: string;
  clipId?: string;
  trackId?: string;
};
export function declaredSceneLinks(snapshot: Snapshot): SceneLink[] {
  const links: SceneLink[] = [];
  const visit = (
    node: Node,
    sourceSceneId: string,
    location: string,
    kind: SceneLink['kind'],
    depth: number,
  ) => {
    if (depth > 32) return;
    for (const [index, sceneId] of (node.sceneDependencies ?? []).entries())
      links.push({
        kind: 'declared',
        sourceSceneId,
        sceneId,
        nodeId: node.id,
        location: `${location}.sceneDependencies.${index}`,
      });
    if (node.type === 'scene' && node.sceneId)
      links.push({
        kind,
        sourceSceneId,
        sceneId: node.sceneId,
        nodeId: node.id,
        location: `${location}.sceneId`,
      });
    for (const [key, patch] of Object.entries(node.overrides))
      if (patch.sceneId)
        links.push({
          kind: 'override',
          sourceSceneId,
          sceneId: patch.sceneId,
          nodeId: node.id,
          location: `${location}.overrides[${JSON.stringify(key)}].sceneId`,
        });
    if (node.structure) {
      node.structure.added.forEach((child, i) =>
        visit(
          { ...child, structure: undefined },
          sourceSceneId,
          `${location}.structure.added.${i}`,
          'structure',
          depth + 1,
        ),
      );
      for (const [key, edit] of Object.entries(node.structure.nested))
        edit.added.forEach((child, i) =>
          visit(
            { ...child, structure: undefined },
            sourceSceneId,
            `${location}.structure.nested[${JSON.stringify(key)}].added.${i}`,
            'structure',
            depth + 1,
          ),
        );
    }
  };
  for (const scene of snapshot.scenes)
    scene.nodes.forEach((n, i) => visit(n, scene.id, `nodes.${i}`, 'layer', 0));
  for (const sequence of snapshot.sequences)
    for (const track of sequence.tracks)
      for (const clip of track.clips)
        if (clip.sceneId)
          links.push({
            kind: 'clip',
            sequenceId: sequence.id,
            sceneId: clip.sceneId,
            clipId: clip.id,
            trackId: track.id,
            location: `tracks[${JSON.stringify(track.id)}].clips[${JSON.stringify(clip.id)}].sceneId`,
          });
  return links;
}
