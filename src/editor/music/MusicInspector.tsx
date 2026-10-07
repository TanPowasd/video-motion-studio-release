import React, { useState } from 'react';
import {
  soundInstrumentSchema,
  soundEffectSchema,
  type SoundDocument,
  type SoundEffect,
  type SoundInstrument,
} from '../../core/sound-schema.js';
import { soundPresets } from '../../core/sound.js';
import type { Asset } from '../../core/model.js';
import { noteLabel } from './music-model.js';
import { PluginPicker } from './PluginPicker.js';

export function MusicNumber({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="music-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.currentTarget.value === '') return;
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n))
            onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
      />
    </label>
  );
}
const controls: Record<string, { label: string; min: number; max: number; step: number }> = {
  gain: { label: '输出增益', min: 0, max: 2, step: 0.01 },
  attack: { label: 'Attack / 秒', min: 0, max: 10, step: 0.001 },
  decay: { label: 'Decay / 秒', min: 0, max: 10, step: 0.01 },
  sustain: { label: 'Sustain', min: 0, max: 1, step: 0.01 },
  release: { label: 'Release / 秒', min: 0, max: 10, step: 0.01 },
  fmRatio: { label: 'FM 频率比', min: 0, max: 20, step: 0.01 },
  fmIndex: { label: 'FM 深度', min: 0, max: 20, step: 0.01 },
  detune: { label: 'Detune / cents', min: -100, max: 100, step: 1 },
  sourceIn: { label: '采样起点 / 秒', min: 0, max: 1800, step: 0.01 },
  sourceDuration: { label: '采样窗口 / 秒', min: 0.001, max: 1800, step: 0.01 },
};
const fxLabels: Record<SoundEffect['type'], string> = {
  gain: '增益',
  filter: 'EQ / 滤波',
  distortion: '失真',
  delay: '延迟',
  chorus: '合唱',
  reverb: '混响',
  compressor: '压缩',
  limiter: '限幅',
  plugin: 'VST3 / AU',
};
const fxLimits: Record<string, [number, number, number]> = {
  db: [-80, 24, 0.5],
  frequency: [10, 22000, 10],
  q: [0.1, 20, 0.1],
  drive: [1, 30, 0.1],
  mix: [0, 1, 0.01],
  seconds: [0.001, 8, 0.01],
  rightSeconds: [0.001, 3, 0.01],
  feedback: [0, 0.9, 0.01],
  rate: [0.01, 10, 0.01],
  depth: [0, 0.015, 0.001],
  delay: [0.016, 0.05, 0.001],
  damping: [0, 0.95, 0.01],
  thresholdDb: [-60, 0, 0.5],
  ratio: [1, 30, 0.1],
  kneeDb: [0, 24, 0.5],
  attack: [0.0001, 0.5, 0.001],
  release: [0.001, 3, 0.01],
  makeupDb: [0, 24, 0.5],
  ceilingDb: [-24, 0, 0.1],
};
export function EffectChain({
  effects,
  onChange,
}: {
  effects: SoundEffect[];
  onChange: (fx: SoundEffect[]) => void;
}) {
  const [error, setError] = useState('');
  const patch = (index: number, value: Record<string, unknown>) => {
    const parsed = soundEffectSchema.safeParse({ ...effects[index], ...value });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError('');
    onChange(effects.map((e, i) => (i === index ? parsed.data : e)));
  };
  return (
    <div className="music-fx">
      <select
        aria-label="添加音乐效果"
        value=""
        disabled={effects.length >= 12}
        onChange={(e) => {
          if (!e.target.value) return;
          const fx = soundEffectSchema.parse(
            e.target.value === 'gain'
              ? { type: 'gain', db: 0 }
              : e.target.value === 'filter'
                ? { type: 'filter', mode: 'lowpass', frequency: 8000 }
                : { type: e.target.value },
          );
          onChange([...effects, fx]);
        }}
      >
        <option value="">＋ 添加效果</option>
        {Object.entries(fxLabels)
          .filter(([id]) => id !== 'plugin')
          .map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
      </select>
      {!effects.length && <p className="music-muted">效果按从上到下的顺序处理。</p>}
      {effects.length < 12 && (
        <PluginPicker
          kind="effect"
          onChange={(config) => onChange([...effects, { ...config, type: 'plugin' }])}
        />
      )}
      {effects.map((fx, index) => (
        <details key={index} open className="music-fx-card">
          <summary>
            <b>{String(index + 1).padStart(2, '0')}</b> {fxLabels[fx.type]}
            <span />
            <button
              aria-label={`上移效果 ${index + 1}`}
              disabled={!index}
              onClick={(e) => {
                e.preventDefault();
                const next = [...effects];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              ↑
            </button>
            <button
              aria-label={`删除效果 ${index + 1}`}
              onClick={(e) => {
                e.preventDefault();
                onChange(effects.filter((_, i) => i !== index));
              }}
            >
              ×
            </button>
          </summary>
          {fx.type === 'filter' && (
            <label className="music-field">
              类型
              <select value={fx.mode} onChange={(e) => patch(index, { mode: e.target.value })}>
                {['lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
          {fx.type === 'plugin' && (
            <PluginPicker
              config={fx}
              kind="effect"
              onChange={(config) =>
                onChange(effects.map((e, i) => (i === index ? { ...config, type: 'plugin' } : e)))
              }
            />
          )}
          {Object.entries(fx)
            .filter(([, v]) => typeof v === 'number')
            .map(([key, value]) => {
              let [min, max, step] = fxLimits[key] ?? [0, 100, 0.01];
              if (fx.type === 'filter' && key === 'db') {
                min = -24;
                max = 24;
              }
              if (key === 'seconds') {
                min = fx.type === 'reverb' ? 0.1 : 0.001;
                max = fx.type === 'reverb' ? 8 : 3;
              }
              return (
                <MusicNumber
                  key={key}
                  label={key}
                  value={Number(value)}
                  min={min}
                  max={max}
                  step={step}
                  onChange={(n) => patch(index, { [key]: n })}
                />
              );
            })}
        </details>
      ))}
      {error && (
        <p role="alert" className="music-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function MusicInspector({
  doc,
  owner,
  assets,
  edit,
}: {
  doc: SoundDocument;
  owner: string;
  assets: Asset[];
  edit: (doc: SoundDocument) => void;
}) {
  const [tab, setTab] = useState('instrument');
  const track = doc.tracks.find((t) => t.id === owner),
    bus = doc.buses.find((b) => b.id === owner),
    config = track ?? bus ?? doc.master;
  const patch = (change: Record<string, unknown>) => {
    if (track)
      edit({
        ...doc,
        tracks: doc.tracks.map((t) => (t.id === track.id ? { ...t, ...change } : t)),
      });
    else if (bus)
      edit({ ...doc, buses: doc.buses.map((b) => (b.id === bus.id ? { ...b, ...change } : b)) });
    else edit({ ...doc, master: { ...doc.master, ...change } });
  };
  const instrument = track?.instrument;
  const patchInstrument = (change: Record<string, unknown>) => {
    const parsed = soundInstrumentSchema.safeParse({ ...instrument, ...change });
    if (parsed.success) patch({ instrument: parsed.data });
  };
  const samples = assets.filter(
    (a) => (a.type === 'audio' || a.type === 'video') && !a.soundSource,
  );
  const setPreset = (id: string) => {
    let value: SoundInstrument | undefined = soundPresets[id];
    if (id === 'sample' && samples[0])
      value = soundInstrumentSchema.parse({
        type: 'sample',
        assetId: samples[0].id,
        sourceDuration: Math.min(1800, Number(samples[0].metadata.duration) || 1),
      });
    if (value) patch({ instrument: structuredClone(value) });
  };
  return (
    <aside className="music-inspector">
      <div className="music-panel-heading">
        <span className="music-eyebrow">CHANNEL SETTINGS</span>
        <h3>{track?.name ?? bus?.name ?? 'Master · 主输出'}</h3>
      </div>
      <div className="music-tabs">
        {[
          ['instrument', '乐器'],
          ['effects', '效果'],
          ['routing', '路由'],
          ['automation', '自动化'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="music-inspector-body">
        {tab === 'instrument' &&
          (instrument ? (
            <>
              <label className="music-field">
                乐器预设
                <select aria-label="乐器预设" value="" onChange={(e) => setPreset(e.target.value)}>
                  <option value="">
                    {instrument.type === 'synth'
                      ? instrument.wave + ' / Synth'
                      : instrument.type === 'drum'
                        ? instrument.voice
                        : instrument.type === 'plugin'
                          ? (instrument.name ?? 'VST3 / AU')
                          : 'Sampler'}
                  </option>
                  {Object.keys(soundPresets).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                  {samples.length > 0 && <option value="sample">音频采样 / Sampler</option>}
                </select>
              </label>
              <PluginPicker
                kind="instrument"
                config={instrument.type === 'plugin' ? instrument : undefined}
                onChange={(config) =>
                  patch({ instrument: { ...config, type: 'plugin', release: 0 } })
                }
              />
              <div className="music-instrument-visual">
                {instrument.type === 'drum'
                  ? '◉'
                  : instrument.type === 'sample'
                    ? '▁▃▆▂▇▄▂▅▁'
                    : '∿'}
                <small>{instrument.type.toUpperCase()}</small>
              </div>
              {instrument.type === 'synth' && (
                <label className="music-field">
                  波形
                  <select
                    value={instrument.wave}
                    onChange={(e) => patchInstrument({ wave: e.target.value })}
                  >
                    {['sine', 'triangle', 'saw', 'square', 'noise'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
              )}
              {instrument.type === 'drum' && (
                <label className="music-field">
                  鼓声
                  <select
                    value={instrument.voice}
                    onChange={(e) => patchInstrument({ voice: e.target.value })}
                  >
                    {['kick', 'snare', 'hat', 'tom', 'clap'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
              )}
              {instrument.type === 'sample' && (
                <>
                  <label className="music-field">
                    采样素材
                    <select
                      value={instrument.assetId}
                      onChange={(e) => patchInstrument({ assetId: e.target.value })}
                    >
                      {samples.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <MusicNumber
                    label={'根音 / ' + noteLabel(instrument.rootNote)}
                    value={typeof instrument.rootNote === 'number' ? instrument.rootNote : 60}
                    min={0}
                    max={127}
                    step={1}
                    onChange={(n) => patchInstrument({ rootNote: n })}
                  />
                  <label className="music-toggle">
                    <input
                      type="checkbox"
                      checked={instrument.loop}
                      onChange={(e) => patchInstrument({ loop: e.target.checked })}
                    />
                    循环采样
                  </label>
                </>
              )}
              {Object.entries(instrument)
                .filter(([key, v]) => key in controls && typeof v === 'number')
                .map(([key, value]) => (
                  <MusicNumber
                    key={key}
                    {...controls[key]}
                    value={Number(value)}
                    onChange={(n) => patchInstrument({ [key]: n })}
                  />
                ))}
            </>
          ) : (
            <p className="music-muted">选择乐器通道编辑音色。总线和主输出在效果与路由中处理。</p>
          ))}
        {tab === 'effects' && (
          <EffectChain effects={config.effects} onChange={(effects) => patch({ effects })} />
        )}
        {tab === 'routing' && (
          <>
            <MusicNumber
              label="增益 / dB"
              value={config.gainDb}
              min={-80}
              max={24}
              step={0.5}
              onChange={(gainDb) => patch({ gainDb })}
            />
            {(track || bus) && (
              <>
                <MusicNumber
                  label="声像 / Pan"
                  value={(track ?? bus)!.pan}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(pan) => patch({ pan })}
                />
                <label className="music-field">
                  输出至
                  <select
                    aria-label="输出总线"
                    value={(track ?? bus)!.busId}
                    onChange={(e) => patch({ busId: e.target.value })}
                  >
                    <option value="master">Master</option>
                    {doc.buses
                      .filter((b) => b.id !== owner)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </label>
                <h4>Post-fader Sends</h4>
                {(track ?? bus)!.sends.map((send, index) => (
                  <div className="music-send" key={index}>
                    <select
                      value={send.busId}
                      onChange={(e) =>
                        patch({
                          sends: (track ?? bus)!.sends.map((s, i) =>
                            i === index ? { ...s, busId: e.target.value } : s,
                          ),
                        })
                      }
                    >
                      <option value="master">Master</option>
                      {doc.buses
                        .filter((b) => b.id !== owner)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                    <MusicNumber
                      label="dB"
                      value={send.db}
                      min={-80}
                      max={12}
                      step={0.5}
                      onChange={(db) =>
                        patch({
                          sends: (track ?? bus)!.sends.map((s, i) =>
                            i === index ? { ...s, db } : s,
                          ),
                        })
                      }
                    />
                    <button
                      aria-label="移除发送"
                      onClick={() =>
                        patch({ sends: (track ?? bus)!.sends.filter((_, i) => i !== index) })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  disabled={(track ?? bus)!.sends.length >= 8}
                  onClick={() => {
                    const target = doc.buses.find(
                      (b) => b.id !== owner && !(track ?? bus)!.sends.some((s) => s.busId === b.id),
                    );
                    if (target)
                      patch({ sends: [...(track ?? bus)!.sends, { busId: target.id, db: -12 }] });
                  }}
                >
                  ＋ 总线发送
                </button>
              </>
            )}
          </>
        )}
        {tab === 'automation' &&
          (track ? (
            <>
              <p className="music-muted">自动化使用整曲时间，按时间顺序线性插值。</p>
              {(['gainDb', 'pan'] as const).map((property) => {
                const lane = track.automation.find((a) => a.property === property);
                return (
                  <section key={property} className="music-automation">
                    <h4>{property === 'pan' ? '声像 / Pan' : '音量 / dB'}</h4>
                    {lane?.keys.map((key, i) => (
                      <div key={i} className="music-auto-key">
                        <MusicNumber
                          label="时间"
                          value={key.at}
                          min={0}
                          max={doc.duration}
                          step={0.25}
                          onChange={(at) =>
                            patch({
                              automation: track.automation.map((a) =>
                                a.property === property
                                  ? {
                                      ...a,
                                      keys: a.keys
                                        .map((k, j) => (j === i ? { ...k, at } : k))
                                        .sort((a, b) => a.at - b.at),
                                    }
                                  : a,
                              ),
                            })
                          }
                        />
                        <MusicNumber
                          label="值"
                          value={key.value}
                          min={property === 'pan' ? -1 : -80}
                          max={property === 'pan' ? 1 : 24}
                          step={0.1}
                          onChange={(value) =>
                            patch({
                              automation: track.automation.map((a) =>
                                a.property === property
                                  ? {
                                      ...a,
                                      keys: a.keys.map((k, j) => (j === i ? { ...k, value } : k)),
                                    }
                                  : a,
                              ),
                            })
                          }
                        />
                        <button
                          aria-label="删除自动化点"
                          onClick={() =>
                            patch({
                              automation: track.automation.flatMap((a) =>
                                a.property !== property
                                  ? [a]
                                  : a.keys.length > 1
                                    ? [{ ...a, keys: a.keys.filter((_, j) => j !== i) }]
                                    : [],
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      disabled={(lane?.keys.length ?? 0) >= 2000}
                      onClick={() => {
                        const at = lane
                          ? Math.min(doc.duration, (lane.keys.at(-1)?.at ?? 0) + 1)
                          : 0;
                        if (lane?.keys.some((k) => k.at === at)) return;
                        const value = { at, value: property === 'pan' ? track.pan : track.gainDb };
                        patch({
                          automation: lane
                            ? track.automation.map((a) =>
                                a.property === property ? { ...a, keys: [...a.keys, value] } : a,
                              )
                            : [...track.automation, { property, keys: [value] }],
                        });
                      }}
                    >
                      ＋ 控制点
                    </button>
                  </section>
                );
              })}
            </>
          ) : (
            <p className="music-muted">自动化曲线属于乐器通道。选择通道后编辑音量与声像。</p>
          ))}
      </div>
    </aside>
  );
}
