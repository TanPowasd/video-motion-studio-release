import React, { useEffect, useState } from 'react';
import type { Snapshot } from '../core/model.js';
import type { SoundDocument } from '../core/sound-schema.js';
import { noteNumber } from '../core/sound.js';
import { soundDocumentSchema } from '../core/sound-schema.js';
const displayedNote = (value: number | string) => {
  try {
    return noteNumber(value);
  } catch {
    return 0;
  }
};
export function SoundEditor({
  assetId,
  snapshot,
  run,
  onClose,
  onSaved,
}: {
  assetId: string;
  snapshot: Snapshot;
  run: (method: string, params?: unknown) => Promise<any>;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [text, setText] = useState(''),
    [presets, setPresets] = useState<Record<string, any>>({}),
    [trackId, setTrackId] = useState(''),
    [eventId, setEventId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [audio, setAudio] = useState<any>(),
    [start, setStart] = useState(0),
    [tab, setTab] = useState<'notes' | 'json'>('notes');
  const [id] = useState(() => (assetId === 'new' ? crypto.randomUUID() : assetId));
  useEffect(() => {
    let live = true;
    (async () => {
      const library = await run('soundLibrary');
      if (!library || !live) return;
      setPresets(library.presets);
      let document;
      if (assetId === 'new')
        document = {
          kind: 'sound',
          version: 1,
          id,
          name: '新乐曲',
          unit: 'beats',
          duration: 16,
          tail: 1,
          tempo: [{ beat: 0, bpm: 120 }],
          tracks: [
            {
              id: 'lead',
              name: '旋律',
              instrument: library.presets.pluck,
              events: [60, 64, 67, 72].map((note, i) => ({
                id: `note-${i}`,
                at: i * 2,
                duration: 1.5,
                note,
                velocity: 0.7,
              })),
            },
          ],
          master: { effects: [{ type: 'limiter', ceilingDb: -1 }] },
        };
      else {
        const info = await run('soundInspect', { assetId, includeDocument: true });
        document = info?.document;
      }
      if (live && document) {
        setText(JSON.stringify(document, null, 2));
        setTrackId(document.tracks[0]?.id ?? '');
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);
  let document: SoundDocument | undefined;
  try {
    document = soundDocumentSchema.parse(JSON.parse(text));
  } catch {}
  const track = document?.tracks.find((t) => t.id === trackId),
    event = track?.events.find((e) => e.id === eventId);
  const update = (change: (doc: SoundDocument) => void) => {
    if (!document) return;
    const doc = structuredClone(document);
    change(doc);
    setText(JSON.stringify(doc, null, 2));
    setAudio(undefined);
    setError('');
  };
  const task = async (save: boolean) => {
    setBusy(true);
    setError('');
    try {
      const plan = await run('soundPlan', {
        revision: snapshot.revision,
        items: [{ assetId: id, document: JSON.parse(text) }],
      });
      if (!plan) throw new Error('声音工程校验未通过，请检查提示');
      if (save) {
        const checked = await run('projectPreflight', plan.candidate);
        if (!checked?.valid)
          throw new Error(
            checked?.diagnostics?.map((d: any) => d.message).join('\n') ?? '预检未通过',
          );
        const result = await run('projectApply', plan.apply);
        if (!result?.applied) throw new Error('保存未完成');
        onSaved(id);
        onClose();
      } else {
        const result = await run('soundPreview', {
          planId: plan.plan.planId,
          assetId: id,
          startSample: Math.round(start * 48000),
          sampleCount: 48000 * 10,
          inline: true,
        });
        if (!result) throw new Error('试听未完成');
        setAudio(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        className="sound-editor"
        role="dialog"
        aria-label="声音制作"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>声音制作</strong>
            <small>音符编曲 · 合成乐器 · 采样与混音</small>
          </div>
          <button aria-label="关闭声音制作" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="sound-toolbar">
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
            音符与轨道
          </button>
          <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
            工程 JSON
          </button>
          <span />
          <label>
            试听起点 / 秒
            <input
              type="number"
              min="0"
              step=".1"
              value={start}
              onChange={(e) => setStart(Math.max(0, Number(e.target.value)))}
            />
          </label>
          <button disabled={busy || !document} onClick={() => task(false)}>
            {busy ? '处理中…' : '试听草稿'}
          </button>
          <button className="primary" disabled={busy || !document} onClick={() => task(true)}>
            保存到素材库
          </button>
        </div>
        {tab === 'json' ? (
          <textarea
            className="sound-json"
            aria-label="声音工程 JSON"
            value={text}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setAudio(undefined);
            }}
          />
        ) : (
          <div className="sound-compose">
            <aside>
              <label>
                乐曲名称
                <input
                  value={document?.name ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    update((d) => {
                      d.name = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                时长 / {document?.unit === 'seconds' ? '秒' : '拍'}
                <input
                  type="number"
                  step=".25"
                  value={document?.duration ?? 16}
                  disabled={busy}
                  onChange={(e) =>
                    update((d) => {
                      d.duration = Number(e.target.value);
                    })
                  }
                />
              </label>
              <div className="section-title">
                轨道
                <button
                  disabled={busy}
                  onClick={() => {
                    const key = crypto.randomUUID();
                    update((d) => {
                      d.tracks.push({
                        id: key,
                        name: '新轨道',
                        instrument: presets.pluck,
                        events: [],
                        gainDb: 0,
                        pan: 0,
                        muted: false,
                        solo: false,
                        busId: 'master',
                        sends: [],
                        effects: [],
                        automation: [],
                      });
                    });
                    setTrackId(key);
                  }}
                >
                  ＋
                </button>
              </div>
              {document?.tracks.map((t) => (
                <button
                  key={t.id}
                  className={trackId === t.id ? 'active' : ''}
                  onClick={() => {
                    setTrackId(t.id);
                    setEventId('');
                  }}
                >
                  {t.name ?? t.id} · {t.events.length} 音符
                </button>
              ))}
              {track && (
                <>
                  <label>
                    乐器
                    <select
                      aria-label="声音乐器"
                      disabled={busy}
                      value={
                        Object.keys(presets).find(
                          (k) => JSON.stringify(presets[k]) === JSON.stringify(track.instrument),
                        ) ?? 'custom'
                      }
                      onChange={(e) =>
                        update((d) => {
                          const t = d.tracks.find((t) => t.id === trackId)!;
                          if (e.target.value === 'sample') {
                            const asset = snapshot.project.assets.find(
                              (a) => a.type === 'audio' && !a.soundSource,
                            );
                            if (asset)
                              t.instrument = {
                                type: 'sample',
                                assetId: asset.id,
                                sourceIn: 0,
                                sourceDuration: Math.min(
                                  1800,
                                  Number(asset.metadata.duration) || 1,
                                ),
                                rootNote: 60,
                                loop: false,
                                attack: 0.005,
                                release: 0.05,
                                gain: 1,
                              };
                          } else if (presets[e.target.value])
                            t.instrument = presets[e.target.value];
                        })
                      }
                    >
                      <option value="custom">当前配置</option>
                      {Object.keys(presets).map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                      {snapshot.project.assets.some(
                        (a) => a.type === 'audio' && !a.soundSource,
                      ) && <option value="sample">音频采样</option>}
                    </select>
                  </label>
                  <label>
                    轨道音量 / dB
                    <input
                      type="number"
                      value={track.gainDb ?? 0}
                      disabled={busy}
                      min="-80"
                      max="24"
                      onChange={(e) =>
                        update((d) => {
                          d.tracks.find((t) => t.id === trackId)!.gainDb = Number(e.target.value);
                        })
                      }
                    />
                  </label>
                  <label>
                    声像
                    <input
                      type="number"
                      min="-1"
                      max="1"
                      step=".1"
                      disabled={busy}
                      value={track.pan ?? 0}
                      onChange={(e) =>
                        update((d) => {
                          d.tracks.find((t) => t.id === trackId)!.pan = Number(e.target.value);
                        })
                      }
                    />
                  </label>
                </>
              )}
              <p className="hint">效果、总线、速度变化与自动化在工程 JSON 中编辑。</p>
            </aside>
            <main>
              <p className="hint">
                点击音符调整。横轴为{document?.unit === 'seconds' ? '秒' : '拍'}；显示当前轨道前 512
                个音符。
              </p>
              <svg className="sound-roll" viewBox="0 0 800 260" aria-label="音符编曲图">
                {Array.from({ length: 13 }, (_, i) => (
                  <g key={i}>
                    <line x1="40" x2="800" y1={i * 20} y2={i * 20} />
                    <text x="3" y={i * 20 + 14}>
                      {84 - i * 4}
                    </text>
                  </g>
                ))}
                {Array.from({ length: 17 }, (_, i) => (
                  <g key={i}>
                    <line x1={40 + i * 47.5} x2={40 + i * 47.5} y1="0" y2="260" />
                    <text x={42 + i * 47.5} y="256">
                      {Number((((document?.duration ?? 16) * i) / 16).toFixed(1))}
                    </text>
                  </g>
                ))}
                {track?.events.slice(0, 512).map((e) => (
                  <rect
                    key={e.id}
                    className={eventId === e.id ? 'selected' : ''}
                    x={40 + (e.at / (document?.duration ?? 16)) * 760}
                    y={Math.max(0, Math.min(240, (84 - displayedNote(e.note)) * 5))}
                    width={Math.max(4, (e.duration / (document?.duration ?? 16)) * 760)}
                    height="9"
                    onClick={() => setEventId(e.id)}
                  >
                    <title>
                      {e.id} · {e.note}
                    </title>
                  </rect>
                ))}
              </svg>
              <div className="sound-note-controls">
                <button
                  disabled={busy || !track}
                  onClick={() => {
                    const key = crypto.randomUUID();
                    update((d) => {
                      d.tracks
                        .find((t) => t.id === trackId)!
                        .events.push({
                          id: key,
                          at: 0,
                          duration: Math.min(1, d.duration),
                          note: 60,
                          velocity: 0.7,
                          pan: 0,
                        });
                    });
                    setEventId(key);
                  }}
                >
                  添加音符
                </button>
                {event && (
                  <>
                    {(['at', 'duration', 'note', 'velocity'] as const).map((key) => (
                      <label key={key}>
                        {{ at: '起点', duration: '长度', note: 'MIDI 音高', velocity: '力度' }[key]}
                        <input
                          type="number"
                          step={key === 'note' ? 1 : 0.1}
                          disabled={busy}
                          value={key === 'note' ? displayedNote(event.note) : event[key]}
                          onChange={(e) =>
                            update((d) => {
                              d.tracks
                                .find((t) => t.id === trackId)!
                                .events.find((e) => e.id === eventId)![key] = Number(
                                e.target.value,
                              );
                            })
                          }
                        />
                      </label>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() => {
                        update((d) => {
                          const t = d.tracks.find((t) => t.id === trackId)!;
                          t.events = t.events.filter((e) => e.id !== eventId);
                        });
                        setEventId('');
                      }}
                    >
                      删除音符
                    </button>
                  </>
                )}
              </div>
              <p className="hint">
                鼓组每种鼓声可用独立轨道；采样的窗口、根音和循环配置保存在 JSON 中。
              </p>
            </main>
          </div>
        )}
        <footer>
          {error && <p className="sound-error">{error}</p>}
          {audio && (
            <>
              <audio controls autoPlay src={`data:audio/wav;base64,${audio.data}`} />
              <span>
                Peak {audio.fullMix.peak.toFixed(3)} · RMS {audio.metrics.rms.toFixed(3)} ·{' '}
                {audio.duration.toFixed(2)}s
              </span>
              {audio.warnings.map((w: string) => (
                <p key={w} className="sound-error">
                  {w}
                </p>
              ))}
            </>
          )}
          <small>试听草稿后保存；主时间轴通过素材库拖入。当前修改在保存前保留为草稿。</small>
        </footer>
      </section>
    </div>
  );
}
