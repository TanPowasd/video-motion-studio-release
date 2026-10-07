import { MusicChannels } from './MusicChannels.js';
import { MusicSettings } from './MusicSettings.js';
import { MusicMixer } from './MusicMixer.js';
import { ChannelRack } from './ChannelRack.js';
import { PlaylistPanel } from './PlaylistPanel.js';
import { colors } from './music-panel-types.js';
import React, { useEffect, useRef, useState } from 'react';
import { compileSound, noteNumber, soundPreset } from '../../core/sound.js';
import {
  soundBusSchema,
  soundDocumentSchema,
  soundTrackSchema,
  type SoundDocument,
  type SoundEvent,
} from '../../core/sound-schema.js';
import { Icon } from '../Icons.js';
import { ProjectActions } from '../ProjectHome.js';
import { rpcTyped } from '../state/rpc-client.js';
import { PianoRoll } from './PianoRoll.js';
import { MusicInspector, MusicNumber } from './MusicInspector.js';
import {
  musicEvents,
  musicSeconds,
  musicTime,
  musicUrl,
  moveMusicNotes,
  noteLabel,
  removeMusicTrack,
  setMusicEvents,
} from './music-model.js';
import { useMusic } from './use-music.js';
import { MidiPerformance } from './MidiPerformance.js';
import '../studio-shell.css';
import './music.css';

