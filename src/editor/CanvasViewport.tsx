import React, { useState, useRef, useEffect } from 'react';
import { Icon } from './Icons.js';
export function CanvasViewport({
  width,
  height,
  name,
  children,
  onStageRef,
  onBackground,
  tip = '直接拖动 · Ctrl 多选 · 空白拖框 · Alt 平移',
}: {
  width: number;
  height: number;
  name: string;
  children: React.ReactNode;
  onStageRef: (element: HTMLDivElement | null) => void;
  onBackground?: () => void;
  tip?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    [bounds, setBounds] = useState({ width: 800, height: 450 }),
    [zoom, setZoom] = useState<number | 'fit'>('fit'),
    [checker, setChecker] = useState(false),
    [safe, setSafe] = useState(false),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    panStart = useRef<{ x: number; y: number; origin: { x: number; y: number } } | undefined>(
      undefined,
    );
  useEffect(() => {
    const element = viewport.current!;
    const resize = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setBounds({ width: rect.width, height: rect.height });
    });
    const preventBrowserZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    element.addEventListener('wheel', preventBrowserZoom, { passive: false });
    resize.observe(element);
    return () => {
      resize.disconnect();
      element.removeEventListener('wheel', preventBrowserZoom);
    };
  }, []);
  const fit = Math.max(0.02, Math.min((bounds.width - 72) / width, (bounds.height - 60) / height)),
    scale = zoom === 'fit' ? fit : zoom / 100;
  const changeZoom = (number: number) => {
    setZoom(Math.max(10, Math.min(400, number)));
    setPan({ x: 0, y: 0 });
  };
  return (
    <div className="viewport-panel">
      <div className="viewer-tab">
        <span>
          <Icon name="layers" size={14} />
          {name}
        </span>
        <span className="viewer-dimensions">
          {width} × {height}
        </span>
      </div>
      <div
        ref={viewport}
        className={`viewer-space ${checker ? 'checker' : ''}`}
        onPointerDown={(e) => {
          if (e.button === 1 || e.altKey) {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            panStart.current = { x: e.clientX, y: e.clientY, origin: pan };
          } else if (e.target === e.currentTarget) onBackground?.();
        }}
        onPointerMove={(e) => {
          if (panStart.current)
            setPan({
              x: panStart.current.origin.x + e.clientX - panStart.current.x,
              y: panStart.current.origin.y + e.clientY - panStart.current.y,
            });
        }}
        onPointerUp={() => (panStart.current = undefined)}
        onPointerCancel={() => (panStart.current = undefined)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) changeZoom(scale * 100 * (e.deltaY > 0 ? 0.9 : 1.1));
        }}
      >
        <div
          className="canvas-fit-box"
          style={{
            width: width * scale,
            height: height * scale,
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
          ref={onStageRef}
        >
          {children}
          {safe && (
            <div className="safe-guides">
              <i />
              <b />
            </div>
          )}
        </div>
      </div>
      <div className="viewer-controls">
        <div className="viewer-control-group">
          <button title="缩小画布" onClick={() => changeZoom((scale * 100) / 1.2)}>
            <Icon name="minus" size={14} />
          </button>
          <select
            aria-label="画布缩放"
            value={zoom}
            onChange={(e) => {
              setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value));
              setPan({ x: 0, y: 0 });
            }}
          >
            <option value="fit">适应画布 · {Math.round(fit * 100)}%</option>
            {[25, 50, 75, 100, 150, 200, 300, 400].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
            {typeof zoom === 'number' && ![25, 50, 75, 100, 150, 200, 300, 400].includes(zoom) && (
              <option value={zoom}>{Math.round(zoom)}%</option>
            )}
          </select>
          <button title="放大画布" onClick={() => changeZoom(scale * 100 * 1.2)}>
            <Icon name="plus" size={14} />
          </button>
          <button
            title="适应画布"
            onClick={() => {
              setZoom('fit');
              setPan({ x: 0, y: 0 });
            }}
          >
            <Icon name="fit" size={14} />
          </button>
        </div>
        <div className="viewer-control-group">
          <button
            className={checker ? 'pressed' : ''}
            title="透明网格"
            onClick={() => setChecker(!checker)}
          >
            <Icon name="grid" size={14} />
          </button>
          <button className={safe ? 'pressed' : ''} title="安全框" onClick={() => setSafe(!safe)}>
            <Icon name="rect" size={14} />
          </button>
          <span>SDR · sRGB</span>
          <span className="view-tip">{tip}</span>
        </div>
      </div>
    </div>
  );
}
