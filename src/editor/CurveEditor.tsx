import React, { useState, useRef, useEffect } from 'react';
import type { Keyframe } from '../core/model.js';
import { interpolate } from '../core/time.js';
export function CurveEditor({
  keys,
  onChange,
  selectedFrames = [],
  onSelect,
  disabled = false,
}: {
  keys: Keyframe[];
  onChange: (keys: Keyframe[]) => unknown;
  selectedFrames?: number[];
  onSelect?: (frame: number, additive: boolean) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Keyframe[] | undefined>(),
    drag = useRef<
      | {
          index: number;
          keys: Keyframe[];
          origin: Keyframe[];
          pointerId: number;
          clientX: number;
          clientY: number;
          moved: boolean;
        }
      | undefined
    >(undefined);
  const values = draft ?? keys;
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        drag.current = undefined;
        setDraft(undefined);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);
  if (keys.length < 2) return null;
  const sorted = [...values].sort((a, b) => a.frame - b.frame),
    minFrame = Math.min(...keys.map((k) => k.frame)),
    maxFrame = Math.max(...keys.map((k) => k.frame)),
    samples = Array.from({ length: 101 }, (_, i) =>
      interpolate(keys, minFrame + (i / 100) * (maxFrame - minFrame)),
    ),
    minValue = Math.min(...keys.map((k) => k.value), ...samples),
    maxValue = Math.max(...keys.map((k) => k.value), ...samples),
    range = Math.max(1, maxValue - minValue),
    bottom = minValue - range * 0.15,
    span = range * 1.3;
  const x = (frame: number) => 12 + ((frame - minFrame) / (maxFrame - minFrame)) * 212,
    y = (value: number) => 100 - ((value - bottom) / span) * 88;
  return (
    <svg
      className="curve-editor"
      viewBox="0 0 236 114"
      role="img"
      aria-label="关键帧曲线编辑器"
      onPointerMove={(event) => {
        if (drag.current === undefined) return;
        const g = drag.current;
        if (!g.moved && Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < 3)
          return;
        g.moved = true;
        const box = event.currentTarget.getBoundingClientRect(),
          dx = ((event.clientX - g.clientX) / box.width) * 236,
          dy = ((event.clientY - g.clientY) / box.height) * 114,
          index = drag.current.index,
          next = structuredClone(values);
        let frame = Math.round(g.origin[index].frame + (dx / 212) * (maxFrame - minFrame));
        const order = [...values].sort((a, b) => a.frame - b.frame),
          position = order.findIndex((k) => k === values[index]),
          prev = order[position - 1],
          following = order[position + 1];
        frame = Math.max(
          prev ? prev.frame + 1 : minFrame,
          Math.min(following ? following.frame - 1 : maxFrame, frame),
        );
        next[index] = {
          ...next[index],
          frame,
          value: Number((g.origin[index].value - (dy / 88) * span).toFixed(3)),
        };
        drag.current.keys = next;
        setDraft(next);
      }}
      onPointerUp={(event) => {
        const g = drag.current;
        if (g && JSON.stringify(g.keys) !== JSON.stringify(keys))
          onChange([...g.keys].sort((a, b) => a.frame - b.frame));
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        setDraft(undefined);
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = undefined;
          setDraft(undefined);
        }
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDraft(undefined);
      }}
    >
      <rect x="0" y="0" width="236" height="114" rx="5" style={{ fill: 'var(--vm-graph-bg)' }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <path
          key={i}
          d={`M 12 ${12 + i * 22} H 224 M ${12 + i * 53} 12 V 100`}
          style={{ stroke: 'var(--vm-graph-grid)' }}
          strokeWidth=".6"
        />
      ))}
      <path
        d={Array.from({ length: 100 }, (_, i) => {
          const frame = minFrame + (i / 99) * (maxFrame - minFrame);
          return `${i ? 'L' : 'M'} ${x(frame)} ${y(interpolate(values, frame))}`;
        }).join(' ')}
        fill="none"
        style={{ stroke: 'var(--vm-graph-curve)' }}
        strokeWidth="1.7"
      />
      {values.map((k, i) => (
        <circle
          key={i}
          cx={x(k.frame)}
          cy={y(k.value)}
          r="4"
          style={{
            cursor: 'grab',
            fill: selectedFrames.includes(k.frame) ? 'var(--vm-graph-point-on)' : 'var(--vm-graph-point)',
            stroke: 'var(--vm-graph-point-line)',
          }}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.stopPropagation();
            onSelect?.(k.frame, event.ctrlKey || event.metaKey);
            event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
            drag.current = {
              index: i,
              keys: structuredClone(keys),
              origin: structuredClone(keys),
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              moved: false,
            };
            setDraft(structuredClone(keys));
          }}
        >
          <title>
            {k.frame}f · {k.value}
          </title>
        </circle>
      ))}
    </svg>
  );
}
