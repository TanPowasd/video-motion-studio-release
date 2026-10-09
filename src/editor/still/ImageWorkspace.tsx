import React, { useState } from 'react';
import { Icon } from '../Icons.js';
import type { Node, Project, Scene } from '../../core/model.js';
import {
  STILL_MAX_SIDE,
  stillGuides,
  stillPresets,
  type AlignMode,
  type StillVariant,
} from '../../core/still.js';
import './still.css';

export type ArtboardView = {
  bleed: boolean;
  safe: boolean;
  rulers: boolean;
  snap: boolean;
  center: boolean;
};
export const defaultArtboardView: ArtboardView = {
  bleed: true,
  safe: true,
  rulers: true,
  snap: true,
  center: false,
};
export type AlignReference = 'auto' | 'selection' | 'canvas' | 'trim' | 'safe';

const alignButtons: Array<[AlignMode, string, string]> = [
  ['left', 'alignLeft', '左对齐'],
  ['hcenter', 'alignHCenter', '水平居中'],
  ['right', 'alignRight', '右对齐'],
  ['top', 'alignTop', '顶对齐'],
  ['vcenter', 'alignVCenter', '垂直居中'],
  ['bottom', 'alignBottom', '底对齐'],
  ['distribute-h', 'distributeH', '水平等距分布（至少 3 个图层）'],
  ['distribute-v', 'distributeV', '垂直等距分布（至少 3 个图层）'],
];

/** Artboard-focused tool row that replaces the animation toolbar while a still is active. */
export function ImageToolbar({
  selection,
  view,
  reference,
  busy,
  onAdd,
  onAlign,
  onReference,
  onView,
  onExport,
}: {
  selection: number;
  view: ArtboardView;
  reference: AlignReference;
  busy: boolean;
  onAdd: (type: Node['type']) => void;
  onAlign: (mode: AlignMode) => void;
  onReference: (value: AlignReference) => void;
  onView: (view: ArtboardView) => void;
  onExport: () => void;
}) {
  const toggle = (key: keyof ArtboardView, label: string, icon: string, keys?: string) => (
    <button
      className={`tool-button still-toggle ${view[key] ? 'pressed' : ''}`}
      aria-pressed={view[key]}
      title={`${label}${keys ? ` · ${keys}` : ''}`}
      aria-label={label}
      onClick={() => onView({ ...view, [key]: !view[key] })}
    >
      <Icon name={icon} size={15} />
    </button>
  );
  return (
    <div className="canvas-toolbar still-toolbar" role="toolbar" aria-label="图片工具">
      <div className="tool-group">
        <span className="tool-group-label">添加</span>
        {(
          [
            ['text', '文字'],
            ['rect', '形状'],
            ['ellipse', '椭圆'],
          ] as const
        ).map(([type, name]) => (
          <button
            key={type}
            className="tool-button"
            title={`添加${name}`}
            aria-label={`添加${name}`}
            onClick={() => onAdd(type)}
          >
            <Icon name={type} size={16} />
            <span>{name}</span>
          </button>
        ))}
        <span className="toolbar-separator" />
        <span className="tool-group-label">对齐</span>
        {alignButtons.map(([mode, icon, label]) => (
          <button
            key={mode}
            className="tool-button icon-only"
            title={label}
            aria-label={label}
            disabled={
              busy ||
              !selection ||
              (mode.startsWith('distribute') && selection < 3) ||
              (reference === 'selection' && selection < 2 && !mode.startsWith('distribute'))
            }
            onClick={() => onAlign(mode)}
          >
            <Icon name={icon} size={16} />
          </button>
        ))}
        <select
          className="still-reference"
          aria-label="对齐参照"
          title="对齐参照：单个图层默认对齐安全区，多个图层默认对齐选区"
          value={reference}
          onChange={(e) => onReference(e.target.value as AlignReference)}
        >
          <option value="auto">自动参照</option>
          <option value="selection">选区</option>
          <option value="canvas">画布</option>
          <option value="trim">成品线</option>
          <option value="safe">安全区</option>
        </select>
        <span className="toolbar-separator" />
        {toggle('snap', '吸附到边缘与中心', 'magnet')}
        {toggle('rulers', '标尺', 'ruler')}
        {toggle('bleed', '出血与成品线', 'bleed')}
        {toggle('safe', '安全区', 'rect')}
        {toggle('center', '中心线', 'alignHCenter')}
      </div>
      <div className="top-spacer" />
      <button className="primary compact" onClick={onExport} title="导出 PNG / JPEG / WebP">
        <Icon name="export" size={14} />
        导出图片
      </button>
    </div>
  );
}

