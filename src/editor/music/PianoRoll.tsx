import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SoundEvent } from '../../core/sound-schema.js';
import { noteNumber } from '../../core/sound.js';
import { moveMusicNotes, noteLabel } from './music-model.js';

type Gesture = {
  pointer: number;
  x: number;
  y: number;
  events: SoundEvent[];
  ids: string[];
  kind: 'move' | 'resize' | 'draw';
  id: string;
};
export function PianoRoll({
  events,
  selected,
  length,
  grid,
  zoom,
  tool,
  disabled,
  playhead,
  onSelect,
  onEdit,
  onSeek,
}: {
  events: SoundEvent[];
  selected: string[];
  length: number;
  grid: number;
  zoom: number;
  tool: 'select' | 'draw';
  disabled: boolean;
  playhead?: number;
  onSelect: (ids: string[]) => void;
  onEdit: (events: SoundEvent[]) => void;
  onSeek: (at: number) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    gesture = useRef<Gesture | undefined>(undefined),
    [preview, setPreview] = useState<SoundEvent[]>();
  const [window, setWindow] = useState({ x: 0, width: 1200, y: 0, height: 600 });
  const px = zoom,
    row = 18,
    left = 58,
    top = 26,
    height = 128 * row + top;
  useEffect(() => {
    if (scroll.current) {
      scroll.current.scrollTop = (127 - 78) * row;
      const el = scroll.current;
      setWindow({
        x: el.scrollLeft,
        y: el.scrollTop,
        width: el.clientWidth,
        height: el.clientHeight,
      });
    }
  }, []);
  const visible = useMemo(
    () =>
      (preview ?? events).filter(
        (e) =>
          (e.at + e.duration) * px >= window.x - left &&
          e.at * px <= window.x + window.width &&
          (127 - noteNumber(e.note)) * row >= window.y - top - row &&
          (127 - noteNumber(e.note)) * row <= window.y + window.height,
      ),
    [preview, events, window, px],
  );
  const rows = Array.from({ length: 128 }, (_, i) => i).filter(
    (i) => i * row + top >= window.y - row && i * row + top <= window.y + window.height,
  );
  const stride = Math.max(grid, 20 / px),
    tickStep = 2 ** Math.ceil(Math.log2(stride));
  const ticks = Array.from(
    { length: Math.ceil(window.width / px / tickStep) + 3 },
    (_, i) => Math.max(0, Math.floor((window.x - left) / px / tickStep)) * tickStep + i * tickStep,
  ).filter((v) => v <= length);
  const snap = (at: number) => Math.round(at / grid) * grid;
  const point = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      at: Math.max(0, Math.min(length - grid, snap((e.clientX - box.left - left) / px))),
      note: Math.max(0, Math.min(127, 127 - Math.floor((e.clientY - box.top - top) / row))),
    };
  };
  return (
    <div
      className="music-roll"
      ref={scroll}
      onScroll={(e) => {
        const el = e.currentTarget;
        setWindow({
          x: el.scrollLeft,
          y: el.scrollTop,
          width: el.clientWidth,
          height: el.clientHeight,
        });
      }}
    >
      <svg
        className="music-roll-svg"
        width={Math.max(window.width, length * px + left)}
        height={height}
        aria-label="钢琴卷帘"
        role="application"
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled) return;
          const id = (e.target as Element).closest('[data-note]')?.getAttribute('data-note');
          if (id) onEdit(events.filter((n) => n.id !== id));
        }}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          const target = e.target as Element,
            id = target.closest('[data-note]')?.getAttribute('data-note'),
            p = point(e);
          if (target.closest('[data-ruler]')) {
            onSeek(p.at);
            return;
          }
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (id) {
            let ids = selected.includes(id) ? selected : [id];
            if (e.ctrlKey || e.metaKey) {
              ids = selected.includes(id) ? selected.filter((n) => n !== id) : [...selected, id];
              onSelect(ids);
              if (!ids.includes(id)) return;
            } else onSelect(ids);
            gesture.current = {
              pointer: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              events,
              ids,
              id,
              kind: target.getAttribute('data-resize') ? 'resize' : 'move',
            };
          } else if (
            tool === 'draw' &&
            e.clientX - e.currentTarget.getBoundingClientRect().left >= left
          ) {
            const id = crypto.randomUUID(),
              note: SoundEvent = {
                id,
                at: p.at,
                duration: Math.min(grid, length - p.at),
                note: p.note,
                velocity: 0.8,
                pan: 0,
              };
            gesture.current = {
              pointer: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              events: [...events, note],
              ids: [id],
              id,
              kind: 'draw',
            };
            setPreview([...events, note]);
            onSelect([id]);
          } else onSelect([]);
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || e.pointerId !== g.pointer) return;
          const delta = snap((e.clientX - g.x) / px);
          if (g.kind === 'move')
            setPreview(
              moveMusicNotes(g.events, g.ids, delta, Math.round((g.y - e.clientY) / row), length),
            );
          else
            setPreview(
              g.events.map((n) =>
                n.id !== g.id
                  ? n
                  : {
                      ...n,
                      duration: Math.max(
                        Math.min(grid, length - n.at),
                        Math.min(length - n.at, snap(n.duration + delta)),
                      ),
                    },
              ),
            );
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          if (!g || g.pointer !== e.pointerId) return;
          if (preview) onEdit(preview);
          else if (g.kind === 'draw') onEdit(g.events);
          gesture.current = undefined;
          setPreview(undefined);
        }}
        onPointerCancel={() => {
          gesture.current = undefined;
          setPreview(undefined);
        }}
      >
        {rows.map((i) => {
          const note = 127 - i,
            black = [1, 3, 6, 8, 10].includes(note % 12);
          return (
            <g key={i}>
              <rect
                x={left}
                y={top + i * row}
                width={length * px}
                height={row}
                fill={black ? '#151d2a' : '#1b2432'}
              />
              <rect
                x={window.x}
                y={top + i * row}
                width={left}
                height={row - 1}
                fill={black ? '#192331' : '#d3dae3'}
                pointerEvents="none"
              />
              <text x={window.x + 8} y={top + i * row + 12} fill={black ? '#8393a9' : '#344050'}>
                {note % 12 === 0 ? noteLabel(note) : black ? '' : noteLabel(note).slice(0, -1)}
              </text>
              <line
                x1={left}
                x2={length * px + left}
                y1={top + i * row}
                y2={top + i * row}
                className={note % 12 === 0 ? 'octave' : ''}
              />
            </g>
          );
        })}
        {ticks.map((at) => (
          <line
            key={at}
            x1={left + at * px}
            x2={left + at * px}
            y1={top}
            y2={height}
            className={Number.isInteger(at) && at % 4 === 0 ? 'bar-line' : ''}
          />
        ))}
        {visible.map((note) => (
          <g
            key={note.id}
            data-note={note.id}
            className={selected.includes(note.id) ? 'selected' : ''}
          >
            <rect
              className="music-note"
              x={left + note.at * px}
              y={top + (127 - noteNumber(note.note)) * row + 1}
              width={Math.max(3, note.duration * px - 1)}
              height={row - 2}
              rx={3}
              opacity={0.45 + note.velocity * 0.55}
            />
            <rect
              data-resize="true"
              x={left + (note.at + note.duration) * px - 7}
              y={top + (127 - noteNumber(note.note)) * row + 1}
              width={7}
              height={row - 2}
              className="note-resize"
            />
            {note.duration * px > 32 && (
              <text
                x={left + note.at * px + 5}
                y={top + (127 - noteNumber(note.note)) * row + 12}
                pointerEvents="none"
                className="note-label"
              >
                {noteLabel(note.note)}
              </text>
            )}
            <title>
              {noteLabel(note.note)} · {note.at.toFixed(2)} · 力度 {Math.round(note.velocity * 127)}
            </title>
          </g>
        ))}
        {playhead !== undefined && (
          <line
            x1={left + playhead * px}
            x2={left + playhead * px}
            y1={top}
            y2={height}
            className="music-playhead"
            pointerEvents="none"
          />
        )}
        <rect
          data-ruler="true"
          x={window.x}
          y={window.y}
          width={window.width}
          height={top}
          fill="#111925"
        />
        {ticks.map((at) => (
          <text
            data-ruler="true"
            key={at}
            x={left + at * px + 5}
            y={window.y + 17}
            className="roll-time"
          >
            {at}
          </text>
        ))}
        <text x={window.x + 9} y={window.y + 17} className="roll-time">
          PITCH
        </text>
      </svg>
    </div>
  );
}
