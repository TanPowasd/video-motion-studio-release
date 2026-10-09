import React, { useEffect, useRef, useState } from 'react';
import { layerBox, snapDelta, snapTargets, unionBox, type SnapTargets } from '../core/still.js';
import {
  isDescendant,
  canvasTarget,
  marqueeLayers,
  movingLayers,
  movePatch,
  parentDelta,
  pointerSelection,
  toggleSelection,
  selectionHit,
  resizePatch,
  multiply,
  transform,
  handleCorners,
  HANDLE_HIT_PX,
  type HandleIndex,
  type Matrix,
  type ResizeResult,
  type CompositionDraft,
  type InteractionGraph,
  type InteractionLayer,
  type Point,
  type Bounds,
} from '../core/interaction.js';

type Gesture = {
  kind: 'move' | 'marquee' | 'resize';
  /** Resize only: which corner handle is dragged. */
  handle?: HandleIndex;
  /** Resize only: handle corner minus pointer at pointerdown, so the corner does not jump. */
  grab?: Point;
  resize?: ResizeResult;
  pointerId: number;
  start: Point;
  client: Point;
  delta: Point;
  moved: boolean;
  capture: HTMLDivElement;
  revision: string;
  before: string[];
  ids: string[];
  layers: InteractionLayer[];
  toggle?: string;
  additive: boolean;
  snap?: { box: Bounds; targets: SnapTargets };
};
export function CanvasInteraction({
  graph,
  selection,
  frame,
  width,
  height,
  stage,
  onSelect,
  onDraft,
  onCommit,
  onEnter,
  snapBoxes,
}: {
  graph: InteractionGraph;
  selection: string[];
  frame: number;
  width: number;
  height: number;
  stage: React.RefObject<HTMLDivElement | null>;
  onSelect: (ids: string[]) => void;
  onDraft: (draft: CompositionDraft[] | undefined) => void;
  onCommit: (draft: CompositionDraft[], revision: string) => Promise<unknown>;
  onEnter: (id: string) => void;
  /** When set, moves snap to these boxes' edges/centres and to the other layers (image mode). */
  snapBoxes?: Bounds[];
}) {
  const gesture = useRef<Gesture | undefined>(undefined),
    [delta, setDelta] = useState<Point>(),
    [box, setBox] = useState<{ a: Point; b: Point }>(),
    [resizing, setResizing] = useState<{ id: string; result: ResizeResult }>(),
    [guides, setGuides] = useState<{ x?: number; y?: number }>(),
    [committing, setCommitting] = useState(false);
  const point = (e: React.PointerEvent): Point => {
    const bounds = stage.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - bounds.left) * width) / bounds.width,
      y: ((e.clientY - bounds.top) * height) / bounds.height,
    };
  };
  const cancel = () => {
    const g = gesture.current;
    gesture.current = undefined;
    if (g?.capture.hasPointerCapture(g.pointerId)) g.capture.releasePointerCapture(g.pointerId);
    if (g) onSelect(g.before);
    setDelta(undefined);
    setBox(undefined);
    setResizing(undefined);
    setGuides(undefined);
    onDraft(undefined);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.preventDefault();
        cancelRef.current();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(
    () => () => {
      gesture.current = undefined;
      onDraft(undefined);
    },
    [],
  );
  const draft = (g: Gesture): CompositionDraft[] =>
    g.kind === 'resize'
      ? g.resize
        ? [
            {
              path: g.layers[0].path,
              nodeId: g.layers[0].node.id,
              frame: g.layers[0].frame ?? frame,
              contextFrames: g.layers[0].contextFrames,
              patch: g.resize.patch,
            },
          ]
        : []
      : g.layers.flatMap((layer) => {
          const local = parentDelta(layer, g.delta);
          return local
            ? [
                {
                  path: layer.path,
                  nodeId: layer.node.id,
                  frame: layer.frame ?? frame,
                  contextFrames: layer.contextFrames,
                  patch: movePatch(layer.node, layer.frame ?? frame, local),
                },
              ]
            : [];
        });
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const p = point(e);
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 3) return;
    g.moved = true;
    if (g.kind === 'marquee') {
      setBox({ a: g.start, b: p });
      const found = marqueeLayers(graph.layers, g.start, p);
      g.ids = g.additive ? [...new Set([...g.before, ...found])] : found;
      onSelect(g.ids);
      return;
    }
    if (g.kind === 'resize') {
      const layer = g.layers[0];
      const target = { x: p.x + g.grab!.x, y: p.y + g.grab!.y };
      g.resize =
        resizePatch(layer, layer.frame ?? frame, g.handle!, target, e.shiftKey) ?? g.resize;
      if (g.resize) {
        setResizing({ id: layer.node.id, result: g.resize });
        onDraft(draft(g));
      }
      return;
    }
    g.delta = { x: p.x - g.start.x, y: p.y - g.start.y };
    if (e.shiftKey) {
      if (Math.abs(g.delta.x) >= Math.abs(g.delta.y)) g.delta.y = 0;
      else g.delta.x = 0;
    }
    if (g.snap && !e.ctrlKey && !e.metaKey) {
      const bounds = stage.current!.getBoundingClientRect(),
        snapped = snapDelta(g.snap.box, g.delta, g.snap.targets, (6 * width) / bounds.width);
      g.delta = e.shiftKey
        ? { x: g.delta.x ? snapped.delta.x : 0, y: g.delta.y ? snapped.delta.y : 0 }
        : snapped.delta;
      setGuides(snapped.guides);
    }
    setDelta(g.delta);
    onDraft(draft(g));
  };
  const active = graph.layers.filter((layer) => selection.includes(layer.node.id));
  // The handle element itself (its hit square can poke outside the canvas element).
  const handleTarget = (target: EventTarget) => {
    const el = target instanceof Element ? target.closest('[data-handle]') : null,
      layer = el && active.find((l) => l.node.id === el.getAttribute('data-node-id'));
    return layer
      ? {
          kind: 'handle' as const,
          layer,
          handle: Number(el.getAttribute('data-handle')) as HandleIndex,
        }
      : undefined;
  };
  return (
    <div
      className={`canvas-picking ${active.length ? 'has-selection' : ''} ${delta ? 'dragging' : ''}`}
      aria-label="画布交互区域"
      data-selected-nodes={JSON.stringify(selection)}
      data-selected-node={selection.at(-1) ?? ''}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.altKey || committing || !e.isPrimary) return;
        e.preventDefault();
        e.stopPropagation();
        const bounds = stage.current!.getBoundingClientRect(),
          p = point(e),
          control = e.ctrlKey || e.metaKey,
          // Selection chrome first: a handle or the border of a selected layer must never
          // fall through to a layer above or below it. Handles win even with Ctrl held;
          // a Ctrl-click on the border keeps its multi-select meaning.
          found =
            handleTarget(e.target) ??
            selectionHit(graph.layers, selection, p, (HANDLE_HIT_PX * width) / bounds.width),
          chrome = found?.kind === 'handle' || !control ? found : undefined;
        if (chrome?.kind === 'handle') {
          const corner = transform(chrome.layer.matrix, handleCorners(chrome.layer)[chrome.handle]);
          gesture.current = {
            kind: 'resize',
            handle: chrome.handle,
            grab: { x: corner.x - p.x, y: corner.y - p.y },
            pointerId: e.pointerId,
            start: p,
            client: { x: e.clientX, y: e.clientY },
            delta: { x: 0, y: 0 },
            moved: false,
            capture: e.currentTarget,
            revision: graph.revision,
            before: selection,
            ids: selection,
            layers: [chrome.layer],
            additive: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
        const hit =
            chrome?.layer ??
            canvasTarget(graph.layers, selection, p, control, (3 * width) / bounds.width),
          ids = hit ? pointerSelection(selection, hit.node.id, control) : control ? selection : [];
        onSelect(ids);
        gesture.current = {
          kind: hit ? 'move' : 'marquee',
          pointerId: e.pointerId,
          start: p,
          client: { x: e.clientX, y: e.clientY },
          delta: { x: 0, y: 0 },
          moved: false,
          capture: e.currentTarget,
          revision: graph.revision,
          before: selection,
          ids,
          layers: movingLayers(graph.layers, ids),
          toggle: hit && control && selection.includes(hit.node.id) ? hit.node.id : undefined,
          additive: control,
        };
        if (hit && snapBoxes) {
          const moving = gesture.current.layers,
            box = unionBox(moving.map(layerBox));
          if (box)
            gesture.current.snap = {
              box,
              targets: snapTargets([
                ...snapBoxes,
                ...graph.layers
                  .filter(
                    (l) =>
                      !l.container &&
                      !moving.some((m) => m === l || isDescendant(graph.layers, l, m)),
                  )
                  .map(layerBox),
              ]),
            };
        }
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (gesture.current) {
          e.stopPropagation();
          move(e);
        }
      }}
      onPointerUp={async (e) => {
        const g = gesture.current;
        if (!g || g.pointerId !== e.pointerId) return;
        e.stopPropagation();
        move(e);
        gesture.current = undefined;
        setGuides(undefined);
        if (g.capture.hasPointerCapture(e.pointerId)) g.capture.releasePointerCapture(e.pointerId);
        if (!g.moved || Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 3) {
          if (g.toggle) onSelect(toggleSelection(g.before, g.toggle));
          else if (g.kind === 'marquee') onSelect(g.additive ? g.before : []);
          setDelta(undefined);
          setBox(undefined);
          setResizing(undefined);
          onDraft(undefined);
          return;
        }
        if (g.kind === 'marquee') {
          setBox(undefined);
          return;
        }
        const edits = draft(g);
        if (
          !edits.length ||
          (g.kind === 'move' && Math.hypot(g.delta.x, g.delta.y) < 1e-6) ||
          (g.kind === 'resize' &&
            (!g.resize ||
              (Math.abs(g.resize.scale.x - 1) < 1e-6 && Math.abs(g.resize.scale.y - 1) < 1e-6)))
        ) {
          setDelta(undefined);
          setResizing(undefined);
          onDraft(undefined);
          return;
        }
        setCommitting(true);
        try {
          await onCommit(edits, g.revision);
        } finally {
          setCommitting(false);
          setDelta(undefined);
          setResizing(undefined);
          onDraft(undefined);
        }
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (gesture.current) cancel();
      }}
      onDoubleClick={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || selection.length !== 1) return;
        const layer = graph.layers.find((l) => l.node.id === selection[0]);
        if (layer?.container) onEnter(layer.node.id);
      }}
    >
      {active.map((layer) => {
        // While resizing, preview the box as matrix · S(anchor); while moving, offset it.
        const r = resizing?.id === layer.node.id ? resizing.result : undefined,
          m: Matrix = r
            ? multiply(layer.matrix, [
                r.scale.x,
                0,
                0,
                r.scale.y,
                r.anchor.x * (1 - r.scale.x),
                r.anchor.y * (1 - r.scale.y),
              ])
            : layer.matrix,
          b = layer.bounds,
          dx = r ? 0 : (delta?.x ?? 0),
          dy = r ? 0 : (delta?.y ?? 0),
          corners = [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x, b.y + b.height],
            [b.x + b.width, b.y + b.height],
          ].map(([x, y]) => ({
            x: m[0] * x + m[2] * y + m[4] + dx,
            y: m[1] * x + m[3] * y + m[5] + dy,
          })),
          // Cursor follows the on-screen diagonal of each corner.
          diag = (i: number) => {
            const c = corners[i],
              o = corners[3 - i];
            return (c.x - o.x) * (c.y - o.y) >= 0 ? 'nwse-resize' : 'nesw-resize';
          };
        return (
          <React.Fragment key={layer.node.id}>
            <div
              className="node-hit selected"
              data-node-id={layer.node.id}
              style={{
                left: `${((m[0] * b.x + m[2] * b.y + m[4] + dx) / width) * 100}%`,
                top: `${((m[1] * b.x + m[3] * b.y + m[5] + dy) / height) * 100}%`,
                width: `${(b.width / width) * 100}%`,
                height: `${(b.height / height) * 100}%`,
                transformOrigin: '0 0',
                transform: `matrix(${m[0]},${m[1]},${m[2]},${m[3]},0,0)`,
              }}
            >
              <span className="selection-label">{layer.node.name}</span>
            </div>
            {/* Handles live outside the transformed box: constant screen size, and their hit
                area receives pointerdown even where it pokes outside the canvas. */}
            {corners.map((c, i) => (
              <i
                key={i}
                className={`handle selection-handle h${i}`}
                data-node-id={layer.node.id}
                data-handle={i}
                style={{
                  left: `${(c.x / width) * 100}%`,
                  top: `${(c.y / height) * 100}%`,
                  cursor: diag(i),
                }}
              />
            ))}
          </React.Fragment>
        );
      })}
      {guides?.x !== undefined && (
        <div className="snap-guide v" style={{ left: `${(guides.x / width) * 100}%` }} />
      )}
      {guides?.y !== undefined && (
        <div className="snap-guide h" style={{ top: `${(guides.y / height) * 100}%` }} />
      )}
      {box && (
        <div
          className="canvas-marquee"
          style={{
            left: `${(Math.min(box.a.x, box.b.x) / width) * 100}%`,
            top: `${(Math.min(box.a.y, box.b.y) / height) * 100}%`,
            width: `${(Math.abs(box.a.x - box.b.x) / width) * 100}%`,
            height: `${(Math.abs(box.a.y - box.b.y) / height) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