/** Trim/bleed, safe-area and centre guides drawn in artboard coordinates over the preview. */
export function ArtboardGuides({
  scene,
  project,
  view,
}: {
  scene: Scene;
  project: Project;
  view: ArtboardView;
}) {
  const g = stillGuides(scene, project),
    stroke = Math.max(1, g.width / 900);
  return (
    <svg
      className="artboard-guides"
      viewBox={`0 0 ${g.width} ${g.height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {view.bleed && g.still.bleed > 0 && (
        <>
          <path
            className="bleed-zone"
            fillRule="evenodd"
            d={`M0 0H${g.width}V${g.height}H0Z M${g.trim.x} ${g.trim.y}V${g.trim.y + g.trim.height}H${g.trim.x + g.trim.width}V${g.trim.y}Z`}
          />
          <rect
            className="trim-line"
            x={g.trim.x}
            y={g.trim.y}
            width={g.trim.width}
            height={g.trim.height}
            strokeWidth={stroke}
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      {view.safe && g.still.safeArea > 0 && (
        <rect
          className="safe-line"
          x={g.safe.x}
          y={g.safe.y}
          width={g.safe.width}
          height={g.safe.height}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {view.center && (
        <path
          className="center-line"
          d={`M${g.width / 2} 0V${g.height}M0 ${g.height / 2}H${g.width}`}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Pixel rulers along the top and left edge of the artboard (screen-scaled ticks). */
export function ArtboardRulers({ width, height, scale }: { width: number; height: number; scale: number }) {
  const step = [5, 10, 20, 50, 100, 200, 250, 500, 1000, 2000].find((s) => s * scale >= 56) ?? 5000,
    minor = step / 5;
  const ticks = (length: number) => {
    const out: Array<{ at: number; major: boolean }> = [];
    for (let v = 0; v <= length + 1e-6; v += minor)
      out.push({ at: v, major: Math.abs(v / step - Math.round(v / step)) < 1e-6 });
    return out;
  };
  return (
    <>
      <svg className="artboard-ruler top" width={width * scale} height={18} aria-hidden>
        {ticks(width).map(({ at, major }) => (
          <g key={at}>
            <line x1={at * scale} x2={at * scale} y1={major ? 4 : 12} y2={18} />
            {major && (
              <text x={at * scale + 3} y={10}>
                {Math.round(at)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <svg className="artboard-ruler left" width={18} height={height * scale} aria-hidden>
        {ticks(height).map(({ at, major }) => (
          <g key={at}>
            <line y1={at * scale} y2={at * scale} x1={major ? 4 : 12} x2={18} />
            {major && (
              <text x={10} y={at * scale + 3} transform={`rotate(-90 10 ${at * scale + 3})`}>
                {Math.round(at)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </>
  );
}

/** Artboard settings shown in the inspector when nothing is selected in image mode. */
export function ArtboardInspector({
  scene,
  project,
  busy,
  onUpdate,
  onVariants,
  onUnmark,
}: {
  scene: Scene;
  project: Project;
  busy: boolean;
  onUpdate: (patch: Record<string, unknown>) => void;
  onVariants: (variants: StillVariant[]) => void;
  onUnmark: () => void;
}) {
  const g = stillGuides(scene, project);
  const [adding, setAdding] = useState('');
  const num = (label: string, value: number, key: string, min = 0, max = STILL_MAX_SIDE) => (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={`${key}-${value}`}
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        disabled={busy}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== value) onUpdate({ [key]: n });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
  return (
    <div className="artboard-inspector">
      <div className="inspector-node">
        <Icon name="artboard" />
        <strong>{scene.name}</strong>
        <span className="tag">画板</span>
      </div>
      <section className="inspector-section" data-category="properties">
        <h3>画布尺寸</h3>
        <label className="select-row">
          预设
          <select
            aria-label="画布预设"
            value={g.still.preset ?? ''}
            disabled={busy}
            onChange={(e) => e.target.value && onUpdate({ preset: e.target.value })}
          >
            <option value="">自定义</option>
            {stillPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.width}×{p.height}
              </option>
            ))}
          </select>
        </label>
        <div className="still-two">
          {num('宽度', g.width, 'width', 16)}
          {num('高度', g.height, 'height', 16)}
        </div>
        <label className="select-row">
          背景
          <span className="still-color">
            <input
              type="color"
              aria-label="画布背景色"
              value={/^#[0-9a-f]{6}$/i.test(scene.background) ? scene.background : '#ffffff'}
              disabled={busy}
              onChange={(e) => onUpdate({ background: e.target.value })}
            />
            <code>{scene.background}</code>
          </span>
        </label>
        <label className="still-check">
          <input
            type="checkbox"
            checked={g.still.transparent}
            disabled={busy}
            onChange={(e) => onUpdate({ transparent: e.target.checked })}
          />
          默认导出透明背景（PNG / WebP）
        </label>
      </section>
      <section className="inspector-section" data-category="properties">
        <h3>印刷与参考线</h3>
        <div className="still-two">
          {num('出血 px', g.still.bleed, 'bleed', 0, 1024)}
          {num('安全边距 px', g.still.safeArea, 'safeArea', 0, 4096)}
        </div>
        {num('分辨率 DPI', g.still.dpi, 'dpi', 36, 2400)}
        <p className="hint">
          成品 {Math.round(g.trim.width)}×{Math.round(g.trim.height)} px
          {g.still.dpi >= 150
            ? ` · ${((g.trim.width / g.still.dpi) * 25.4).toFixed(0)}×${((g.trim.height / g.still.dpi) * 25.4).toFixed(0)} mm`
            : ''}
        </p>
      </section>
      <section className="inspector-section" data-category="properties">
        <h3>尺寸变体</h3>
        {g.still.variants.length ? (
          g.still.variants.map((v) => (
            <div className="still-variant-row" key={v.id}>
              <span>
                <strong>{v.name}</strong>
                <small>
                  {v.width}×{v.height}
                </small>
              </span>
              <select
                aria-label={`${v.name} 适配方式`}
                value={v.fit}
                disabled={busy}
                onChange={(e) =>
                  onVariants(
                    g.still.variants.map((x) =>
                      x.id === v.id ? { ...x, fit: e.target.value as StillVariant['fit'] } : x,
                    ),
                  )
                }
              >
                <option value="contain">完整显示</option>
                <option value="cover">裁切填满</option>
                <option value="reflow">重新排版</option>
              </select>
              <button
                className="subtle"
                aria-label={`删除变体 ${v.name}`}
                disabled={busy}
                onClick={() => onVariants(g.still.variants.filter((x) => x.id !== v.id))}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))
        ) : (
          <p className="hint">同一设计导出到其他尺寸，例如小红书 + 方图 + 视频封面。</p>
        )}
        <div className="still-variant-add">
          <select
            aria-label="添加尺寸变体"
            value={adding}
            disabled={busy || g.still.variants.length >= 16}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">选择预设…</option>
            {stillPresets
              .filter((p) => !g.still.variants.some((v) => v.id === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.width}×{p.height}
                </option>
              ))}
          </select>
          <button
            className="secondary compact"
            disabled={!adding || busy}
            onClick={() => {
              const p = stillPresets.find((x) => x.id === adding)!;
              onVariants([
                ...g.still.variants,
                { id: p.id, name: p.name, width: p.width, height: p.height, fit: 'contain', preset: p.id },
              ]);
              setAdding('');
            }}
          >
            添加
          </button>
        </div>
      </section>
      <section className="inspector-section" data-category="properties">
        <h3>模式</h3>
        <p className="hint">图片画板固定为 1 帧，时间轴、关键帧与声音已隐藏。</p>
        <button className="secondary compact" disabled={busy} onClick={onUnmark}>
          转为动画场景
        </button>
      </section>
    </div>
  );
}
