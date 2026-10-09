import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node } from '../../core/model.js';
import type { InteractionLayer } from '../../core/interaction.js';
import { layerBox } from '../../core/still.js';
import { evaluateNode } from '../../core/time.js';
import { Icon } from '../Icons.js';
import { inspectGlyphs, type GlyphSetSummary } from '../glyphs/glyph-api.js';
import { formatAgo, type Highlight } from './change-feed.js';
import { placeToolbar, type Obstacle } from './model.js';

const pct = (v: number, of: number) => `${(v / Math.max(1, of)) * 100}%`;
const FONTS = ['Noto Sans SC', 'Microsoft YaHei', 'Source Han Serif SC', 'SimHei', 'KaiTi', 'Inter'];
const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff');

/**
 * Canvas overlays drawn inside the fitted canvas box: dashed mint outlines + chips on
 * objects changed by AI, and a floating context toolbar next to the selected object.
 */
export function StageOverlays({
  layers,
  width,
  height,
  selection,
  node,
  frame,
  highlights,
  now,
  revision,
  canUndo,
  update,
  onInspector,
  onEffects,
  onMotion,
  onGlyphs,
  onEnter,
  onUndoEntry,
  onRevealEntry,
}: {
  layers: InteractionLayer[];
  width: number;
  height: number;
  selection: string[];
  node?: Node;
  frame: number;
  highlights: Map<string, Highlight>;
  now: number;
  revision: string;
  canUndo: (h: Highlight) => boolean;
  update: (patch: Partial<Node>) => unknown;
  onInspector: () => void;
  onEffects: () => void;
  onMotion: () => void;
  onGlyphs: () => void;
  onEnter: (id: string) => void;
  onUndoEntry: (h: Highlight) => void;
  onRevealEntry: (h: Highlight) => void;
}) {
  const byId = new Map(layers.map((l) => [l.node.id, l] as const));
  const selected = selection.length === 1 ? byId.get(selection[0]) : undefined;
  return (
    <div className="stage-overlays" aria-hidden={false}>
      {[...highlights.values()].map((h) => {
        const layer = byId.get(h.nodeId);
        if (!layer) return null;
        const box = layerBox(layer),
          below = box.y + box.height < height * 0.86;
        return (
          <React.Fragment key={h.nodeId}>
            <div
              className={`ai-outline ${h.created ? 'created' : ''}`}
              style={{ left: pct(box.x, width), top: pct(box.y, height), width: pct(box.width, width), height: pct(box.height, height) }}
            />
            <div
              className={`ai-chip ${below ? 'below' : 'above'}`}
              style={{
                left: pct(Math.max(0, box.x), width),
                top: pct(below ? box.y + box.height : box.y, height),
              }}
            >
              <button className="ai-chip-text" onClick={() => onRevealEntry(h)} title="在改动记录中查看">
                <i />
                AI · {formatAgo(now - h.entry.at)} · {h.created ? '新建' : h.text || '已修改'}
              </button>
              <button
                className="ai-chip-undo"
                disabled={!canUndo(h)}
                title={canUndo(h) ? '撤销这一步' : '之后还有改动；在改动记录里整组撤销'}
                onClick={() => onUndoEntry(h)}
              >
                撤销
              </button>
            </div>
          </React.Fragment>
        );
      })}
      {selected && node && node.id === selected.node.id && (
        <ContextToolbar
          layer={selected}
          others={layers
            .filter((l) => l !== selected && l.node.visible !== false)
            .map((l) => ({ ...layerBox(l), weight: l.node.type === 'text' ? 2 : 1 }))}
          node={evaluateNode(node, frame)}
          width={width}
          height={height}
          revision={revision}
          update={update}
          onInspector={onInspector}
          onEffects={onEffects}
          onMotion={onMotion}
          onGlyphs={onGlyphs}
          onEnter={onEnter}
        />
      )}
    </div>
  );
}

