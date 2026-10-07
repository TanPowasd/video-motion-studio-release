import React, { useState } from 'react';
import type { Node, Snapshot } from '../core/model.js';
import { contentTiming, contentDuration } from '../core/content-time.js';
import { evaluateNode } from '../core/time.js';
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
export function TimeInspector({
  node,
  snapshot,
  frame,
  onEdit,
  onKey,
}: {
  node: Node;
  snapshot: Snapshot;
  frame: number;
  onEdit: (data: Record<string, unknown>) => Promise<unknown>;
  onKey: (property: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    current = evaluateNode(node, frame),
    duration = contentDuration(snapshot, current),
    timing = contentTiming(snapshot, current, frame, true);
  const edit = async (data: Record<string, unknown>) => {
    setBusy(true);
    try {
      return await onEdit(data);
    } finally {
      setBusy(false);
    }
  };
  const setting = (key: string, value: unknown) => void edit({ settings: { [key]: value } });
  return (
    <div className="time-inspector">
      <p className="hint">
        父帧 {frame.toFixed(2)} → 内容帧 {timing.sourceFrame.toFixed(2)}
        {!timing.present ? ' · 当前无内容' : ''}
      </p>
      <div className="time-presets">
        <button disabled={busy} onClick={() => void edit({ preset: 'freeze' })}>
          冻结当前内容
        </button>
        <button
          disabled={busy || !duration}
          title={!duration ? '先指定内容长度' : '从内容末帧开始倒放'}
          onClick={() => void edit({ preset: 'reverse' })}
        >
          倒放
        </button>
        <button disabled={busy} onClick={() => void edit({ reset: true })}>
          重置时间
        </button>
      </div>
      <label className="select-row">
        时间方式
        <select
          aria-label="内容时间方式"
          value={current.timeMapping.mode}
          disabled={busy}
          onChange={(e) =>
            e.target.value === 'remap'
              ? void edit({
                  keys: [{ frame: Math.round(frame), value: timing.rawFrame, easing: 'linear' }],
                })
              : setting('mode', 'linear')
          }
        >
          <option value="linear">变速与偏移</option>
          <option value="remap">关键帧重映射</option>
        </select>
      </label>
      {current.timeMapping.mode === 'linear' ? (
        <>
          <NumberControl
            label="内容速率"
            value={current.timeMapping.rate}
            onChange={(v) => setting('rate', v)}
            onKey={() => onKey('timeMapping.rate')}
          />
          <NumberControl
            label="父时间起点"
            value={current.timeMapping.anchor}
            onChange={(v) => setting('anchor', v)}
            onKey={() => onKey('timeMapping.anchor')}
          />
          <NumberControl
            label="内容起始帧"
            value={current.timeMapping.offset}
            onChange={(v) => setting('offset', v)}
            onKey={() => onKey('timeMapping.offset')}
          />
        </>
      ) : (
        <NumberControl
          label="映射内容帧"
          value={current.timeMapping.frame}
          onChange={(v) => {
            const channel = node.animations.find((a) => a.property === 'timeMapping.frame'),
              at = Math.round(frame),
              keys = channel?.keys.filter((k) => k.frame !== at) ?? [];
            keys.push({ frame: at, value: v, easing: 'linear' });
            void edit({ keys });
          }}
          onKey={() => onKey('timeMapping.frame')}
        />
      )}
      <label className="select-row">
        范围行为
        <select
          aria-label="内容范围行为"
          value={current.timeMapping.repeat}
          disabled={busy}
          onChange={(e) => setting('repeat', e.target.value)}
        >
          <option value="continue">持续求值</option>
          <option value="clamp">保持首末帧</option>
          <option value="loop">循环</option>
          <option value="pingpong">往返</option>
          <option value="blank">范围外透明</option>
        </select>
      </label>
      <NumberControl
        label="内容长度 (帧)"
        value={duration ?? 0}
        onChange={(v) => {
          if (v > 0) setting('duration', v);
        }}
      />
      <p className="hint">
        0
        倍冻结，负速率倒放。场景和媒体长度自动读取；代码组件使用循环等范围行为前需指定长度。图层变换按父时间求值。
      </p>
      <p className="hint">进入内部编辑使用内容时间，进入点的祖先时钟固定。音频仍按主时间轴混音。</p>
    </div>
  );
}