export default function MusicWorkspace() {
  const m = useMusic(),
    { doc, draft, application } = m;
  const [tab, setTab] = useState('playlist'),
    [tool, setTool] = useState<'select' | 'draw'>('draw'),
    [grid, setGrid] = useState(0.25),
    [zoom, setZoom] = useState(80);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [owner, setOwner] = useState(''),
    [midiPath, setMidiPath] = useState(''),
    [showMidi, setShowMidi] = useState(false),
    [showPlace, setShowPlace] = useState(false);
  const [placeTrack, setPlaceTrack] = useState(''),
    [placeFrame, setPlaceFrame] = useState(0);
  const track = doc?.tracks.find((t) => t.id === draft.trackId),
    pattern = doc?.patterns?.find((p) => p.id === draft.patternId);
  const length = pattern?.length ?? doc?.duration ?? 16,
    events = doc ? musicEvents(doc, draft.trackId, draft.patternId) : [];
  const selected = events.filter((e) => draft.selected.includes(e.id)),
    busy = !!m.busy;
  const selectTrack = (trackId: string) => {
    m.dispatch({ type: 'select', trackId });
    setOwner(trackId);
  };
  const editEvents = (next: SoundEvent[]) => {
    if (doc) m.edit(setMusicEvents(doc, draft.trackId, draft.patternId, next));
  };
  const edit = (change: (d: SoundDocument) => void) => {
    if (!doc) return;
    const next = structuredClone(doc);
    change(next);
    m.edit(next);
  };
  let validation = '',
    duration = 0;
  if (doc)
    try {
      duration = compileSound(doc).duration;
    } catch (e) {
      validation = (e as Error).message;
    }
  useEffect(() => {
    setOwner(draft.trackId);
  }, [draft.trackId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) || busy)
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void m.save();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void m.history(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && tab === 'piano') {
        e.preventDefault();
        m.dispatch({ type: 'select', selected: events.map((n) => n.id) });
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        tab === 'piano' &&
        draft.selected.length
      ) {
        e.preventDefault();
        editEvents(events.filter((n) => !draft.selected.includes(n.id)));
        m.dispatch({ type: 'select', selected: [] });
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (m.audio) {
          if (m.audioRef.current?.paused) void m.audioRef.current.play();
          else m.audioRef.current?.pause();
        } else void m.audition();
      } else if (e.key === 'Escape') m.dispatch({ type: 'select', selected: [] });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const addTrack = (preset: string) => {
    if (!doc || doc.tracks.length >= 64) return;
    const id = crypto.randomUUID();
    edit((d) =>
      d.tracks.push(
        soundTrackSchema.parse({
          id,
          name: preset === 'pluck' ? '旋律 ' + (d.tracks.length + 1) : preset,
          instrument: soundPreset(preset),
        }),
      ),
    );
    selectTrack(id);
  };
  const addPattern = () => {
    if (!doc) return;
    const id = crypto.randomUUID();
    edit((d) => {
      d.patterns = [
        ...(d.patterns ?? []),
        {
          id,
          name: 'Pattern ' + String((d.patterns?.length ?? 0) + 1).padStart(2, '0'),
          length: 4,
          channels: [],
        },
      ];
    });
    m.dispatch({ type: 'select', patternId: id });
  };
  const duplicateNotes = () => {
    if (!selected.length) return;
    const min = Math.min(...selected.map((n) => n.at)),
      max = Math.max(...selected.map((n) => n.at + n.duration)),
      offset = max - min;
    if (max + offset > length) return;
    const copies = selected.map((n) => ({ ...n, id: crypto.randomUUID(), at: n.at + offset }));
    editEvents([...events, ...copies]);
    m.dispatch({ type: 'select', selected: copies.map((n) => n.id) });
  };
  const importAudio = () =>
    void m.task('导入采样', async () => {
      const input = window.vmotionDesktop
        ? await window.vmotionDesktop.pickAsset()
        : window.prompt('本地音频文件的完整路径');
      if (input) {
        await rpcTyped('import', { path: input, type: 'audio', copy: true });
        await m.refresh();
      }
    });
  if (!application || !doc)
    return (
      <div className="workspace-loading">
        {m.error || '正在打开音乐工作区…'}
        <a href="#/project">返回剪辑</a>
      </div>
    );
  const assets = application.snapshot.project.assets,
    activeSequence = application.snapshot.sequences.find(
      (s) => s.id === application.snapshot.project.activeSequence,
    )!;
  const clock = musicTime(doc, m.start);
  return (
    <div className="music-app">
      <header className="music-header">
        <a className="music-brand" href="#/project">
          <span>V</span>Vmotion
        </a>
        <ProjectActions
          onError={(error) =>
            void m.task('工程', async () => {
              throw new Error(error);
            })
          }
          onPause={() => m.audioRef.current?.pause()}
        />
        <span className="music-project">
          {application.snapshot.project.name}
          <small>音乐工作区</small>
        </span>
        <div className="music-spacer" />
        <span className="music-save-state">
          {busy ? m.busy + '…' : m.dirty ? '● 草稿未保存' : '● 已保存'}
        </span>
        <button
          title="Ctrl+Z"
          aria-label="撤销音乐编辑"
          disabled={busy || !(draft.past.length || (!m.dirty && application.canUndo))}
          onClick={() => m.history()}
        >
          <Icon name="undo" />
        </button>
        <button
          aria-label="重做音乐编辑"
          disabled={busy || !(draft.future.length || (!m.dirty && application.canRedo))}
          onClick={() => m.history(true)}
        >
          <Icon name="redo" />
        </button>
        <button disabled={busy || !!validation} onClick={m.save} className="music-primary">
          保存到素材库
        </button>
        <a className="music-button" href="#/project">
          返回视频剪辑 <Icon name="film" />
        </a>
      </header>
      <nav className="music-transport">
        <div className="music-section-mark">
          <Icon name="music" /> MUSIC STUDIO
        </div>
        <button
          aria-label="播放或暂停音乐"
          className="music-play"
          disabled={busy || !!validation}
          onClick={() => {
            if (m.audio) {
              if (m.audioRef.current?.paused) void m.audioRef.current.play();
              else m.audioRef.current?.pause();
            } else void m.audition();
          }}
        >
          <Icon name={m.playing ? 'pause' : 'play'} />
        </button>
        <button
          aria-label="停止音乐"
          onClick={() => {
            m.audioRef.current?.pause();
            if (m.audioRef.current) m.audioRef.current.currentTime = 0;
            m.setStart(0);
          }}
        >
          ■
        </button>
        <div className="music-clock">
          {Math.floor(m.start / 60)
            .toString()
            .padStart(2, '0')}
          :{(m.start % 60).toFixed(2).padStart(5, '0')}
          <small>{doc.unit === 'beats' ? `${clock.toFixed(2)} BEATS` : 'SECONDS'}</small>
        </div>
        <label className="music-bpm">
          BPM
          <input
            aria-label="音乐 BPM"
            type="number"
            min={20}
            max={400}
            value={doc.tempo[0].bpm}
            disabled={busy}
            onChange={(e) =>
              edit((d) => {
                d.tempo[0].bpm = Math.max(20, Math.min(400, Number(e.target.value) || 120));
              })
            }
          />
        </label>
        <label className="music-signature">
          <select
            aria-label="拍号"
            value={doc.timeSignature.join('/')}
            disabled={busy}
            onChange={(e) =>
              edit((d) => {
                const [a, b] = e.target.value.split('/').map(Number);
                d.timeSignature = [a, b] as SoundDocument['timeSignature'];
              })
            }
          >
            {['4/4', '3/4', '6/8', '7/8', '2/4'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="music-spacer" />
        <button disabled={busy || !!validation} onClick={() => m.audition()}>
          试听草稿 · 10 秒
        </button>
        <button disabled={busy || !!validation} onClick={() => m.audition(true)}>
          整曲试听
        </button>
        <button disabled={busy || !!validation} onClick={m.exportWav}>
          导出 WAV
        </button>
        <button disabled={busy || !!validation} onClick={m.exportMidi}>
          MIDI ↓
        </button>
        <button disabled={busy} onClick={() => setShowPlace(!showPlace)}>
          加入视频轨道
        </button>
        <button
          className={performanceOpen ? 'active' : ''}
          onClick={() => setPerformanceOpen(!performanceOpen)}
        >
          MIDI 演奏
        </button>
      </nav>
      <div className="music-body">
        <aside className="music-browser">
          <div className="music-panel-heading">
            <span className="music-eyebrow">BROWSER</span>
            <h3>乐曲与素材</h3>
          </div>
          <button
            className="music-new"
            disabled={busy}
            onClick={() => {
              if (location.hash !== musicUrl('new')) location.hash = musicUrl('new');
              else {
                location.hash = musicUrl();
              }
            }}
          >
            ＋ 新建乐曲
          </button>
          <div className="music-browser-scroll">
            <h4>
              PROJECT SCORES <span>{assets.filter((a) => a.soundSource).length}</span>
            </h4>
            {assets
              .filter((a) => a.soundSource)
              .map((a) => (
                <a
                  key={a.id}
                  className={`music-resource ${doc.id === a.id ? 'active' : ''}`}
                  href={musicUrl(a.id)}
                >
                  <Icon name="music" />
                  <span>
                    {a.name}
                    <small>{Number(a.metadata.duration || 0).toFixed(1)} 秒 · 可编辑</small>
                  </span>
                </a>
              ))}
            <h4>
              PATTERNS{' '}
              <button
                aria-label="新建 Pattern"
                disabled={busy || (doc.patterns?.length ?? 0) >= 128}
                onClick={addPattern}
              >
                ＋
              </button>
            </h4>
            <button
              className={`music-resource ${!draft.patternId ? 'active' : ''}`}
              onClick={() => m.dispatch({ type: 'select', patternId: '' })}
            >
              <Icon name="layers" />
              <span>
                整曲音符<small>直接音符 / MIDI 导入</small>
              </span>
            </button>
            {doc.patterns?.map((p, i) => (
              <button
                key={p.id}
                draggable
                className={`music-resource ${p.id === draft.patternId ? 'active' : ''}`}
                onDragStart={(e) => e.dataTransfer.setData('application/x-vmotion-pattern', p.id)}
                onClick={() => m.dispatch({ type: 'select', patternId: p.id })}
              >
                <i style={{ background: colors[i % colors.length] }} />
                <span>
                  {p.name}
                  <small>
                    {p.length} {doc.unit === 'beats' ? '拍' : '秒'} · 拖到 Playlist
                  </small>
                </span>
              </button>
            ))}
            <h4>
              SAMPLES{' '}
              <button aria-label="导入音乐采样" disabled={busy} onClick={importAudio}>
                ＋
              </button>
            </h4>
            {assets
              .filter((a) => (a.type === 'audio' || a.type === 'video') && !a.soundSource)
              .map((a) => (
                <div className="music-resource" key={a.id}>
                  <Icon name="volume" />
                  <span>
                    {a.name}
                    <small>{Number(a.metadata.duration || 0).toFixed(1)} 秒</small>
                  </span>
                </div>
              ))}
            <button disabled={busy} onClick={() => setShowMidi(!showMidi)}>
              导入 MIDI…
            </button>
          </div>
          <div className="music-browser-footer">
            48 kHz · Stereo
            <br />
            本地合成与采样引擎
          </div>
        </aside>
        <main className="music-main">
          <div className="music-title-row">
            <input
              aria-label="乐曲名称"
              value={doc.name}
              disabled={busy}
              onChange={(e) =>
                edit((d) => {
                  d.name = e.target.value;
                })
              }
            />
            <span>
              {doc.tracks.length} CHANNELS · {duration.toFixed(1)}s
            </span>
          </div>
          <div className="music-tabs music-main-tabs">
            {[
              ['playlist', 'Playlist · 编排'],
              ['piano', 'Piano roll · 钢琴卷帘'],
              ['rack', 'Channel rack · 步进鼓机'],
              ['mixer', 'Mixer · 混音'],
              ['settings', '工程设置'],
            ].map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {showMidi && (
            <form
              className="music-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (midiPath) void m.importMidi(midiPath);
              }}
            >
              <input
                aria-label="MIDI 文件路径"
                placeholder="本地 .mid 文件完整路径"
                value={midiPath}
                onChange={(e) => setMidiPath(e.target.value)}
              />
              <button disabled={busy || !midiPath}>导入为新乐曲</button>
              <button type="button" onClick={() => setShowMidi(false)}>
                ×
              </button>
            </form>
          )}
          {showPlace && (
            <div className="music-inline-form">
              <select
                aria-label="视频音乐轨道"
                value={placeTrack}
                onChange={(e) => setPlaceTrack(e.target.value)}
              >
                <option value="">新建音乐轨道</option>
                {activeSequence.tracks
                  .filter((t) => t.type === 'audio' && !t.locked)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <MusicNumber
                label="起始帧"
                min={0}
                max={activeSequence.duration - 1}
                step={1}
                value={placeFrame}
                onChange={setPlaceFrame}
              />
              <button
                disabled={busy || !!validation}
                onClick={() => m.insert(placeTrack, Math.round(placeFrame))}
              >
                保存并加入轨道
              </button>
              <button onClick={() => setShowPlace(false)}>×</button>
            </div>
          )}
          {m.conflicted && (
            <div className="music-alert">
              源文件已由其他编辑修改，当前草稿保留。复制 JSON 合并后重新载入。
              <button disabled={busy} onClick={m.reload}>
                重新载入源文件
              </button>
            </div>
          )}
          {tab === 'playlist' && (
            <PlaylistPanel doc={doc} m={m} edit={edit} busy={busy} grid={grid} setTab={setTab} />
          )}
          {(tab === 'piano' || tab === 'rack') && (
            <>
              <div className="music-editor-toolbar">
                <select
                  aria-label="编辑 Pattern"
                  value={draft.patternId}
                  onChange={(e) => m.dispatch({ type: 'select', patternId: e.target.value })}
                >
                  <option value="">整曲音符</option>
                  {doc.patterns?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="编辑音乐通道"
                  value={draft.trackId}
                  onChange={(e) => selectTrack(e.target.value)}
                >
                  {doc.tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="音符网格"
                  value={grid}
                  onChange={(e) => setGrid(Number(e.target.value))}
                >
                  {[
                    [1, '1 拍'],
                    [0.5, '1/2'],
                    [0.25, '1/4'],
                    [0.125, '1/8'],
                    [1 / 3, '三连音'],
                  ].map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
                {tab === 'piano' && (
                  <>
                    <button
                      className={tool === 'draw' ? 'active' : ''}
                      onClick={() => setTool('draw')}
                    >
                      铅笔
                    </button>
                    <button
                      className={tool === 'select' ? 'active' : ''}
                      onClick={() => setTool('select')}
                    >
                      选择
                    </button>
                    <label>
                      缩放
                      <input
                        aria-label="钢琴卷帘缩放"
                        type="range"
                        min={30}
                        max={160}
                        value={zoom}
                        onChange={(e) => setZoom(Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
                {pattern && (
                  <MusicNumber
                    label="Pattern 长度"
                    value={pattern.length}
                    min={0.25}
                    max={doc.duration}
                    step={0.25}
                    onChange={(n) =>
                      edit((d) => {
                        d.patterns = d.patterns?.map((p) =>
                          p.id === pattern.id ? { ...p, length: n } : p,
                        );
                      })
                    }
                  />
                )}
              </div>
              {tab === 'piano' ? (
                <PianoRoll
                  key={doc.id + ':' + draft.patternId}
                  events={events}
                  selected={draft.selected}
                  length={length}
                  grid={grid}
                  zoom={zoom}
                  tool={tool}
                  disabled={busy}
                  playhead={!pattern ? clock : undefined}
                  onSelect={(selected) => m.dispatch({ type: 'select', selected })}
                  onEdit={editEvents}
                  onSeek={(at) => m.seek(musicSeconds(doc, at))}
                />
              ) : (
                <ChannelRack
                  doc={doc}
                  m={m}
                  edit={edit}
                  busy={busy}
                  draft={draft}
                  length={length}
                  addTrack={addTrack}
                  selectTrack={selectTrack}
                />
              )}
              <div className="music-selection-bar">
                <span>
                  {selected.length
                    ? `${selected.length} 个音符`
                    : '点击绘制 · 拖动移动 · 右边缘调整长度 · Ctrl 多选 · 右键删除'}
                </span>
                {selected.length > 0 && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        editEvents(
                          events.map((n) =>
                            draft.selected.includes(n.id)
                              ? {
                                  ...n,
                                  at: Math.min(
                                    length - n.duration,
                                    Math.max(0, Math.round(n.at / grid) * grid),
                                  ),
                                }
                              : n,
                          ),
                        )
                      }
                    >
                      量化
                    </button>
                    <button disabled={busy} onClick={duplicateNotes}>
                      复制
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        editEvents(moveMusicNotes(events, draft.selected, 0, 12, length))
                      }
                    >
                      ＋ 八度
                    </button>
                    <MusicNumber
                      label="力度"
                      value={selected[0].velocity}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(velocity) =>
                        editEvents(
                          events.map((n) =>
                            draft.selected.includes(n.id) ? { ...n, velocity } : n,
                          ),
                        )
                      }
                    />
                    {selected.length === 1 && (
                      <>
                        <MusicNumber
                          label="起点"
                          value={selected[0].at}
                          min={0}
                          max={length - selected[0].duration}
                          step={grid}
                          onChange={(at) =>
                            editEvents(
                              events.map((n) => (n.id === selected[0].id ? { ...n, at } : n)),
                            )
                          }
                        />
                        <MusicNumber
                          label="长度"
                          value={selected[0].duration}
                          min={0.001}
                          max={length - selected[0].at}
                          step={grid}
                          onChange={(duration) =>
                            editEvents(
                              events.map((n) => (n.id === selected[0].id ? { ...n, duration } : n)),
                            )
                          }
                        />
                        <MusicNumber
                          label="MIDI 音高"
                          value={noteNumber(selected[0].note)}
                          min={0}
                          max={127}
                          step={1}
                          onChange={(note) =>
                            editEvents(
                              events.map((n) => (n.id === selected[0].id ? { ...n, note } : n)),
                            )
                          }
                        />
                      </>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        editEvents(events.filter((n) => !draft.selected.includes(n.id)));
                        m.dispatch({ type: 'select', selected: [] });
                      }}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {tab === 'mixer' && (
            <MusicMixer doc={doc} m={m} edit={edit} busy={busy} owner={owner} setOwner={setOwner} />
          )}
          {tab === 'settings' && (
            <MusicSettings doc={doc} m={m} edit={edit} busy={busy} pattern={pattern} />
          )}

          {performanceOpen && (
            <MidiPerformance
              doc={doc}
              track={track}
              patternId={draft.patternId}
              grid={grid}
              disabled={busy}
              onEdit={m.edit}
              onStatus={(error) =>
                void m.task('MIDI', async () => {
                  throw new Error(error);
                })
              }
            />
          )}
          <MusicChannels
            doc={doc}
            m={m}
            edit={edit}
            busy={busy}
            draft={draft}
            track={track}
            addTrack={addTrack}
            selectTrack={selectTrack}
          />
        </main>
        <fieldset className="music-inspector-fieldset" disabled={busy}>
          <MusicInspector
            key={owner}
            doc={doc}
            owner={owner || draft.trackId}
            assets={assets}
            edit={m.edit}
          />
        </fieldset>
      </div>
      <footer className="music-footer">
        <div className="music-footer-status" role={m.error || validation ? 'alert' : 'status'}>
          {m.error ||
            validation ||
            m.notice ||
            `${pattern?.name ?? '整曲'} · ${track?.name ?? '选择通道'} · ${selected.length ? selected.map((n) => noteLabel(n.note)).join(', ') : '准备就绪'}`}
        </div>
        {m.audio && (
          <>
            <audio
              ref={m.audioRef}
              controls
              autoPlay
              src={m.audio.src}
              onPlay={() => m.setPlaying(true)}
              onPause={() => m.setPlaying(false)}
              onEnded={() => m.setPlaying(false)}
              onTimeUpdate={(e) => m.setStart(m.audio!.startSeconds + e.currentTarget.currentTime)}
            />
            <span className={m.audio.peak > 1 ? 'music-error' : ''}>
              Peak {m.audio.peak.toFixed(3)} · RMS {m.audio.rms.toFixed(3)}
            </span>
          </>
        )}
      </footer>
    </div>
  );
}