function ContextToolbar({
  layer,
  others,
  node,
  width,
  height,
  revision,
  update,
  onInspector,
  onEffects,
  onMotion,
  onGlyphs,
  onEnter,
}: {
  layer: InteractionLayer;
  others: Obstacle[];
  node: Node;
  width: number;
  height: number;
  revision: string;
  update: (patch: Partial<Node>) => unknown;
  onInspector: () => void;
  onEffects: () => void;
  onMotion: () => void;
  onGlyphs: () => void;
  onEnter: (id: string) => void;
}) {
  const box = layerBox(layer),
    text = node.type === 'text',
    shape = node.type === 'rect' || node.type === 'ellipse' || node.type === 'path',
    container = node.type === 'group' || node.type === 'component' || node.type === 'scene';
  const [sets, setSets] = useState<GlyphSetSummary[]>([]);
  useEffect(() => {
    if (!text) return;
    let alive = true;
    inspectGlyphs({})
      .then((r) => alive && setSets(r.sets))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [text, revision]);
  const fonts = [...new Set([node.fontFamily ?? '', ...FONTS].filter(Boolean))];
  // Measure the bar in canvas units, then place it off the selection and, where possible,
  // off neighbouring objects (above → below → right → left), clamped to the canvas.
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: width * 0.3, height: height * 0.06, scale: 0.4 });
  useLayoutEffect(() => {
    const el = ref.current,
      parent = el?.parentElement;
    if (!el || !parent) return;
    const scale = parent.clientWidth / Math.max(1, width);
    if (!scale) return;
    const next = { width: el.offsetWidth / scale, height: el.offsetHeight / scale, scale };
    if (Math.abs(next.width - size.width) > 1 || Math.abs(next.height - size.height) > 1 || Math.abs(scale - size.scale) > 0.01)
      setSize(next);
  });
  // Ancestors (boxes that contain the selection) are not obstacles: every spot overlaps them.
  const obstacles = others.filter(
    (o) => !(o.x <= box.x && o.y <= box.y && o.x + o.width >= box.x + box.width && o.y + o.height >= box.y + box.height),
  );
  // Gaps are in screen pixels: 12px, and 28px above to clear the layer-name tag.
  const place = placeToolbar(box, size, { width, height }, obstacles, 12 / size.scale, 28 / size.scale);
  return (
    <div
      ref={ref}
      className={`ctx-toolbar placed ${place.side}`}
      role="toolbar"
      aria-label={`${node.name} 常用属性`}
      data-side={place.side}
      style={{ left: pct(place.x, width), top: pct(place.y, height) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {text && (
        <>
          <label className="ctx-font" title="字体">
            <span>Aa</span>
            <select aria-label="字体" value={node.fontFamily ?? ''} onChange={(e) => update({ fontFamily: e.target.value })}>
              {fonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="ctx-field" title="字形库（偏旁拼字）">
            <span>字形库</span>
            <select
              aria-label="快捷字形库"
              value={node.glyphSet ?? ''}
              onChange={(e) => update({ glyphSet: e.target.value || null } as Partial<Node>)}
            >
              <option value="">字体</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.id}
                </option>
              ))}
              {node.glyphSet && !sets.some((s) => s.id === node.glyphSet) && <option value={node.glyphSet}>{node.glyphSet}</option>}
            </select>
          </label>
          <span className="ctx-sep" />
          <label className="ctx-color" title="颜色">
            <input type="color" aria-label="文字颜色" value={hex(node.fill)} onChange={(e) => update({ fill: e.target.value })} />
          </label>
          <label className="ctx-num" title="字号">
            <input
              type="number"
              aria-label="字号"
              min={1}
              max={2000}
              value={Math.round(Number(node.fontSize ?? 48))}
              onChange={(e) => Number(e.target.value) > 0 && update({ fontSize: Number(e.target.value) })}
            />
          </label>
          <span className="ctx-sep" />
          <button className="ctx-field" onClick={onMotion} title="入场 / 强调 / 退场动作模板">
            <span>入场</span>
            <em>动作模板</em>
          </button>
          <button className="ctx-icon" onClick={onGlyphs} title="字形面板">
            字
          </button>
        </>
      )}
      {shape && (
        <>
          <label className="ctx-color" title="填充">
            <input type="color" aria-label="填充颜色" value={hex(node.fill)} onChange={(e) => update({ fill: e.target.value })} />
          </label>
          {node.type === 'rect' && (
            <label className="ctx-num labelled" title="圆角">
              <span>圆角</span>
              <input type="number" aria-label="圆角" min={0} value={Math.round(Number(node.radius ?? 0))} onChange={(e) => update({ radius: Number(e.target.value) })} />
            </label>
          )}
        </>
      )}
      {!text && (
        <label className="ctx-num labelled" title="不透明度">
          <span>不透明</span>
          <input
            type="number"
            aria-label="不透明度"
            min={0}
            max={100}
            value={Math.round(Number(node.opacity ?? 1) * 100)}
            onChange={(e) => update({ opacity: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })}
          />
        </label>
      )}
      {!text && (
        <>
          <span className="ctx-sep" />
          <button className="ctx-field" onClick={onEffects} title="效果堆栈">
            <Icon name="sparkles" size={13} />
            <span>特效</span>
          </button>
          <button className="ctx-field" onClick={onMotion} title="动作模板与动画层">
            <Icon name="layers" size={13} />
            <span>动画</span>
          </button>
        </>
      )}
      {container && (
        <button className="ctx-field" onClick={() => onEnter(node.id)} title="进入内部编辑">
          <Icon name="arrow" size={13} />
          <span>进入</span>
        </button>
      )}
      <button className="ctx-more" aria-label="完整属性" title="完整属性检查器" onClick={onInspector}>
        ⋯
      </button>
    </div>
  );
}
