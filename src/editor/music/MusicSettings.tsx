import React from 'react';
import { MusicNumber } from './MusicInspector.js';
import type { MusicPanelProps } from './music-panel-types.js';
export function MusicSettings({
  doc,
  m,
  edit,
  busy,
  pattern,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'edit' | 'busy' | 'pattern'>) {
  return (
    <div className="music-settings">
      <h3>音乐工程</h3>
      <p className="music-muted">现有乐曲的时间单位保持不变。速度变化点以四分音符拍数计。</p>
      <MusicNumber
        label={'时长 / ' + (doc.unit === 'beats' ? '拍' : '秒')}
        value={doc.duration}
        min={0.001}
        max={14400}
        step={1}
        onChange={(n) =>
          edit((d) => {
            d.duration = n;
          })
        }
      />
      <MusicNumber
        label="尾音 / 秒"
        value={doc.tail}
        min={0}
        max={20}
        step={0.1}
        onChange={(n) =>
          edit((d) => {
            d.tail = n;
          })
        }
      />
      <MusicNumber
        label="随机种子"
        value={doc.seed}
        min={0}
        max={0xffffffff}
        step={1}
        onChange={(n) =>
          edit((d) => {
            d.seed = Math.round(n);
          })
        }
      />
      <h3>Tempo map</h3>
      {doc.tempo.map((tempo, index) => (
        <div className="music-tempo-row" key={index}>
          <MusicNumber
            label="拍数"
            value={tempo.beat}
            min={0}
            max={14400}
            step={0.25}
            onChange={(beat) => {
              if (index)
                edit((d) => {
                  d.tempo[index].beat = beat;
                  d.tempo.sort((a, b) => a.beat - b.beat);
                });
            }}
          />
          <MusicNumber
            label="BPM"
            value={tempo.bpm}
            min={20}
            max={400}
            step={1}
            onChange={(bpm) =>
              edit((d) => {
                d.tempo[index].bpm = bpm;
              })
            }
          />
          <button
            disabled={!index || busy}
            onClick={() =>
              edit((d) => {
                d.tempo.splice(index, 1);
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        disabled={busy || doc.tempo.length >= 1000}
        onClick={() =>
          edit((d) => {
            d.tempo.push({ beat: d.tempo.at(-1)!.beat + 4, bpm: d.tempo.at(-1)!.bpm });
          })
        }
      >
        ＋ 速度变化点
      </button>
      {pattern && (
        <>
          <h3>选定 Pattern</h3>
          <label className="music-field">
            名称
            <input
              value={pattern.name}
              onChange={(e) =>
                edit((d) => {
                  d.patterns!.find((p) => p.id === pattern.id)!.name = e.target.value;
                })
              }
            />
          </label>
          <button
            disabled={busy}
            onClick={() => {
              edit((d) => {
                d.patterns = d.patterns?.filter((p) => p.id !== pattern.id);
                d.arrangement = d.arrangement?.filter((c) => c.patternId !== pattern.id);
              });
              m.dispatch({ type: 'select', patternId: '' });
            }}
          >
            删除 Pattern 及其编排片段
          </button>
        </>
      )}
    </div>
  );
}
