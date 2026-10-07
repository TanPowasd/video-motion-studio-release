import React, { lazy, useCallback, useEffect, useRef } from 'react';
import type { SequenceAction } from '../../core/editing.js';
import type { CompositionDraft } from '../../core/interaction.js';
import type { KeyframeAction } from '../../core/keyframes.js';
import type { Node, Operation, Scene } from '../../core/model.js';
import { evaluateNode, getNumericPath } from '../../core/time.js';
import { ASSET_DROP_EVENT, type AssetDropDetail } from '../AssetItem.js';
import { compositionUrl, readCompositionRoute } from '../navigation.js';
import { usePanelLayout } from '../panelLayout.js';
import { canPresentPreview, paintPreview, readPreviewBitmap } from '../preview.js';
import { usePlayback } from '../usePlayback.js';
import { rpc } from './rpc-client.js';
import { useStableControllerValues } from './stable-controller.js';
import { createWorkbenchCommands, subscribeWorkbench } from './workbench-effects.js';
import { useWorkbenchField } from './workbench-selectors.js';
import { useWorkbenchStore } from './workbench-store.js';
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
export function useWorkbenchController() {
  const [state, setState] = useWorkbenchField('project', 'state');
  const initialRoute = useRef(readCompositionRoute()).current;
  const [workspace, setWorkspace] = useWorkbenchField('route', 'workspace');
  const [studioTab, setStudioTab] = useWorkbenchField('route', 'studioTab');
  const studioRef = useRef(studioTab);
  studioRef.current = studioTab;
  const [exportGpu, setExportGpu] = useWorkbenchField('tasks', 'exportGpu');
  const [drawingId, setDrawingId] = useWorkbenchField('route', 'drawingId');
  const [focusPath, setFocusPath] = useWorkbenchField('route', 'focusPath'),
    [composition, setComposition] = useWorkbenchField('route', 'composition');
  const [sceneId, setSceneId] = useWorkbenchField('route', 'sceneId');
  const [focusContextFrames, setFocusContextFrames] = useWorkbenchField(
    'route',
    'focusContextFrames',
  );
  const [sceneFrames, setSceneFrames] = useWorkbenchField('preview', 'sceneFrames'),
    [sequenceFrame, setSequenceFrame] = useWorkbenchField('preview', 'sequenceFrame');
  const scopeKey = `${sceneId}:${JSON.stringify(focusPath)}${focusContextFrames.length ? `:${JSON.stringify(focusContextFrames)}` : ''}`,
    sceneFrame = sceneFrames[scopeKey] ?? 0;
  const setSceneFrame = (value: React.SetStateAction<number>) =>
    setSceneFrames((current) => ({
      ...current,
      [scopeKey]: typeof value === 'function' ? value(current[scopeKey] ?? 0) : value,
    }));
  const frame = workspace === 'editing' ? sequenceFrame : sceneFrame;
  const setFrame = workspace === 'editing' ? setSequenceFrame : setSceneFrame;
  const { layout, setLayout, reset: resetLayout } = usePanelLayout();
  const [inspectorTab, setInspectorTab] = useWorkbenchField('panels', 'inspectorTab');
  const [filter, setFilter] = useWorkbenchField('panels', 'filter');
  const [saving, setSaving] = useWorkbenchField('tasks', 'saving');
  const [playing, setPlaying] = useWorkbenchField('preview', 'playing');
  const [selectedIds, setSelectedIds] = useWorkbenchField('selection', 'selectedIds');
  const selected = selectedIds.at(-1) ?? '';
  const setSelected = (id: string) => setSelectedIds(id ? [id] : []);
  const [error, setError] = useWorkbenchField('diagnostics', 'error');
  const [modal, setModal] = useWorkbenchField('panels', 'modal');
  const [exportPath, setExportPath] = useWorkbenchField('tasks', 'exportPath');
  const [format, setFormat] = useWorkbenchField('tasks', 'format');
  const [codePath, setCodePath] = useWorkbenchField('code', 'codePath');
  const [code, setCode] = useWorkbenchField('code', 'code');
  const [codeDirty, setCodeDirty] = useWorkbenchField('code', 'codeDirty');
  const [codeBusy, setCodeBusy] = useWorkbenchField('code', 'codeBusy'),
    [codeCheck, setCodeCheck] = useWorkbenchField('code', 'codeCheck'),
    [codeJump, setCodeJump] = useWorkbenchField('code', 'codeJump'),
    [codeBase, setCodeBase] = useWorkbenchField('code', 'codeBase');
  const codeBaseTicket = useRef(0);
  const codeDrafts = useRef(
    new Map<
      string,
      { content: string; base?: { path: string; hash: string; version: 'active' | 'pending' } }
    >(),
  );
  const draftKey = (file: string) => `vmotion-code-draft:${state?.root ?? ''}:${file}`;
  const [brush, setBrush] = useWorkbenchField('drawing', 'brush');
  const [paintColor, setPaintColor] = useWorkbenchField('drawing', 'paintColor');
  const [hold, setHold] = useWorkbenchField('drawing', 'hold');
  const [onion, setOnion] = useWorkbenchField('drawing', 'onion');
  const [stroke, setStroke] = useWorkbenchField('drawing', 'stroke');
  const [jobs, setJobs] = useWorkbenchField('tasks', 'jobs');
  const [previewReady, setPreviewReady] = useWorkbenchField('preview', 'previewReady');
  const [previewFrame, setPreviewFrame] = useWorkbenchField('preview', 'previewFrame');
  const [previewBusy, setPreviewBusy] = useWorkbenchField('preview', 'previewBusy');
  const [visualCheck, setVisualCheck] = useWorkbenchField('diagnostics', 'visualCheck'),
    [visualCheckBusy, setVisualCheckBusy] = useWorkbenchField('diagnostics', 'visualCheckBusy');
  const visualCheckOpen =
    workspace === 'animation' &&
    visualCheck?.sceneId === sceneId &&
    JSON.stringify(visualCheck.path) === JSON.stringify(focusPath);
  const [interactions, setInteractions] = useWorkbenchField('selection', 'interactions');
  const [canvasDraft, setCanvasDraft] = useWorkbenchField('selection', 'canvasDraft');
  const [componentParams, setComponentParams] = useWorkbenchField('selection', 'componentParams');
  const componentMetadataSource = useRef('');
  const [assetTab, setAssetTab] = useWorkbenchField('assets', 'assetTab');
  const [selectedAsset, setSelectedAsset] = useWorkbenchField('assets', 'selectedAsset');
  const [soundEditing, setSoundEditing] = useWorkbenchField('assets', 'soundEditing');
  const [mediaManaging, setMediaManaging] = useWorkbenchField('assets', 'mediaManaging');
  const [pluginManaging, setPluginManaging] = useWorkbenchField('assets', 'pluginManaging');
  const [clipSelection, setClipSelection] = useWorkbenchField('selection', 'clipSelection'),
    clipSelected = clipSelection.at(-1) ?? '';
  const setClipSelected = (id: string) => setClipSelection(id ? [id] : []);
  const selectClip = (id: string, additive = false) =>
    setClipSelection((current) =>
      additive
        ? current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id]
        : [id],
    );
  const previewRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<Node['points']>([]);
  const abort = useRef<AbortController | undefined>(undefined);
  const previewCanvas = useRef<HTMLCanvasElement | null>(null),
    previewBitmap = useRef<{ bitmap: ImageBitmap; key: string; frame: number } | undefined>(
      undefined,
    );
  const [previewQuality, setPreviewQuality] = useWorkbenchField('preview', 'previewQuality');
  const [previewMedia, setPreviewMedia] = useWorkbenchField('preview', 'previewMedia');
  const attachPreviewCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    previewCanvas.current = canvas;
    if (canvas && previewBitmap.current) paintPreview(canvas, previewBitmap.current.bitmap);
  }, []);
  const previewTarget = useRef<
    | {
        signature: string;
        key: string;
        quality: number;
        mediaQuality: 'auto' | 'original';
        frame: number;
        sceneId: string;
        editing: boolean;
        width: number;
        height: number;
        playing: boolean;
        revision: string;
        path: string[];
        contextFrames: number[];
        draft?: CompositionDraft[];
      }
    | undefined
  >(undefined);
  const previewFlight = useRef(false),
    unmounted = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [waveforms, setWaveforms] = useWorkbenchField('preview', 'waveforms');
  const store = useWorkbenchStore();
  const run = React.useMemo(() => createWorkbenchCommands(store), [store]);
  useEffect(() => {
    rpc('state')
      .then((s) => {
        setState(s);
        setJobs(s.jobs);
        const selectedScene =
          s.snapshot.scenes.find((scene: Scene) => scene.id === initialRoute.sceneId) ??
          s.snapshot.scenes[0];
        setSceneId(selectedScene?.id ?? '');
        setSelected('');
        setExportPath(`${s.root}/exports/video.mp4`);
      })
      .catch((e) => setError(e.message));
    const events = new EventSource('/api/events');
    const unsubscribe = subscribeWorkbench(store, events);
    return () => {
      unmounted.current = true;
      unsubscribe();
      abort.current?.abort();
      previewBitmap.current?.bitmap.close();
      previewBitmap.current = undefined;
    };
  }, []);
  const snapshot = state?.snapshot,
    project = snapshot?.project,
    rootScene = snapshot?.scenes.find((s) => s.id === sceneId),
    scene = focusPath.length && composition ? composition.scene : rootScene,
    node =
      scene?.nodes.find((n) => n.id === selected) ??
      interactions?.layers.find((l) => l.node.id === selected)?.node,
    sequence = snapshot?.sequences.find((s) => s.id === project?.activeSequence),
    fps = project ? project.fps.num / project.fps.den : 30;
  const selectedLayer = interactions?.layers.find((layer) => layer.node.id === node?.id),
    nodeFrame = selectedLayer?.frame ?? frame,
    nodeContextFrames = selectedLayer?.contextFrames ?? focusContextFrames;
  const activeDuration =
    workspace === 'editing' ? (sequence?.duration ?? 1) : (scene?.duration ?? 1);
  const viewWidth =
      focusPath.length && composition
        ? composition.width
        : ((workspace !== 'editing' ? rootScene?.width : undefined) ?? project?.width ?? 1920),
    viewHeight =
      focusPath.length && composition
        ? composition.height
        : ((workspace !== 'editing' ? rootScene?.height : undefined) ?? project?.height ?? 1080);
  const playback = usePlayback({
    snapshot,
    sequenceId: sequence?.id,
    audio: workspace === 'editing',
    scope: workspace === 'editing' ? `editing:${sequence?.id ?? ''}` : workspace + scopeKey,
    playing,
    frame,
    duration: activeDuration,
    fps,
    onFrame: setFrame,
    onStop: () => setPlaying(false),
  });
  useEffect(() => {
    if (!sceneId) return;
    window.history.replaceState(
      null,
      '',
      workspace === 'drawing'
        ? `#/drawing/${encodeURIComponent(drawingId)}`
        : workspace === 'editing'
          ? '#/project'
          : compositionUrl(sceneId, focusPath, focusContextFrames),
    );
  }, [sceneId, workspace, focusPath.join('/'), focusContextFrames.join(','), drawingId]);
  useEffect(() => {
    const back = () => {
      const route = readCompositionRoute();
      setPlaying(false);
      setWorkspace(route.workspace);
      if (route.drawingId) setDrawingId(route.drawingId);
      if (route.sceneId) setSceneId(route.sceneId);
      setFocusContextFrames(route.contextFrames ?? []);
      setFocusPath(route.path);
      setSelected('');
      setComposition(undefined);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    if (!snapshot || workspace === 'editing' || !focusPath.length) {
      setComposition(undefined);
      return;
    }
    let cancelled = false;
    rpc('compositionInspect', {
      sceneId,
      frame,
      path: focusPath,
      contextFrames: focusContextFrames,
    })
      .then((result) => {
        if (!cancelled) setComposition(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    snapshot?.revision,
    sceneId,
    focusPath.join('/'),
    focusContextFrames.join(','),
    frame,
    workspace,
  ]);
  useEffect(() => {
    setSelected('');
  }, [sceneId]);
  useEffect(() => {
    if (!snapshot || workspace !== 'animation' || playing) return;
    let cancelled = false;
    rpc('compositionInteractions', {
      sceneId,
      frame,
      path: focusPath,
      contextFrames: focusContextFrames,
    })
      .then((result) => {
        if (!cancelled) setInteractions(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    snapshot?.revision,
    sceneId,
    frame,
    focusPath.join('/'),
    focusContextFrames.join(','),
    workspace,
    playing,
  ]);
  useEffect(() => {
    setInteractions(undefined);
    setCanvasDraft(undefined);
  }, [sceneId, focusPath.join('/'), workspace]);
  useEffect(() => {
    if (snapshot && !snapshot.scenes.some((s) => s.id === sceneId)) {
      setSceneId(snapshot.scenes[0]?.id ?? '');
    }
  }, [snapshot?.revision]);
  useEffect(() => {
    for (const asset of project?.assets ?? [])
      if (asset.type === 'audio' && !waveforms[asset.id])
        rpc('waveform', { assetId: asset.id })
          .then((peaks) => setWaveforms((w) => ({ ...w, [asset.id]: peaks })))
          .catch(() => setWaveforms((w) => ({ ...w, [asset.id]: [] })));
  }, [project?.assets.length]);
  useEffect(() => {
    if (!project || workspace === 'drawing') return;
    previewTarget.current = {
      key: JSON.stringify([
        snapshot?.revision,
        sceneId,
        workspace,
        focusPath,
        focusContextFrames,
        canvasDraft,
        playback.clockId,
        previewQuality,
        previewMedia,
        state?.mediaEpoch,
      ]),
      quality: previewQuality,
      mediaQuality: previewMedia,
      signature: JSON.stringify([
        frame,
        snapshot?.revision,
        sceneId,
        workspace,
        playing,
        project.width,
        project.height,
        focusPath,
        focusContextFrames,
        canvasDraft,
        previewQuality,
        previewMedia,
        state?.mediaEpoch,
      ]),
      frame,
      sceneId,
      contextFrames: focusContextFrames,
      editing: workspace === 'editing',
      width: viewWidth,
      height: viewHeight,
      playing,
      revision: snapshot!.revision,
      path: focusPath,
      draft: canvasDraft,
    };
    const pump = async () => {
      if (previewFlight.current || unmounted.current || studioRef.current) return;
      const target = previewTarget.current!;
      previewFlight.current = true;
      setPreviewBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      const w = Math.min(target.width, target.quality),
        h = Math.round((w * target.height) / target.width);
      try {
        const r = await fetch(
          `/api/frame?format=rgba&media=${target.mediaQuality}&frame=${target.frame}&width=${w}&height=${h}&${target.editing ? '' : `scene=${encodeURIComponent(target.sceneId)}&path=${encodeURIComponent(JSON.stringify(target.path))}&context=${encodeURIComponent(JSON.stringify(target.contextFrames))}`}&revision=${target.revision}${target.draft ? `&draft=${encodeURIComponent(JSON.stringify(target.draft))}` : ''}`,
          { signal: controller.signal },
        );
        if (!r.ok) {
          const v = await r.json();
          throw new Error(v.error.message);
        }
        if (r.headers.get('X-Vmotion-Stale') === 'true')
          setError(decodeURIComponent(r.headers.get('X-Vmotion-Error') ?? '正在使用最后有效画面'));
        const bitmap = await readPreviewBitmap(r),
          reply = {
            revision: r.headers.get('X-Vmotion-Revision') ?? '',
            frame: Number(r.headers.get('X-Vmotion-Frame') ?? target.frame),
          };
        if (
          !unmounted.current &&
          canPresentPreview(
            target,
            previewTarget.current,
            reply,
            target.revision,
            previewBitmap.current,
            fps * 2,
          )
        ) {
          if (previewCanvas.current) paintPreview(previewCanvas.current, bitmap);
          const previous = previewBitmap.current;
          previewBitmap.current = { bitmap, key: target.key, frame: reply.frame };
          previous?.bitmap.close();
          setPreviewReady(true);
          setPreviewFrame(reply.frame);
        } else bitmap.close();
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        previewFlight.current = false;
        if (!unmounted.current) {
          setPreviewBusy(false);
          if (previewTarget.current?.signature !== target.signature) void pump();
        }
      }
    };
    void pump();
  }, [
    frame,
    studioTab,
    snapshot?.revision,
    sceneId,
    workspace,
    viewWidth,
    viewHeight,
    playing,
    focusPath.join('/'),
    focusContextFrames.join(','),
    playback.clockId,
    previewQuality,
    previewMedia,
    state?.mediaEpoch,
    canvasDraft,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (componentMetadataSource.current !== node?.component) {
      setComponentParams({});
      componentMetadataSource.current = node?.component ?? '';
    }
    if ((node?.type === 'component' && node.component) || node?.templateInstance)
      (node.templateInstance
        ? rpc('componentParameters', {
            sceneId,
            nodeId: node.id,
            path: selectedLayer?.path ?? focusPath,
            frame: nodeFrame,
            contextFrames: nodeContextFrames,
          }).then((v) => ({ parameters: v.parameters }))
        : rpc('component', { source: node.component })
      )
        .then((value) => {
          if (!cancelled) setComponentParams(value.parameters);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    else setComponentParams({});
    return () => {
      cancelled = true;
    };
  }, [node?.id, node?.component, node?.templateInstance?.source, snapshot?.revision]);
  useEffect(() => {
    if (!snapshot || codeDirty) return;
    const file = codePath || Object.keys(snapshot.files).find((f) => f.endsWith('.ts')) || '';
    setCodePath(file);
    const ticket = ++codeBaseTicket.current;
    const content = state?.pendingFiles?.[file] ?? snapshot.files[file] ?? '';
    let draft = codeDrafts.current.get(file);
    if (!draft)
      try {
        const stored = sessionStorage.getItem(draftKey(file));
        if (stored) {
          const parsed = JSON.parse(stored);
          if (
            typeof parsed.content === 'string' &&
            parsed.base?.path === file &&
            typeof parsed.base.hash === 'string'
          )
            draft = parsed;
        }
      } catch {}
    if (draft && draft.content !== content) {
      codeDrafts.current.set(file, draft);
      setCode(draft.content);
      setCodeBase(draft.base);
      setCodeDirty(true);
      return;
    }
    setCode(content);
    setCodeBase(undefined);
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)).then((bytes) => {
      if (ticket === codeBaseTicket.current && !unmounted.current) {
        const base = {
          path: file,
          hash: Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join(''),
          version: state?.pendingFiles ? ('pending' as const) : ('active' as const),
        };
        setCodeBase(base);
        const current = codeDrafts.current.get(file);
        if (current && !current.base) {
          current.base = base;
          try {
            sessionStorage.setItem(draftKey(file), JSON.stringify(current));
          } catch {}
        }
      }
    });
  }, [codePath, snapshot?.revision, codeDirty, state?.pendingFiles]);
  const checkCode = async (commit = false) => {
    if (!codeBase || codeBase.path !== codePath) return;
    setCodeBusy(true);
    try {
      const frames = [
          ...new Set([0, frame, Math.floor(activeDuration / 2), Math.max(0, activeDuration - 1)]),
        ],
        request = {
          revision: stateRef.current?.snapshot.revision,
          version: codeBase.version,
          files: [{ type: 'replace', path: codePath, expectedHash: codeBase.hash, content: code }],
          samples: frames.map((frame) => ({
            sceneId,
            frame,
            path: focusPath,
            contextFrames: focusContextFrames,
          })),
          width: 320,
          determinism: true,
          inline: !commit,
        },
        result = await run(commit ? 'projectApply' : 'projectPreflight', request);
      if (result) {
        if (commit && 'applied' in result && result.applied) {
          codeDrafts.current.delete(codePath);
          try {
            sessionStorage.removeItem(draftKey(codePath));
          } catch {}
          const fresh = await rpc('state');
          setState(fresh);
          setCodeDirty(false);
          setCodeCheck(undefined);
        } else setCodeCheck(result);
      }
    } finally {
      setCodeBusy(false);
    }
  };
  const checkVisual = async () => {
    if (visualCheckBusy || !scene) return;
    setVisualCheckBusy(true);
    setPlaying(false);
    try {
      const samples = [
          ...new Set([
            0,
            Math.max(0, frame - 1),
            frame,
            Math.min(activeDuration - 1, frame + 1),
            Math.floor((activeDuration - 1) / 2),
            activeDuration - 1,
          ]),
        ],
        result = await run('visualAudit', {
          sceneId,
          path: focusPath,
          contextFrames: focusContextFrames,
          revision: stateRef.current?.snapshot.revision,
          frames: samples,
          width: 320,
          inline: true,
        });
      if (result) setVisualCheck(result);
    } finally {
      setVisualCheckBusy(false);
    }
  };
  const transact = async (operations: Operation[]) => {
    setSaving(true);
    try {
      if (
        operations.every((op) => op.type === 'updateNode') &&
        (focusPath.length ||
          operations.some((op) => !rootScene?.nodes.some((n) => n.id === (op as any).nodeId)))
      ) {
        return await run('compositionTransactBatch', {
          sceneId,
          frame,
          revision: stateRef.current?.snapshot.revision,
          edits: operations.map((operation) => {
            const op = operation as Extract<Operation, { type: 'updateNode' }>;
            return {
              path: interactions?.layers.find((l) => l.node.id === op.nodeId)?.path ?? focusPath,
              contextFrames:
                interactions?.layers.find((l) => l.node.id === op.nodeId)?.contextFrames ??
                focusContextFrames,
              frame: interactions?.layers.find((l) => l.node.id === op.nodeId)?.frame ?? frame,
              nodeId: op.nodeId,
              patch: op.patch,
            };
          }),
        });
      }
      return await run('transact', { operations, revision: stateRef.current?.snapshot.revision });
    } finally {
      setSaving(false);
    }
  };
  const enterScene = (id: string) => {
    setFocusContextFrames([]);
    window.history.pushState(null, '', compositionUrl(id, []));
    setFilter('');
    setPlaying(false);
    setFocusPath([]);
    setComposition(undefined);
    setSceneId(id);
    setWorkspace('animation');
    const key = `${id}:[]`;
    setSceneFrames((current) => ({ ...current, [key]: current[key] ?? 0 }));
    setSelected('');
  };
  const enterGroup = (id: string) => {
    const layer = interactions?.layers.find((l) => l.node.id === id),
      contexts = [...(layer?.contextFrames ?? focusContextFrames), layer?.frame ?? frame],
      sourceFrame = Math.round(layer?.contentFrame ?? layer?.frame ?? sceneFrame);
    const nextPath = [
      ...(interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath),
      id,
    ];
    const key = `${sceneId}:${JSON.stringify(nextPath)}:${JSON.stringify(contexts)}`;
    setSceneFrames((current) => ({ ...current, [key]: current[key] ?? sourceFrame }));
    setFocusContextFrames(contexts);
    window.history.pushState(null, '', compositionUrl(sceneId, nextPath, contexts));
    setFilter('');
    setPlaying(false);
    setSelected('');
    setFocusPath(nextPath);
    setComposition(undefined);
  };
  const returnProject = () => {
    setFocusContextFrames([]);
    window.history.pushState(null, '', '#/project');
    setFilter('');
    setPlaying(false);
    setFocusPath([]);
    setComposition(undefined);
    setWorkspace('editing');
    setSelected('');
  };
  const update = (patch: Partial<Node>) => {
    if (!node) return;
    const current = evaluateNode(node, nodeFrame),
      keyFrame = Math.round(nodeFrame);
    if (
      Object.entries(patch).every(
        ([key, value]) => JSON.stringify(value) === JSON.stringify((current as any)[key]),
      )
    )
      return;
    const animations = structuredClone(node.animations);
    let keyed = false;
    for (const [property, value] of Object.entries(patch)) {
      const channel = animations.find((a) => a.property === property);
      if (channel && typeof value === 'number') {
        channel.keys = channel.keys.filter((k) => k.frame !== keyFrame);
        channel.keys.push({ frame: keyFrame, value, easing: 'easeInOut' });
        channel.keys.sort((a, b) => a.frame - b.frame);
        keyed = true;
      }
    }
    if (patch.params) {
      for (const [name, value] of Object.entries(patch.params)) {
        const channel = animations.find((a) => a.property === `params.${name}`);
        if (channel && typeof value === 'number') {
          channel.keys = channel.keys.filter((k) => k.frame !== keyFrame);
          channel.keys.push({ frame: keyFrame, value, easing: 'easeInOut' });
          channel.keys.sort((a, b) => a.frame - b.frame);
          keyed = true;
        }
      }
    }
    return transact([
      {
        type: 'updateNode',
        sceneId,
        nodeId: node.id,
        patch: { ...patch, ...(keyed ? { animations } : {}) },
      },
    ]);
  };
  const selectMany = (ids: string[]) => {
    if (JSON.stringify(ids) === JSON.stringify(selectedIds)) return;
    setSelectedIds(ids);
    void run('selection', { ids });
  };
  const select = (id: string, additive = false) =>
    selectMany(
      additive
        ? selectedIds.includes(id)
          ? selectedIds.filter((value) => value !== id)
          : [...selectedIds, id]
        : id
          ? [id]
          : [],
    );
  const editSequenceActions = async (actions: SequenceAction[]) => {
    if (!sequence) return;
    setSaving(true);
    setPlaying(false);
    try {
      const result = await run('sequenceEdit', {
        sequenceId: sequence.id,
        actions,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result?.edit) {
        const ids = new Set(
          result.snapshot.sequences
            .find((s: { id: string }) => s.id === sequence.id)
            ?.tracks.flatMap((t: { clips: Array<{ id: string }> }) => t.clips.map((c) => c.id)) ??
            [],
        );
        setClipSelection((current) =>
          result.edit.selection.length
            ? result.edit.selection
            : current.filter((id) => ids.has(id)),
        );
        setSequenceFrame((at) => Math.min(at, result.edit.duration - 1));
      }
      return result;
    } finally {
      setSaving(false);
    }
  };
  const editParameters = async (data: Record<string, unknown>) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('componentParametersEdit', {
        sceneId,
        nodeId: node.id,
        path: interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
        frame: Math.round(nodeFrame),
        contextFrames: nodeContextFrames,
        revision: stateRef.current?.snapshot.revision,
        ...data,
      });
    } finally {
      setSaving(false);
    }
  };
  const editTime = async (data: Record<string, unknown>) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('timeEdit', {
        sceneId,
        nodeId: node.id,
        path: selectedLayer?.path ?? focusPath,
        contextFrames: nodeContextFrames,
        frame: nodeFrame,
        revision: stateRef.current?.snapshot.revision,
        ...data,
      });
    } finally {
      setSaving(false);
    }
  };
  const editAnimation = async (actions: KeyframeAction[]) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('animationEdit', {
        sceneId,
        frame,
        revision: stateRef.current?.snapshot.revision,
        edits: [
          {
            nodeId: node.id,
            path: interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
            actions,
            frame: nodeFrame,
            contextFrames: nodeContextFrames,
          },
        ],
      });
    } finally {
      setSaving(false);
    }
  };
  const editStructure = async (
    type: string,
    options: Record<string, unknown> = {},
    ids = selectedIds,
  ) => {
    const buckets = new Map<
      string,
      { path: string[]; ids: string[]; frame: number; contextFrames: number[] }
    >();
    for (const id of ids) {
      const path = interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
        layer = interactions?.layers.find((l) => l.node.id === id),
        at = layer?.frame ?? frame,
        contexts = layer?.contextFrames ?? focusContextFrames,
        key = JSON.stringify([path, at, contexts]),
        bucket = buckets.get(key) ?? { path, ids: [], frame: at, contextFrames: contexts };
      bucket.ids.push(id);
      buckets.set(key, bucket);
    }
    if (type === 'group' && buckets.size > 1) {
      setError('编组需要同一组件的图层；请进入对应合成后选择图层。');
      return;
    }
    const actions =
      type === 'add'
        ? [
            {
              path: focusPath,
              contextFrames: focusContextFrames,
              frame,
              action: { type, ...options },
            },
          ]
        : [...buckets.values()].map((bucket) => ({
            path: bucket.path,
            frame: bucket.frame,
            contextFrames: bucket.contextFrames,
            action: { type, ids: bucket.ids, ...options },
          }));
    if (!actions.length) return;
    setSaving(true);
    try {
      const result = await run('compositionStructureBatch', {
        sceneId,
        frame,
        actions,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const bakeVector = async (operation: string, radius: number) => {
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请进入共同的组件合成，再选择同一父级的矢量图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('vectorBake', {
        sceneId,
        path: paths[0] ?? focusPath,
        nodeIds: selectedIds,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        operation,
        radius,
        hideSources: true,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const createRepeated = async () => {
    if (!selectedIds.length) return;
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请进入共同的组件合成，再选择同一父级的图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('repeatCreate', {
        sceneId,
        path: paths[0] ?? focusPath,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        nodeIds: selectedIds,
        hideSources: true,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const createSharedScene = async () => {
    if (!selectedIds.length) return;
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请在共同合成中选择同一父级的图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('scenePrecompose', {
        sceneId,
        path: paths[0] ?? focusPath,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        nodeIds: selectedIds,
        name: `${node?.name ?? '图层'} · 共享场景`,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const insertSharedScene = async (sourceId: string) => {
    if (!sourceId) return;
    setSaving(true);
    try {
      const result = await run('scenePlace', {
        sceneId,
        sourceId,
        path: focusPath,
        frame,
        contextFrames: focusContextFrames,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (workspace === 'drawing' || visualCheckOpen || document.querySelector('.project-modal'))
        return;
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,[role="separator"],[contenteditable="true"]',
        )
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFrame((f) => Math.min(f + 1, activeDuration - 1));
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFrame((f) => Math.max(0, f - 1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void run(e.shiftKey ? 'redo' : 'undo');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void run('save');
      }
      if (workspace === 'editing') {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          void editSequenceActions([
            { type: 'split', frame, clipIds: clipSelected ? [clipSelected] : undefined },
          ]);
        }
        if (!e.ctrlKey && !e.metaKey && ['i', 'o'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          void editSequenceActions([
            { type: e.key.toLowerCase() === 'i' ? 'rangeIn' : 'rangeOut', frame },
          ]);
        }
        if (e.key === 'Delete' && clipSelected) {
          e.preventDefault();
          void editSequenceActions([
            { type: 'remove', clipIds: [clipSelected], ripple: e.shiftKey },
          ]);
        }
        return;
      }
      if (e.key === 'Delete' && selected && scene) {
        e.preventDefault();
        void editStructure('delete');
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void editStructure('duplicate', { offset: { x: 0, y: 0 } });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        void editStructure(e.shiftKey ? 'ungroup' : 'group');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    selectedIds,
    clipSelected,
    sceneId,
    sequence?.duration,
    scene,
    interactions,
    focusPath.join('/'),
    frame,
    workspace,
    visualCheckOpen,
  ]);
  const addNode = async (type: Node['type']) => {
    if (!scene) return;
    const id = uid();
    const props: Partial<Node> = {
      id,
      type,
      name:
        type === 'text'
          ? 'Text layer'
          : type === 'formula'
            ? 'Equation'
            : type === 'chart'
              ? 'Data chart'
              : type === 'group'
                ? 'Group'
                : `${type[0].toUpperCase() + type.slice(1)}`,
      x: 240,
      y: 240,
      width: type === 'text' ? 1000 : 600,
      height: type === 'text' ? 180 : 300,
      fill: type === 'text' || type === 'formula' ? '#f4f6ff' : '#92a0ff',
      text: type === 'text' ? 'Write your next idea' : type === 'formula' ? 'e^{i\\pi}+1=0' : '',
      fontSize: 64,
      params: type === 'chart' ? { values: [30, 65, 45, 90, 72], mode: 'bar' } : {},
    };
    return editStructure('add', { node: props });
  };
  const addKey = (property: Node['animations'][number]['property']) => {
    if (!node) return;
    const existing = node.animations.find((a) => a.property === property);
    const keyFrame = Math.round(nodeFrame),
      keys = existing?.keys.filter((k) => k.frame !== keyFrame) ?? [];
    keys.push({
      frame: keyFrame,
      value: getNumericPath(evaluateNode(node, nodeFrame), property),
      easing: 'easeInOut',
    });
    const animations = node.animations.filter((a) => a.property !== property);
    animations.push({ property, keys: keys.sort((a, b) => a.frame - b.frame) });
    void update({ animations });
  };
  const importAsset = async () => {
    const file = window.vmotionDesktop
      ? await window.vmotionDesktop.pickAsset()
      : window.prompt('Absolute path to a local image, video, audio or font');
    if (!file) return;
    const ext = file.split('.').at(-1)?.toLowerCase();
    const type = ['mp4', 'mov', 'mkv', 'webm'].includes(ext ?? '')
      ? 'video'
      : ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext ?? '')
        ? 'audio'
        : ['ttf', 'otf', 'woff', 'woff2'].includes(ext ?? '')
          ? 'font'
          : 'image';
    await run('import', { path: file, type });
    setAssetTab(true);
  };
  const placeAsset = async (asset: any, drop?: { x: number; y: number }) => {
    if (!scene) return;
    if (asset.type === 'font') return;
    const result = await run('assetPlace', {
      assetId: asset.id,
      frame: asset.type === 'audio' && workspace !== 'editing' ? sequenceFrame : frame,
      revision: stateRef.current?.snapshot.revision,
      ...(workspace === 'editing' || asset.type === 'audio'
        ? { sequenceId: sequence!.id }
        : {
            sceneId,
            path: focusPath,
            contextFrames: focusContextFrames,
            ...drop,
            anchor: drop ? 'center' : undefined,
          }),
    });
    if (result?.nodeId) select(result.nodeId);
    if (result?.clipId) {
      setClipSelected(result.clipId);
      if (asset.type === 'audio' && workspace !== 'editing') {
        setPlaying(false);
        setWorkspace('editing');
      }
    }
  };
  useEffect(() => {
    const drop = (event: Event) => {
      const { assetId, clientX, clientY } = (event as CustomEvent<AssetDropDetail>).detail,
        target = document.elementFromPoint(clientX, clientY);
      if (!target?.closest('.canvas-interaction') || !previewRef.current) return;
      const bounds = previewRef.current.getBoundingClientRect(),
        asset = project?.assets.find((a) => a.id === assetId);
      if (asset)
        void placeAsset(asset, {
          x: ((clientX - bounds.left) * viewWidth) / bounds.width,
          y: ((clientY - bounds.top) * viewHeight) / bounds.height,
        });
    };
    window.addEventListener(ASSET_DROP_EVENT, drop);
    return () => window.removeEventListener(ASSET_DROP_EVENT, drop);
  }, [project?.assets, workspace, sceneId, focusPath.join('/'), frame, viewWidth, viewHeight]);
  function position(e: React.PointerEvent) {
    const box = previewRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * viewWidth,
      y: ((e.clientY - box.top) / box.height) * viewHeight,
      pressure: e.pointerType === 'pen' ? e.pressure : 1,
    };
  }
  function pointerDown(e: React.PointerEvent) {
    if (e.altKey || e.button === 1) return;
    if (workspace !== 'drawing') return;
    const p = position(e);
    strokeRef.current = [p];
    setStroke([p]);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: React.PointerEvent) {
    if (workspace === 'drawing' && strokeRef.current.length) {
      const p = position(e);
      strokeRef.current = [...strokeRef.current, p];
      setStroke(strokeRef.current);
    }
  }
  async function pointerUp() {
    if (workspace === 'drawing' && strokeRef.current.length > 1) {
      await run('drawingStroke', {
        sceneId,
        points: strokeRef.current,
        color: paintColor,
        width: brush,
        start: frame,
        end: Math.min(scene?.duration ?? 300, frame + hold),
      });
    }
    strokeRef.current = [];
    setStroke([]);
  }
  const timecode = (f: number) =>
    `${String(Math.floor(f / fps / 60)).padStart(2, '0')}:${String(Math.floor(f / fps) % 60).padStart(2, '0')}:${String(Math.floor(f % fps)).padStart(2, '0')}`;

  return useStableControllerValues({
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
  });
}
