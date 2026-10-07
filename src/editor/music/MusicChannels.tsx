import React from 'react';
import { removeMusicTrack } from './music-model.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
export function MusicChannels({
  doc,
  m,
  edit,
  busy,
  draft,
  track,
  addTrack,
  selectTrack,
}: Pick<
  MusicPanelProps,
  'doc' | 'm' | 'edit' | 'busy' | 'draft' | 'track' | 'addTrack' | 'selectTrack'
>) {
  return (
    <div className="music-channels">
      <div className="music-channels-heading">
        <span>CHANNELS</span>
        <button aria-label="添加乐器通道" disabled={busy} onClick={() => addTrack('pluck')}>
          ＋ 通道
        </button>
      </div>
      <div className="music-channel-list">
        {doc.tracks.map((t, index) => (
          <div
            key={t.id}
            className={`music-channel ${draft.trackId === t.id ? 'selected' : ''}`}
            style={{ '--channel-color': colors[index % colors.length] } as React.CSSProperties}
          >
            <button className="music-channel-name" onClick={() => selectTrack(t.id)}>
              <i />
              <span>
                {t.name}
                <small>
                  {t.instrument.type === 'drum'
                    ? t.instrument.voice
                    : t.instrument.type === 'synth'
                      ? t.instrument.wave
                      : 'sample'}
                </small>
              </span>
            </button>
            <button
              title="Mute"
              aria-label={t.name + ' 静音'}
              aria-pressed={t.muted}
              disabled={busy}
              className={t.muted ? 'active' : ''}
              onClick={() =>
                edit((d) => {
                  d.tracks.find((ch) => ch.id === t.id)!.muted = !t.muted;
                })
              }
            >
              M
            </button>
            <button
              title="Solo"
              aria-label={t.name + ' 独奏'}
              aria-pressed={t.solo}
              disabled={busy}
              className={t.solo ? 'active' : ''}
              onClick={() =>
                edit((d) => {
                  d.tracks.find((ch) => ch.id === t.id)!.solo = !t.solo;
                })
              }
            >
              S
            </button>
          </div>
        ))}
      </div>
      {track && (
        <div className="music-channel-actions">
          <input
            aria-label="音乐通道名称"
            value={track.name}
            disabled={busy}
            onChange={(e) =>
              edit((d) => {
                d.tracks.find((t) => t.id === track.id)!.name = e.target.value;
              })
            }
          />
          <button
            disabled={busy}
            onClick={() => {
              m.edit(removeMusicTrack(doc, track.id));
              selectTrack(doc.tracks.find((t) => t.id !== track.id)?.id ?? '');
            }}
          >
            删除通道
          </button>
        </div>
      )}
    </div>
  );
}
