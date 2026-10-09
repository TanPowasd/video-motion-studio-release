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
import React, { lazy, Suspense, useEffect, useState } from 'react';
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
import { StudioTopBar, type AgentStatus, type Crumb, type MoreAction } from './studio-ui/StudioTopBar.js';
import { SceneStrip } from './studio-ui/SceneStrip.js';
import { ChangeFeed, DiffDialog, type FeedFilter } from './studio-ui/ChangeFeed.js';
import { StageOverlays } from './studio-ui/StageOverlays.js';
import {
  MODES,
  inferMode,
  modeFromShortcut,
  readLayout,
  responsive,
  studioDefaults,
  studioLimits,
  writeLayout,
  type StudioLayout,
  type StudioMode,
} from './studio-ui/model.js';
import {
  clipHighlights,
  isHead,
  nodeHighlights,
  revealTarget,
  sceneBadges,
  groupChanges,
  undoStepsFor,
  type ChangeEntry,
  type ChangeTarget,
  type FeedGroup,
} from './studio-ui/change-feed.js';
import { compositionUrl } from './navigation.js';
import './studio-ui/studio-ui.css';
import { openMcpConnection } from './McpConnection.js';
import { Splitter, panelDefaults, panelLimits } from './panelLayout.js';
import { CommandPalette, ShortcutSheet, type PaletteCommand } from './CommandPalette.js';
import { studioTabs } from './studio/types.js';
import { rpc } from './state/rpc-client.js';
import { useWorkbenchController } from './state/workbench-controller.js';
import { mergeApplicationState } from './state/workbench-effects.js';
import './workbench.css';
import './studio-shell.css';
import { NewImageDialog, type NewImageSettings } from './still/NewImageDialog.js';
import { ImageExportDialog } from './still/ImageExportDialog.js';
import {
  ArtboardGuides,
  ArtboardInspector,
  ArtboardRulers,
  ImageToolbar,
  defaultArtboardView,
  type AlignReference,
  type ArtboardView,
} from './still/ImageWorkspace.js';
import { alignDrafts, stillGuides, type AlignMode } from '../core/still.js';
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
const MusicWorkspace = lazy(() => import('./music/MusicWorkspace.js'));
const GlyphPanel = lazy(() =>
  import('./glyphs/GlyphPanel.js').then((m) => ({ default: m.GlyphPanel })),
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
  const [overlay, setOverlay] = useState<'palette' | 'shortcuts'>();
  const [imageDialog, setImageDialog] = useState<'new' | 'export'>();
  const [artboardView, setArtboardViewState] = useState<ArtboardView>(() => {
    try {
      return { ...defaultArtboardView, ...JSON.parse(localStorage.getItem('vmotion.artboardView') ?? '{}') };
    } catch {
      return defaultArtboardView;
    }
  });
  const setArtboardView = (view: ArtboardView) => {
    setArtboardViewState(view);
    try {
      localStorage.setItem('vmotion.artboardView', JSON.stringify(view));
    } catch {}
  };
  const [alignReference, setAlignReference] = useState<AlignReference>('auto');
  const [stillBusy, setStillBusy] = useState(false);
  const stillMode = workspace === 'animation' && !!rootScene?.still;
  const stillScene = stillMode
    ? rootScene
    : snapshot?.scenes.find((s) => s.still && s.id === sceneId) ??
      snapshot?.scenes.find((s) => s.still);
  /** Throwing RPC call that still merges the returned application state. */
  const call = async (method: string, params: unknown = {}): Promise<any> => {
    const result: any = await rpc(method, params);
    setState((s) => mergeApplicationState(s, result));
    return result;
  };
  const stillCommit = async (actions: unknown[]) => {
    setStillBusy(true);
    try {
      const plan = await call('stillPlan', {
        revision: stateRef.current?.snapshot.revision,
        actions,
      });
      if (plan.unchanged) return plan;
      const applied = await call('projectApply', plan.apply);
      if (!applied?.valid && applied?.valid !== undefined)
        throw new Error(applied.diagnostics?.[0]?.message ?? '画板修改未通过检查');
      return plan;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setStillBusy(false);
    }
  };
  const createImage = async (settings: NewImageSettings) => {
    const id = `image-${uid().slice(0, 8)}`;
    const plan = await call('stillPlan', {
      revision: stateRef.current?.snapshot.revision,
      actions: [
        {
          action: 'create',
          sceneId: id,
          name: settings.name,
          template: settings.template,
          ...(settings.preset ? { preset: settings.preset } : {}),
          width: settings.width,
          height: settings.height,
        },
      ],
    });
    await call('projectApply', plan.apply);
    setImageDialog(undefined);
    setStudioTab(undefined);
    enterScene(id);
  };
  const alignSelection = async (mode: AlignMode) => {
    if (!interactions || !rootScene?.still || !project) return;
    const g = stillGuides(rootScene, project),
      reference =
        alignReference === 'auto'
          ? selectedIds.length > 1
            ? 'selection'
            : g.still.safeArea > 0
              ? g.safe
              : g.trim
          : alignReference === 'selection'
            ? 'selection'
            : g[alignReference === 'canvas' ? 'canvas' : alignReference],
      drafts = alignDrafts(interactions.layers, selectedIds, mode, reference, frame);
    if (!drafts.length) return;
    setSaving(true);
    try {
      await run('compositionTransactBatch', {
        sceneId,
        frame,
        edits: drafts,
        revision: stateRef.current?.snapshot.revision,
      });
    } finally {
      setSaving(false);
    }
  };
  const autoEntered = React.useRef(false);
  useEffect(() => {
    if (autoEntered.current || !project || !snapshot) return;
    autoEntered.current = true;
    const first = snapshot.scenes.find((s) => s.still);
    if (project.kind === 'still' && first && workspace === 'editing') enterScene(first.id);
  }, [project?.id]);
  const [pluginView, setPluginView] = useState<'list' | 'install'>('list');
  const openPlugins = (view: 'list' | 'install' = 'list') => {
    setPluginView(view);
    setPluginManaging(true);
  };
  const toggleLayout = (side: 'left' | 'right' | 'timeline') => {
    const key = side === 'left' ? 'showLeft' : side === 'right' ? 'showRight' : 'showTimeline';
    setStudio((v) => ({ [key]: !v[key] }));
    if (side === 'right' && fit.rightDrawer) setDrawerOpen((v) => !v);
  };
  const resetStudioLayout = () =>
    setStudio((v) => ({ ...studioDefaults, mode: v.mode, followAi: v.followAi }));
  // ── Studio shell state (modes, per-project layout, change feed) ─────────────────────
  const projectId = project?.id ?? '';
  const [studio, setStudioState] = useState<StudioLayout>(() => ({ ...studioDefaults }));
  const studioLoaded = React.useRef('');
  useEffect(() => {
    if (!projectId || studioLoaded.current === projectId) return;
    studioLoaded.current = projectId;
    setStudioState(readLayout(localStorage, projectId));
  }, [projectId]);
  const setStudio = (patch: Partial<StudioLayout> | ((s: StudioLayout) => Partial<StudioLayout>)) =>
    setStudioState((s) => {
      const next = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) };
      if (studioLoaded.current) writeLayout(localStorage, studioLoaded.current, next);
      return next;
    });
  const mode = studio.mode;
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  // Music is a full multi-panel app of its own: give it the width and turn the change
  // feed / inspector column into the overlay drawer while in music mode.
  const fit = mode === 'music' && workspace !== 'code' ? { ...responsive(viewportWidth), rightDrawer: true } : responsive(viewportWidth);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const changeLog: ChangeEntry[] = (state as { changeLog?: ChangeEntry[] } | undefined)?.changeLog ?? [];
  const agents = (state as { agents?: AgentStatus } | undefined)?.agents;
  const reviewKey = `vmotion.studio.reviewed.${projectId}`;
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!projectId) return;
    try {
      setReviewed(new Set(JSON.parse(localStorage.getItem(reviewKey) ?? '[]')));
    } catch {
      setReviewed(new Set());
    }
  }, [projectId]);
  const markReviewed = (ids: string[]) =>
    setReviewed((current) => {
      const next = new Set([...current, ...ids]);
      try {
        localStorage.setItem(reviewKey, JSON.stringify([...next].slice(-500)));
      } catch {}
      return next;
    });
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [feedFocus, setFeedFocus] = useState<string>();
  const [diffGroup, setDiffGroup] = useState<FeedGroup>();
  const [feedBusy, setFeedBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const highlights = React.useMemo(() => nodeHighlights(changeLog, reviewed, now), [changeLog, reviewed, now]);
  const clipLights = React.useMemo(() => clipHighlights(changeLog, reviewed, now), [changeLog, reviewed, now]);
  const badges = React.useMemo(() => sceneBadges(changeLog, reviewed, now), [changeLog, reviewed, now]);
  const lastExternal = React.useMemo(() => {
    const e = [...changeLog].reverse().find((x) => x.kind !== 'ui');
    return e ? { at: e.at, label: e.files[0] ?? '工程' } : undefined;
  }, [changeLog]);
  const head = snapshot?.revision ?? '';
  const musicHash = React.useRef('#/music');
  /** Keeps the mode pill truthful when a route or an existing action changes workspace. */
  useEffect(() => {
    if (!project) return;
    const sync = () => {
      const inferred = inferMode(mode, workspace, location.hash, stillMode);
      if (inferred !== mode) setStudio({ mode: inferred });
      if (location.hash.startsWith('#/music')) {
        musicHash.current = location.hash;
        // Arriving at music (URL or Ctrl+4) from the code overlay must actually show music.
        if (workspace === 'code') setWorkspace('animation');
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [workspace, stillMode, sceneId, project?.id, mode]);
  const setHash = (hash: string) => {
    if (location.hash === hash) return;
    window.history.pushState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  const leaveMusic = () => {
    if (!location.hash.startsWith('#/music')) return;
    setHash(workspace === 'editing' ? '#/project' : compositionUrl(sceneId, focusPath, focusContextFrames));
  };
  const motionScene = () =>
    (!snapshot?.scenes.find((s) => s.id === sceneId)?.still ? sceneId : undefined) ??
    snapshot?.scenes.find((s) => !s.still)?.id;
  const switchMode = (next: StudioMode) => {
    setPlaying(false);
    setStudioTab(undefined);
    setPreviewing(false);
    if (next === 'music') {
      setStudio({ mode: 'music' });
      setHash(musicHash.current || '#/music');
      return;
    }
    leaveMusic();
    if (next === 'edit') {
      setStudio({ mode: 'edit' });
      setAssetTab(true);
      if (workspace !== 'editing') returnProject();
      return;
    }
    if (next === 'still') {
      const target = stillMode ? sceneId : snapshot?.scenes.find((s) => s.still)?.id;
      if (!target) {
        setImageDialog('new');
        return;
      }
      setStudio({ mode: 'still' });
      if (!stillMode || target !== sceneId) enterScene(target);
      return;
    }
    setStudio({ mode: next });
    if (mode === 'edit') setAssetTab(false);
    if (next === 'effects') setInspectorTab('effects');
    if (next === 'motion' && inspectorTab === 'effects') setInspectorTab('properties');
    if (workspace !== 'animation' || stillMode) {
      const target = motionScene();
      if (target) enterScene(target);
    }
  };
  const switchSub = (id: 'drawing' | 'code') => {
    leaveMusic();
    setPlaying(false);
    setStudioTab(undefined);
    if (id === 'code' && !codePath) {
      const first = Object.keys(snapshot?.files ?? {}).find((f) => f.endsWith('.ts'));
      if (first) setCodePath(first);
    }
    setWorkspace(id);
  };
  const reveal = (entry: ChangeEntry, target?: ChangeTarget) => {
    target ??= revealTarget(entry);
    setFeedFocus(entry.id);
    if (!target || !snapshot) return;
    if (target.kind === 'clip' && target.id) {
      if (mode !== 'edit') switchMode('edit');
      const clip = snapshot.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips)).find((c) => c.id === target!.id);
      setClipSelected(target.id);
      if (clip) setTimeout(() => setFrame(clip.start), 0);
      return;
    }
    const sid = target.sceneId ?? (target.kind === 'scene' ? target.id : undefined);
    const targetScene = snapshot.scenes.find((s) => s.id === sid);
    if (!targetScene) return;
    if (targetScene.still) {
      if (!stillMode || sceneId !== targetScene.id) {
        setStudio({ mode: 'still' });
        leaveMusic();
        enterScene(targetScene.id);
      }
    } else if (mode === 'edit' || mode === 'music' || mode === 'still' || workspace !== 'animation' || sceneId !== targetScene.id || focusPath.length) {
      leaveMusic();
      if (mode === 'edit' || mode === 'music' || mode === 'still') setStudio({ mode: 'motion' });
      enterScene(targetScene.id);
    }
    if (target.kind === 'node' && target.id && targetScene.nodes.some((n) => n.id === target!.id)) {
      const nodeId = target.id,
        n = targetScene.nodes.find((x) => x.id === nodeId)!;
      setTimeout(() => {
        selectMany([nodeId]);
        const end = n.end ?? targetScene.duration;
        if (sceneId === targetScene.id && (frame < n.start || frame >= end)) setFrame(n.start);
      }, 0);
    }
  };
  // Follow AI: reveal each new external change as it arrives.
  const seenEntries = React.useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = changeLog.at(-1);
    if (seenEntries.current === undefined) {
      seenEntries.current = last?.id ?? '';
      return;
    }
    if (!last || last.id === seenEntries.current) return;
    const fresh = changeLog.slice(changeLog.findIndex((e) => e.id === seenEntries.current) + 1);
    seenEntries.current = last.id;
    const ai = fresh.filter((e) => e.kind !== 'ui' && e.action !== 'undo').at(-1);
    if (ai && studio.followAi && workspace !== 'drawing' && workspace !== 'code') reveal(ai);
  }, [changeLog]);
  const undoSteps = async (steps: number, group?: FeedGroup) => {
    if (!steps) return;
    setFeedBusy(true);
    try {
      for (let i = 0; i < steps; i++) await run('undo');
      if (group) markReviewed(group.entries.map((e) => e.id));
    } finally {
      setFeedBusy(false);
    }
  };
  const setAgentHold = async (hold: boolean) => {
    try {
      const result = await rpc('agentHold', { hold });
      setState((s) => (s ? ({ ...s, agents: result } as typeof s) : s));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openInspector = (tab?: 'properties' | 'effects' | 'animation') => {
    if (tab) setInspectorTab(tab);
    setStudio({ rightTab: 'inspector', showRight: true });
    if (fit.rightDrawer) setDrawerOpen(true);
  };
  const [glyphPanel, setGlyphPanel] = useState(false);
  // Shell-level shortcuts. Registered in the capture phase so they win over the
  // playback/editing handlers, and only for combinations those handlers don't use.
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (workspace === 'drawing' || !state) return;
      const target = e.target as HTMLElement;
      const typing = !!target.closest?.('input,textarea,select,[contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === 'k' || (e.shiftKey && key === 'p'))) {
        e.preventDefault();
        e.stopPropagation();
        setOverlay((v) => (v === 'palette' ? undefined : 'palette'));
        return;
      }
      if (overlay || document.querySelector('.project-modal')) return;
      if (!typing && !mod && !e.altKey && e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        setOverlay('shortcuts');
        return;
      }
      if (mod && e.altKey && ['l', 'i', 't'].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
        toggleLayout(key === 'l' ? 'left' : key === 'i' ? 'right' : 'timeline');
        return;
      }
      const nextMode = modeFromShortcut(e);
      if (nextMode) {
        e.preventDefault();
        e.stopPropagation();
        switchMode(nextMode);
        return;
      }
      if (e.key === 'Escape' && previewing) {
        e.preventDefault();
        e.stopPropagation();
        setPreviewing(false);
        setPlaying(false);
        return;
      }
      if (!typing && !mod && !e.altKey && e.key === '/') {
        e.preventDefault();
        e.stopPropagation();
        setOverlay('palette');
        return;
      }
      if (mode === 'music' && workspace !== 'code') return;
      if (!typing && !mod && (e.key === 'Home' || e.key === 'End') && workspace !== 'code') {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(false);
        setFrame(e.key === 'Home' ? 0 : Math.max(0, activeDuration - 1));
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  });
  // Recomputed per render (cheap) so labels/disabled states always reflect current state.
  const commands = ((): PaletteCommand[] => {
    if (!state || !project || !scene || !sequence) return [];
    const animation = workspace === 'animation',
      none = !selectedIds.length,
      list: PaletteCommand[] = [
        ...MODES.map((m) => ({
          id: `mode.${m.id}`,
          group: '模式',
          label: `${m.name}模式 — ${m.hint}`,
          keywords: `mode workspace ${m.id} ${m.id === 'motion' ? '动画 animation' : ''}`,
          icon: m.icon,
          keys: m.keys,
          disabled: m.id === mode && workspace !== 'code',
          run: () => switchMode(m.id),
        })),
        ...(
          [
            ['drawing', '绘画', 'brush', '逐帧画稿'],
            ['code', '代码', 'code', 'TypeScript 组件'],
          ] as const
        ).map(([id, name, icon, hint]) => ({
          id: `workspace.${id}`,
          group: '模式',
          label: `打开${name}工作区 — ${hint}`,
          keywords: `workspace ${id}`,
          icon,
          disabled: workspace === id,
          run: () => switchSub(id),
        })),
        ...(workspace === 'animation' && mode !== 'music'
          ? scene.nodes.map((n) => ({
              id: `object.${n.id}`,
              group: '对象',
              label: `${n.name}`,
              keywords: `${n.id} ${n.type} ${n.type === 'text' ? (n.text ?? '') : ''} 对象 图层 layer`,
              icon: n.type === 'text' ? 'text' : n.type === 'component' ? 'code' : n.type === 'ellipse' ? 'ellipse' : n.type === 'rect' ? 'rect' : 'layers',
              run: () => {
                if (focusPath.length && !interactions?.layers.some((l) => l.node.id === n.id)) {
                  setFocusPath([]);
                  setFocusContextFrames([]);
                  setComposition(undefined);
                }
                selectMany([n.id]);
              },
            }))
          : []),
        ...snapshot!.scenes.map((sc, i) => ({
          id: `scene.${sc.id}`,
          group: '场景',
          label: `${i + 1} ${sc.name}`,
          keywords: `scene 场景 ${sc.id}`,
          icon: sc.still ? 'image' : 'scene',
          disabled: workspace === 'animation' && sc.id === sceneId,
          run: () => {
            if (sc.still) setStudio({ mode: 'still' });
            else if (mode === 'edit' || mode === 'music' || mode === 'still') setStudio({ mode: 'motion' });
            leaveMusic();
            enterScene(sc.id);
          },
        })),
        {
          id: 'ai.follow',
          group: 'AI 协作',
          label: studio.followAi ? '关闭跟随 AI' : '开启跟随 AI（自动跳到 AI 刚改的地方）',
          keywords: 'follow ai 跟随',
          icon: 'eye',
          run: () => setStudio((v) => ({ followAi: !v.followAi })),
        },
        {
          id: 'ai.hold',
          group: 'AI 协作',
          label: agents?.hold ? '恢复 AI 修改' : '暂停 AI 修改（拒绝 MCP 写入）',
          keywords: 'pause hold ai mcp 暂停',
          icon: agents?.hold ? 'play' : 'pause',
          run: () => void setAgentHold(!agents?.hold),
        },
        {
          id: 'ai.feed',
          group: 'AI 协作',
          label: '打开改动记录',
          keywords: 'changes history feed 改动 记录',
          icon: 'reset',
          run: () => {
            setStudio({ rightTab: 'changes', showRight: true });
            if (fit.rightDrawer) setDrawerOpen(true);
          },
        },
        {
          id: 'file.export',
          group: '工程',
          label: '导出作品…',
          keywords: 'export render mp4 png wav',
          icon: 'export',
          run: () => setModal('export'),
        },
        {
          id: 'file.newImage',
          group: '图片',
          label: '新建图片…',
          keywords: 'new image still poster cover thumbnail 图片 海报 封面 缩略图 小红书 公众号',
          icon: 'image',
          run: () => {
            setPlaying(false);
            setImageDialog('new');
          },
        },
        {
          id: 'file.exportImage',
          group: '图片',
          label: '导出图片…',
          keywords: 'export image png jpeg webp still poster 导出 图片 海报 封面',
          icon: 'export',
          disabled: !stillScene,
          run: () => {
            if (!stillScene) return;
            if (!stillMode) enterScene(stillScene.id);
            setImageDialog('export');
          },
        },
        ...(stillMode
          ? (
              [
                ['left', '左对齐'],
                ['hcenter', '水平居中'],
                ['right', '右对齐'],
                ['top', '顶对齐'],
                ['vcenter', '垂直居中'],
                ['bottom', '底对齐'],
                ['distribute-h', '水平等距分布'],
                ['distribute-v', '垂直等距分布'],
              ] as const
            ).map(([mode, label]) => ({
              id: `still.align.${mode}`,
              group: '图片',
              label: `${label}（选中图层）`,
              keywords: `align distribute ${mode} 对齐 分布`,
              icon: 'layers',
              disabled: !selectedIds.length || (mode.startsWith('distribute') && selectedIds.length < 3),
              run: () => void alignSelection(mode),
            }))
          : []),
        {
          id: 'file.save',
          group: '工程',
          label: '保存',
          keywords: 'save',
          icon: 'check',
          keys: 'Ctrl+S',
          run: () => void run('save'),
        },
        {
          id: 'edit.undo',
          group: '工程',
          label: '撤销',
          keywords: 'undo',
          icon: 'undo',
          keys: 'Ctrl+Z',
          disabled: !state.canUndo,
          run: () => void run('undo'),
        },
        {
          id: 'edit.redo',
          group: '工程',
          label: '重做',
          keywords: 'redo',
          icon: 'redo',
          keys: 'Ctrl+Shift+Z',
          disabled: !state.canRedo,
          run: () => void run('redo'),
        },
        {
          id: 'file.settings',
          group: '工程',
          label: '工程设置（画布、帧率、时长）',
          keywords: 'settings project canvas fps',
          icon: 'settings',
          run: () => setModal('settings'),
        },
        {
          id: 'file.mcp',
          group: '工程',
          label: '连接 MCP / 外部 AI',
          keywords: 'mcp agent ai connect',
          icon: 'link',
          run: () => openMcpConnection(),
        },
        {
          id: 'file.media',
          group: '工程',
          label: '媒体与缓存管理',
          keywords: 'media cache proxy',
          icon: 'image',
          run: () => setMediaManaging(true),
        },
        {
          id: 'file.plugins',
          group: '工程',
          label: '打开插件管理器',
          keywords: 'plugins plugin manager 插件 扩展 模块 依赖',
          icon: 'plug',
          run: () => openPlugins('list'),
        },
        {
          id: 'file.plugins.install',
          group: '工程',
          label: '安装插件…',
          keywords: 'install plugin vmplugin zip git folder upgrade 插件 安装 升级 导入',
          icon: 'plus',
          run: () => openPlugins('install'),
        },
        ...studioTabs.map((tab) => ({
          id: `studio.${tab.id}`,
          group: '创作工具',
          label: `${tab.name} — ${tab.description}`,
          keywords: `studio tool ${tab.id}`,
          icon: tab.icon,
          run: () => {
            setPlaying(false);
            setStudioTab(tab.id);
          },
        })),
        ...(stillMode ? [] : [
        {
          id: 'play.toggle',
          group: '播放',
          label: playing ? '暂停' : '播放',
          keywords: 'play pause',
          icon: playing ? 'pause' : 'play',
          keys: 'Space',
          run: () => setPlaying(!playing),
        },
        {
          id: 'play.start',
          group: '播放',
          label: '跳到第一帧',
          keywords: 'start home',
          icon: 'skipBack',
          keys: 'Home',
          run: () => setFrame(0),
        },
        {
          id: 'play.end',
          group: '播放',
          label: '跳到最后一帧',
          keywords: 'end',
          icon: 'skipForward',
          keys: 'End',
          run: () => setFrame(Math.max(0, activeDuration - 1)),
        },
        ]),
        ...(workspace === 'animation' || workspace === 'editing'
          ? (
              [
                ['text', '文字', 'text'],
                ['rect', '形状', 'shape rect'],
                ['ellipse', '椭圆', 'ellipse circle'],
                ['formula', '公式', 'formula math'],
                ['chart', '图表', 'chart'],
              ] as const
            ).map(([type, label, keywords]) => ({
              id: `add.${type}`,
              group: '添加',
              label: `添加${label}`,
              keywords: `add ${keywords}`,
              icon: type === 'formula' ? 'text' : type,
              run: () => void addNode(type as Node['type']),
            }))
          : []),
        ...(animation
          ? [
              {
                id: 'layer.group',
                group: '图层',
                label: '编组选中图层',
                keywords: 'group',
                icon: 'layers',
                keys: 'Ctrl+G',
                disabled: none,
                run: () => void editStructure('group'),
              },
              {
                id: 'layer.duplicate',
                group: '图层',
                label: '复制图层',
                keywords: 'duplicate',
                icon: 'copy',
                keys: 'Ctrl+D',
                disabled: none,
                run: () => void editStructure('duplicate', { offset: { x: 0, y: 0 } }),
              },
              {
                id: 'layer.delete',
                group: '图层',
                label: '删除图层',
                keywords: 'delete remove',
                icon: 'delete',
                keys: 'Delete',
                disabled: none,
                run: () => void editStructure('delete'),
              },
              {
                id: 'layer.up',
                group: '图层',
                label: '上移一层',
                keywords: 'order up raise',
                icon: 'up',
                disabled: none,
                run: () => void editStructure('order', { direction: 'up' }),
              },
              {
                id: 'layer.down',
                group: '图层',
                label: '下移一层',
                keywords: 'order down lower',
                icon: 'down',
                disabled: none,
                run: () => void editStructure('order', { direction: 'down' }),
              },
              {
                id: 'layer.check',
                group: '图层',
                label: '检查画面',
                keywords: 'visual check audit',
                icon: 'eye',
                disabled: visualCheckBusy || playing,
                run: () => void checkVisual(),
              },
            ]
          : []),
        {
          id: 'view.left',
          group: '面板',
          label: studio.showLeft ? '隐藏场景与图层栏' : '显示场景与图层栏',
          keywords: 'panel sidebar left project',
          icon: 'sidebarLeft',
          keys: 'Ctrl+Alt+L',
          run: () => toggleLayout('left'),
        },
        {
          id: 'view.right',
          group: '面板',
          label: studio.showRight ? '隐藏改动记录 / 属性栏' : '显示改动记录 / 属性栏',
          keywords: 'panel inspector right',
          icon: 'sidebarRight',
          keys: 'Ctrl+Alt+I',
          run: () => toggleLayout('right'),
        },
        {
          id: 'view.timeline',
          group: '面板',
          label: studio.showTimeline ? '折叠时间轴' : '展开时间轴',
          disabled: stillMode,
          keywords: 'timeline collapse expand',
          icon: 'panelBottom',
          keys: 'Ctrl+Alt+T',
          run: () => toggleLayout('timeline'),
        },
        {
          id: 'view.reset',
          group: '面板',
          label: '重置布局',
          keywords: 'reset layout',
          icon: 'reset',
          run: resetStudioLayout,
        },
        {
          id: 'help.shortcuts',
          group: '帮助',
          label: '键盘快捷键',
          keywords: 'shortcuts keyboard help',
          icon: 'keyboard',
          keys: '?',
          run: () => setOverlay('shortcuts'),
        },
      ];
    return list;
  })();
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
  const breadcrumb = (
    <nav className="composition-breadcrumb" aria-label="合成导航">
      <button onClick={returnProject}>
        <Icon name="film" size={13} />
        工程总览
      </button>
      {workspace === 'editing' && (
        <>
          <Icon name="arrow" size={11} />
          <span className="crumb-current">{sequence.name}</span>
        </>
      )}
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
          {stillMode ? (
            <span className="scope-badge still-badge">
              图片画板 · {viewWidth} × {viewHeight}
              {rootScene?.still?.dpi && rootScene.still.dpi !== 72 ? ` · ${rootScene.still.dpi}dpi` : ''}
            </span>
          ) : (
          <span className="scope-badge">
            独立合成 · 内容时间 · {scene?.duration ?? 0} 帧
            {focusContextFrames.length
              ? ` · 父帧 ${focusContextFrames.at(-1)!.toFixed(1)}`
              : ''}
          </span>
          )}
        </>
      )}
    </nav>
  );
  const timelineVisible = !stillMode && mode !== 'music' && workspace !== 'code';
  const rightVisible = studio.showRight && !previewing && (!fit.rightDrawer || drawerOpen);
  const leftVisible = studio.showLeft && !previewing;
  const crumbs: Crumb[] =
    workspace === 'code'
      ? [{ label: '代码' }, { label: codePath.split('/').at(-1) ?? '' }]
      : mode === 'music'
        ? [{ label: '音乐' }]
        : workspace === 'editing'
          ? [{ label: sequence.name }]
          : [
              {
                label: rootScene?.name ?? scene.name,
                onClick: focusPath.length
                  ? () => {
                      setFocusPath([]);
                      setFocusContextFrames([]);
                      setComposition(undefined);
                    }
                  : undefined,
              },
              ...focusPath.map((id, index) => ({
                label: composition?.breadcrumbs[index]?.name ?? id.split('/').at(-1) ?? id,
                onClick:
                  index < focusPath.length - 1
                    ? () => {
                        setFocusPath((path) => path.slice(0, index + 1));
                        setFocusContextFrames((contexts) => contexts.slice(0, index + 1));
                        setSelected('');
                      }
                    : undefined,
              })),
              ...(node && selectedIds.length === 1 ? [{ label: node.name }] : []),
            ];
  const moreActions: MoreAction[] = [
    { id: 'palette', label: '命令与对象搜索', icon: 'search', keys: 'Ctrl+K', run: () => setOverlay('palette') },
    { id: 'tools', label: '创作工具', icon: 'sparkles', run: () => { setPlaying(false); setStudioTab('graph'); } },
    { id: 'left', label: '场景与图层栏', icon: 'sidebarLeft', keys: 'Ctrl+Alt+L', pressed: studio.showLeft, run: () => toggleLayout('left') },
    { id: 'right', label: '改动记录 / 属性栏', icon: 'sidebarRight', keys: 'Ctrl+Alt+I', pressed: studio.showRight, run: () => toggleLayout('right') },
    { id: 'timeline', label: '时间线', icon: 'panelBottom', keys: 'Ctrl+Alt+T', pressed: studio.showTimeline, run: () => toggleLayout('timeline') },
    { id: 'reset', label: '重置布局', icon: 'reset', run: resetStudioLayout },
    { id: 'settings', label: '工程设置', icon: 'settings', run: () => setModal('settings') },
    { id: 'media', label: '媒体与缓存', icon: 'image', run: () => setMediaManaging(true) },
    { id: 'keys', label: '键盘快捷键', icon: 'keyboard', keys: '?', run: () => setOverlay('shortcuts') },
  ];
  const stageSearch = (
    <button className="stage-search" onClick={() => { setSearchQuery(''); setOverlay('palette'); }} title="搜索对象或命令 · / 或 Ctrl+K">
      <Icon name="search" size={13} />
      <span>搜索对象或命令</span>
      <kbd>/</kbd>
    </button>
  );
  const feed = (
    <ChangeFeed
      entries={changeLog}
      head={head}
      reviewed={reviewed}
      filter={feedFilter}
      now={now}
      agents={agents}
      focusId={feedFocus}
      busy={feedBusy || saving}
      onFilter={setFeedFilter}
      onKeep={(group) => markReviewed(group.entries.map((e) => e.id))}
      onUndo={(steps, group) => void undoSteps(steps, group)}
      onHold={(hold) => {
        if (hold) setStudio({ followAi: false });
        void setAgentHold(hold);
      }}
      onReveal={reveal}
      onDiff={setDiffGroup}
      onConnect={() => openMcpConnection()}
    />
  );
  return (
    <div
      className={`studio-app ${previewing ? 'previewing' : ''} ${stillMode ? 'still-mode' : ''} ${fit.compactTop ? 'compact-top' : ''} ${fit.rightDrawer ? 'right-drawer' : ''}`}
      data-studio-mode={workspace === 'code' ? 'code' : mode}
      style={
        {
          '--left-width': `${studio.left}px`,
          '--right-width': `${studio.right}px`,
          '--timeline-height': `${studio.timeline}px`,
        } as React.CSSProperties
      }
    >
      <StudioTopBar
        projectName={project.name}
        crumbs={crumbs}
        mode={mode}
        workspace={workspace}
        onMode={switchMode}
        onSubWorkspace={switchSub}
        agents={agents}
        lastExternal={lastExternal}
        now={now}
        followAi={studio.followAi}
        onFollowAi={(followAi) => setStudio({ followAi })}
        previewing={previewing}
        onPreview={() => {
          if (previewing) {
            setPreviewing(false);
            setPlaying(false);
          } else {
            setPreviewing(true);
            if (!stillMode && mode !== 'music') setPlaying(true);
          }
        }}
        onExport={() => (stillMode ? setImageDialog('export') : setModal('export'))}
        exportLabel={stillMode ? '导出图片' : undefined}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={() => void run('undo')}
        onRedo={() => void run('redo')}
        saving={saving}
        error={error}
        onPlugin={() => openPlugins('list')}
        onError={setError}
        onPause={() => setPlaying(false)}
        more={moreActions}
      />
      <div className="studio-body">
        {leftVisible && (
          <>
            <aside className="studio-left" aria-label="场景与图层">
              <SceneStrip
                scenes={snapshot!.scenes}
                project={project}
                revision={snapshot!.revision}
                fps={fps}
                activeId={workspace === 'editing' ? undefined : sceneId}
                badges={badges}
                compact={fit.compactStrip}
                onOpen={(s) => {
                  if (s.still) {
                    setStudio({ mode: 'still' });
                    leaveMusic();
                    enterScene(s.id);
                  } else if (mode === 'edit') {
                    const clip = sequence.tracks.flatMap((t) => t.clips).find((c) => c.sceneId === s.id);
                    if (clip) {
                      setClipSelected(clip.id);
                      setFrame(clip.start);
                    } else enterScene(s.id);
                  } else {
                    if (mode === 'music' || mode === 'still') setStudio({ mode: 'motion' });
                    leaveMusic();
                    enterScene(s.id);
                  }
                }}
                onNew={async () => {
                  const id = crypto.randomUUID();
                  await transact([
                    { type: 'addScene', scene: { id, name: '新场景', duration: 300, background: '#101525', nodes: [] } },
                  ]);
                  if (mode === 'edit' || mode === 'music' || mode === 'still') setStudio({ mode: 'motion' });
                  leaveMusic();
                  enterScene(id);
                }}
                onReveal={(s) => {
                  const e = [...changeLog].reverse().find((x) => x.kind !== 'ui' && x.targets.some((t) => t.sceneId === s.id || t.id === s.id));
                  setStudio({ rightTab: 'changes', showRight: true });
                  if (fit.rightDrawer) setDrawerOpen(true);
                  if (e) setFeedFocus(e.id);
                }}
              />
              {mode !== 'music' && (
                <div className="studio-layers">
                  {(
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
                      stillMode={stillMode}
                      hideScenes
                      aiNodes={highlights}
                    />
                  )}
                </div>
              )}
            </aside>
            <Splitter
              label="调整场景栏宽度"
              direction="vertical"
              value={studio.left}
              min={studioLimits.left.min}
              max={studioLimits.left.max}
              defaultValue={studioDefaults.left}
              onChange={(left) => setStudio({ left })}
            />
          </>
        )}
      <main className={'main-panel studio-stage' + (studioTab ? ' studio-open' : '') + (mode === 'music' && workspace !== 'code' ? ' music-stage' : '')}>
        {mode === 'music' && workspace !== 'code' ? (
          <Suspense fallback={<div className="studio-loading" role="status"><span className="vm-spinner" />正在打开音乐工作区…</div>}>
            <MusicWorkspace embedded />
          </Suspense>
        ) : (
          <>
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
            {workspace === 'code' && breadcrumb}
            {stillMode ? (
              <ImageToolbar
                selection={selectedIds.length}
                view={artboardView}
                reference={alignReference}
                busy={saving || stillBusy}
                onAdd={(type) => void addNode(type)}
                onAlign={(mode) => void alignSelection(mode)}
                onReference={setAlignReference}
                onView={setArtboardView}
                onExport={() => setImageDialog('export')}
              />
            ) : (
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
                    <span className="tool-group-label">添加</span>
                    {[
                      ['text', 'Text', '文字'],
                      ['rect', 'Shape', '形状'],
                      ['ellipse', 'Ellipse', '椭圆'],
                      ['formula', 'Formula', '公式'],
                      ['chart', 'Chart', '图表'],
                    ].map(([type, label, name]) => (
                      <button
                        key={type}
                        className="tool-button"
                        title={`添加${name}`}
                        aria-label={label}
                        onClick={() => addNode(type as Node['type'])}
                      >
                        <Icon name={type === 'formula' ? 'text' : type} size={16} />
                        <span>{name}</span>
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
              {workspace === 'animation' && (mode === 'effects' || mode === 'type' || mode === 'motion') && (
                <div className="tool-group mode-tools" role="group" aria-label="模式工具">
                  <span className="toolbar-separator" />
                  {(mode === 'effects'
                    ? ([
                        ['graph', '节点图', 'scene'],
                        ['particles', '粒子', 'sparkles'],
                        ['space', '三维', 'cube'],
                        ['storyboard', '转场', 'film'],
                        ['review', '画面检查', 'eye'],
                      ] as const)
                    : mode === 'motion'
                      ? ([['motion', '动作模板', 'layers']] as const)
                      : ([] as const)
                  ).map(([tab, label, icon]) => (
                    <button key={tab} className="tool-button" title={label} onClick={() => { setPlaying(false); setStudioTab(tab); }}>
                      <Icon name={icon} size={15} />
                      <span>{label}</span>
                    </button>
                  ))}
                  {mode === 'effects' && (
                    <button className="tool-button" title="效果堆栈 / 抠像 / 混合" onClick={() => openInspector('effects')}>
                      <Icon name="settings" size={15} />
                      <span>效果堆栈</span>
                    </button>
                  )}
                  {mode === 'motion' && (
                    <button className="tool-button" title="关键帧与曲线" onClick={() => openInspector('animation')}>
                      <Icon name="key" size={15} />
                      <span>关键帧</span>
                    </button>
                  )}
                  {mode === 'type' && (
                    <>
                      <button className="tool-button" disabled={node?.type !== 'text'} title="字形面板：覆盖率、拼字、部件" onClick={() => setGlyphPanel(true)}>
                        <span className="tool-glyph">字</span>
                        <span>字形面板</span>
                      </button>
                      <button className="tool-button" title="逐字动画 / 路径文字" onClick={() => openInspector('animation')}>
                        <Icon name="text" size={15} />
                        <span>逐字动画</span>
                      </button>
                      <button className="tool-button" title="导入 SRT / VTT 字幕（剪辑模式）" onClick={() => switchMode('edit')}>
                        <Icon name="film" size={15} />
                        <span>字幕</span>
                      </button>
                    </>
                  )}
                </div>
              )}
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
            )}
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
                  header={null}
                  footerStart={stageSearch}
                  fitRequest={stillMode ? `${sceneId}:${viewWidth}x${viewHeight}` : undefined}
                  tip={stillMode ? '拖动吸附边缘与中心 · Ctrl 暂停吸附 · Shift 锁定方向 · Alt 平移' : undefined}
                  decorations={(scale) => (
                    <>
                      {stillMode && !focusPath.length && rootScene && (
                        <>
                          <ArtboardGuides scene={rootScene} project={project} view={artboardView} />
                          {artboardView.rulers && (
                            <ArtboardRulers width={viewWidth} height={viewHeight} scale={scale} />
                          )}
                        </>
                      )}
                      {workspace === 'animation' &&
                        !playing &&
                        !previewing &&
                        interactions &&
                        interactions.sceneId === sceneId &&
                        interactions.revision === snapshot!.revision && (
                          <StageOverlays
                            layers={interactions.layers}
                            width={viewWidth}
                            height={viewHeight}
                            selection={selectedIds}
                            node={node}
                            frame={nodeFrame}
                            highlights={
                              new Map([...highlights].filter(([, h]) => h.sceneId === sceneId))
                            }
                            now={now}
                            revision={snapshot!.revision}
                            canUndo={(h) => isHead(h.entry, changeLog, head)}
                            update={update}
                            onInspector={() => openInspector()}
                            onEffects={() => openInspector('effects')}
                            onMotion={() => {
                              setPlaying(false);
                              setStudioTab('motion');
                            }}
                            onGlyphs={() => setGlyphPanel(true)}
                            onEnter={enterGroup}
                            onUndoEntry={(h) => void undoSteps(1)}
                            onRevealEntry={(h) => {
                              setStudio({ rightTab: 'changes', showRight: true });
                              if (fit.rightDrawer) setDrawerOpen(true);
                              setFeedFocus(undefined);
                              setTimeout(() => setFeedFocus(h.entry.id), 0);
                            }}
                          />
                        )}
                    </>
                  )}
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
                          snapBoxes={
                            stillMode && artboardView.snap && !focusPath.length && rootScene
                              ? (() => {
                                  const g = stillGuides(rootScene, project);
                                  return [g.canvas, g.trim, g.safe];
                                })()
                              : undefined
                          }
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
          </>
        )}
      </main>
        {studio.showRight && !previewing && fit.rightDrawer && !drawerOpen && (
          <button className="studio-drawer-tab" onClick={() => setDrawerOpen(true)} aria-label="打开改动记录">
            <span>改动记录</span>
            {highlights.size > 0 && <b>{highlights.size}</b>}
          </button>
        )}
        {rightVisible && (
          <>
            {!fit.rightDrawer && (
              <Splitter
                label="调整改动记录宽度"
                direction="vertical"
                value={studio.right}
                min={studioLimits.right.min}
                max={studioLimits.right.max}
                defaultValue={studioDefaults.right}
                invert
                onChange={(right) => setStudio({ right })}
              />
            )}
            <aside className={`studio-right ${fit.rightDrawer ? 'drawer' : ''}`} aria-label="改动记录与属性">
              <div className="studio-right-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={studio.rightTab === 'changes'}
                  className={studio.rightTab === 'changes' ? 'active' : ''}
                  onClick={() => setStudio({ rightTab: 'changes' })}
                >
                  改动记录
                  {highlights.size > 0 && <b className="ai-count">{highlights.size}</b>}
                </button>
                <button
                  role="tab"
                  aria-selected={studio.rightTab === 'inspector'}
                  className={studio.rightTab === 'inspector' ? 'active' : ''}
                  onClick={() => setStudio({ rightTab: 'inspector' })}
                >
                  属性
                </button>
                {fit.rightDrawer && (
                  <button className="icon-button drawer-close" aria-label="关闭侧栏" onClick={() => setDrawerOpen(false)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
              <div className="studio-right-body" hidden={studio.rightTab !== 'changes'}>
                {feed}
              </div>
              <div className="studio-right-body inspector-host" hidden={studio.rightTab !== 'inspector'}>
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
          stillMode={stillMode}
          artboard={
            stillMode && rootScene && !focusPath.length ? (
              <ArtboardInspector
                scene={rootScene}
                project={project}
                busy={stillBusy}
                onUpdate={(patch) => void stillCommit([{ action: 'update', sceneId, ...patch }])}
                onVariants={(variants) => void stillCommit([{ action: 'variants', sceneId, variants }])}
                onUnmark={() =>
                  void stillCommit([
                    { action: 'unmark', sceneId, duration: Math.round(fps * 5) },
                  ])
                }
              />
            ) : undefined
          }
        />
              </div>
            </aside>
          </>
        )}
      </div>
      {timelineVisible && !previewing && (
        <>
          <Splitter
            label="调整时间轴高度"
            direction="horizontal"
            value={studio.timeline}
            min={studioLimits.timeline.min}
            max={studioLimits.timeline.max}
            defaultValue={studioDefaults.timeline}
            invert
            onChange={(timeline) => setStudio({ timeline, showTimeline: true })}
          />
          <div className={`studio-timeline ${studio.showTimeline ? '' : 'collapsed'}`}>
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
            aiMarks={{
          nodes: new Map([...highlights].filter(([, h]) => h.sceneId === sceneId)),
          clips: clipLights,
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
          </div>
        </>
      )}
      <footer className="statusbar studio-status">
        <span>
          <span className="status-dot" />
          工程服务已连接
        </span>
        <span className="studio-status-msg">{error || `${scene.nodes.length} 图层 · ${project.assets.length} 素材`}</span>
        <div className="top-spacer" />
        <span>
          {stillMode
            ? `图片 · ${viewWidth} × ${viewHeight} px`
            : `${project.width} × ${project.height} · ${fps.toFixed(2)} fps`}
        </span>
        <span className="mono" title="工程修订版本">{snapshot!.revision.slice(0, 8)}</span>
        <button className="statusbar-hint" onClick={() => setOverlay('shortcuts')}>
          <kbd>?</kbd>
          快捷键
        </button>
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
      {overlay === 'palette' && (
        <CommandPalette commands={commands} onClose={() => setOverlay(undefined)} />
      )}
      {overlay === 'shortcuts' && <ShortcutSheet onClose={() => setOverlay(undefined)} />}
      {imageDialog === 'new' && (
        <div className="project-modal" role="dialog" aria-modal="true" aria-label="新建图片">
          <NewImageDialog
            mode="scene"
            onCancel={() => setImageDialog(undefined)}
            onSubmit={createImage}
          />
        </div>
      )}
      {imageDialog === 'export' && stillScene && (
        <ImageExportDialog
          snapshot={snapshot!}
          scene={stillScene}
          root={state.root}
          run={call}
          onClose={() => setImageDialog(undefined)}
        />
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
          initialView={pluginView}
          onClose={() => setPluginManaging(false)}
          onOpenFile={(file) => {
            setPluginManaging(false);
            setStudioTab(undefined);
            setWorkspace('code');
            setCodePath(file);
          }}
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
      {diffGroup && (
        <DiffDialog
          group={diffGroup}
          onClose={() => setDiffGroup(undefined)}
          onReveal={(entry, target) => {
            setDiffGroup(undefined);
            reveal(entry, target);
          }}
        />
      )}
      {glyphPanel && node?.type === 'text' && (
        <Suspense fallback={null}>
          <GlyphPanel
            initialSet={node.glyphSet || 'builtin:demo'}
            sampleText={node.text ?? ''}
            revision={snapshot!.revision}
            onClose={() => setGlyphPanel(false)}
            onApplied={() => run('state')}
          />
        </Suspense>
      )}
    </div>
  );
}
