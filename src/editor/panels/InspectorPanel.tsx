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

export const InspectorPanel = React.memo(function InspectorPanel({
  inspectorTab,
  workspace,
  setInspectorTab,
  selectedClip,
  transact,
  sequence,
  editSequenceActions,
  node,
  update,
  selectedIds,
  enterGroup,
  snapshot,
  sceneId,
  enterScene,
  run,
  interactions,
  focusPath,
  nodeFrame,
  nodeContextFrames,
  stateRef,
  componentParams,
  editParameters,
  setCodePath,
  setCodeDirty,
  setWorkspace,
  setPlaying,
  editTime,
  addKey,
  bakeVector,
  scene,
  setError,
  selectedLayer,
  activeDuration,
  state,
  focusContextFrames,
  setFocusPath,
  setFocusContextFrames,
  setComposition,
  setSceneFrames,
  editAnimation,
  jobs,
}: PanelProps<
  | 'inspectorTab'
  | 'workspace'
  | 'setInspectorTab'
  | 'transact'
  | 'sequence'
  | 'editSequenceActions'
  | 'node'
  | 'update'
  | 'selectedIds'
  | 'enterGroup'
  | 'snapshot'
  | 'sceneId'
  | 'enterScene'
  | 'run'
  | 'interactions'
  | 'focusPath'
  | 'nodeFrame'
  | 'nodeContextFrames'
  | 'stateRef'
  | 'componentParams'
  | 'editParameters'
  | 'setCodePath'
  | 'setCodeDirty'
  | 'setWorkspace'
  | 'setPlaying'
  | 'editTime'
  | 'addKey'
  | 'bakeVector'
  | 'scene'
  | 'setError'
  | 'selectedLayer'
  | 'activeDuration'
  | 'state'
  | 'focusContextFrames'
  | 'setFocusPath'
  | 'setFocusContextFrames'
  | 'setComposition'
  | 'setSceneFrames'
  | 'editAnimation'
  | 'jobs'
>) {
  return (
    <aside className={`inspector tab-${inspectorTab}`}>
      <div className="inspector-heading">
        <span>{workspace === 'editing' ? '片段属性' : '图层检查器'}</span>
        <Icon name="settings" size={16} />
      </div>
      <div className="inspector-tabs">
        {[
          ['properties', '属性'],
          ['effects', '效果'],
          ['animation', '动画'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={inspectorTab === id ? 'active' : ''}
            onClick={() => setInspectorTab(id as typeof inspectorTab)}
          >
            {label}
          </button>
        ))}
      </div>
      {workspace === 'editing' && selectedClip ? (
        <>
          <div className="inspector-node">
            <Icon name="film" />
            <strong>{selectedClip.id.slice(0, 20)}</strong>
          </div>
          <Section title="时间设置">
            <label className="select-row">
              片段名称
              <input
                aria-label="片段名称"
                key={selectedClip.id}
                defaultValue={selectedClip.name ?? ''}
                onBlur={(e) =>
                  transact([
                    {
                      type: 'updateClip',
                      sequenceId: sequence.id,
                      trackId: selectedClip.trackId,
                      clipId: selectedClip.id,
                      patch: { name: e.target.value },
                    },
                  ])
                }
              />
            </label>
            {(
              ['start', 'duration', 'sourceIn', 'speed', 'volume', 'fadeIn', 'fadeOut'] as const
            ).map((property) => (
              <Field
                key={property}
                label={property}
                value={selectedClip[property]}
                onChange={(value) =>
                  transact([
                    {
                      type: 'updateClip',
                      sequenceId: sequence.id,
                      trackId: selectedClip.trackId,
                      clipId: selectedClip.id,
                      patch: { [property]: value },
                    },
                  ])
                }
              />
            ))}
          </Section>
          <Section title="源片段与链接">
            <div className="clip-actions">
              <button
                onClick={() =>
                  void editSequenceActions([
                    { type: 'slip', clipIds: [selectedClip.id], delta: -1 },
                  ])
                }
              >
                源向前 1f
              </button>
              <button
                onClick={() =>
                  void editSequenceActions([{ type: 'slip', clipIds: [selectedClip.id], delta: 1 }])
                }
              >
                源向后 1f
              </button>
            </div>
            <label className="select-row">
              播放片段声音
              <input
                type="checkbox"
                aria-label="播放片段声音"
                checked={selectedClip.audioEnabled !== false}
                onChange={(e) =>
                  transact([
                    {
                      type: 'updateClip',
                      sequenceId: sequence.id,
                      trackId: selectedClip.trackId,
                      clipId: selectedClip.id,
                      patch: { audioEnabled: e.target.checked },
                    },
                  ])
                }
              />
            </label>
            {selectedClip.linkedGroup && (
              <button
                onClick={() =>
                  void editSequenceActions([{ type: 'unlink', clipIds: [selectedClip.id] }])
                }
              >
                解除当前片段链接
              </button>
            )}
            {selectedClip.fadeWindow && (
              <p className="hint">
                裁切保留了原始淡化位置；编辑淡入/淡出数值可重新以当前片段为起点。
              </p>
            )}
          </Section>
          <button
            className="danger"
            onClick={() =>
              transact([
                {
                  type: 'removeClip',
                  sequenceId: sequence.id,
                  trackId: selectedClip.trackId,
                  clipId: selectedClip.id,
                },
              ])
            }
          >
            移除片段
          </button>
        </>
      ) : node && workspace !== 'editing' ? (
        <>
          <div className="inspector-node">
            <Icon
              name={node.type === 'component' ? 'code' : node.type === 'text' ? 'text' : node.type}
            />
            <input
              aria-label="图层名称"
              key={node.id + node.name}
              defaultValue={node.name}
              onBlur={(e) => update({ name: e.target.value })}
            />
            <span>{selectedIds.length > 1 ? `${selectedIds.length} 个已选中` : node.type}</span>
          </div>
          {(node.type === 'group' || node.type === 'component' || node.type === 'scene') && (
            <button className="enter-composition" onClick={() => enterGroup(node.id)}>
              <Icon name="layers" size={14} />
              进入独立合成
              <Icon name="arrow" size={13} />
            </button>
          )}
          {node.type === 'scene' && (
            <Section title="共享场景引用">
              <SceneReferenceInspector
                node={node}
                snapshot={snapshot!}
                rootSceneId={sceneId}
                onChange={update}
                onSource={enterScene}
                onReset={() =>
                  run('sceneReset', {
                    sceneId,
                    nodeId: node.id,
                    path:
                      interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
                    frame: nodeFrame,
                    contextFrames: nodeContextFrames,
                    revision: stateRef.current?.snapshot.revision,
                  })
                }
              />
            </Section>
          )}
          {(node.type === 'component' || node.templateInstance) && (
            <Section title="组件参数">
              <ParameterInspector
                specs={componentParams}
                values={evaluateNode(node, nodeFrame).params}
                onUpdate={(path, value) => editParameters({ updates: [{ path, value }] })}
                onKey={(path) =>
                  void editParameters({ keys: [{ path, frame: Math.round(nodeFrame) }] })
                }
                onReset={(path) => void editParameters({ reset: [path] })}
                onArray={(action) => editParameters({ arrays: [action] })}
              />
              <button
                className="source-link"
                onClick={() => {
                  setCodePath(node.component!);
                  setCodeDirty(false);
                  setWorkspace('code');
                  setPlaying(false);
                }}
              >
                打开组件代码 <Icon name="arrow" size={13} />
              </button>
            </Section>
          )}
          {['video', 'component', 'scene'].includes(node.type) && (
            <Section title="内容时间">
              <TimeInspector
                key={node.id}
                node={node}
                snapshot={snapshot!}
                frame={nodeFrame}
                onEdit={editTime}
                onKey={addKey}
              />
            </Section>
          )}
          <Section title="变换">
            <div className="field-grid">
              {(
                [
                  'x',
                  'y',
                  'width',
                  'height',
                  'rotation',
                  'scaleX',
                  'scaleY',
                  'originX',
                  'originY',
                ] as const
              ).map((property) => (
                <Field
                  key={`${node.id}-${property}-${node[property]}`}
                  label={property}
                  value={evaluateNode(node, nodeFrame)[property]}
                  onChange={(value) => update({ [property]: value })}
                  onKey={() => addKey(property)}
                />
              ))}
            </div>
            <MatrixInspector
              key={node.id}
              node={node}
              frame={nodeFrame}
              onChange={update}
              onKey={addKey}
            />
          </Section>
          <Section title="外观">
            <Field
              label="不透明度"
              value={Math.round(evaluateNode(node, nodeFrame).opacity * 100)}
              onChange={(v) => update({ opacity: Math.max(0, Math.min(1, v / 100)) })}
              onKey={() => addKey('opacity')}
            />
            <div className="color-row">
              <label>填充</label>
              <input
                aria-label="填充颜色"
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(node.fill) ? node.fill : '#ffffff'}
                onChange={(e) => update({ fill: e.target.value })}
              />
              <span className="mono">{node.fill.toUpperCase()}</span>
            </div>
            <label className="select-row">
              混合
              <select
                value={node.blend}
                onChange={(e) => update({ blend: e.target.value as Node['blend'] })}
              >
                {[
                  'source-over',
                  'multiply',
                  'screen',
                  'overlay',
                  'darken',
                  'lighten',
                  'difference',
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <Field
              label="模糊"
              value={node.blur}
              onChange={(v) => update({ blur: Math.max(0, v) })}
            />
          </Section>
          {['rect', 'ellipse', 'path', 'text'].includes(node.type) && (
            <Section title="描边与路径">
              <VectorInspector
                key={node.id}
                node={node}
                frame={nodeFrame}
                selectedCount={selectedIds.length}
                onChange={update}
                onKey={addKey}
                onBake={bakeVector}
              />
            </Section>
          )}
          <Section title="效果栈">
            <EffectInspector node={node} frame={nodeFrame} onChange={update} onKey={addKey} />
          </Section>
          <Section title="遮罩与羽化">
            <label className="select-row">
              遮罩图层
              <select
                value={node.maskId ?? ''}
                onChange={(e) => update({ maskId: e.target.value || undefined })}
              >
                <option value="">无</option>
                {scene.nodes
                  .filter((n) => n.id !== node.id && n.parentId === node.parentId)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="select-row">
              模式
              <select
                value={node.maskMode}
                onChange={(e) => update({ maskMode: e.target.value as Node['maskMode'] })}
              >
                {[
                  ['alpha', 'Alpha'],
                  ['alphaInverted', 'Alpha 反向'],
                  ['luma', '亮度'],
                  ['lumaInverted', '亮度反向'],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="羽化"
              value={node.maskFeather}
              onChange={(v) => update({ maskFeather: v })}
              onKey={() => addKey('maskFeather')}
            />
          </Section>
          {(node.type === 'text' || node.type === 'formula') && (
            <Section title={node.type === 'formula' ? '公式' : '文字排版'}>
              <textarea
                aria-label="图层文字"
                className="text-content"
                key={node.id + node.text}
                defaultValue={node.text}
                onBlur={(e) => update({ text: e.target.value })}
              />
              {node.type === 'text' && (
                <>
                  <input
                    className="full-input"
                    aria-label="字体"
                    key={node.fontFamily}
                    defaultValue={node.fontFamily}
                    onBlur={(e) => update({ fontFamily: e.target.value })}
                  />
                  <Field
                    label="字号"
                    value={node.fontSize}
                    onChange={(v) => update({ fontSize: v })}
                    onKey={() => addKey('fontSize')}
                  />
                  <div className="alignment">
                    {['left', 'center', 'right'].map((a) => (
                      <button
                        className={node.align === a ? 'pressed' : ''}
                        key={a}
                        onClick={() => update({ align: a as Node['align'] })}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </Section>
          )}
          {node.type === 'chart' && (
            <Section title="DATA">
              <textarea
                className="text-content"
                aria-label="Chart values"
                key={JSON.stringify(node.params.values)}
                defaultValue={JSON.stringify(node.params.values ?? [30, 65, 45])}
                onBlur={(e) => {
                  try {
                    const values = JSON.parse(e.target.value);
                    void update({ params: { ...node.params, values } });
                  } catch {
                    setError('Chart values must be a JSON number array');
                  }
                }}
              />
              <select
                value={String(node.params.mode ?? 'bar')}
                onChange={(e) => update({ params: { ...node.params, mode: e.target.value } })}
              >
                <option value="bar">Bar chart</option>
                <option value="line">Line chart</option>
              </select>
            </Section>
          )}
          <Section title="设计资源">
            <DesignInspector
              key={`design-${node.id}`}
              node={node}
              revision={snapshot!.revision}
              sceneId={sceneId}
              path={selectedLayer?.path ?? focusPath}
              contextFrames={nodeContextFrames}
              frame={nodeFrame}
              rpc={rpc}
              onApplied={() => run('state')}
            />
          </Section>
          <Section title="动画">
            <TrackingInspector
              key={`tracking-${node.id}`}
              node={node}
              snapshot={snapshot!}
              sceneId={sceneId}
              path={selectedLayer?.path ?? focusPath}
              contextFrames={nodeContextFrames}
              duration={activeDuration}
              rpc={rpc}
              onApplied={() => run('state')}
            />
            <GraphicsInspector
              key={`graphics-${node.id}`}
              node={node}
              onEdit={async (fields) => {
                const plan = await rpc('graphicsPlan', {
                  sceneId,
                  revision: state.snapshot.revision,
                  frame: nodeFrame,
                  targets: [
                    {
                      nodeId: node.id,
                      path: selectedLayer?.path ?? focusPath,
                      contextFrames: selectedLayer?.contextFrames ?? focusContextFrames,
                      ...fields,
                    },
                  ],
                });
                const result = await run('projectApply', plan.apply);
                if (!result) throw new Error('保存失败，请查看工程诊断');
                return result;
              }}
            />
            <Suspense fallback={<p className="hint">正在打开属性驱动…</p>}>
              <DriverInspector node={node} onChange={update} onKey={addKey} />
            </Suspense>
            <AnimationInspector
              key={node.id}
              node={node}
              frame={nodeFrame}
              onFrame={(at) => {
                const path = selectedLayer?.path ?? focusPath,
                  contexts = selectedLayer?.contextFrames ?? focusContextFrames,
                  key = `${sceneId}:${JSON.stringify(path)}${contexts.length ? `:${JSON.stringify(contexts)}` : ''}`;
                if (JSON.stringify(path) !== JSON.stringify(focusPath)) {
                  setFocusPath(path);
                  setFocusContextFrames(contexts);
                  setComposition(undefined);
                }
                setSceneFrames((current) => ({ ...current, [key]: at }));
              }}
              onEdit={(actions) => editAnimation(actions)}
            />
          </Section>
        </>
      ) : (
        <div className="empty inspector-empty">
          <Icon name="layers" size={32} />
          <p>{workspace === 'editing' ? '选择一个片段' : '选择一个图层'}</p>
          <small>
            {workspace === 'editing'
              ? '在时间轴中选择片段，或点击场景进入独立合成。'
              : '直接拖动图层移动；Ctrl 单击多选，拖动任一选中图层一起移动。空白处拖框选择。'}
          </small>
        </div>
      )}
      {jobs.length > 0 && (
        <Section title="渲染队列">
          {jobs.slice(-3).map((job) => (
            <div className="render-job" key={job.id}>
              <div>
                <span>{job.status}</span>
                <span>{Math.round(job.progress * 100)}%</span>
              </div>
              <progress max={1} value={job.progress} />
              <small>
                {job.stage}
                {job.error && ` · ${job.error}`}
              </small>
              {job.status === 'running' && (
                <button onClick={() => run('cancel', { id: job.id })}>取消</button>
              )}
              {job.status === 'completed' && window.vmotionDesktop && (
                <button onClick={() => window.vmotionDesktop!.showFile(job.output)}>
                  显示文件
                </button>
              )}
            </div>
          ))}
        </Section>
      )}
    </aside>
  );
});
