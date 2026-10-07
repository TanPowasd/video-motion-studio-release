import React, { useState } from 'react';
import type { Node, Keyframe } from '../core/model.js';
import type { KeyframeAction } from '../core/keyframes.js';
import { CurveEditor } from './CurveEditor.js';
import { BezierEditor } from './BezierEditor.js';
import { SelectControl } from './studio/Controls.js';
type Selected = { property: string; frame: number };
const easingNames: Record<Keyframe['easing'], string> = {
  linear: '线性',
  easeIn: '缓入',
  easeOut: '缓出',
  easeInOut: '缓入缓出',
  hold: '保持',
  spring: '弹簧',
  bezier: '贝塞尔',
};
export function AnimationInspector({
  node,
  frame,
  onFrame,
  onEdit,
}: {
  node: Node;
  frame: number;
  onFrame: (frame: number) => void;
  onEdit: (actions: KeyframeAction[]) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<Selected[]>([]),
    [offset, setOffset] = useState(10),
    [scale, setScale] = useState(1),
    [busy, setBusy] = useState(false),
    [easing, setEasing] = useState<Keyframe['easing']>('easeInOut');
  const valid = selected.filter((s) =>
      node.animations.some(
        (a) => a.property === s.property && a.keys.some((k) => k.frame === s.frame),
      ),
    ),
    picked = (property: string, at: number) =>
      valid.some((s) => s.property === property && s.frame === at);
  const select = (property: string, at: number, additive: boolean) => {
    setSelected(
      additive
        ? picked(property, at)
          ? valid.filter((s) => s.property !== property || s.frame !== at)
          : [...valid, { property, frame: at }]
        : [{ property, frame: at }],
    );
  };
  const edit = async (actions: KeyframeAction[], clear = false) => {
    setBusy(true);
    try {
      const result = await onEdit(actions);
      if (result && clear) setSelected([]);
      return result;
    } finally {
      setBusy(false);
    }
  };
  const groups = () =>
    node.animations
      .map((a) => ({
        property: a.property,
        frames: valid.filter((s) => s.property === a.property).map((s) => s.frame),
      }))
      .filter((g) => g.frames.length);
  const transform = (copy = false, timeOffset = offset) =>
    void edit(
      groups().map((g) => ({
        type: 'transform',
        properties: [g.property],
        frames: g.frames,
        timeOffset,
        timeScale: scale,
        pivotFrame: Math.min(...valid.map((s) => s.frame)),
        copy,
      })),
      true,
    );
  const remove = () =>
    void edit(
      groups().map((g) => ({ type: 'remove', properties: [g.property], frames: g.frames })),
      true,
    );
  if (!node.animations.length)
    return <p className="hint">点击属性旁的菱形，为当前帧添加关键帧。</p>;
  return (
    <div className="animation-inspector">
      <div className="keyframe-tools">
        <span>{valid.length} 个关键帧已选</span>
        <button
          disabled={busy}
          onClick={() =>
            setSelected(
              node.animations.flatMap((a) =>
                a.keys.map((k) => ({ property: a.property, frame: k.frame })),
              ),
            )
          }
        >
          全选
        </button>
        <button disabled={!valid.length || busy} onClick={() => setSelected([])}>
          清空选择
        </button>
        <label>
          偏移
          <input
            aria-label="关键帧偏移"
            type="number"
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
          />
        </label>
        <label>
          时间倍数
          <input
            aria-label="关键帧时间倍数"
            type="number"
            step={0.1}
            min={0.01}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
          />
        </label>
        <button disabled={!valid.length || busy} onClick={() => transform()}>
          移动 / 缩放
        </button>
        <button
          disabled={!valid.length || busy}
          onClick={() => transform(true, frame - Math.min(...valid.map((s) => s.frame)))}
        >
          复制到播放头
        </button>
        <select
          aria-label="批量关键帧缓动"
          value={easing}
          onChange={(e) => setEasing(e.target.value as Keyframe['easing'])}
        >
          {Object.entries(easingNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <button
          disabled={!valid.length || busy}
          onClick={() =>
            void edit(
              groups().map((g) => ({
                type: 'ease',
                properties: [g.property],
                frames: g.frames,
                easing,
              })),
            )
          }
        >
          应用缓动
        </button>
        <button disabled={!valid.length || busy} onClick={remove}>
          删除所选
        </button>
      </div>
      {node.animations.map((channel) => (
        <div key={channel.property} className="animation-channel">
          <div>
            <strong>{channel.property}</strong>
            <button
              aria-label={`移除 ${channel.property} 动画`}
              disabled={busy}
              onClick={() => void edit([{ type: 'remove', properties: [channel.property] }], true)}
            >
              ×
            </button>
          </div>
          <CurveEditor
            disabled={busy}
            keys={channel.keys}
            selectedFrames={valid
              .filter((s) => s.property === channel.property)
              .map((s) => s.frame)}
            onSelect={(at, additive) => select(channel.property, at, additive)}
            onChange={(keys) =>
              void edit(
                [
                  { type: 'remove', properties: [channel.property] },
                  { type: 'upsert', property: channel.property, keys },
                ],
                true,
              )
            }
          />
          <div className="channel-extrapolation">
            {(['before', 'after'] as const).map((side) => (
              <SelectControl
                key={side}
                label={`${channel.property} ${side === 'before' ? '首帧前' : '末帧后'}`}
                value={channel[side] ?? 'constant'}
                options={['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong']}
                onChange={(value) =>
                  void edit([
                    {
                      type: 'extrapolate',
                      properties: [channel.property],
                      [side]: value,
                    } as KeyframeAction,
                  ])
                }
              />
            ))}
          </div>
          {channel.keys.map((key) => (
            <div
              key={key.frame}
              className={`keyframe-edit-row ${picked(channel.property, key.frame) ? 'selected' : ''}`}
            >
              <button
                className="keyframe-select"
                aria-label={`选择关键帧 ${channel.property} ${key.frame}`}
                aria-pressed={picked(channel.property, key.frame)}
                disabled={busy}
                onClick={(e) => select(channel.property, key.frame, e.ctrlKey || e.metaKey)}
              >
                ◆
              </button>
              <input
                aria-label={`${channel.property} ${key.frame} 帧号`}
                disabled={busy}
                type="number"
                min={0}
                defaultValue={key.frame}
                onBlur={(e) => {
                  const at = Number(e.target.value);
                  if (Number.isInteger(at) && at >= 0 && at !== key.frame)
                    void edit(
                      [
                        {
                          type: 'transform',
                          properties: [channel.property],
                          frames: [key.frame],
                          timeOffset: at - key.frame,
                        },
                      ],
                      true,
                    );
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <input
                aria-label={`${channel.property} ${key.frame} 数值`}
                disabled={busy}
                type="number"
                step="any"
                key={key.value}
                defaultValue={key.value}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value !== key.value)
                    void edit([
                      { type: 'upsert', property: channel.property, keys: [{ ...key, value }] },
                    ]);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <button
                aria-label={`跳转 ${channel.property} ${key.frame}`}
                onClick={() => onFrame(key.frame)}
              >
                ↗
              </button>
              <select
                aria-label={`${channel.property} ${key.frame} 缓动`}
                value={key.easing}
                disabled={busy}
                onChange={(e) =>
                  void edit([
                    {
                      type: 'ease',
                      properties: [channel.property],
                      frames: [key.frame],
                      easing: e.target.value as Keyframe['easing'],
                    },
                  ])
                }
              >
                {Object.entries(easingNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              {key.easing === 'bezier' && (
                <BezierEditor
                  disabled={busy}
                  value={key.bezier ?? [0.25, 0.1, 0.25, 1]}
                  onChange={(bezier) =>
                    edit([
                      {
                        type: 'ease',
                        properties: [channel.property],
                        frames: [key.frame],
                        easing: 'bezier',
                        bezier,
                      },
                    ])
                  }
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
