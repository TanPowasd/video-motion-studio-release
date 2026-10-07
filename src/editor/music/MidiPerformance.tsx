import React, { useEffect, useRef, useState } from 'react';
import type { SoundDocument, SoundTrack } from '../../core/sound-schema.js';
import { tempoClock } from '../../core/sound.js';
import { musicEvents, setMusicEvents } from './music-model.js';
import { MidiRecorder, parseMidi, type MidiMessage } from './midi.js';
import { LiveAudio } from './live-audio.js';
const keyNotes: Record<string, number> = {
  a: 60,
  w: 61,
  s: 62,
  e: 63,
  d: 64,
  f: 65,
  t: 66,
  g: 67,
  y: 68,
  h: 69,
  u: 70,
  j: 71,
  k: 72,
};
export function MidiPerformance({
  doc,
  track,
  patternId,
  grid,
  disabled,
  onEdit,
  onStatus,
}: {
  doc: SoundDocument;
  track?: SoundTrack;
  patternId: string;
  grid: number;
  disabled: boolean;
  onEdit: (doc: SoundDocument) => void;
  onStatus: (error: string) => void;
}) {
  const live = useRef(new LiveAudio()),
    access = useRef<MIDIAccess | undefined>(undefined),
    record = useRef<MidiRecorder | undefined>(undefined),
    recordContext = useRef<{ doc: SoundDocument; trackId: string; patternId: string } | undefined>(
      undefined,
    ),
    pressed = useRef(new Set<number>());
  const [enabled, setEnabled] = useState(false),
    [recording, setRecording] = useState(false),
    [inputs, setInputs] = useState<Array<{ id: string; name: string }>>([]),
    [device, setDevice] = useState(''),
    [error, setError] = useState(''),
    [stats, setStats] = useState({ underruns: 0, bufferedMs: 0 }),
    [octave, setOctave] = useState(0);
  const [count, setCount] = useState(0);
  const current = useRef({ doc, track, patternId, grid, onEdit, onStatus });
  current.current = { doc, track, patternId, grid, onEdit, onStatus };
  const stopRecord = () => {
    const r = record.current,
      c = recordContext.current;
    if (r && c) {
      const notes = r.stop(performance.now());
      const latest = current.current.doc;
      current.current.onEdit(
        setMusicEvents(latest, c.trackId, c.patternId, [
          ...musicEvents(latest, c.trackId, c.patternId),
          ...notes,
        ]),
      );
      setCount(notes.length);
    }
    record.current = undefined;
    recordContext.current = undefined;
    setRecording(false);
  };
  const panic = () => {
    live.current.panic();
    pressed.current.clear();
    stopRecord();
  };
  const feed = (message: MidiMessage) => {
    live.current.send(message);
    try {
      record.current?.feed(message);
    } catch (e) {
      setError((e as Error).message);
      stopRecord();
    }
    if ((message.status & 240) === 144 && message.b) pressed.current.add(message.a);
    else if ((message.status & 240) === 128 || ((message.status & 240) === 144 && !message.b))
      pressed.current.delete(message.a);
  };
  const toggle = async () => {
    setError('');
    if (enabled) {
      panic();
      await live.current.close();
      setEnabled(false);
      return;
    }
    if (!track) return;
    try {
      live.current.onStatus = setStats;
      live.current.onError = (e) => {
        setError(e.message);
        setEnabled(false);
        stopRecord();
      };
      await live.current.start(track.instrument, 10 ** (track.gainDb / 20));
      setEnabled(true);
    } catch (e) {
      await live.current.close();
      setError((e as Error).message);
    }
  };
  const connect = async () => {
    try {
      const nav = navigator;
      if (!nav.requestMIDIAccess)
        throw new Error('当前浏览器没有 Web MIDI，请使用桌面版或支持 Web MIDI 的浏览器');
      const result = await nav.requestMIDIAccess({ sysex: false });
      access.current = result;
      const update = () =>
        setInputs(
          [...result.inputs.values()]
            .filter((i) => i.state === 'connected')
            .map((i) => ({ id: i.id, name: i.name ?? 'MIDI Input' })),
        );
      result.onstatechange = update;
      update();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const input = access.current?.inputs.get(device);
    if (!input) return;
    void input.open();
    input.onmidimessage = (e) => {
      const message = e.data ? parseMidi(e.data, e.timeStamp) : undefined;
      if (message) feed(message);
    };
    return () => {
      input.onmidimessage = null;
      void input.close();
      panic();
    };
  }, [device, enabled, inputs]);
  useEffect(() => {
    const blur = () => panic(),
      keyDown = (e: KeyboardEvent) => {
        if (
          !enabled ||
          disabled ||
          e.repeat ||
          e.ctrlKey ||
          e.metaKey ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)
        )
          return;
        const key = e.key.toLowerCase();
        if (keyNotes[key] !== undefined) {
          e.preventDefault();
          feed({
            status: 144,
            a: keyNotes[key] + octave * 12,
            b: 100,
            timestamp: performance.now(),
          });
        }
      },
      keyUp = (e: KeyboardEvent) => {
        if (!enabled) return;
        const note = keyNotes[e.key.toLowerCase()];
        if (note !== undefined && pressed.current.has(note + octave * 12))
          feed({ status: 128, a: note + octave * 12, b: 0, timestamp: performance.now() });
      };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [enabled, octave, disabled]);
  useEffect(() => {
    if (enabled) {
      panic();
      void live.current.close();
      setEnabled(false);
    }
  }, [track?.id, doc.id, patternId]);
  useEffect(() => {
    if (disabled && enabled) {
      panic();
      void live.current.close();
      setEnabled(false);
    }
  }, [disabled]);
  useEffect(
    () => () => {
      live.current.panic();
      void live.current.close();
      if (access.current) {
        access.current.onstatechange = null;
        for (const input of access.current.inputs.values()) input.onmidimessage = null;
      }
    },
    [],
  );
  const beginRecord = () => {
    if (recording) {
      stopRecord();
      return;
    }
    if (!track || !enabled) return;
    const now = performance.now(),
      tempo = tempoClock(doc.tempo),
      pattern = doc.patterns?.find((p) => p.id === patternId),
      limit = pattern?.length ?? doc.duration;
    record.current = new MidiRecorder(
      (ms) =>
        doc.unit === 'beats'
          ? tempo.secondsBeat(Math.max(0, ms - now) / 1000)
          : Math.max(0, ms - now) / 1000,
      limit,
      grid,
    );
    recordContext.current = { doc, trackId: track.id, patternId };
    setRecording(true);
    setCount(0);
  };
  return (
    <section className="music-midi">
      <div className="music-midi-controls">
        <button
          aria-label="开启实时演奏"
          disabled={disabled || !track}
          className={enabled ? 'active' : ''}
          onClick={toggle}
        >
          {enabled ? '关闭实时演奏' : '开启实时演奏'}
        </button>
        <button disabled={disabled} onClick={connect}>
          连接 MIDI 键盘
        </button>
        <select
          aria-label="MIDI 输入设备"
          value={device}
          onChange={(e) => setDevice(e.target.value)}
        >
          <option value="">电脑键盘 / 屏幕键盘</option>
          {inputs.map((i) => (
            <option value={i.id} key={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <button
          className={recording ? 'recording' : ''}
          disabled={!enabled || disabled}
          onClick={beginRecord}
        >
          {recording ? '■ 停止录入' : '● 录入音符'}
        </button>
        <button onClick={panic}>Panic · 停止所有音符</button>
        <button
          onClick={() => {
            panic();
            setOctave(Math.max(-3, octave - 1));
          }}
        >
          − Oct
        </button>
        <button
          onClick={() => {
            panic();
            setOctave(Math.min(3, octave + 1));
          }}
        >
          ＋ Oct
        </button>
        {track?.instrument.type === 'plugin' && enabled && (
          <>
            <button onClick={() => void live.current.editor().catch((e) => setError(e.message))}>
              插件界面
            </button>
            <button
              disabled={recording}
              onClick={async () => {
                try {
                  const state = await live.current.state();
                  const ins = track.instrument;
                  if (ins.type === 'plugin') {
                    onEdit({
                      ...doc,
                      tracks: doc.tracks.map((t) =>
                        t.id === track.id
                          ? {
                              ...t,
                              instrument: {
                                ...ins,
                                state: state.state,
                                controllerState: state.controllerState,
                                parameters: state.parameters,
                              },
                            }
                          : t,
                      ),
                    });
                    await live.current.close();
                    setEnabled(false);
                  }
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              捕获插件音色
            </button>
          </>
        )}
      </div>
      <div className="music-keyboard">
        {Array.from({ length: 25 }, (_, i) => 48 + i + octave * 12).map((note) => (
          <button
            key={note}
            disabled={!enabled}
            aria-label={`演奏音符 ${note}`}
            className={[1, 3, 6, 8, 10].includes(note % 12) ? 'black' : 'white'}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              feed({ status: 144, a: note, b: 100, timestamp: performance.now() });
            }}
            onPointerUp={() => feed({ status: 128, a: note, b: 0, timestamp: performance.now() })}
            onPointerCancel={() =>
              feed({ status: 128, a: note, b: 0, timestamp: performance.now() })
            }
          >
            {note % 12 === 0 ? `C${Math.floor(note / 12) - 1}` : ''}
          </button>
        ))}
      </div>
      <p className="music-muted">
        {recording
          ? '正在录入当前 Pattern，从零拍开始；结束后成为一次草稿编辑。'
          : `A W S E D F T G Y H U J K 演奏 · ${count} 个录入音符`}
        {track?.instrument.type === 'plugin'
          ? ` · 缓冲 ${stats.bufferedMs.toFixed(0)} ms · underruns ${stats.underruns}`
          : ' · Web Audio 实时监听音色；最终音频由项目声音引擎生成。'}
      </p>
      {error && (
        <p role="alert" className="music-error">
          {error}
        </p>
      )}
    </section>
  );
}
