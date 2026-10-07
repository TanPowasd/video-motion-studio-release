import { AssetPanel } from './panels/AssetPanel.js';
import { InspectorPanel } from './panels/InspectorPanel.js';
import { Field, Section } from './panels/WorkbenchFields.js';
type ControllerValues = ReturnType<typeof useWorkbenchController>;
type PanelProps<K extends keyof ControllerValues> = Pick<ControllerValues, K> & {
  [P in Extract<K, 'project' | 'scene' | 'sequence' | 'state'>]: NonNullable<ControllerValues[P]>;
} & {
  selectedClip?: NonNullable<ControllerValues['sequence']>['tracks'][number]['clips'][number] & {
    trackId: string;
  };
};
import React, { lazy, Suspense } from 'react';
import type { Node } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
import { AnimationInspector } from './AnimationInspector.js';
import { AssetItem } from './AssetItem.js';
import { CanvasInteraction } from './CanvasInteraction.js';
import { CanvasViewport } from './CanvasViewport.js';
import { CodeCheck } from './CodeCheck.js';
import { CodeEditor } from './CodeEditor.js';
import { DesignInspector } from './DesignInspector.js';
import { EffectInspector } from './EffectInspector.js';
import { FilmToolbar } from './FilmToolbar.js';
import { GraphicsInspector } from './GraphicsInspector.js';
import { Icon } from './Icons.js';
import { MatrixInspector } from './MatrixInspector.js';
import { MediaManager } from './MediaManager.js';
import { ParameterInspector } from './ParameterInspector.js';
import { SceneReferenceInspector } from './SceneReferenceInspector.js';
import { TimeInspector } from './TimeInspector.js';
import { Timeline } from './Timeline.js';
import { TrackingInspector } from './TrackingInspector.js';
import { VectorInspector } from './VectorInspector.js';
import { VisualAuditPanel } from './VisualAuditPanel.js';
import { WorkbenchHeader } from './WorkbenchHeader.js';
import { openMcpConnection } from './McpConnection.js';
import { Splitter } from './panelLayout.js';
import { rpc } from './state/rpc-client.js';
import { useWorkbenchController } from './state/workbench-controller.js';
import { mergeApplicationState } from './state/workbench-effects.js';
import './studio-shell.css';
import './workbench.css';
const StudioWorkspace = lazy(() =>
  import('./studio/StudioWorkspace.js').then((m) => ({ default: m.StudioWorkspace })),
);
const DriverInspector = lazy(() =>
  import('./DriverInspector.js').then((m) => ({ default: m.DriverInspector })),
);
const DrawingWorkspace = lazy(() =>
  import('./DrawingWorkspace.js').then((m) => ({ default: m.DrawingWorkspace })),
);
const SoundEditor = lazy(() =>
  import('./SoundEditor.js').then((m) => ({ default: m.SoundEditor })),
);
const PluginManager = lazy(() =>
  import('./PluginManager.js').then((m) => ({ default: m.PluginManager })),
);
const uid = () => crypto.randomUUID();
export function Workbench() {
  const {
    state,
    project,
    scene,
    sequence,
    error,
    clipSelected,
    workspace,
    snapshot,
    drawingId,
    run,
    setDrawingId,
    setWorkspace,
    setAssetTab,
    layout,
    saving,
    setStudioTab,
    setPlaying,
    returnProject,
    setModal,
    setPluginManaging,
    setError,
    setLayout,
    resetLayout,
    assetTab,
    focusPath,
    filter,
    setFilter,
    setMediaManaging,
    setSoundEditing,
    importAsset,
    selectedAsset,
    setSelectedAsset,
    placeAsset,
    sequenceFrame,
    stateRef,
    setClipSelected,
    transact,
    setSceneId,
    setSelected,
    sceneId,
    enterScene,
    fps,
    selectedIds,
    select,
    enterGroup,
    codeBusy,
    setCodePath,
    setCodeDirty,
    studioTab,
    frame,
    clipSelection,
    editSequenceActions,
    setFocusPath,
    setFocusContextFrames,
    setComposition,
    rootScene,
    composition,
    focusContextFrames,
    paintColor,
    setPaintColor,
    brush,
    setBrush,
    hold,
    setHold,
    onion,
    setOnion,
    codePath,
    addNode,
    editStructure,
    createRepeated,
    createSharedScene,
    insertSharedScene,
    codeBase,
    checkCode,
    codeDirty,
    previewMedia,
    setPreviewMedia,
    previewQuality,
    setPreviewQuality,
    visualCheckBusy,
    playing,
    checkVisual,
    code,
    codeJump,
    setCode,
    codeDrafts,
    draftKey,
    setCodeCheck,
    codeCheck,
    setCodeJump,
    viewWidth,
    viewHeight,
    previewRef,
    pointerDown,
    pointerMove,
    pointerUp,
    strokeRef,
    setStroke,
    attachPreviewCanvas,
    previewFrame,
    previewReady,
    interactions,
    scopeKey,
    selectMany,
    setCanvasDraft,
    setSaving,
    stroke,
    visualCheck,
    setVisualCheck,
    setSceneFrames,
    nodeFrame,
    selectedLayer,
    nodeContextFrames,
    setState,
    inspectorTab,
    setInspectorTab,
    node,
    update,
    componentParams,
    editParameters,
    editTime,
    addKey,
    bakeVector,
    activeDuration,
    editAnimation,
    jobs,
    selected,
    setFrame,
    selectClip,
    waveforms,
    playback,
    soundEditing,
    mediaManaging,
    pluginManaging,
    modal,
    format,
    setFormat,
    setExportPath,
    exportPath,
    exportGpu,
    setExportGpu,
    setJobs,
  } = useWorkbenchController();
  if (!state || !project || !scene || !sequence)
    return (
      <div className="loading">
        <div className="brand-mark">V</div>
        <h2>正在打开工作区</h2>
        <p>{error || '正在读取本地工程…'}</p>
      </div>
    );
  const selectedClip = sequence.tracks
    .flatMap((t) => t.clips.map((c) => ({ ...c, trackId: t.id })))
    .find((c) => c.id === clipSelected);
  if (workspace === 'drawing')
    return (
      <DrawingWorkspace
        snapshot={snapshot!}
        initialId={drawingId}
        run={run}
        onDocument={setDrawingId}
        onExit={() => setWorkspace('animation')}
        onPublish={() => {
          setAssetTab(true);
        }}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        error={error || state.diagnostics.find((d) => d.severity === 'error')?.message}
      />
    );
  return (
    <div
      className={`app ${!layout.showLeft ? 'hide-left' : ''} ${!layout.showRight ? 'hide-right' : ''}`}
      style={
        {
          '--left-width': `${layout.left}px`,
          '--right-width': `${layout.right}px`,
          '--timeline-height': `${layout.timeline}px`,
        } as React.CSSProperties
      }
    >
      <WorkbenchHeader
        projectName={project.name}
        workspace={workspace}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        saving={saving}
        error={error}
        showLeft={layout.showLeft}
        showRight={layout.showRight}
        onWorkspace={(id) => {
          setStudioTab(undefined);
          setPlaying(false);
          if (id === 'editing') returnProject();
          else setWorkspace(id);
        }}
        onTools={() => {
          setPlaying(false);
          setStudioTab('graph');
        }}
        onModal={(value) => (value === 'connect' ? openMcpConnection() : setModal(value))}
        onUndo={() => void run('undo')}
        onRedo={() => void run('redo')}
        onPlugin={() => setPluginManaging(true)}
        onError={setError}
        onPause={() => setPlaying(false)}
        onLayout={(side) =>
          setLayout((v) => ({
            ...v,
            [side === 'left' ? 'showLeft' : 'showRight']:
              !v[side === 'left' ? 'showLeft' : 'showRight'],
          }))
        }
        onReset={resetLayout}
      />
      <AssetPanel
        assetTab={assetTab}
        setAssetTab={setAssetTab}
        project={project}
        focusPath={focusPath}
        filter={filter}
        setFilter={setFilter}
        setMediaManaging={setMediaManaging}
        setSoundEditing={setSoundEditing}
        importAsset={importAsset}
        snapshot={snapshot}
        selectedAsset={selectedAsset}
        setSelectedAsset={setSelectedAsset}
        placeAsset={placeAsset}
        workspace={workspace}
        run={run}
        sequence={sequence}
        sequenceFrame={sequenceFrame}
        stateRef={stateRef}
        setWorkspace={setWorkspace}
        setClipSelected={setClipSelected}
        setDrawingId={setDrawingId}
        transact={transact}
        setSceneId={setSceneId}
        setSelected={setSelected}
        sceneId={sceneId}
        enterScene={enterScene}
        fps={fps}
        scene={scene}
        selectedIds={selectedIds}
        select={select}
        enterGroup={enterGroup}
        codeBusy={codeBusy}
        setCodePath={setCodePath}
        setCodeDirty={setCodeDirty}
        setPlaying={setPlaying}
      />
      <Splitter
        label="调整工程面板宽度"
        direction="vertical"
        value={layout.left}
        min={180}
        max={420}
        onChange={(left) => setLayout((v) => ({ ...v, left }))}
      />
      <main className={'main-panel' + (studioTab ? ' studio-open' : '')}>
        {workspace === 'editing' && (
          <FilmToolbar
            sequence={sequence}
            frame={frame}
            selectedClipIds={clipSelection}
            onEdit={editSequenceActions}
            onCaptions={async (content, format) => {
              setPlaying(false);
              return run('captionsImport', {
                sequenceId: sequence.id,
                content,
                format,
                revision: stateRef.current?.snapshot.revision,
              });
            }}
          />
        )}
        <nav className="composition-breadcrumb" aria-label="合成导航">
          <button onClick={returnProject}>
            <Icon name="film" size={13} />
            工程总览
          </button>
          {workspace !== 'editing' && (
            <>
              <Icon name="arrow" size={11} />
              <button
                onClick={() => {
                  setFocusPath([]);
                  setFocusContextFrames([]);
                  setComposition(undefined);
                }}
              >
                {rootScene?.name}
              </button>
              {focusPath.map((id, index) => (
                <React.Fragment key={id}>
                  <Icon name="arrow" size={11} />
                  <button
                    onClick={() => {
                      setFocusPath((path) => path.slice(0, index + 1));
                      setFocusContextFrames((contexts) => contexts.slice(0, index + 1));
                      setSelected('');
                    }}
                  >
                    {composition?.breadcrumbs[index]?.name ?? id.split('/').at(-1)}
                  </button>
                </React.Fragment>
              ))}
              <span className="scope-badge">
                独立合成 · 内容时间 · {scene?.duration ?? 0} 帧
                {focusContextFrames.length
                  ? ` · 父帧 ${focusContextFrames.at(-1)!.toFixed(1)}`
                  : ''}
              </span>
            </>
          )}
        </nav>
        <div className="canvas-toolbar">
          <div className="tool-group">
            {workspace === 'drawing' ? (
              <>
                <Icon name="brush" />
                <input
                  aria-label="笔刷颜色"
                  type="color"
                  value={paintColor}
                  onChange={(e) => setPaintColor(e.target.value)}
                />
                <label>
                  笔刷{' '}
                  <input
                    aria-label="笔刷大小"
                    type="number"
                    value={brush}
                    min={1}
                    max={100}
                    onChange={(e) => setBrush(Number(e.target.value))}
                  />
                </label>
                <label>
                  持帧{' '}
                  <input
                    aria-label="持帧帧数"
                    type="number"
                    value={hold}
                    min={1}
                    onChange={(e) => setHold(Number(e.target.value))}
                  />
                </label>
                <button className={onion ? 'pressed' : ''} onClick={() => setOnion(!onion)}>
                  洋葱皮
                </button>
              </>
            ) : workspace === 'code' ? (
              <>
                <Icon name="code" />
                <span>{codePath}</span>
                <span className="tag">TYPESCRIPT</span>
              </>
            ) : (
              <>
                {[
                  ['text', 'Text'],
                  ['rect', 'Shape'],
                  ['ellipse', 'Ellipse'],
                  ['formula', 'Formula'],
                  ['chart', 'Chart'],
                ].map(([type, label]) => (
                  <button
                    key={type}
                    title={`Add ${label}`}
                    aria-label={label}
                    onClick={() => addNode(type as Node['type'])}
                  >
                    <Icon name={type === 'formula' ? 'text' : type} size={17} />
                    <span>{label}</span>
                  </button>
                ))}
                {workspace === 'animation' && (
                  <>
                    <span className="toolbar-separator" />
                    <button
                      title="编组 · Ctrl+G"
                      aria-label="编组"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('group')}
                    >
                      <Icon name="layers" />
                    </button>
                    <button
                      title="复制图层 · Ctrl+D"
                      aria-label="复制图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('duplicate', { offset: { x: 0, y: 0 } })}
                    >
                      <Icon name="copy" />
                    </button>
                    <button
                      title="从选中图层创建重复器，保留并隐藏来源"
                      aria-label="创建重复器"
                      disabled={!selectedIds.length || saving}
                      onClick={createRepeated}
                    >
                      <Icon name="repeat" />
                    </button>
                    <button
                      title="将选中图层预合成为可复用共享场景"
                      aria-label="生成共享场景"
                      disabled={!selectedIds.length || saving}
                      onClick={createSharedScene}
                    >
                      <Icon name="scene" />
                    </button>
                    <select
                      aria-label="添加共享场景"
                      title="添加已存在的共享场景"
                      value=""
                      disabled={saving}
                      className="scene-place-select"
                      onChange={(e) => {
                        void insertSharedScene(e.target.value);
                      }}
                    >
                      <option value="">引用场景…</option>
                      {snapshot!.scenes
                        .filter((s) => s.id !== sceneId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                    <button
                      title="删除图层 · Delete"
                      aria-label="删除图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('delete')}
                    >
                      <Icon name="delete" />
                    </button>
                    <button
                      title="上移一层"
                      aria-label="上移图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('order', { direction: 'up' })}
                    >
                      <Icon name="up" />
                    </button>
                    <button
                      title="下移一层"
                      aria-label="下移图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('order', { direction: 'down' })}
                    >
                      <Icon name="down" />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="top-spacer" />
          {workspace === 'code' ? (
            <>
              <button
                className="compact"
                disabled={codeBusy || !codeBase}
                onClick={() => checkCode()}
              >
                {' '}
                {codeBusy ? '检查中…' : '预检代码'}{' '}
              </button>
              <button
                className="primary compact"
                disabled={!codeDirty || codeBusy || !codeBase}
                onClick={() => checkCode(true)}
              >
                保存组件
              </button>
            </>
          ) : (
            <span className="preview-quality">
              <select
                aria-label="素材预览方式"
                value={previewMedia}
                onChange={(e) => setPreviewMedia(e.target.value as 'auto' | 'original')}
              >
                <option value="auto">代理优先</option>
                <option value="original">原始素材</option>
              </select>
              <span />
              <select
                aria-label="预览质量"
                value={previewQuality}
                onChange={(e) => setPreviewQuality(Number(e.target.value))}
              >
                {[480, 720, 960, 1280, 1920].map((width) => (
                  <option key={width} value={width}>
                    稳定预览 · {width}px
                  </option>
                ))}
              </select>
            </span>
          )}
          {workspace === 'animation' && (
            <button className="compact" disabled={visualCheckBusy || playing} onClick={checkVisual}>
              {visualCheckBusy ? '画面检查中…' : '检查画面'}
            </button>
          )}
        </div>
        {workspace === 'code' ? (
          <>
            <CodeEditor
              key={codePath}
              value={code}
              readOnly={codeBusy}
              jumpTo={codeJump}
              onChange={(value) => {
                setCode(value);
                setCodeDirty(true);
                const draft = { content: value, base: codeBase };
                codeDrafts.current.set(codePath, draft);
                try {
                  sessionStorage.setItem(draftKey(codePath), JSON.stringify(draft));
                } catch {}
                setCodeCheck(undefined);
              }}
            />
            {codeCheck && (
              <CodeCheck
                report={codeCheck}
                onClose={() => setCodeCheck(undefined)}
                onJump={(d) => {
                  if (d.line && d.file?.replace(/\\/g, '/').endsWith(codePath))
                    setCodeJump({ line: d.line, column: d.column });
                  else setError(`${d.file ?? '工程'} ${d.path ?? ''}: ${d.message}`);
                }}
              />
            )}
          </>
        ) : (
          <>
            <CanvasViewport
              width={viewWidth}
              height={viewHeight}
              name={workspace === 'editing' ? sequence.name : scene.name}
              onStageRef={(element) => {
                previewRef.current = element;
              }}
            >
              <div
                className="canvas-interaction"
                style={{ width: '100%', height: '100%' }}
                onPointerDown={pointerDown}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-vmotion-asset')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('application/x-vmotion-asset'),
                    asset = project.assets.find((a) => a.id === id);
                  if (!asset) return;
                  e.preventDefault();
                  const b = previewRef.current!.getBoundingClientRect();
                  void placeAsset(asset, {
                    x: ((e.clientX - b.left) / b.width) * viewWidth,
                    y: ((e.clientY - b.top) / b.height) * viewHeight,
                  });
                }}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  strokeRef.current = [];
                  setStroke([]);
                }}
              >
                {onion && workspace === 'drawing' && (
                  <>
                    <img
                      className="onion previous"
                      src={`/api/frame?frame=${Math.max(0, frame - hold)}&width=960&height=540&scene=${sceneId}`}
                      alt="Previous exposure"
                    />
                    <img
                      className="onion next"
                      src={`/api/frame?frame=${frame + hold}&width=960&height=540&scene=${sceneId}`}
                      alt="Next exposure"
                    />
                  </>
                )}
                <canvas
                  ref={attachPreviewCanvas}
                  className="rendered-frame"
                  role="img"
                  aria-label={`Native rendered frame ${previewFrame}`}
                  data-preview-frame={previewFrame}
                />
                {!previewReady && <div className="preview-placeholder">正在渲染场景…</div>}
                {workspace === 'animation' &&
                  !playing &&
                  interactions &&
                  interactions.revision === snapshot!.revision &&
                  interactions.frame === frame &&
                  interactions.sceneId === sceneId &&
                  JSON.stringify(interactions.path) === JSON.stringify(focusPath) && (
                    <CanvasInteraction
                      key={scopeKey}
                      graph={interactions}
                      selection={selectedIds}
                      frame={frame}
                      width={viewWidth}
                      height={viewHeight}
                      stage={previewRef}
                      onSelect={selectMany}
                      onDraft={setCanvasDraft}
                      onEnter={enterGroup}
                      onCommit={async (draft, revision) => {
                        setSaving(true);
                        try {
                          return await run('compositionTransactBatch', {
                            sceneId,
                            frame,
                            edits: draft,
                            revision,
                          });
                        } finally {
                          setSaving(false);
                        }
                      }}
                    />
                  )}
                {workspace === 'drawing' && (
                  <svg
                    className="stroke-overlay"
                    viewBox={`0 0 ${project.width} ${project.height}`}
                  >
                    <polyline
                      points={stroke.map((p) => `${p.x},${p.y}`).join(' ')}
                      stroke={paintColor}
                      strokeWidth={brush}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            </CanvasViewport>
            {visualCheck &&
              visualCheck.sceneId === sceneId &&
              JSON.stringify(visualCheck.path) === JSON.stringify(focusPath) &&
              workspace === 'animation' && (
                <VisualAuditPanel
                  report={visualCheck}
                  revision={snapshot!.revision}
                  onClose={() => setVisualCheck(undefined)}
                  onFinding={(finding) => {
                    setPlaying(false);
                    const path = finding.path,
                      contexts = finding.contextFrames ?? focusContextFrames,
                      at = Math.round(finding.localFrame ?? finding.frame),
                      key = `${sceneId}:${JSON.stringify(path)}${contexts.length ? `:${JSON.stringify(contexts)}` : ''}`;
                    setFocusPath(path);
                    setFocusContextFrames(contexts);
                    setComposition(undefined);
                    setSceneFrames((current) => ({ ...current, [key]: at }));
                    if (finding.nodeId) select(finding.nodeId);
                    setVisualCheck(undefined);
                  }}
                />
              )}
          </>
        )}
        {studioTab && (
          <Suspense fallback={<div className="studio-loading">正在打开创作工具…</div>}>
            <StudioWorkspace
              tab={studioTab}
              onTab={setStudioTab}
              onClose={() => setStudioTab(undefined)}
              context={{
                snapshot: snapshot!,
                sceneId,
                node,
                nodes: scene.nodes,
                frame: nodeFrame,
                path: selectedLayer?.path ?? focusPath,
                contextFrames: nodeContextFrames,
                selected: selectedIds.map((id) => {
                  const layer = interactions?.layers.find((l) => l.node.id === id);
                  return {
                    nodeId: id,
                    path: layer?.path ?? focusPath,
                    contextFrames: layer?.contextFrames ?? focusContextFrames,
                    frame: layer?.frame ?? frame,
                  };
                }),
                run: async (method, params) => {
                  try {
                    const result = await rpc(method, params);
                    setState((s) => mergeApplicationState(s, result));
                    return result;
                  } catch (e) {
                    setError((e as Error).message);
                    throw e;
                  }
                },
                onApplied: () => setStudioTab(undefined),
              }}
            />
          </Suspense>
        )}
      </main>
      <Splitter
        label="调整属性面板宽度"
        direction="vertical"
        value={layout.right}
        min={240}
        max={480}
        invert
        onChange={(right) => setLayout((v) => ({ ...v, right }))}
      />
      <InspectorPanel
        inspectorTab={inspectorTab}
        workspace={workspace}
        setInspectorTab={setInspectorTab}
        selectedClip={selectedClip}
        transact={transact}
        sequence={sequence}
        editSequenceActions={editSequenceActions}
        node={node}
        update={update}
        selectedIds={selectedIds}
        enterGroup={enterGroup}
        snapshot={snapshot}
        sceneId={sceneId}
        enterScene={enterScene}
        run={run}
        interactions={interactions}
        focusPath={focusPath}
        nodeFrame={nodeFrame}
        nodeContextFrames={nodeContextFrames}
        stateRef={stateRef}
        componentParams={componentParams}
        editParameters={editParameters}
        setCodePath={setCodePath}
        setCodeDirty={setCodeDirty}
        setWorkspace={setWorkspace}
        setPlaying={setPlaying}
        editTime={editTime}
        addKey={addKey}
        bakeVector={bakeVector}
        scene={scene}
        setError={setError}
        selectedLayer={selectedLayer}
        activeDuration={activeDuration}
        state={state}
        focusContextFrames={focusContextFrames}
        setFocusPath={setFocusPath}
        setFocusContextFrames={setFocusContextFrames}
        setComposition={setComposition}
        setSceneFrames={setSceneFrames}
        editAnimation={editAnimation}
        jobs={jobs}
      />
      <Splitter
        label="调整时间轴高度"
        direction="horizontal"
        value={layout.timeline}
        min={150}
        max={500}
        invert
        onChange={(timeline) => setLayout((v) => ({ ...v, timeline }))}
      />
      <Timeline
        snapshot={snapshot!}
        scene={scene}
        sequence={sequence}
        sequenceMode={workspace === 'editing'}
        frame={frame}
        selected={selected}
        selection={selectedIds}
        playing={playing}
        onFrame={setFrame}
        onPlaying={setPlaying}
        onSelect={select}
        onScene={setSceneId}
        onClip={selectClip}
        clipSelection={clipSelection}
        onSequenceEdit={editSequenceActions}
        selectedClip={clipSelected}
        transact={transact}
        waveforms={waveforms}
        audioMonitor={{
          status: playback.status,
          muted: playback.muted,
          volume: playback.volume,
          onMute: () => playback.setMuted((value) => !value),
          onVolume: playback.setVolume,
          enabled: workspace === 'editing',
        }}
        onAssetDrop={async (assetId, at, trackId) => {
          const result = await run('assetPlace', {
            assetId,
            frame: at,
            revision: stateRef.current?.snapshot.revision,
            ...(workspace === 'editing'
              ? { sequenceId: sequence.id }
              : { sceneId, path: focusPath, contextFrames: focusContextFrames }),
          });
          if (result?.nodeId) select(result.nodeId);
          if (result?.clipId) setClipSelected(result.clipId);
          return result;
        }}
        onAnimationEdit={async (edits, revision) => {
          setSaving(true);
          try {
            return await run('animationEdit', {
              sceneId,
              frame,
              revision: revision ?? stateRef.current?.snapshot.revision,
              edits: edits.map((edit) => ({
                ...edit,
                path:
                  interactions?.layers.find((l) => l.node.id === edit.nodeId)?.path ?? focusPath,
                contextFrames:
                  interactions?.layers.find((l) => l.node.id === edit.nodeId)?.contextFrames ??
                  focusContextFrames,
                frame: interactions?.layers.find((l) => l.node.id === edit.nodeId)?.frame ?? frame,
              })),
            });
          } finally {
            setSaving(false);
          }
        }}
      />
      <footer className="statusbar">
        <span>
          <span className="status-dot" />
          工程服务已连接
        </span>
        <span>{error || `${scene.nodes.length} 图层 · ${project.assets.length} 素材`}</span>
        <div className="top-spacer" />
        <span>
          {project.width} × {project.height} · {fps.toFixed(2)} fps
        </span>
        <span className="mono">{snapshot!.revision.slice(0, 8)}</span>
      </footer>
      {(state.diagnostics.length > 0 || state.conflicts.length > 0) && (
        <div className="diagnostics">
          <strong>{state.conflicts.length ? '文件冲突' : '工程诊断'}</strong>
          {state.conflicts.map((c, i) => (
            <div key={i}>
              <span>
                {c.file} {c.path}
              </span>
              <button onClick={() => run('resolve', { index: i, choice: 'ours' })}>
                保留界面版本
              </button>
              <button onClick={() => run('resolve', { index: i, choice: 'theirs' })}>
                采用文件版本
              </button>
            </div>
          ))}
          {state.diagnostics.map((d, i) => (
            <p key={i}>
              {d.code}: {d.message}
            </p>
          ))}
        </div>
      )}
      {soundEditing && (
        <SoundEditor
          key={soundEditing}
          assetId={soundEditing}
          snapshot={snapshot!}
          run={run}
          onClose={() => setSoundEditing(undefined)}
          onSaved={setSelectedAsset}
        />
      )}
      {mediaManaging && <MediaManager run={run} onClose={() => setMediaManaging(false)} />}
      {pluginManaging && (
        <PluginManager
          run={run}
          revision={snapshot!.revision}
          onClose={() => setPluginManaging(false)}
        />
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(undefined)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              aria-label="Close dialog"
              onClick={() => setModal(undefined)}
            >
              <Icon name="close" />
            </button>
            {modal === 'export' ? (
              <>
                <span className="eyebrow">让想法成为影片</span>
                <h2>导出你的作品</h2>
                <p>基于固定工程版本，在本地渲染。</p>
                <label className="modal-field">
                  格式
                  <select
                    value={format}
                    onChange={(e) => {
                      setFormat(e.target.value);
                      setExportPath(
                        `${state.root}/exports/${e.target.value === 'png' ? 'frames' : `video.${e.target.value}`}`,
                      );
                    }}
                  >
                    <option value="mp4">MP4 视频</option>
                    <option value="png">PNG 图像序列</option>
                    <option value="wav">WAV 音频</option>
                  </select>
                </label>
                <label className="modal-field">
                  输出路径
                  <input value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
                </label>
                <label className="modal-field">
                  特效渲染设备
                  <select
                    aria-label="导出渲染设备"
                    value={exportGpu}
                    onChange={(e) => setExportGpu(e.target.value)}
                  >
                    <option value="auto">自动选择</option>
                    <option value="cpu">CPU</option>
                    <option value="gpu">要求硬件 GPU</option>
                  </select>
                </label>
                <div className="export-summary">
                  <span>
                    分辨率
                    <strong>
                      {project.width} × {project.height}
                    </strong>
                  </span>
                  <span>
                    时长<strong>{(sequence.duration / fps).toFixed(1)} sec</strong>
                  </span>
                  <span>
                    帧率<strong>{fps.toFixed(2)} fps</strong>
                  </span>
                </div>
                <button
                  className="primary modal-primary"
                  onClick={async () => {
                    const result = await run('render', {
                      output: exportPath,
                      format,
                      gpu: exportGpu,
                      revision: stateRef.current?.snapshot.revision,
                      ...(sequence.workArea
                        ? { start: sequence.workArea.start, end: sequence.workArea.end }
                        : {}),
                    });
                    if (result) {
                      setJobs((j) => [...j, result]);
                      setModal(undefined);
                    }
                  }}
                >
                  <Icon name="export" />
                  开始本地渲染
                </button>
              </>
            ) : modal === 'connect' ? (
              <>
                <span className="eyebrow">外部工具</span>
                <h2>连接你的 agent</h2>
                <p>
                  外部 agent 可以直接修改工程文件，也可通过本地 MCP 检查工程、执行编辑并获取画面。
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      mcpServers: {
                        vmotion: state.connection,
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
                <button
                  className="secondary"
                  onClick={() => navigator.clipboard.writeText(state.root)}
                >
                  复制工程路径
                </button>
              </>
            ) : (
              <>
                <span className="eyebrow">工程设置</span>
                <h2>工程画布</h2>
                <Field
                  label="宽度"
                  value={project.width}
                  onChange={(v) => transact([{ type: 'updateProject', patch: { width: v } }])}
                />
                <Field
                  label="高度"
                  value={project.height}
                  onChange={(v) => transact([{ type: 'updateProject', patch: { height: v } }])}
                />
                <Field
                  label="FPS numerator"
                  value={project.fps.num}
                  onChange={(v) =>
                    transact([
                      { type: 'updateProject', patch: { fps: { ...project.fps, num: v } } },
                    ])
                  }
                />
                <Field
                  label="FPS denominator"
                  value={project.fps.den}
                  onChange={(v) =>
                    transact([
                      { type: 'updateProject', patch: { fps: { ...project.fps, den: v } } },
                    ])
                  }
                />
                <Field
                  label="序列帧数"
                  value={sequence.duration}
                  onChange={(v) =>
                    transact([
                      { type: 'updateSequence', sequenceId: sequence.id, patch: { duration: v } },
                    ])
                  }
                />
                <p>SDR · sRGB · 48 kHz audio</p>
                <p>新建或打开其他工程请使用顶部项目入口（Ctrl+N / Ctrl+O）。</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
