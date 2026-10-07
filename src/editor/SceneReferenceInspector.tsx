import React from 'react';
import type { Node, Snapshot } from '../core/model.js';
export function SceneReferenceInspector({
  node,
  snapshot,
  rootSceneId,
  onChange,
  onSource,
  onReset,
}: {
  node: Node;
  snapshot: Snapshot;
  rootSceneId: string;
  onChange: (patch: Partial<Node>) => unknown;
  onSource: (id: string) => void;
  onReset: () => unknown;
}) {
  const source = snapshot.scenes.find((s) => s.id === node.sceneId),
    references = snapshot.scenes.flatMap((scene) =>
      scene.nodes.filter((n) => n.type === 'scene' && n.sceneId === node.sceneId),
    );
  return (
    <div className="scene-reference-inspector">
      <label className="select-row">
        源场景
        <select
          aria-label="引用源场景"
          value={node.sceneId ?? ''}
          onChange={(e) => onChange({ sceneId: e.target.value })}
        >
          {!source && <option value="">选择源场景…</option>}
          {snapshot.scenes
            .filter((s) => s.id !== rootSceneId)
            .map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
      {source && (
        <>
          <p className="hint">
            {source.width ?? snapshot.project.width} × {source.height ?? snapshot.project.height} ·{' '}
            {source.duration} 帧 · {source.nodes.length} 图层
          </p>
          <p className="hint">
            进入独立合成后编辑当前引用的覆盖。源场景更新会同步到全部引用；当前实例的覆盖优先。
          </p>
          <button type="button" className="source-link" onClick={() => onSource(source.id)}>
            打开共享源场景 · 编辑全部引用
          </button>
          <button type="button" className="source-link" onClick={onReset}>
            重置当前实例内部覆盖
          </button>
          <p className="hint">{references.length} 个直接图层引用 · 内容时间可独立映射</p>
        </>
      )}
    </div>
  );
}
