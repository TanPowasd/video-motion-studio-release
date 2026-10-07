import { McpConnectionButton } from './McpConnection.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../core/model.js';
import type {
  DrawingDocument,
  DrawingLayer,
  DrawingOperation,
  DrawingStroke,
} from '../core/drawing-model.js';
import { CanvasViewport } from './CanvasViewport.js';
import { Icon } from './Icons.js';
type Gesture = {
  pointerId: number;
  capture: HTMLDivElement;
  revision: string;
  start: { x: number; y: number };
  layers: DrawingLayer[];
  stroke?: DrawingStroke;
  operations: DrawingOperation[];
};
export function DrawingWorkspace({
  snapshot,
  initialId,
  run,
  onDocument,
  onExit,
  onPublish,
  canUndo,
  canRedo,
  error,
}: {
  snapshot: Snapshot;
  initialId?: string;
  run: (method: string, params?: unknown) => Promise<any>;
  onDocument: (id: string) => void;
  onExit: () => void;
  onPublish: () => void;
  canUndo: boolean;
  canRedo: boolean;
  error?: string;
}) {
  const [id, setId] = useState(initialId ?? snapshot.project.drawings[0]?.id ?? ''),
    [selected, setSelected] = useState<string[]>([]),
    [tool, setTool] = useState<'brush' | 'eraser' | 'move'>('brush'),
    [color, setColor] = useState('#c1b6ff'),
    [size, setSize] = useState(12),
    [opacity, setOpacity] = useState(1),
    [draft, setDraft] = useState<{ operations: DrawingOperation[] }>(),
    [cursor, setCursor] = useState<{ x: number; y: number }>(),
    [preview, setPreview] = useState(''),
    [message, setMessage] = useState(''),
    [previewError, setPreviewError] = useState(''),
    [busy, setBusy] = useState(false),
    [width, setWidth] = useState(snapshot.project.width),
    [height, setHeight] = useState(snapshot.project.height),
    stage = useRef<HTMLDivElement>(null),
    gesture = useRef<Gesture | undefined>(undefined);
  const document = useMemo(() => {
    const entry = snapshot.project.drawings.find((d) => d.id === id);
    if (!entry) return;
    try {
      return JSON.parse(snapshot.files[entry.path]) as DrawingDocument;
    } catch {
      return;
    }
  }, [id, snapshot.revision]);
  const layer = document?.layers.find((l) => l.id === selected.at(-1)),
    flight = useRef(false),
    mounted = useRef(true),
    imageUrl = useRef(''),
    abort = useRef<AbortController | undefined>(undefined),
    target = useRef<any>(undefined),
    ticket = useRef(0);
  useEffect(() => {
    onDocument(id);
    setSelected([]);
    setPreview('');
  }, [id]);
  useEffect(() => {
    if (document) {
      setWidth(document.width);
      setHeight(document.height);
      if (!document.layers.some((l) => selected.includes(l.id)))
        setSelected(document.layers.at(-1) ? [document.layers.at(-1)!.id] : []);
    }
  }, [document?.id, snapshot.revision]);
  useEffect(
    () => () => {
      mounted.current = false;
      abort.current?.abort();
      URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (!document) return;
    const scale = Math.min(1, 1280 / document.width, 1280 / document.height);
    target.current = {
      ticket: ++ticket.current,
      params: {
        id,
        width: Math.max(16, Math.round(document.width * scale)),
        height: Math.max(16, Math.round(document.height * scale)),
        draft,
      },
    };
    const pump = async () => {
      if (flight.current || !mounted.current) return;
      flight.current = true;
      const current = target.current,
        controller = new AbortController();
      abort.current = controller;
      try {
        const response = await fetch('/api/drawing-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(current.params),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message ?? '画稿预览失败');
        }
        const blob = await response.blob();
        if (mounted.current && target.current.ticket === current.ticket) {
          const url = URL.createObjectURL(blob);
          URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = url;
          setPreview(url);
          setPreviewError('');
        }
      } catch (e) {
        if (
          (e as Error).name !== 'AbortError' &&
          mounted.current &&
          target.current.ticket === current.ticket
        )
          setPreviewError((e as Error).message);
      } finally {
        flight.current = false;
        if (mounted.current && target.current.ticket !== current.ticket) void pump();
      }
    };
    void pump();
  }, [id, snapshot.revision, draft]);
  const edit = async (operations: DrawingOperation[], revision = snapshot.revision) => {
    setBusy(true);
    const result = await run('drawingEdit', { id, operations, revision });
    setBusy(false);
    return result;
  };
  const create = async () => {
    const result = await run('drawingCreate', {
      name: `画稿 ${snapshot.project.drawings.length + 1}`,
      width,
      height,
      revision: snapshot.revision,
    });
    if (result?.document) setId(result.document.id);
  };
  const publish = async (partial = false) => {
    setBusy(true);
    const result = await run('drawingPublish', {
      id,
      layerIds: partial ? selected : undefined,
      revision: snapshot.revision,
    });
    setBusy(false);
    if (result?.asset) {
      setMessage(`已发布「${result.asset.name}」到素材库`);
      onPublish();
    }
  };
  const point = (event: {
    clientX: number;
    clientY: number;
    pressure?: number;
    pointerType?: string;
  }) => {
    const box = stage.current!.getBoundingClientRect();
    return {
      x: Math.round((((event.clientX - box.left) * document!.width) / box.width) * 1000) / 1000,
      y: Math.round((((event.clientY - box.top) * document!.height) / box.height) * 1000) / 1000,
      pressure: event.pointerType === 'pen' ? (event.pressure ?? 1) : 1,
    };
  };
  const cancel = () => {
    const g = gesture.current;
    gesture.current = undefined;
    if (g?.capture.hasPointerCapture(g.pointerId)) g.capture.releasePointerCapture(g.pointerId);
    setDraft(undefined);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'Escape') {
        cancelRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        cancelRef.current();
        void run(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key.toLowerCase() === 'b') setTool('brush');
        if (e.key.toLowerCase() === 'e') setTool('eraser');
        if (e.key.toLowerCase() === 'v') setTool('move');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [run]);
  const move = (e: React.PointerEvent) => {
    if (!document) return;
    const g = gesture.current,
      p = point(e);
    setCursor(p);
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.stroke) {
      const coalesced = e.nativeEvent.getCoalescedEvents?.(),
        samples = coalesced?.length ? coalesced : [e.nativeEvent];
      for (const sample of samples) {
        const world = point(sample),
          at = { ...world, x: world.x - g.layers[0].x, y: world.y - g.layers[0].y },
          last = g.stroke.points.at(-1)!;
        if (Math.hypot(at.x - last.x, at.y - last.y) >= 0.25) g.stroke.points.push(at);
      }
      g.operations = [
        {
          type: 'stroke',
          layerId: g.layers[0].id,
          stroke: { ...g.stroke, points: [...g.stroke.points] },
        },
      ];
    } else {
      let dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      g.operations = g.layers.map((l) => ({
        type: 'updateLayer',
        layerId: l.id,
        patch: { x: l.x + dx, y: l.y + dy },
      }));
    }
    setDraft({ operations: g.operations });
  };
  const addLayer = async () => {
    const id = crypto.randomUUID(),
      result = await edit([
        {
          type: 'addLayer',
          layer: {
            id,
            name: `图层 ${document!.layers.length + 1}`,
            visible: true,
            locked: false,
            x: 0,
            y: 0,
            opacity: 1,
            blend: 'source-over',
            strokes: [],
          },
        },
      ]);
    if (result) setSelected([id]);
  };
  return (
    <div className="drawing-workspace">
      <header className="drawing-topbar">
        <McpConnectionButton />
        <button onClick={onExit}>
          <Icon name="arrow" /> 返回创作工作站
        </button>
        <strong>绘画文档</strong>
        <select aria-label="选择画稿" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">选择画稿</option>
          {snapshot.project.drawings.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button onClick={create}>
          <Icon name="plus" />
          新建画稿
        </button>
        <div className="top-spacer" />
        <button
          aria-label="撤销绘画"
          disabled={!canUndo || busy}
          onClick={() => {
            cancel();
            void run('undo');
          }}
        >
          <Icon name="undo" />
        </button>
        <button
          aria-label="重做绘画"
          disabled={!canRedo || busy}
          onClick={() => {
            cancel();
            void run('redo');
          }}
        >
          <Icon name="redo" />
        </button>
        <button disabled={!document?.layers.length || busy} onClick={() => publish()}>
          发布整张画稿
        </button>
        <button
          className="primary"
          disabled={!selected.length || busy}
          onClick={() => publish(true)}
        >
          发布选定图层
        </button>
      </header>
      <aside className="drawing-layers">
        <div className="section-title">
          绘画图层 <span>{document?.layers.length ?? 0}</span>
          <button aria-label="新建绘画图层" disabled={!document || busy} onClick={addLayer}>
            <Icon name="plus" />
          </button>
        </div>
        {document?.layers
          .slice()
          .reverse()
          .map((l) => (
            <div
              key={l.id}
              className={`drawing-layer ${selected.includes(l.id) ? 'selected' : ''}`}
            >
              <button
                className="drawing-layer-name"
                onClick={(e) =>
                  setSelected(
                    e.ctrlKey || e.metaKey
                      ? selected.includes(l.id)
                        ? selected.filter((id) => id !== l.id)
                        : [...selected, l.id]
                      : [l.id],
                  )
                }
              >
                <span
                  className="drawing-layer-swatch"
                  style={{
                    background: l.strokes.find((s) => s.tool === 'brush')?.color ?? 'transparent',
                  }}
                />
                <span>{l.name}</span>
                <small>{l.strokes.length} 笔迹</small>
              </button>
              <button
                aria-label={`显示 ${l.name}`}
                onClick={() =>
                  edit([{ type: 'updateLayer', layerId: l.id, patch: { visible: !l.visible } }])
                }
              >
                <Icon name={l.visible ? 'eye' : 'minus'} size={14} />
              </button>
              <button
                aria-label={`锁定 ${l.name}`}
                onClick={() =>
                  edit([{ type: 'updateLayer', layerId: l.id, patch: { locked: !l.locked } }])
                }
              >
                <Icon name={l.locked ? 'lock' : 'unlock'} size={14} />
              </button>
            </div>
          ))}
        {document && (
          <div className="drawing-layer-actions">
            <button
              disabled={!layer || busy}
              title="复制绘画图层"
              onClick={async () => {
                const old = new Set(document.layers.map((l) => l.id)),
                  result = await edit(
                    selected.map((layerId) => ({ type: 'duplicateLayer', layerId })),
                  );
                if (result)
                  setSelected(
                    result.document.layers
                      .filter((l: DrawingLayer) => !old.has(l.id))
                      .map((l: DrawingLayer) => l.id),
                  );
              }}
            >
              <Icon name="copy" />
              复制
            </button>
            <button
              disabled={!layer || busy}
              title="删除绘画图层"
              onClick={() => edit(selected.map((layerId) => ({ type: 'removeLayer', layerId })))}
            >
              <Icon name="delete" />
              删除
            </button>
            <button
              disabled={!layer || busy}
              title="上移绘画图层"
              onClick={() => {
                const order = document.layers.map((l) => l.id),
                  at = order.indexOf(layer!.id);
                if (at < order.length - 1) {
                  [order[at], order[at + 1]] = [order[at + 1], order[at]];
                  void edit([{ type: 'orderLayers', ids: order }]);
                }
              }}
            >
              <Icon name="up" />
            </button>
            <button
              disabled={!layer || busy}
              title="下移绘画图层"
              onClick={() => {
                const order = document.layers.map((l) => l.id),
                  at = order.indexOf(layer!.id);
                if (at > 0) {
                  [order[at], order[at - 1]] = [order[at - 1], order[at]];
                  void edit([{ type: 'orderLayers', ids: order }]);
                }
              }}
            >
              <Icon name="down" />
            </button>
          </div>
        )}
        <div className="drawing-help">
          画稿先在独立图层中完成，发布后出现在素材库。Ctrl 单击可选择多个图层。
        </div>
      </aside>
      <main className="drawing-canvas">
        <div className="drawing-tools">
          {(
            [
              ['brush', '画笔 B'],
              ['eraser', '橡皮擦 E'],
              ['move', '移动 V'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tool === id ? 'pressed' : ''} onClick={() => setTool(id)}>
              {label}
            </button>
          ))}
          <span>{layer?.locked ? '当前图层已锁定' : (layer?.name ?? '先选择绘画图层')}</span>
        </div>
        {document ? (
          <CanvasViewport
            width={document.width}
            height={document.height}
            name={document.name}
            onStageRef={(e) => (stage.current = e)}
            tip="B 画笔 · E 橡皮 · V 移动 · Alt 平移"
          >
            <div
              className={`drawing-surface tool-${tool}`}
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.altKey || e.button !== 0 || !e.isPrimary || !layer || layer.locked || busy)
                  return;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.focus();
                const p = point(e),
                  layers =
                    tool === 'move'
                      ? document.layers.filter((l) => selected.includes(l.id) && !l.locked)
                      : [layer];
                const stroke =
                  tool === 'move'
                    ? undefined
                    : ({
                        id: crypto.randomUUID(),
                        tool,
                        color,
                        width: size,
                        opacity,
                        points: [{ x: p.x - layer.x, y: p.y - layer.y, pressure: p.pressure }],
                      } as DrawingStroke);
                gesture.current = {
                  pointerId: e.pointerId,
                  capture: e.currentTarget,
                  revision: snapshot.revision,
                  start: p,
                  layers,
                  stroke,
                  operations: stroke ? [{ type: 'stroke', layerId: layer.id, stroke }] : [],
                };
                e.currentTarget.setPointerCapture(e.pointerId);
                setDraft({ operations: gesture.current.operations });
              }}
              onPointerMove={move}
              onPointerUp={async (e) => {
                const g = gesture.current;
                if (!g || g.pointerId !== e.pointerId) return;
                move(e);
                gesture.current = undefined;
                if (g.capture.hasPointerCapture(e.pointerId))
                  g.capture.releasePointerCapture(e.pointerId);
                try {
                  if (g.operations.length) await edit(g.operations, g.revision);
                } finally {
                  setDraft(undefined);
                }
              }}
              onPointerCancel={cancel}
              onLostPointerCapture={() => {
                if (gesture.current) cancel();
              }}
              onPointerLeave={() => {
                if (!gesture.current) setCursor(undefined);
              }}
            >
              {preview ? (
                <img
                  className="rendered-frame"
                  src={preview}
                  draggable={false}
                  alt="独立画稿预览"
                />
              ) : (
                <div className="preview-placeholder">正在生成画稿预览…</div>
              )}
              {cursor && tool !== 'move' && (
                <svg
                  className="drawing-cursor"
                  viewBox={`0 0 ${document.width} ${document.height}`}
                >
                  <circle
                    cx={cursor.x}
                    cy={cursor.y}
                    r={size / 2}
                    fill="none"
                    stroke="#eff5ff"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
            </div>
          </CanvasViewport>
        ) : (
          <div className="drawing-start">
            <Icon name="brush" size={48} />
            <h2>先创建一张画稿</h2>
            <p>独立绘画、管理图层，再发布到素材库用于动画和剪辑。</p>
            <button className="primary" onClick={create}>
              新建画稿
            </button>
          </div>
        )}
      </main>
      <aside className="drawing-properties">
        <div className="section-title">画笔</div>
        <label>
          颜色
          <input
            aria-label="画笔颜色"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label>
          大小
          <input
            aria-label="画笔大小"
            type="number"
            min={0.5}
            max={1000}
            value={size}
            onChange={(e) => setSize(Math.max(0.5, Math.min(1000, Number(e.target.value))))}
          />
        </label>
        <label>
          不透明度
          <input
            aria-label="画笔不透明度"
            type="range"
            min={1}
            max={100}
            value={opacity * 100}
            onChange={(e) => setOpacity(Number(e.target.value) / 100)}
          />
          {Math.round(opacity * 100)}%
        </label>
        <div className="drawing-help">支持笔压。橡皮擦只擦除当前绘画图层；Esc 取消当前笔迹。</div>
        {layer && (
          <>
            <div className="section-title">图层属性</div>
            <label>
              名称
              <input
                aria-label="绘画图层名称"
                key={layer.id + layer.name}
                defaultValue={layer.name}
                onBlur={(e) => {
                  if (e.target.value && e.target.value !== layer.name)
                    void edit([
                      { type: 'updateLayer', layerId: layer.id, patch: { name: e.target.value } },
                    ]);
                }}
              />
            </label>
            <label>
              图层透明度
              <input
                aria-label="绘画图层透明度"
                key={layer.id + layer.opacity}
                type="number"
                min={0}
                max={100}
                defaultValue={Math.round(layer.opacity * 100)}
                onBlur={(e) => {
                  const value = Number(e.target.value) / 100;
                  if (Number.isFinite(value) && value !== layer.opacity)
                    void edit([
                      { type: 'updateLayer', layerId: layer.id, patch: { opacity: value } },
                    ]);
                }}
              />
            </label>
            <label>
              混合
              <select
                aria-label="绘画图层混合"
                value={layer.blend}
                onChange={(e) =>
                  void edit([
                    {
                      type: 'updateLayer',
                      layerId: layer.id,
                      patch: { blend: e.target.value as DrawingLayer['blend'] },
                    },
                  ])
                }
              >
                {[
                  'source-over',
                  'multiply',
                  'screen',
                  'overlay',
                  'darken',
                  'lighten',
                  'difference',
                ].map((blend) => (
                  <option key={blend} value={blend}>
                    {blend}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="section-title">画布</div>
        {document && (
          <label>
            画稿名称
            <input
              aria-label="画稿名称"
              key={document.id + document.name}
              defaultValue={document.name}
              onBlur={(e) => {
                if (e.target.value && e.target.value !== document.name)
                  void edit([{ type: 'updateDocument', patch: { name: e.target.value } }]);
              }}
            />
          </label>
        )}
        <label>
          宽度
          <input
            aria-label="画稿宽度"
            type="number"
            value={width}
            min={16}
            max={8192}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
        <label>
          高度
          <input
            aria-label="画稿高度"
            type="number"
            value={height}
            min={16}
            max={8192}
            onChange={(e) => setHeight(Number(e.target.value))}
          />
        </label>
        <button
          disabled={!document || busy}
          onClick={() => edit([{ type: 'updateDocument', patch: { width, height } }])}
        >
          应用画布尺寸
        </button>
      </aside>
      <footer className="drawing-status">
        <span>
          {error || previewError || message || '草稿与素材分开保存 · 发布后可拖入画布或时间轴'}
        </span>
        <span>
          {busy
            ? '正在保存…'
            : document
              ? `${document.width} × ${document.height} · ${document.layers.length} 图层`
              : '未创建画稿'}
        </span>
      </footer>
    </div>
  );
}
