import React from 'react';
import { soundTrackSchema } from '../../core/sound-schema.js';
import { noteNumber, soundPreset } from '../../core/sound.js';
import { musicEvents, setMusicEvents } from './music-model.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
export function ChannelRack({
  doc,
  m,
  edit,
  busy,
  draft,
  length,
  addTrack,
  selectTrack,
}: Pick<
  MusicPanelProps,
  'doc' | 'm' | 'edit' | 'busy' | 'draft' | 'length' | 'addTrack' | 'selectTrack'
>) {
  return (
    <div className="music-rack">
      <div className="music-rack-head">
        <strong>Channel rack</strong>
        <span>16 步 / 4 拍 · 每格切换音符</span>
        <button
          disabled={busy}
          onClick={() => {
            edit((d) => {
              for (const preset of ['kick', 'snare', 'hat'])
                if (
                  d.tracks.length < 64 &&
                  !d.tracks.some(
                    (t) => t.instrument.type === 'drum' && t.instrument.voice === preset,
                  )
                )
                  d.tracks.push(
                    soundTrackSchema.parse({
                      id: crypto.randomUUID(),
                      name: preset,
                      instrument: soundPreset(preset),
                    }),
                  );
            });
          }}
        >
          ＋ 鼓组
        </button>
      </div>
      {Array.from({ length: Math.ceil(Math.min(length, 64) / 4) }, (_, bar) => (
        <section key={bar}>
          <h4>
            {doc.unit === 'beats' ? '小节' : '区间'} {bar + 1}
          </h4>
          {doc.tracks.map((t, index) => {
            const notes = musicEvents(doc, t.id, draft.patternId);
            return (
              <div key={t.id} className="music-rack-row">
                <button
                  className={draft.trackId === t.id ? 'active' : ''}
                  onClick={() => selectTrack(t.id)}
                >
                  <i style={{ background: colors[index % colors.length] }} />
                  {t.name}
                </button>
                <div className="music-steps">
                  {Array.from({ length: 16 }, (_, step) => {
                    const at = bar * 4 + step * 0.25,
                      found = notes.find((n) => Math.abs(n.at - at) < 1e-6);
                    return (
                      <button
                        key={step}
                        disabled={busy || at >= length}
                        aria-label={`${t.name} 第 ${bar * 16 + step + 1} 步`}
                        aria-pressed={!!found}
                        className={`${step % 8 >= 4 ? 'alternate' : ''} ${found ? 'on' : ''}`}
                        style={
                          {
                            '--step-color': colors[index % colors.length],
                          } as React.CSSProperties
                        }
                        onClick={() =>
                          m.edit(
                            setMusicEvents(
                              doc,
                              t.id,
                              draft.patternId,
                              found
                                ? notes.filter((n) => n.id !== found.id)
                                : [
                                    ...notes,
                                    {
                                      id: crypto.randomUUID(),
                                      at,
                                      duration: Math.min(0.2, length - at),
                                      note:
                                        t.instrument.type === 'sample'
                                          ? noteNumber(t.instrument.rootNote)
                                          : 60,
                                      velocity: 0.8,
                                      pan: 0,
                                    },
                                  ],
                            ),
                          )
                        }
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {length > 64 && (
        <p className="music-muted">步进鼓机显示前 64 拍，完整范围在钢琴卷帘中编辑。</p>
      )}
      <div className="music-rack-add">
        {['pluck', 'bass', 'pad', 'bell', 'kick', 'snare', 'hat'].map((p) => (
          <button key={p} disabled={busy} onClick={() => addTrack(p)}>
            ＋ {p}
          </button>
        ))}
      </div>
    </div>
  );
}
