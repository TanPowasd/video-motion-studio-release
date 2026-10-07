import React, { useState } from 'react';
import type { Node } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
import { strokeDashSchema } from '../core/vector-schema.js';

function NumberControl({
  label,
  value,
  onChange,
  onKey,
}: {
  label: string;
  value: number;
  onChange: (value: number) => unknown;
  onKey?: () => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={value}
        type="number"
        step="any"
        defaultValue={Number(value.toFixed(4))}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (e.target.value.trim() && Number.isFinite(n) && n !== Number(value.toFixed(4)))
            onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {onKey && (
        <button type="button" title={`为${label}添加关键帧`} onClick={onKey}>
          ◇
        </button>
      )}
    </label>
  );
}
export function VectorInspector({
  node,
  frame,
  selectedCount,
  onChange,
  onKey,
  onBake,
}: {
  node: Node;
  frame: number;
  selectedCount: number;
  onChange: (patch: Partial<Node>) => unknown;
  onKey: (property: string) => void;
  onBake: (operation: string, radius: number) => Promise<unknown>;
}) {
  const [error, setError] = useState(''),
    [radius, setRadius] = useState(12),
    [busy, setBusy] = useState(false);
  const current = evaluateNode(node, frame),
    vector = ['rect', 'ellipse', 'path'].includes(node.type);
  const trimChange = (key: 'start' | 'end' | 'offset', value: number) => {
    const animations = structuredClone(node.animations),
      channel = animations.find((a) => a.property === `pathTrim.${key}`);
    if (channel) {
      const at = Math.round(frame);
      channel.keys = channel.keys.filter((k) => k.frame !== at);
      channel.keys.push({ frame: at, value, easing: 'easeInOut' });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
    return onChange({ pathTrim: { ...node.pathTrim, [key]: value }, animations });
  };
  const bake = async (operation: string) => {
    setBusy(true);
    try {
      await onBake(operation, radius);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vector-inspector">
      <label className="select-row">
        描边颜色
        <input
          aria-label="描边颜色"
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(node.stroke) ? node.stroke : '#ffffff'}
          onChange={(e) => onChange({ stroke: e.target.value })}
        />
      </label>
      <NumberControl
        label="描边宽度"
        value={current.strokeWidth}
        onChange={(v) => onChange({ strokeWidth: Math.max(0, v) })}
        onKey={() => onKey('strokeWidth')}
      />
      <label className="select-row">
        端点
        <select
          aria-label="描边端点"
          value={node.strokeCap}
          onChange={(e) => onChange({ strokeCap: e.target.value as Node['strokeCap'] })}
        >
          <option value="butt">平头 · Butt</option>
          <option value="round">圆头 · Round</option>
          <option value="square">方头 · Square</option>
        </select>
      </label>
      <label className="select-row">
        拐角
        <select
          aria-label="描边拐角"
          value={node.strokeJoin}
          onChange={(e) => onChange({ strokeJoin: e.target.value as Node['strokeJoin'] })}
        >
          <option value="miter">尖角 · Miter</option>
          <option value="round">圆角 · Round</option>
          <option value="bevel">斜角 · Bevel</option>
        </select>
      </label>
      <NumberControl
        label="尖角上限"
        value={current.strokeMiterLimit}
        onChange={(v) => onChange({ strokeMiterLimit: Math.max(1, Math.min(1000, v)) })}
      />
      <label className="select-row">
        虚线间隔
        <input
          aria-label="虚线间隔"
          key={node.strokeDash.join(',')}
          placeholder="例如 18, 8；空白为实线"
          defaultValue={node.strokeDash.join(', ')}
          onBlur={(e) => {
            const raw = e.target.value.trim(),
              dash = raw ? raw.split(/[,，\s]+/).map(Number) : [];
            const parsed = strokeDashSchema.safeParse(dash);
            if (!parsed.success) {
              setError('虚线需为非负数，至少一个间隔大于 0，最多 32 项。');
              return;
            }
            setError('');
            if (JSON.stringify(dash) !== JSON.stringify(node.strokeDash))
              onChange({
                strokeDash: dash,
                animations: node.animations.filter((a) => !a.property.startsWith('strokeDash.')),
              });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
      <NumberControl
        label="虚线偏移"
        value={current.strokeDashOffset}
        onChange={(v) => onChange({ strokeDashOffset: Math.max(-1e6, Math.min(1e6, v)) })}
        onKey={() => onKey('strokeDashOffset')}
      />
      {error && (
        <p role="alert" className="hint">
          {error}
        </p>
      )}
      {vector && (
        <>
          <label className="select-row">
            填充规则
            <select
              aria-label="路径填充规则"
              value={node.fillRule}
              onChange={(e) => onChange({ fillRule: e.target.value as Node['fillRule'] })}
            >
              <option value="nonzero">非零 · Nonzero</option>
              <option value="evenodd">奇偶 · Evenodd</option>
            </select>
          </label>
          <label className="select-row">
            <span>仅显示描边</span>
            <input
              type="checkbox"
              aria-label="仅显示描边"
              checked={node.fill === 'transparent' && !node.gradient}
              disabled={Boolean(node.gradient)}
              title={node.gradient ? '此图层使用渐变，请先在组件源码或工程中移除渐变。' : undefined}
              onChange={(e) => onChange({ fill: e.target.checked ? 'transparent' : '#7c8cff' })}
            />
          </label>
          {node.type === 'rect' && (
            <NumberControl
              label="矩形圆角"
              value={current.radius}
              onChange={(v) => onChange({ radius: Math.max(0, v) })}
              onKey={() => onKey('radius')}
            />
          )}
          <p className="hint">路径裁切 · 总轮廓长度。起点大于终点时跨越首尾；偏移单位为圈。</p>
          <NumberControl
            label="裁切起点 (%)"
            value={current.pathTrim.start * 100}
            onChange={(v) => trimChange('start', Math.max(0, Math.min(1, v / 100)))}
            onKey={() => onKey('pathTrim.start')}
          />
          <NumberControl
            label="裁切终点 (%)"
            value={current.pathTrim.end * 100}
            onChange={(v) => trimChange('end', Math.max(0, Math.min(1, v / 100)))}
            onKey={() => onKey('pathTrim.end')}
          />
          <NumberControl
            label="裁切偏移 (圈)"
            value={current.pathTrim.offset}
            onChange={(v) => trimChange('offset', Math.max(-1e6, Math.min(1e6, v)))}
            onKey={() => onKey('pathTrim.offset')}
          />
          <label className="select-row">
            生成路径快照
            <select
              aria-label="生成路径快照"
              value=""
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void bake(e.target.value);
              }}
            >
              <option value="">选择操作…</option>
              {selectedCount >= 2 ? (
                <>
                  <option value="union">合并 · Union</option>
                  <option value="difference">第一层减去其余 · Difference</option>
                  <option value="intersect">交集 · Intersect</option>
                  <option value="xor">排除交集 · Xor</option>
                  <option value="reverseDifference">反向相减 · Reverse difference</option>
                </>
              ) : (
                <>
                  <option value="simplify">简化自交路径</option>
                  <option value="round">路径圆角</option>
                  <option value="outline">实线描边转轮廓</option>
                </>
              )}
            </select>
          </label>
          {selectedCount === 1 && (
            <NumberControl
              label="路径圆角半径"
              value={radius}
              onChange={(v) => setRadius(Math.max(0, v))}
            />
          )}
          <p className="hint">
            快照固定当前帧的几何，使用第一层填充与透明度；保留并隐藏源图层，可撤销。渐变、遮罩、效果与动画保留在源图层。
          </p>
        </>
      )}
    </div>
  );
}
