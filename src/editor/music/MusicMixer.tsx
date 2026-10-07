import React from 'react';
import { soundBusSchema } from '../../core/sound-schema.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
export function MusicMixer({
  doc,
  m,
  edit,
  busy,
  owner,
  setOwner,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'edit' | 'busy' | 'owner' | 'setOwner'>) {
  return (
    <div className="music-mixer">
      <div className="music-mixer-strips">
        {[
          ...doc.tracks.map((t, i) => ({
            id: t.id,
            name: t.name,
            gain: t.gainDb,
            pan: t.pan,
            color: colors[i % colors.length],
            kind: 'track',
          })),
          ...doc.buses.map((b) => ({
            id: b.id,
            name: b.name,
            gain: b.gainDb,
            pan: b.pan,
            color: '#7ebbc9',
            kind: 'bus',
          })),
          {
            id: 'master',
            name: 'Master',
            gain: doc.master.gainDb,
            pan: 0,
            color: '#f2aa62',
            kind: 'master',
          },
        ].map((channel, index) => (
          <div
            key={channel.id}
            className={`music-mixer-strip ${owner === channel.id ? 'selected' : ''}`}
            style={{ '--channel-color': channel.color } as React.CSSProperties}
            onClick={() => setOwner(channel.id)}
          >
            <small>{channel.kind === 'master' ? 'M' : String(index + 1).padStart(2, '0')}</small>
            <strong>{channel.name}</strong>
            <span className="music-strip-type">{channel.kind}</span>
            <div className="music-fader-row">
              <div className="music-meter">
                <i
                  style={{
                    height:
                      channel.kind === 'master' && m.audio
                        ? `${Math.min(100, m.audio.peak * 100)}%`
                        : '0%',
                  }}
                />
              </div>
              <input
                aria-label={channel.name + ' 混音音量'}
                type="range"
                min={-80}
                max={24}
                step={0.5}
                value={channel.gain}
                disabled={busy}
                onChange={(e) =>
                  edit((d) => {
                    const gainDb = Number(e.target.value);
                    if (channel.kind === 'master') d.master.gainDb = gainDb;
                    else if (channel.kind === 'bus')
                      d.buses.find((b) => b.id === channel.id)!.gainDb = gainDb;
                    else d.tracks.find((t) => t.id === channel.id)!.gainDb = gainDb;
                  })
                }
              />
            </div>
            <output>{channel.gain.toFixed(1)} dB</output>
            {channel.kind !== 'master' && (
              <input
                aria-label={channel.name + ' 声像'}
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={channel.pan}
                disabled={busy}
                onChange={(e) =>
                  edit((d) => {
                    (channel.kind === 'bus'
                      ? d.buses.find((b) => b.id === channel.id)!
                      : d.tracks.find((t) => t.id === channel.id)!
                    ).pan = Number(e.target.value);
                  })
                }
              />
            )}
          </div>
        ))}
        <button
          className="music-add-bus"
          disabled={busy || doc.buses.length >= 16}
          onClick={() => {
            const id = crypto.randomUUID();
            edit((d) =>
              d.buses.push(soundBusSchema.parse({ id, name: 'Bus ' + (d.buses.length + 1) })),
            );
            setOwner(id);
          }}
        >
          ＋ Bus
        </button>
      </div>
      <p className="music-muted">
        主输出电平显示最近一次试听的峰值。选择通道，在右侧编辑效果、路由和发送。
      </p>
    </div>
  );
}
