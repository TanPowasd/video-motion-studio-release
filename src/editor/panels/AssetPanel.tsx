import { Field, Section } from './WorkbenchFields.js';
type ControllerValues = ReturnType<typeof useWorkbenchController>;
type PanelProps<K extends keyof ControllerValues> = Pick<ControllerValues, K> & {
  [P in Extract<K, 'project' | 'scene' | 'sequence' | 'state'>]: NonNullable<ControllerValues[P]>;
} & {
  selectedClip?: NonNullable<ControllerValues['sequence']>['tracks'][number]['clips'][number] & {
    trackId: string;
  };
};
import React, { lazy, Suspense } from 'react';
import type { Node } from '../../core/model.js';
import { evaluateNode } from '../../core/time.js';
import { AnimationInspector } from '../AnimationInspector.js';
import { AssetItem } from '../AssetItem.js';
import { CanvasInteraction } from '../CanvasInteraction.js';
import { CanvasViewport } from '../CanvasViewport.js';
import { CodeCheck } from '../CodeCheck.js';
import { CodeEditor } from '../CodeEditor.js';
import { DesignInspector } from '../DesignInspector.js';
import { EffectInspector } from '../EffectInspector.js';
import { FilmToolbar } from '../FilmToolbar.js';
import { GraphicsInspector } from '../GraphicsInspector.js';
import { Icon } from '../Icons.js';
import { MatrixInspector } from '../MatrixInspector.js';
import { MediaManager } from '../MediaManager.js';
import { ParameterInspector } from '../ParameterInspector.js';
import { SceneReferenceInspector } from '../SceneReferenceInspector.js';
import { TimeInspector } from '../TimeInspector.js';
import { Timeline } from '../Timeline.js';
import { TrackingInspector } from '../TrackingInspector.js';
import { VectorInspector } from '../VectorInspector.js';
import { VisualAuditPanel } from '../VisualAuditPanel.js';
import { WorkbenchHeader } from '../WorkbenchHeader.js';
import { Splitter } from '../panelLayout.js';
import { rpc } from '../state/rpc-client.js';
import { useWorkbenchController } from '../state/workbench-controller.js';
import { mergeApplicationState } from '../state/workbench-effects.js';
import '../studio-shell.css';
import '../workbench.css';
const StudioWorkspace = lazy(() =>
  import('../studio/StudioWorkspace.js').then((m) => ({ default: m.StudioWorkspace })),
);
const DriverInspector = lazy(() =>
  import('../DriverInspector.js').then((m) => ({ default: m.DriverInspector })),
);
const DrawingWorkspace = lazy(() =>
  import('../DrawingWorkspace.js').then((m) => ({ default: m.DrawingWorkspace })),
);
const SoundEditor = lazy(() =>
  import('../SoundEditor.js').then((m) => ({ default: m.SoundEditor })),
);
const PluginManager = lazy(() =>
  import('../PluginManager.js').then((m) => ({ default: m.PluginManager })),
);
const uid = () => crypto.randomUUID();

