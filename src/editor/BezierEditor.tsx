import React, { useRef, useState, useEffect } from 'react';
type Curve = [number, number, number, number];
export function BezierEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: Curve;
  onChange: (value: Curve) => Promise<unknown>;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Curve>(),
    drag = useRef<
      | {
          pointerId: number;
          handle: 0 | 1;
          value: Curve;
          origin: Curve;
          clientX: number;
          clientY: number;
          moved: boolean;
        }
      | undefined
    >(undefined);
  const curve = draft ?? value,
    x = (n: number) => 24 + n * 188,
    bottom = Math.min(-0.25, value[1], value[3]),
    top = Math.max(1.25, value[1], value[3]),
    span = top - bottom,
    y = (n: number) => 108 - ((n - bottom) / span) * 96;
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
  const move = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const b = e.currentTarget.getBoundingClientRect(),
      dx = ((e.clientX - g.clientX) / b.width) * 236,
      dy = ((e.clientY - g.clientY) / b.height) * 120,
      next = [...g.value] as Curve;
    if (!g.moved && Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY) < 3) return;
    g.moved = true;
    next[g.handle * 2] = Number(
      Math.max(0, Math.min(1, g.origin[g.handle * 2] + dx / 188)).toFixed(4),
    );
    next[g.handle * 2 + 1] = Number((g.origin[g.handle * 2 + 1] - (dy / 96) * span).toFixed(4));
    g.value = next;
    setDraft(next);
  };
  return (
    <div className="bezier-control">
      <svg
        viewBox="0 0 236 120"
        aria-label="贝塞尔缓动控制点"
        role="img"
        onPointerMove={move}
        onPointerUp={async (e) => {
          const g = drag.current;
          if (!g || g.pointerId !== e.pointerId) return;
          move(e);
          drag.current = undefined;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          try {
            if (JSON.stringify(g.value) !== JSON.stringify(value)) await onChange(g.value);
          } finally {
            setDraft(undefined);
          }
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDraft(undefined);
        }}
        onLostPointerCapture={() => {
          if (drag.current) {
            drag.current = undefined;
            setDraft(undefined);
          }
        }}
      >
        <rect width="236" height="120" rx="5" fill="#142033" />
        <path
          d={`M 24 ${y(1)} H 212 V ${y(0)} H 24 Z M 24 ${y(0)} L 212 ${y(1)}`}
          stroke="#405775"
          fill="none"
          strokeWidth="0.8"
        />
        <path
          d={`M 24 ${y(0)} L ${x(curve[0])} ${y(curve[1])} M 212 ${y(1)} L ${x(curve[2])} ${y(curve[3])}`}
          stroke="#7e9fc9"
          fill="none"
        />
        <path
          d={`M 24 ${y(0)} C ${x(curve[0])} ${y(curve[1])}, ${x(curve[2])} ${y(curve[3])}, 212 ${y(1)}`}
          stroke="#aabaff"
          strokeWidth="2"
          fill="none"
        />
        {([0, 1] as const).map((handle) => (
          <circle
            key={handle}
            cx={x(curve[handle * 2])}
            cy={y(curve[handle * 2 + 1])}
            r={5}
            fill={handle ? '#e8bd80' : '#90c4f8'}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              if (disabled || e.button !== 0 || !e.isPrimary) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
              drag.current = {
                pointerId: e.pointerId,
                handle,
                value: [...value],
                origin: [...value],
                clientX: e.clientX,
                clientY: e.clientY,
                moved: false,
              };
              setDraft([...value]);
            }}
          >
            <title>控制点 {handle + 1}</title>
          </circle>
        ))}
        <text x="24" y="113" fill="#718fb9" fontSize="9">
          0
        </text>
        <text x="207" y="113" fill="#718fb9" fontSize="9">
          1
        </text>
      </svg>
      <div className="bezier-numbers">
        {(['x1', 'y1', 'x2', 'y2'] as const).map((name, i) => (
          <label key={name}>
            {name}
            <input
              aria-label={`贝塞尔 ${name}`}
              disabled={disabled}
              type="number"
              step={0.01}
              min={i % 2 === 0 ? 0 : undefined}
              max={i % 2 === 0 ? 1 : undefined}
              key={value[i]}
              defaultValue={value[i]}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n === value[i]) return;
                const next = [...value] as Curve;
                next[i] = n;
                void onChange(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
