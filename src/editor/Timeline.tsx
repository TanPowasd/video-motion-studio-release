import React, { useState, useRef, useEffect } from 'react';
import type { Snapshot, Scene, Sequence, Operation, Node, Clip, Keyframe } from '../core/model.js';
import { Icon } from './Icons.js';
import { ASSET_DROP_EVENT, type AssetDropDetail } from './AssetItem.js';
import type { KeyframeAction } from '../core/keyframes.js';
import { AudioMonitor } from './AudioMonitor.js';
import type { SequenceAction } from '../core/editing.js';
interface TimelineProps {
  snapshot: Snapshot;
  scene: Scene;
  sequence: Sequence;
  sequenceMode: boolean;
  frame: number;
  selected: string;
  selection: string[];
  playing: boolean;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
  onSelect: (id: string, additive?: boolean) => void;
  onScene: (id: string) => void;
  onClip: (id: string, additive?: boolean) => void;
  clipSelection: string[];
  onSequenceEdit: (actions: SequenceAction[]) => Promise<unknown>;
  selectedClip: string;
  transact: (operations: Operation[]) => Promise<unknown>;
  waveforms: Record<string, number[]>;
  onAssetDrop: (assetId: string, frame: number, trackId?: string) => Promise<unknown>;
  onAnimationEdit: (
    edits: Array<{ nodeId: string; actions: KeyframeAction[] }>,
    revision?: string,
  ) => Promise<unknown>;
  audioMonitor?: React.ComponentProps<typeof AudioMonitor>;
  /** Studio shell: layers / clips changed by external AI (mint marks + ruler strips). */
  aiMarks?: {
    nodes: Map<string, { created: boolean }>;
    clips: Map<string, { created: boolean }>;
  };
}
type Drag = {
  kind: 'move' | 'left' | 'right';
  id: string;
  startX: number;
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  trackId?: string;
  node?: Node;
  clipIds?: string[];
  patch: { start: number; duration: number; sourceIn: number };
};
export function Timeline({
  snapshot,
  scene,
  sequence,
  sequenceMode,
  frame,
  selected,
  selection,
  playing,
  onFrame,
  onPlaying,
  onSelect,
  onScene,
  onClip,
  selectedClip,
  clipSelection,
  onSequenceEdit,
  transact,
  waveforms,
  onAssetDrop,
  onAnimationEdit,
  audioMonitor,
  aiMarks,
}: TimelineProps) {
  const [zoom, setZoom] = useState(1),
    [snap, setSnap] = useState(true),
    [width, setWidth] = useState(1000),
    [dragging, setDragging] = useState<Drag | undefined>(),
    scroll = useRef<HTMLDivElement>(null),
    dragRef = useRef<Drag | undefined>(undefined),
    [scrollLeft, setScrollLeft] = useState(0),
    scrubbing = useRef(false),
    [hoverFrame, setHoverFrame] = useState<number>(),
    zoomAnchor = useRef<{ frame: number; offset: number } | undefined>(undefined);
  type SelectedKey = { nodeId: string; property: string; frame: number };
  const [selectedKeys, setSelectedKeys] = useState<SelectedKey[]>([]),
    [keyDelta, setKeyDelta] = useState<number>(),
    [clipboardCount, setClipboardCount] = useState(0),
    keyDrag = useRef<
      | {
          pointerId: number;
          clientX: number;
          keys: SelectedKey[];
          delta: number;
          target: HTMLElement;
          revision: string;
        }
      | undefined
    >(undefined),
    keyClipboard = useRef<Array<{ nodeId: string; property: string; key: Keyframe }>>([]);
  useEffect(() => {
    setSelectedKeys([]);
    setKeyDelta(undefined);
    keyDrag.current = undefined;
  }, [scene.id, sequenceMode, selected]);
  useEffect(() => {
    keyClipboard.current = [];
    setClipboardCount(0);
  }, [scene.id, sequenceMode]);
  const selectedKey = (nodeId: string, property: string, frame: number) =>
    selectedKeys.some((k) => k.nodeId === nodeId && k.property === property && k.frame === frame);
  const keyActions = (keys: SelectedKey[], kind: 'move' | 'delete', delta = 0) => {
    const nodes = new Map<string, Map<string, number[]>>();
    for (const key of keys) {
      const channels = nodes.get(key.nodeId) ?? new Map<string, number[]>(),
        frames = channels.get(key.property) ?? [];
      frames.push(key.frame);
      channels.set(key.property, frames);
      nodes.set(key.nodeId, channels);
    }
    return [...nodes.entries()].map(([nodeId, channels]) => ({
      nodeId,
      actions: [...channels.entries()].map(([property, frames]) =>
        kind === 'delete'
          ? { type: 'remove' as const, properties: [property], frames }
          : { type: 'transform' as const, properties: [property], frames, timeOffset: delta },
      ),
    }));
  };
  const moveKey = (event: React.PointerEvent) => {
    const drag = keyDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientX - drag.clientX) / pxPerFrame);
    drag.delta = Math.max(-Math.min(...drag.keys.map((k) => k.frame)), delta);
    setKeyDelta(drag.delta);
  };
  const finishKey = async (event: React.PointerEvent) => {
    const drag = keyDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveKey(event);
    keyDrag.current = undefined;
    if (drag.target.hasPointerCapture(event.pointerId))
      drag.target.releasePointerCapture(event.pointerId);
    setKeyDelta(undefined);
    if (!drag.delta) return;
    const result = await onAnimationEdit(keyActions(drag.keys, 'move', drag.delta), drag.revision);
    if (result) setSelectedKeys(drag.keys.map((k) => ({ ...k, frame: k.frame + drag.delta })));
  };
  const copyKeys = () => {
    keyClipboard.current = selectedKeys.flatMap((k) => {
      const key = scene.nodes
        .find((n) => n.id === k.nodeId)
        ?.animations.find((a) => a.property === k.property)
        ?.keys.find((v) => v.frame === k.frame);
      return key ? [{ nodeId: k.nodeId, property: k.property, key: structuredClone(key) }] : [];
    });
    setClipboardCount(keyClipboard.current.length);
  };
  const pasteKeys = () => {
    if (!keyClipboard.current.length) return;
    const targetNode =
      new Set(keyClipboard.current.map((k) => k.nodeId)).size === 1 && selected
        ? selected
        : undefined;
    const shift = frame - Math.min(...keyClipboard.current.map((k) => k.key.frame)),
      nodes = new Map<string, Map<string, Keyframe[]>>();
    for (const item of keyClipboard.current) {
      const channels = nodes.get(targetNode ?? item.nodeId) ?? new Map<string, Keyframe[]>(),
        keys = channels.get(item.property) ?? [];
      keys.push({ ...item.key, frame: item.key.frame + shift });
      channels.set(item.property, keys);
      nodes.set(targetNode ?? item.nodeId, channels);
    }
    void onAnimationEdit(
      [...nodes.entries()].map(([nodeId, channels]) => ({
        nodeId,
        actions: [...channels.entries()].map(([property, keys]) => ({
          type: 'upsert',
          property,
          keys,
          collision: 'error',
        })),
      })),
    ).then((result) => {
      if (result)
        setSelectedKeys(
          keyClipboard.current.map((k) => ({
            nodeId: targetNode ?? k.nodeId,
            property: k.property,
            frame: k.key.frame + shift,
          })),
        );
    });
  };
  const fps = snapshot.project.fps.num / snapshot.project.fps.den,
    duration = sequenceMode ? sequence.duration : scene.duration,
    labelWidth = 218,
    contentWidth = Math.max(300, width - labelWidth - 20) * zoom,
    pxPerFrame = contentWidth / duration,
    pxPerFrameRef = useRef(pxPerFrame),
    seconds = duration / fps,
    selectedNode = scene.nodes.find((n) => n.id === selected);
  pxPerFrameRef.current = pxPerFrame;
  useEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(scroll.current!);
    return () => observer.disconnect();
  }, []);
  // Ctrl/⌘ + wheel zooms around the pointer; plain wheel keeps native scrolling.
  useEffect(() => {
    const element = scroll.current!;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const box = element.getBoundingClientRect(),
        offset = Math.max(0, event.clientX - box.left - labelWidth),
        frameAt = (element.scrollLeft + offset) / pxPerFrameRef.current;
      zoomAnchor.current = { frame: frameAt, offset };
      setZoom((z) => Math.max(1, Math.min(64, z * (event.deltaY > 0 ? 1 / 1.2 : 1.2))));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const anchor = zoomAnchor.current;
    if (!anchor) return;
    zoomAnchor.current = undefined;
    scroll.current!.scrollLeft = Math.max(0, anchor.frame * pxPerFrame - anchor.offset);
  }, [zoom]);
  // Keep the selected layer/clip row visible when selection changes elsewhere (canvas, layer list).
  useEffect(() => {
    const box = scroll.current,
      row = box?.querySelector<HTMLElement>('.tl-row.selected');
    if (!box || !row) return;
    // Scroll only the timeline itself (scrollIntoView would also move overflow:hidden ancestors).
    const r = row.getBoundingClientRect(),
      b = box.getBoundingClientRect(),
      ruler = box.querySelector<HTMLElement>('.tl-ruler-row')?.offsetHeight ?? 0;
    if (r.top < b.top + ruler) box.scrollTop -= b.top + ruler - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [selected]);
  useEffect(() => {
    if (!playing) return;
    const box = scroll.current!,
      x = frame * pxPerFrame;
    if (x < box.scrollLeft || x > box.scrollLeft + width - labelWidth - 35)
      box.scrollLeft = Math.max(0, x - (width - labelWidth) * 0.65);
  }, [frame, playing]);
  useEffect(() => {
    const drop = (event: Event) => {
      const { assetId, clientX, clientY } = (event as CustomEvent<AssetDropDetail>).detail,
        element = scroll.current!,
        bounds = element.getBoundingClientRect();
      if (
        clientX < bounds.left ||
        clientX > bounds.right ||
        clientY < bounds.top ||
        clientY > bounds.bottom
      )
        return;
      const at = Math.max(
          0,
          Math.min(
            duration - 1,
            Math.round((clientX - bounds.left + element.scrollLeft - labelWidth) / pxPerFrame),
          ),
        ),
        trackId = document
          .elementFromPoint(clientX, clientY)
          ?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId;
      void onAssetDrop(assetId, at, sequenceMode ? trackId : undefined).then((result) => {
        if (result) {
          onFrame(at);
          onPlaying(false);
        }
      });
    };
    window.addEventListener(ASSET_DROP_EVENT, drop);
    return () => window.removeEventListener(ASSET_DROP_EVENT, drop);
  }, [duration, pxPerFrame, sequenceMode, onAssetDrop, onFrame, onPlaying]);
  const time = (f: number) => {
    const sec = f / fps;
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec) % 60).padStart(2, '0')}:${String(Math.floor(f % fps)).padStart(2, '0')}`;
  };
  const snapFrame = (value: number, exclude: string) => {
    if (!snap) return Math.round(value);
    const candidates = [
      0,
      duration,
      frame,
      ...(sequenceMode ? sequence.markers.map((m) => m.frame) : []),
      ...(sequenceMode
        ? sequence.tracks.flatMap((t) =>
            t.clips.filter((c) => c.id !== exclude).flatMap((c) => [c.start, c.start + c.duration]),
          )
        : scene.nodes.filter((n) => n.id !== exclude).flatMap((n) => [n.start, n.end ?? duration])),
    ];
    const near = candidates.sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
    return Math.abs(near - value) * pxPerFrame < 8 ? near : Math.round(value);
  };
  function begin(
    event: React.PointerEvent,
    kind: Drag['kind'],
    id: string,
    start: number,
    length: number,
    sourceIn = 0,
    speed = 1,
    trackId?: string,
    node?: Node,
  ) {
    if (sequenceMode && sequence.tracks.find((t) => t.id === trackId)?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    onPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag: Drag = {
      kind,
      id,
      startX: event.clientX,
      start,
      duration: length,
      sourceIn,
      speed,
      trackId,
      node,
      clipIds: sequenceMode
        ? event.ctrlKey || event.metaKey
          ? [...new Set([...clipSelection, id])]
          : clipSelection.includes(id)
            ? clipSelection
            : [id]
        : undefined,
      patch: { start, duration: length, sourceIn },
    };
    if (sequenceMode && drag.clipIds) {
      const seeds = new Set(drag.clipIds),
        clips = sequence.tracks.flatMap((t) => t.clips),
        groups = new Set(
          clips.flatMap((c) => (seeds.has(c.id) && c.linkedGroup ? [c.linkedGroup] : [])),
        );
      drag.clipIds = clips
        .filter((c) => seeds.has(c.id) || (c.linkedGroup && groups.has(c.linkedGroup)))
        .map((c) => c.id);
    }
    dragRef.current = drag;
    setDragging(drag);
    if (sequenceMode) {
      if (event.ctrlKey || event.metaKey) onClip(id, true);
      else if (!clipSelection.includes(id)) onClip(id);
    } else if (event.ctrlKey || event.metaKey) onSelect(id, true);
    else if (!selection.includes(id)) onSelect(id);
  }
  function move(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.startX) / pxPerFrame;
    let start = drag.start,
      length = drag.duration,
      sourceIn = drag.sourceIn;
    if (drag.kind === 'move') {
      start = Math.max(0, Math.min(duration - length, snapFrame(drag.start + delta, drag.id)));
      if (sequenceMode && drag.clipIds?.length) {
        const clips = sequence.tracks
            .flatMap((t) => t.clips)
            .filter((c) => drag.clipIds!.includes(c.id)),
          min = Math.min(...clips.map((c) => c.start));
        start = Math.max(drag.start - min, start);
      }
    } else if (drag.kind === 'right') {
      const end = Math.max(
        start + 1,
        Math.min(duration, snapFrame(start + length + delta, drag.id)),
      );
      length = end - start;
    } else {
      start = Math.max(
        0,
        Math.min(drag.start + drag.duration - 1, snapFrame(drag.start + delta, drag.id)),
      );
      if (sequenceMode) {
        start = Math.max(drag.start - Math.floor(drag.sourceIn / drag.speed), start);
        sourceIn = Math.max(0, drag.sourceIn + (start - drag.start) * drag.speed);
      }
      length = drag.start + drag.duration - start;
    }
    drag.patch = { start, duration: length, sourceIn };
    setDragging({ ...drag });
  }
  async function finish() {
    const drag = dragRef.current;
    dragRef.current = undefined;
    setDragging(undefined);
    if (!drag) return;
    if (
      drag.patch.start === drag.start &&
      drag.patch.duration === drag.duration &&
      drag.patch.sourceIn === drag.sourceIn
    )
      return;
    if (sequenceMode) {
      await onSequenceEdit([
        drag.kind === 'move'
          ? {
              type: 'move',
              clipIds: drag.clipIds ?? [drag.id],
              delta: drag.patch.start - drag.start,
            }
          : {
              type: 'trim',
              clipId: drag.id,
              edge: drag.kind === 'left' ? 'in' : 'out',
              frame:
                drag.kind === 'left' ? drag.patch.start : drag.patch.start + drag.patch.duration,
            },
      ]);
    } else {
      const delta = drag.patch.start - drag.start,
        patch: Partial<Node> = {
          start: drag.patch.start,
          end: drag.patch.start + drag.patch.duration,
        };
      if (drag.kind === 'move' && drag.node) {
        patch.animations = drag.node.animations.map((a) => ({
          ...a,
          keys: a.keys.map((k) => ({ ...k, frame: Math.max(0, k.frame + delta) })),
        }));
      }
      await transact([{ type: 'updateNode', sceneId: scene.id, nodeId: drag.id, patch }]);
    }
  }
  const stepOptions = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600],
    step = stepOptions.find((s) => s * fps * pxPerFrame >= 70) ?? 3600,
    firstTick = Math.floor(scrollLeft / (fps * pxPerFrame) / step) * step,
    lastTick = Math.min(seconds, (scrollLeft + width) / (fps * pxPerFrame) + step),
    ticks = Array.from(
      { length: Math.max(0, Math.ceil((lastTick - firstTick) / step)) },
      (_, i) => firstTick + i * step,
    );
  // Visual feedback for snapping: show a guide where the dragged edge landed on a target.
  const snapGuide = (() => {
    if (!dragging || !snap) return undefined;
    const { start, duration: length } = dragging.patch,
      edges =
        dragging.kind === 'left'
          ? [start]
          : dragging.kind === 'right'
            ? [start + length]
            : [start, start + length],
      targets = new Set([
        0,
        duration,
        frame,
        ...(sequenceMode ? sequence.markers.map((m) => m.frame) : []),
        ...(sequenceMode
          ? sequence.tracks.flatMap((t) =>
              t.clips
                .filter((c) => c.id !== dragging.id && !dragging.clipIds?.includes(c.id))
                .flatMap((c) => [c.start, c.start + c.duration]),
            )
          : scene.nodes
              .filter((n) => n.id !== dragging.id)
              .flatMap((n) => [n.start, n.end ?? duration])),
      ]);
    return edges.find((edge) => targets.has(edge));
  })();
  const title = sequenceMode ? sequence.name : scene.name;
  const draft = (id: string, start: number, length: number) =>
    dragging?.id === id
      ? dragging.patch
      : dragging?.kind === 'move' && dragging.clipIds?.includes(id)
        ? { start: start + dragging.patch.start - dragging.start, duration: length }
        : { start, duration: length };
  const clipName = (clip: Clip) =>
    clip.name ||
    (clip.sceneId
      ? snapshot.scenes.find((s) => s.id === clip.sceneId)?.name
      : clip.assetId
        ? snapshot.project.assets.find((a) => a.id === clip.assetId)?.name
        : snapshot.sequences.find((s) => s.id === clip.sequenceId)?.name);
  function keyRow(nodeId: string, property: string, keys: Keyframe[]) {
    return (
      <div className="tl-row channel-row" key={property}>
        <div className="tl-label">
          <Icon name="key" size={12} />
          <span>{property}</span>
          <span className="tl-small">{keys.length}</span>
        </div>
        <div className="tl-lane" style={{ width: contentWidth }}>
          {keys.map((key) => (
            <button
              className="tl-key"
              aria-label={`关键帧 ${property} ${key.frame}`}
              aria-pressed={selectedKey(nodeId, property, key.frame)}
              key={key.frame}
              title={`${property} ${key.value} @ ${key.frame}f`}
              style={{
                left:
                  (key.frame + (selectedKey(nodeId, property, key.frame) ? (keyDelta ?? 0) : 0)) *
                  pxPerFrame,
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.focus();
                onPlaying(false);
                onFrame(key.frame);
                const item = { nodeId, property, frame: key.frame },
                  keys =
                    e.ctrlKey || e.metaKey
                      ? selectedKey(nodeId, property, key.frame)
                        ? selectedKeys.filter(
                            (k) =>
                              k.nodeId !== nodeId ||
                              k.property !== property ||
                              k.frame !== key.frame,
                          )
                        : [...selectedKeys, item]
                      : selectedKey(nodeId, property, key.frame)
                        ? selectedKeys
                        : [item];
                setSelectedKeys(keys);
                if (!keys.length) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                keyDrag.current = {
                  pointerId: e.pointerId,
                  clientX: e.clientX,
                  keys,
                  delta: 0,
                  target: e.currentTarget,
                  revision: snapshot.revision,
                };
              }}
              onPointerMove={(e) => {
                if (keyDrag.current) {
                  e.stopPropagation();
                  moveKey(e);
                }
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                void finishKey(e);
              }}
              onPointerCancel={() => {
                keyDrag.current = undefined;
                setKeyDelta(undefined);
              }}
              onLostPointerCapture={() => {
                if (keyDrag.current) {
                  keyDrag.current = undefined;
                  setKeyDelta(undefined);
                }
              }}
            >
              ◆
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <section
      className="timeline"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('input,textarea,select')) return;
        if (e.key === 'Escape') {
          keyDrag.current = undefined;
          setKeyDelta(undefined);
          setSelectedKeys([]);
          return;
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === 'a' &&
          !sequenceMode &&
          selectedNode
        ) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedKeys(
            selectedNode.animations.flatMap((channel) =>
              channel.keys.map((key) => ({
                nodeId: selectedNode.id,
                property: channel.property,
                frame: key.frame,
              })),
            ),
          );
          return;
        }
        if (e.key === 'Delete' && selectedKeys.length) {
          e.preventDefault();
          e.stopPropagation();
          void onAnimationEdit(keyActions(selectedKeys, 'delete')).then((result) => {
            if (result) setSelectedKeys([]);
          });
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedKeys.length) {
          e.preventDefault();
          e.stopPropagation();
          copyKeys();
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === 'v' &&
          keyClipboard.current.length
        ) {
          e.preventDefault();
          e.stopPropagation();
          pasteKeys();
        }
      }}
    >
      <div className="timeline-top">
        <div className="timeline-name">
          <Icon name={sequenceMode ? 'film' : 'layers'} size={16} />
          <strong>{title}</strong>
          <span className="tag">{sequenceMode ? '序列' : '场景'}</span>
        </div>
        <div className="transport">
          <button
            className="icon-button"
            title="回到第一帧 · Home"
            aria-label="回到第一帧"
            onClick={() => {
              onPlaying(false);
              onFrame(0);
            }}
          >
            <Icon name="skipBack" size={14} />
          </button>
          <button
            className="icon-button"
            title="上一帧 · ←"
            aria-label="上一帧"
            onClick={() => onFrame(Math.max(0, frame - 1))}
          >
            <Icon name="stepBack" size={15} />
          </button>
          <button
            className={`play-button ${playing ? 'playing' : ''}`}
            aria-label={playing ? '暂停' : '播放'}
            title={`${playing ? '暂停' : '播放'} · Space`}
            onClick={() => onPlaying(!playing)}
          >
            <Icon name={playing ? 'pause' : 'play'} size={15} />
          </button>
          <button
            className="icon-button"
            title="下一帧 · →"
            aria-label="下一帧"
            onClick={() => onFrame(Math.min(duration - 1, frame + 1))}
          >
            <Icon name="stepForward" size={15} />
          </button>
          <button
            className="icon-button"
            title="跳到最后一帧 · End"
            aria-label="跳到最后一帧"
            onClick={() => {
              onPlaying(false);
              onFrame(Math.max(0, duration - 1));
            }}
          >
            <Icon name="skipForward" size={14} />
          </button>
          <input
            className="timecode-input"
            aria-label="当前帧"
            type="number"
            min={0}
            max={duration - 1}
            value={frame}
            onChange={(e) => {
              onFrame(Math.max(0, Math.min(duration - 1, Number(e.target.value) || 0)));
              onPlaying(false);
            }}
          />
          <span className="timecode">{time(frame)}</span>
          <span className="duration">/ {time(duration)}</span>
        </div>
        <div className="timeline-actions">
          {aiMarks && (
            <span className="tl-legend" aria-label="图例">
              <span className="me">
                <i />
                我的改动
              </span>
              <span className="ai">
                <i />
                AI 的改动
              </span>
            </span>
          )}
          {audioMonitor && <AudioMonitor {...audioMonitor} />}
          <button
            className={`snap-toggle ${snap ? 'pressed' : ''}`}
            aria-pressed={snap}
            title="吸附到边界、标记和播放头"
            onClick={() => setSnap(!snap)}
          >
            <Icon name="magnet" size={14} />
            吸附
          </button>
          <span className="timeline-actions-divider" />
          <button
            className="icon-button"
            title="时间轴缩小 · Ctrl+滚轮"
            aria-label="时间轴缩小"
            onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
          >
            <Icon name="minus" size={14} />
          </button>
          <input
            aria-label="时间轴缩放"
            type="range"
            min={0}
            max={6}
            step={0.1}
            value={Math.log2(zoom)}
            onChange={(e) => setZoom(2 ** Number(e.target.value))}
          />
          <button
            className="icon-button"
            title="时间轴放大 · Ctrl+滚轮"
            aria-label="时间轴放大"
            onClick={() => setZoom((z) => Math.min(64, z * 1.5))}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            title="时间轴适应全部"
            onClick={() => {
              setZoom(1);
              scroll.current!.scrollLeft = 0;
            }}
          >
            适应
          </button>
          {sequenceMode && (
            <button
              title="添加视频轨道"
              onClick={() =>
                transact([
                  {
                    type: 'addTrack',
                    sequenceId: sequence.id,
                    track: {
                      id: crypto.randomUUID(),
                      name: '视频轨道',
                      type: 'video',
                      muted: false,
                      clips: [],
                    },
                  },
                ])
              }
            >
              <Icon name="plus" size={14} />
              轨道
            </button>
          )}
        </div>
      </div>
      <div
        className="tl-scroll"
        ref={scroll}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-vmotion-asset')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(e) => {
          const assetId = e.dataTransfer.getData('application/x-vmotion-asset');
          if (!assetId) return;
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect(),
            at = Math.max(
              0,
              Math.min(
                duration - 1,
                Math.round(
                  (e.clientX - bounds.left + e.currentTarget.scrollLeft - labelWidth) / pxPerFrame,
                ),
              ),
            ),
            trackId = (e.target as HTMLElement).closest<HTMLElement>('[data-track-id]')?.dataset
              .trackId;
          void onAssetDrop(assetId, at, sequenceMode ? trackId : undefined);
        }}
        onPointerMove={move}
        onPointerUp={() => void finish()}
        onPointerCancel={() => {
          dragRef.current = undefined;
          setDragging(undefined);
        }}
      >
        <div className="tl-body" style={{ width: labelWidth + contentWidth + 20 }}>
          <div className="tl-row tl-ruler-row">
            <div className="tl-label ruler-label">
              {sequenceMode ? '视频与音频轨道' : '图层与动画'}
              <span className="tl-small">{fps.toFixed(fps % 1 ? 2 : 0)} FPS</span>
            </div>
            <div
              className={`tl-ruler ${scrubbing.current ? 'scrubbing' : ''}`}
              style={
                {
                  width: contentWidth,
                  '--tl-minor': `${Math.max(4, (step * fps * pxPerFrame) / 5)}px`,
                  '--tl-major': `${step * fps * pxPerFrame}px`,
                } as React.CSSProperties
              }
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const box = e.currentTarget.getBoundingClientRect();
                e.currentTarget.setPointerCapture(e.pointerId);
                scrubbing.current = true;
                onFrame(
                  Math.max(
                    0,
                    Math.min(duration - 1, Math.round((e.clientX - box.left) / pxPerFrame)),
                  ),
                );
                onPlaying(false);
              }}
              onPointerMove={(e) => {
                const box = e.currentTarget.getBoundingClientRect(),
                  at = Math.max(
                    0,
                    Math.min(duration - 1, Math.round((e.clientX - box.left) / pxPerFrame)),
                  );
                if (!scrubbing.current) {
                  setHoverFrame(at);
                  return;
                }
                e.stopPropagation();
                setHoverFrame(undefined);
                onFrame(at);
              }}
              onPointerLeave={() => setHoverFrame(undefined)}
              onPointerUp={(e) => {
                if (!scrubbing.current) return;
                e.stopPropagation();
                scrubbing.current = false;
              }}
              onLostPointerCapture={() => (scrubbing.current = false)}
            >
              {ticks.map((t) => (
                <span key={t} style={{ left: t * fps * pxPerFrame }}>
                  {t < 60
                    ? `${Number(t.toFixed(1))}s`
                    : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`}
                </span>
              ))}
              {aiMarks &&
                (sequenceMode
                  ? sequence.tracks.flatMap((t) =>
                      t.clips
                        .filter((c) => aiMarks.clips.has(c.id))
                        .map((c) => ({ id: c.id, start: c.start, end: c.start + c.duration })),
                    )
                  : scene.nodes
                      .filter((n) => aiMarks.nodes.has(n.id))
                      .map((n) => ({ id: n.id, start: n.start, end: n.end ?? scene.duration }))
                ).map((r) => (
                  <i
                    key={r.id}
                    className="tl-ai-strip"
                    style={{ left: r.start * pxPerFrame, width: Math.max(4, (r.end - r.start) * pxPerFrame) }}
                  />
                ))}
              {sequenceMode && sequence.workArea && (
                <div
                  className="tl-work-area"
                  style={{
                    left: sequence.workArea.start * pxPerFrame,
                    width: (sequence.workArea.end - sequence.workArea.start) * pxPerFrame,
                  }}
                  title="入出点导出范围"
                />
              )}
              {sequenceMode &&
                sequence.markers
                  .filter(
                    (m) =>
                      m.frame * pxPerFrame >= scrollLeft - labelWidth - 20 &&
                      m.frame * pxPerFrame <= scrollLeft + width + 20,
                  )
                  .map((m) => (
                    <button
                      className={`tl-marker ${m.kind === 'beat' ? 'beat' : ''}`}
                      title={m.label}
                      key={m.id}
                      style={{ left: m.frame * pxPerFrame }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onFrame(m.frame);
                      }}
                    >
                      ◆
                    </button>
                  ))}
            </div>
          </div>
          {sequenceMode
            ? sequence.tracks.map((track) => (
                <div className="tl-row" key={track.id} data-track-id={track.id}>
                  <div className="tl-label">
                    <Icon name={track.type === 'audio' ? 'music' : 'film'} size={14} />
                    <span>{track.name}</span>
                    <button
                      aria-label={`${track.locked ? '解锁' : '锁定'}轨道 ${track.name}`}
                      title={track.locked ? '解锁轨道' : '锁定轨道'}
                      onClick={() =>
                        void onSequenceEdit([
                          { type: 'trackLock', trackId: track.id, locked: !track.locked },
                        ])
                      }
                    >
                      <Icon name={track.locked ? 'lock' : 'unlock'} size={11} />
                    </button>
                    <button
                      className={track.muted ? 'muted' : ''}
                      title={`${track.muted ? '开启' : '静音'}${track.name}`}
                      onClick={() =>
                        transact([
                          {
                            type: 'updateSequence',
                            sequenceId: sequence.id,
                            patch: {
                              tracks: sequence.tracks.map((t) =>
                                t.id === track.id ? { ...t, muted: !t.muted } : t,
                              ),
                            },
                          },
                        ])
                      }
                    >
                      {track.muted ? 'M' : '●'}
                    </button>
                  </div>
                  <div className={`tl-lane ${track.type}`} style={{ width: contentWidth }}>
                    {track.clips.map((clip) => {
                      const value = draft(clip.id, clip.start, clip.duration);
                      return (
                        <div
                          className={`tl-clip ${clipSelection.includes(clip.id) ? 'selected' : ''} ${track.locked ? 'locked' : ''} ${aiMarks?.clips.get(clip.id)?.created ? 'ai-created' : aiMarks?.clips.has(clip.id) ? 'ai-changed' : ''}`}
                          key={clip.id}
                          style={{
                            left: value.start * pxPerFrame,
                            width: Math.max(4, value.duration * pxPerFrame),
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`片段 ${clipName(clip)}`}
                          onClick={() => {
                            if (track.locked) onClip(clip.id);
                            if (clip.sceneId) onScene(clip.sceneId);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.stopPropagation();
                              onClip(clip.id, e.ctrlKey || e.metaKey);
                            }
                          }}
                          onPointerDown={(e) =>
                            begin(
                              e,
                              'move',
                              clip.id,
                              clip.start,
                              clip.duration,
                              clip.sourceIn,
                              clip.speed,
                              track.id,
                            )
                          }
                        >
                          <span
                            className="tl-trim left"
                            title="调整入点"
                            onPointerDown={(e) =>
                              begin(
                                e,
                                'left',
                                clip.id,
                                clip.start,
                                clip.duration,
                                clip.sourceIn,
                                clip.speed,
                                track.id,
                              )
                            }
                          />
                          <Icon name={track.type === 'audio' ? 'music' : 'layers'} size={12} />
                          <span>{clipName(clip)}</span>
                          {clip.assetId && waveforms[clip.assetId]?.length > 0 && (
                            <svg
                              className="tl-waveform"
                              viewBox="0 0 500 24"
                              preserveAspectRatio="none"
                            >
                              <path
                                d={waveforms[clip.assetId]
                                  .map(
                                    (v, i) =>
                                      `M ${(i * 500) / waveforms[clip.assetId!].length} ${12 - Math.min(1, v) * 12} V ${12 + Math.min(1, v) * 12}`,
                                  )
                                  .join(' ')}
                                stroke="currentColor"
                              />
                            </svg>
                          )}
                          <span
                            className="tl-trim right"
                            title="调整出点"
                            onPointerDown={(e) =>
                              begin(
                                e,
                                'right',
                                clip.id,
                                clip.start,
                                clip.duration,
                                clip.sourceIn,
                                clip.speed,
                                track.id,
                              )
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            : scene.nodes
                .filter((n) => !n.parentId)
                .reverse()
                .map((node, index) => {
                  const value = draft(
                    node.id,
                    node.start,
                    (node.end ?? scene.duration) - node.start,
                  );
                  return (
                    <React.Fragment key={node.id}>
                      <div className={`tl-row ${selection.includes(node.id) ? 'selected' : ''}`}>
                        <div className="tl-label">
                          <span className="tl-index">{String(index + 1).padStart(2, '0')}</span>
                          <Icon
                            name={
                              node.type === 'component'
                                ? 'code'
                                : node.type === 'text'
                                  ? 'text'
                                  : 'layers'
                            }
                            size={13}
                          />
                          <button
                            className="tl-layer-name"
                            onClick={(e) => onSelect(node.id, e.ctrlKey || e.metaKey)}
                          >
                            {node.name}
                          </button>
                          <button
                            title="图层显示"
                            onClick={() =>
                              transact([
                                {
                                  type: 'updateNode',
                                  sceneId: scene.id,
                                  nodeId: node.id,
                                  patch: { visible: !node.visible },
                                },
                              ])
                            }
                          >
                            <Icon name="eye" size={12} />
                          </button>
                        </div>
                        <div className="tl-lane" style={{ width: contentWidth }}>
                          <div
                            className={`tl-clip layer ${selection.includes(node.id) ? 'selected' : ''} ${aiMarks?.nodes.get(node.id)?.created ? 'ai-created' : aiMarks?.nodes.has(node.id) ? 'ai-changed' : ''}`}
                            style={{
                              left: value.start * pxPerFrame,
                              width: Math.max(4, value.duration * pxPerFrame),
                              opacity: node.visible ? 1 : 0.35,
                            }}
                            role="button"
                            tabIndex={0}
                            aria-label={`图层 ${node.name}`}
                            onPointerDown={(e) =>
                              begin(
                                e,
                                'move',
                                node.id,
                                node.start,
                                (node.end ?? scene.duration) - node.start,
                                0,
                                1,
                                undefined,
                                node,
                              )
                            }
                          >
                            <span
                              className="tl-trim left"
                              onPointerDown={(e) =>
                                begin(
                                  e,
                                  'left',
                                  node.id,
                                  node.start,
                                  (node.end ?? scene.duration) - node.start,
                                  0,
                                  1,
                                  undefined,
                                  node,
                                )
                              }
                            />
                            <span>{node.name}</span>
                            <span
                              className="tl-trim right"
                              onPointerDown={(e) =>
                                begin(
                                  e,
                                  'right',
                                  node.id,
                                  node.start,
                                  (node.end ?? scene.duration) - node.start,
                                  0,
                                  1,
                                  undefined,
                                  node,
                                )
                              }
                            />
                          </div>
                        </div>
                      </div>
                      {selected === node.id &&
                        node.animations.map((a) => keyRow(node.id, a.property, a.keys))}
                    </React.Fragment>
                  );
                })}
          {hoverFrame !== undefined && hoverFrame !== frame && (
            <div className="tl-hover-line" style={{ left: labelWidth + hoverFrame * pxPerFrame }}>
              <span>{hoverFrame}</span>
            </div>
          )}
          {snapGuide !== undefined && (
            <div className="tl-snap-guide" style={{ left: labelWidth + snapGuide * pxPerFrame }} />
          )}
          <div
            className={`tl-playhead ${playing ? 'playing' : ''}`}
            style={{ left: labelWidth + frame * pxPerFrame }}
          >
            <span />
            <i />
          </div>
        </div>
      </div>
      <div className="timeline-footer">
        {!sequenceMode && (selectedKeys.length > 0 || clipboardCount > 0) && (
          <div className="timeline-key-actions">
            <button disabled={!selectedKeys.length} onClick={copyKeys}>
              复制关键帧
            </button>
            <button disabled={!clipboardCount} onClick={pasteKeys}>
              粘贴关键帧
            </button>
          </div>
        )}
        <span>
          {sequenceMode
            ? '拖动片段调整位置，拖动两端裁切'
            : selectedKeys.length
              ? `${selectedKeys.length} 个关键帧 · Ctrl 多选 · 拖动移动 · Ctrl+C/V 复制粘贴 · Delete 删除`
              : '拖动图层调整时间，选中图层查看关键帧'}
        </span>
        <span>
          {duration} 帧 · {seconds.toFixed(2)} 秒
        </span>
      </div>
    </section>
  );
}
