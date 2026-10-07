import React, { useState } from 'react';
import { audioMixSchema } from '../../core/audio-mix-schema.js';
import { soundEffectSchema } from '../../core/sound-schema.js';
import type { StudioContext } from './types.js';
import { CandidateActions, NumberControl, PanelIntro, SelectControl, Toggle } from './Controls.js';
export default function MixPanel({ context }: { context: StudioContext }) {
  const sequence = context.snapshot.sequences.find(
      (s) => s.id === context.snapshot.project.activeSequence,
    )!,
    [mix, setMix] = useState(() => audioMixSchema.parse(sequence.mix ?? {})),
    [base] = useState(context.snapshot.revision),
    [selected, setSelected] = useState('master'),
    [audio, setAudio] = useState<any>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const tracks = sequence.tracks.filter((t) => t.type === 'audio'),
    config: any =
      selected === 'master'
        ? mix.master
        : selected.startsWith('bus:')
          ? mix.buses.find((b) => b.id === selected.slice(4))!
          : (mix.tracks[selected] ??
            audioMixSchema.parse({ tracks: { [selected]: {} } }).tracks[selected]);
  const patch = (value: any) =>
    setMix((m) =>
      selected === 'master'
        ? { ...m, master: { ...m.master, ...value } }
        : selected.startsWith('bus:')
          ? {
              ...m,
              buses: m.buses.map((b) => (b.id === selected.slice(4) ? { ...b, ...value } : b)),
            }
          : { ...m, tracks: { ...m.tracks, [selected]: { ...config, ...value } } },
    );
  const routes = [['master', '主输出'], ...mix.buses.map((b) => [b.id, b.name])] as [
    string,
    string,
  ][];
  return (
    <>
      <PanelIntro title="轨道与总线混音">
        调整音量、声像、路由与效果，配音可作为侧链来源。所有配置与时间轴试听、导出共用。
      </PanelIntro>
      <div className="mixer-layout">
        <div className="mixer-strips">
          {[
            ...tracks.map((t) => ({
              id: t.id,
              name: t.name,
              config: mix.tracks[t.id] ?? { gainDb: 0, pan: 0 },
            })),
            ...mix.buses.map((b) => ({ id: 'bus:' + b.id, name: b.name, config: b })),
            { id: 'master', name: '主输出', config: mix.master },
          ].map((strip) => (
            <button
              key={strip.id}
              className={`mixer-strip ${selected === strip.id ? 'selected' : ''}`}
              onClick={() => setSelected(strip.id)}
            >
              <strong>{strip.name}</strong>
              <div className="mixer-fader">
                <i style={{ bottom: `${((strip.config.gainDb + 80) / 104) * 100}%` }} />
              </div>
              <span>{strip.config.gainDb.toFixed(1)} dB</span>
              <small>Pan {strip.config.pan.toFixed(2)}</small>
            </button>
          ))}
          <button
            className="mixer-add"
            disabled={mix.buses.length >= 16}
            onClick={() => {
              const id = 'bus-' + crypto.randomUUID().slice(0, 8);
              setMix((m) =>
                audioMixSchema.parse({ ...m, buses: [...m.buses, { id, name: '新总线' }] }),
              );
              setSelected('bus:' + id);
            }}
          >
            ＋ 总线
          </button>
        </div>
        <div className="mixer-properties">
          <h3>
            {selected === 'master'
              ? '主输出'
              : selected.startsWith('bus:')
                ? config.name
                : tracks.find((t) => t.id === selected)?.name}
          </h3>
          <NumberControl
            label="混音增益 dB"
            value={config.gainDb}
            min={-80}
            max={24}
            step={0.5}
            onChange={(gainDb) => patch({ gainDb })}
          />
          <NumberControl
            label="声像"
            value={config.pan}
            min={-1}
            max={1}
            step={0.05}
            onChange={(pan) => patch({ pan })}
          />
          {selected !== 'master' && (
            <SelectControl
              label="输出总线"
              value={config.busId}
              options={routes.filter(([id]) => id !== selected.slice(4))}
              onChange={(busId) => patch({ busId })}
            />
          )}
          {selected !== 'master' && !selected.startsWith('bus:') && (
            <Toggle label="轨道独奏" value={!!config.solo} onChange={(solo) => patch({ solo })} />
          )}
          <SelectControl
            label="侧链来源"
            value={config.ducking?.source.id ?? ''}
            options={[
              ['', '无侧链'],
              ...tracks
                .filter((t) => t.id !== selected)
                .map((t) => [t.id, t.name] as [string, string]),
            ]}
            onChange={(id) =>
              patch({
                ducking: id
                  ? {
                      source: { type: 'track', id },
                      thresholdDb: -24,
                      ratio: 4,
                      kneeDb: 6,
                      attack: 0.01,
                      release: 0.25,
                      maxReductionDb: 24,
                    }
                  : null,
              })
            }
          />
          {config.ducking && (
            <NumberControl
              label="侧链阈值 dB"
              value={config.ducking.thresholdDb}
              min={-60}
              max={0}
              onChange={(thresholdDb) => patch({ ducking: { ...config.ducking, thresholdDb } })}
            />
          )}
          <h3>效果链</h3>
          {selected !== 'master' && (
            <fieldset>
              <legend>发送</legend>
              {(config.sends ?? []).map((send: any, index: number) => (
                <div key={index}>
                  <SelectControl
                    label={`发送 ${index + 1} 总线`}
                    value={send.busId}
                    options={routes.filter(([id]) => id !== selected.slice(4))}
                    onChange={(busId) =>
                      patch({
                        sends: config.sends.map((s: any, i: number) =>
                          i === index ? { ...s, busId } : s,
                        ),
                      })
                    }
                  />
                  <NumberControl
                    label={`发送 ${index + 1} dB`}
                    value={send.db}
                    min={-80}
                    max={12}
                    onChange={(db) =>
                      patch({
                        sends: config.sends.map((s: any, i: number) =>
                          i === index ? { ...s, db } : s,
                        ),
                      })
                    }
                  />
                  <button
                    onClick={() =>
                      patch({ sends: config.sends.filter((_: any, i: number) => i !== index) })
                    }
                  >
                    移除发送
                  </button>
                </div>
              ))}
              <button
                disabled={(config.sends?.length ?? 0) >= 8}
                onClick={() =>
                  patch({ sends: [...(config.sends ?? []), { busId: 'master', db: -12 }] })
                }
              >
                ＋ 添加发送
              </button>
            </fieldset>
          )}
          <select
            aria-label="添加混音效果"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              try {
                const effect = soundEffectSchema.parse(
                  e.target.value === 'filter'
                    ? { type: 'filter', mode: 'peaking', frequency: 1000 }
                    : e.target.value === 'gain'
                      ? { type: 'gain', db: 0 }
                      : { type: e.target.value },
                );
                patch({ effects: [...config.effects, effect] });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <option value="">＋ 添加效果</option>
            {[
              'filter',
              'compressor',
              'limiter',
              'delay',
              'reverb',
              'chorus',
              'distortion',
              'gain',
            ].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          {config.effects.map((effect: any, index: number) => (
            <fieldset key={index}>
              <legend>
                {effect.type}{' '}
                <button
                  onClick={() =>
                    patch({ effects: config.effects.filter((_: any, i: number) => i !== index) })
                  }
                >
                  ×
                </button>
              </legend>
              {effect.type === 'filter' && (
                <SelectControl
                  label="EQ 类型"
                  value={effect.mode}
                  options={['lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf']}
                  onChange={(mode) =>
                    patch({
                      effects: config.effects.map((fx: any, i: number) =>
                        i === index ? { ...fx, mode } : fx,
                      ),
                    })
                  }
                />
              )}
              {Object.entries(effect)
                .filter(([, v]) => typeof v === 'number')
                .map(([key, value]) => (
                  <NumberControl
                    key={key}
                    label={`${effect.type} ${key}`}
                    value={Number(value)}
                    step={0.01}
                    onChange={(v) =>
                      patch({
                        effects: config.effects.map((fx: any, i: number) =>
                          i === index ? { ...fx, [key]: v } : fx,
                        ),
                      })
                    }
                  />
                ))}
            </fieldset>
          ))}
          {selected === 'master' && (
            <>
              <Toggle
                label="响度归一化"
                value={!!mix.master.normalization}
                onChange={(enabled) =>
                  patch({
                    normalization: enabled
                      ? { targetLufs: -16, targetLra: 11, truePeakDb: -1, mode: 'auto' }
                      : null,
                  })
                }
              />
              {mix.master.normalization && (
                <NumberControl
                  label="目标 LUFS"
                  value={mix.master.normalization.targetLufs}
                  min={-36}
                  max={-5}
                  onChange={(targetLufs) =>
                    patch({ normalization: { ...mix.master.normalization!, targetLufs } })
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
      <div className="studio-tools">
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const plan = await context.run('audioMixPlan', {
                revision: base,
                items: [{ sequenceId: sequence.id, mix }],
              });
              const result = await context.run('audioPreview', {
                planId: plan.candidate.planId,
                sequenceId: sequence.id,
                startSample: 0,
                sampleCount: Math.min(
                  240000,
                  Math.floor(
                    ((sequence.duration * context.snapshot.project.fps.den) /
                      context.snapshot.project.fps.num) *
                      48000,
                  ),
                ),
                inline: true,
              });
              setAudio(result);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          试听混音草稿
        </button>
        {audio?.data && <audio controls src={`data:audio/wav;base64,${audio.data}`} />}
      </div>
      {error && <p className="studio-error">{error}</p>}
      <CandidateActions
        context={context}
        changeKey={JSON.stringify(mix)}
        prepare={() =>
          context.run('audioMixPlan', { revision: base, items: [{ sequenceId: sequence.id, mix }] })
        }
      />
    </>
  );
}