export const AssetPanel = React.memo(function AssetPanel({
  assetTab,
  setAssetTab,
  project,
  focusPath,
  filter,
  setFilter,
  setMediaManaging,
  setSoundEditing,
  importAsset,
  snapshot,
  selectedAsset,
  setSelectedAsset,
  placeAsset,
  workspace,
  run,
  sequence,
  sequenceFrame,
  stateRef,
  setWorkspace,
  setClipSelected,
  setDrawingId,
  transact,
  setSceneId,
  setSelected,
  sceneId,
  enterScene,
  fps,
  scene,
  selectedIds,
  select,
  enterGroup,
  codeBusy,
  setCodePath,
  setCodeDirty,
  setPlaying,
}: PanelProps<
  | 'assetTab'
  | 'setAssetTab'
  | 'project'
  | 'focusPath'
  | 'filter'
  | 'setFilter'
  | 'setMediaManaging'
  | 'setSoundEditing'
  | 'importAsset'
  | 'snapshot'
  | 'selectedAsset'
  | 'setSelectedAsset'
  | 'placeAsset'
  | 'workspace'
  | 'run'
  | 'sequence'
  | 'sequenceFrame'
  | 'stateRef'
  | 'setWorkspace'
  | 'setClipSelected'
  | 'setDrawingId'
  | 'transact'
  | 'setSceneId'
  | 'setSelected'
  | 'sceneId'
  | 'enterScene'
  | 'fps'
  | 'scene'
  | 'selectedIds'
  | 'select'
  | 'enterGroup'
  | 'codeBusy'
  | 'setCodePath'
  | 'setCodeDirty'
  | 'setPlaying'
>) {
  return (
    <aside className="left-panel">
      <div className="panel-tabs">
        <button className={!assetTab ? 'active' : ''} onClick={() => setAssetTab(false)}>
          工程
        </button>
        <button className={assetTab ? 'active' : ''} onClick={() => setAssetTab(true)}>
          素材 <span>{project.assets.length}</span>
        </button>
      </div>
      <label className="panel-search">
        <Icon name="search" size={14} />
        <input
          aria-label="搜索场景或图层"
          placeholder={focusPath.length ? '搜索当前合成' : '搜索工程'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button title="清空搜索" onClick={() => setFilter('')}>
            ×
          </button>
        )}
      </label>
      {assetTab ? (
        <>
          <div className="section-title">
            素材库
            <button aria-label="媒体与缓存" onClick={() => setMediaManaging(true)}>
              <Icon name="settings" size={15} />
            </button>
            <button aria-label="新建声音" onClick={() => (location.hash = '#/music/new')}>
              <Icon name="music" size={15} />
            </button>
            <button aria-label="导入素材" onClick={importAsset}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          {project.assets.length ? (
            project.assets.map((a) => (
              <AssetItem
                key={a.id}
                asset={a}
                revision={snapshot!.revision}
                selected={selectedAsset === a.id}
                onSelect={() => setSelectedAsset(a.id)}
                onPlace={() => void placeAsset(a)}
              />
            ))
          ) : (
            <div className="empty">
              <Icon name="image" size={32} />
              <p>在这里管理素材</p>
              <small>图片、视频、音频与字体</small>
              <button className="secondary" onClick={importAsset}>
                导入素材
              </button>
            </div>
          )}
          {selectedAsset && (
            <div className="asset-actions">
              {project.assets.find((a) => a.id === selectedAsset)?.soundSource && (
                <button
                  onClick={() => (location.hash = `#/music/${encodeURIComponent(selectedAsset)}`)}
                >
                  编辑声音
                </button>
              )}
              <button
                onClick={() => {
                  const asset = project.assets.find((a) => a.id === selectedAsset);
                  if (asset) void placeAsset(asset);
                }}
              >
                加入当前{workspace === 'editing' ? '轨道' : '合成'}
              </button>
              <button
                onClick={async () => {
                  const result = await run('assetPlace', {
                    assetId: selectedAsset,
                    sequenceId: sequence.id,
                    frame: sequenceFrame,
                    revision: stateRef.current?.snapshot.revision,
                  });
                  if (result?.clipId) {
                    setWorkspace('editing');
                    setClipSelected(result.clipId);
                  }
                }}
              >
                加入主时间轴
              </button>
              {project.assets.find((a) => a.id === selectedAsset)?.type === 'drawing' && (
                <button
                  onClick={async () => {
                    const result = await run('drawingOpenAsset', {
                      assetId: selectedAsset,
                      revision: stateRef.current?.snapshot.revision,
                    });
                    if (result?.document) {
                      setDrawingId(result.document.id);
                      setWorkspace('drawing');
                    }
                  }}
                >
                  打开画稿编辑
                </button>
              )}
            </div>
          )}
          <div className="drawing-help">
            拖入画布或时间轴放置。画稿从绘画工作区发布；已发布的画稿可再次打开编辑。
          </div>
        </>
      ) : (
        <>
          <div className="section-title">
            场景
            <button
              aria-label="新场景"
              onClick={async () => {
                const id = uid();
                await transact([
                  {
                    type: 'addScene',
                    scene: {
                      id,
                      name: '新场景',
                      duration: 300,
                      background: '#101525',
                      nodes: [],
                    },
                  },
                ]);
                setSceneId(id);
                setSelected('');
              }}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          {snapshot!.scenes
            .filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
            .map((s, i) => (
              <button
                className={`scene-row ${sceneId === s.id ? 'selected' : ''}`}
                key={s.id}
                onClick={() => {
                  enterScene(s.id);
                }}
              >
                <div className="scene-thumb">
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  <img
                    loading="lazy"
                    src={`/api/frame?frame=90&width=240&height=${Math.round((240 * project.height) / project.width)}&scene=${s.id}&revision=${snapshot!.revision}`}
                    alt=""
                  />
                </div>
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    {(s.duration / fps).toFixed(1)}s · {s.nodes.length} 图层
                  </small>
                </div>
              </button>
            ))}
          <div className="section-title layers-title">
            图层<span>{scene.nodes.length}</span>
          </div>
          <div className="layer-list">
            {scene.nodes
              .filter(
                (n) =>
                  !n.parentId && `${n.name} ${n.id}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .reverse()
              .map((n) => (
                <div
                  key={n.id}
                  className={`layer-row ${selectedIds.includes(n.id) ? 'selected' : ''}`}
                  style={{ paddingLeft: n.parentId ? 26 : 12 }}
                >
                  <button
                    className="layer-name"
                    onClick={(e) => select(n.id, e.ctrlKey || e.metaKey)}
                    onDoubleClick={() => {
                      if (n.type === 'group' || n.type === 'component' || n.type === 'scene')
                        enterGroup(n.id);
                    }}
                  >
                    <Icon
                      name={
                        n.type === 'text'
                          ? 'text'
                          : n.type === 'component'
                            ? 'code'
                            : n.type === 'formula'
                              ? 'text'
                              : n.type === 'drawing'
                                ? 'brush'
                                : n.type
                      }
                      size={15}
                    />
                    <span>{n.name}</span>
                    {n.animations.length > 0 && <span className="key-dot">◆</span>}
                  </button>
                  <button
                    aria-label={`Toggle ${n.name}`}
                    className={n.visible ? 'visibility' : 'visibility off'}
                    onClick={() =>
                      transact([
                        {
                          type: 'updateNode',
                          sceneId,
                          nodeId: n.id,
                          patch: { visible: !n.visible },
                        },
                      ])
                    }
                  >
                    <Icon name="eye" size={13} />
                  </button>
                  {(n.type === 'group' || n.type === 'component' || n.type === 'scene') && (
                    <button
                      className="layer-enter"
                      title={`进入 ${n.name} 内部`}
                      onClick={() => enterGroup(n.id)}
                    >
                      <Icon name="arrow" size={12} />
                    </button>
                  )}
                </div>
              ))}
          </div>
          <div className="section-title">组件</div>
          {Object.keys(snapshot!.files)
            .filter((f) => f.endsWith('.ts'))
            .map((file) => (
              <button
                className="component-row"
                disabled={codeBusy}
                key={file}
                onClick={() => {
                  setCodePath(file);
                  setCodeDirty(false);
                  setWorkspace('code');
                  setPlaying(false);
                }}
              >
                <Icon name="code" size={15} />
                {file.split('/').at(-1)}
                <span>TS</span>
              </button>
            ))}
        </>
      )}
      <div className="sidebar-footer">
        <span className="status-dot" />
        本地工程<span className="mono">v{project.formatVersion}</span>
      </div>
    </aside>
  );
});
