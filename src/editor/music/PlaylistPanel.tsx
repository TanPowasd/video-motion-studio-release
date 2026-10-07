import React, { useState, useRef } from 'react';
import { noteNumber } from '../../core/sound.js';
import { musicSeconds, musicTime } from './music-model.js';
import { MusicNumber } from './MusicInspector.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
export function PlaylistPanel({
  doc,
  m,
  edit,
  busy,
  grid,
  setTab,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'edit' | 'busy' | 'grid' | 'setTab'>) {
  const [clipSelection, setClipSelection] = useState(''),
    [clipPreview, setClipPreview] = useState<{ id: string; at: number }>();
  const clipGesture = useRef<{ id: string; x: number; at: number; pointer: number } | undefined>(
    undefined,
  );
  return (
    <>
      <div className="music-editor-toolbar">
        <strong>Pattern 编排</strong>
        <span>从左侧拖入，或点击轨道放置 · 拖动移动 · 双击进入</span>
        <MusicNumber
          label="时长"
          value={doc.duration}
          min={0.25}
          max={14400}
          step={1}
          onChange={(n) =>
            edit((d) => {
              d.duration = n;
            })
          }
        />
      </div>
      <div className="music-playlist-scroll">
        <div className="music-playlist" style={{ width: Math.max(760, doc.duration * 36 + 120) }}>
          <div
            className="music-playlist-ruler"
            style={{ paddingLeft: 120 }}
            onPointerDown={(e) => {
              const at = Math.max(
                0,
                Math.min(
                  doc.duration,
                  (e.clientX - e.currentTarget.getBoundingClientRect().left - 120) / 36,
                ),
              );
              m.seek(musicSeconds(doc, at));
            }}
          >
            {Array.from({ length: Math.min(1000, Math.ceil(doc.duration / 4)) }, (_, i) => (
              <span style={{ left: 120 + i * 144 }} key={i}>
                {doc.unit === 'beats' ? `${i + 1}` : `${i * 4}s`}
              </span>
            ))}
          </div>
          <i
            className="music-playlist-cursor"
            style={{ left: 120 + musicTime(doc, m.start) * 36 }}
          />
          {(doc.patterns ?? []).map((p, index) => (
            <div
              key={p.id}
              className="music-playlist-lane"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (busy) return;
                const id = e.dataTransfer.getData('application/x-vmotion-pattern');
                const dropped = doc.patterns?.find((p) => p.id === id);
                if (!dropped) return;
                const at = Math.max(
                  0,
                  Math.round(
                    (e.clientX - e.currentTarget.getBoundingClientRect().left - 120) / 36 / grid,
                  ) * grid,
                );
                if (at + dropped.length > doc.duration) return;
                edit((d) => {
                  d.arrangement = [
                    ...(d.arrangement ?? []),
                    { id: crypto.randomUUID(), patternId: id, at, repeats: 1 },
                  ];
                });
              }}
              onPointerDown={(e) => {
                if (busy || e.button !== 0 || (e.target as Element).closest('button')) return;
                const at = Math.max(
                  0,
                  Math.round(
                    (e.clientX - e.currentTarget.getBoundingClientRect().left - 120) / 36 / grid,
                  ) * grid,
                );
                if (at + p.length <= doc.duration)
                  edit((d) => {
                    d.arrangement = [
                      ...(d.arrangement ?? []),
                      { id: crypto.randomUUID(), patternId: p.id, at, repeats: 1 },
                    ];
                  });
              }}
            >
              <button
                className="music-lane-label"
                onClick={() => {
                  m.dispatch({ type: 'select', patternId: p.id });
                  setTab('piano');
                }}
              >
                <i style={{ background: colors[index % colors.length] }} />
                {p.name}
              </button>
              {doc.arrangement
                ?.filter((c) => c.patternId === p.id)
                .map((c) => (
                  <button
                    key={c.id}
                    data-clip={c.id}
                    className={`music-pattern-clip ${clipSelection === c.id ? 'selected' : ''}`}
                    style={
                      {
                        left: 120 + (clipPreview?.id === c.id ? clipPreview.at : c.at) * 36,
                        width: Math.max(16, p.length * c.repeats * 36 - 2),
                        '--pattern-color': colors[index % colors.length],
                      } as React.CSSProperties
                    }
                    onDoubleClick={() => {
                      m.dispatch({ type: 'select', patternId: p.id });
                      setTab('piano');
                    }}
                    onPointerDown={(e) => {
                      if (busy || e.button !== 0) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setClipSelection(c.id);
                      clipGesture.current = {
                        id: c.id,
                        x: e.clientX,
                        at: c.at,
                        pointer: e.pointerId,
                      };
                    }}
                    onPointerMove={(e) => {
                      const g = clipGesture.current;
                      if (!g || g.pointer !== e.pointerId) return;
                      setClipPreview({
                        id: c.id,
                        at: Math.max(
                          0,
                          Math.min(
                            doc.duration - p.length * c.repeats,
                            g.at + Math.round((e.clientX - g.x) / 36 / grid) * grid,
                          ),
                        ),
                      });
                    }}
                    onPointerUp={() => {
                      if (clipPreview)
                        edit((d) => {
                          d.arrangement = d.arrangement?.map((clip) =>
                            clip.id === c.id ? { ...clip, at: clipPreview.at } : clip,
                          );
                        });
                      clipGesture.current = undefined;
                      setClipPreview(undefined);
                    }}
                    onPointerCancel={() => {
                      clipGesture.current = undefined;
                      setClipPreview(undefined);
                    }}
                  >
                    <span>
                      {p.name}
                      {c.repeats > 1 ? ` × ${c.repeats}` : ''}
                    </span>
                    <div className="music-mini-notes">
                      {p.channels
                        .flatMap((ch) => ch.events)
                        .slice(0, 64)
                        .map((n, i) => (
                          <i
                            key={i}
                            style={{
                              left: `${((n.at / p.length) * 100) / c.repeats}%`,
                              top: `${4 + (84 - noteNumber(n.note)) * 0.6}px`,
                              width: `${Math.max(1, ((n.duration / p.length) * 100) / c.repeats)}%`,
                            }}
                          />
                        ))}
                    </div>
                  </button>
                ))}
            </div>
          ))}
          {!doc.patterns?.length && (
            <div className="music-empty">
              此乐曲使用整曲音符。前往钢琴卷帘编辑，或新建 Pattern 开始编排。
            </div>
          )}
          {doc.tracks.some((t) => t.events.length) && (
            <div
              className="music-direct-score"
              onClick={() => {
                m.dispatch({ type: 'select', patternId: '' });
                setTab('piano');
              }}
            >
              整曲直接音符 · {doc.tracks.reduce((sum, t) => sum + t.events.length, 0)} 个 · 点击编辑
            </div>
          )}
        </div>
      </div>
      <div className="music-selection-bar">
        {(() => {
          const c = doc.arrangement?.find((c) => c.id === clipSelection);
          return c ? (
            <>
              <span>编排片段</span>
              <MusicNumber
                label="起点"
                value={c.at}
                min={0}
                max={doc.duration}
                step={grid}
                onChange={(at) =>
                  edit((d) => {
                    d.arrangement = d.arrangement?.map((v) => (v.id === c.id ? { ...v, at } : v));
                  })
                }
              />
              <MusicNumber
                label="重复"
                value={c.repeats}
                min={1}
                max={1024}
                step={1}
                onChange={(repeats) =>
                  edit((d) => {
                    d.arrangement = d.arrangement?.map((v) =>
                      v.id === c.id ? { ...v, repeats: Math.round(repeats) } : v,
                    );
                  })
                }
              />
              <button
                onClick={() =>
                  edit((d) => {
                    d.arrangement = d.arrangement?.filter((v) => v.id !== c.id);
                  })
                }
              >
                删除片段
              </button>
            </>
          ) : (
            <span>重复使用同一 Pattern，编辑音符时所有实例一起更新。</span>
          );
        })()}
      </div>
    </>
  );
}
