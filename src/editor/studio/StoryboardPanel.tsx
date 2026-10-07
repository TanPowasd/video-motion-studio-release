import React, { useState } from 'react';
import type { StudioContext } from './types.js';
import { CandidateActions, NumberControl, PanelIntro, SelectControl } from './Controls.js';
import type { StoryboardInput } from '../../core/storyboard.js';
export default function StoryboardPanel({ context }: { context: StudioContext }) {
  const resources = Object.keys(context.snapshot.files).filter(
      (f) => f.startsWith('components/storyboards/') && f.endsWith('.json'),
    ),
    [source, setSource] = useState(resources[0] ?? ''),
    [document, setDocument] = useState<StoryboardInput>(() =>
      resources[0]
        ? JSON.parse(context.snapshot.files[resources[0]])
        : {
            kind: 'storyboard',
            version: 1,
            id: 'sb-' + crypto.randomUUID().slice(0, 8),
            name: '新分镜',
            unit: 'frames',
            start: 0,
            chapters: [],
            shots: [],
          },
    ),
    [base, setBase] = useState(context.snapshot.revision),
    [mode, setMode] = useState('shots'),
    [from, setFrom] = useState(context.sceneId),
    [to, setTo] = useState(
      context.snapshot.scenes.find((s) => s.id !== context.sceneId)?.id ?? context.sceneId,
    ),
    [style, setStyle] = useState('crossfade'),
    [at, setAt] = useState(0),
    [duration, setDuration] = useState(30);
  const sequence = context.snapshot.sequences.find(
      (s) => s.id === context.snapshot.project.activeSequence,
    )!,
    [videoTrack, setVideoTrack] = useState(
      () =>
        sequence.tracks.find((t) => t.clips.some((c) => c.id.startsWith(`sb/${document.id}/`)))
          ?.id ?? '',
    ),
    [newVideoId] = useState('storyboard-' + crypto.randomUUID().slice(0, 8)),
    [audioTrack, setAudioTrack] = useState(
      sequence.tracks.find((t) => t.type === 'audio')?.id ?? '',
    ),
    [drag, setDrag] = useState('');
  const updateShot = (id: string, patch: any) =>
    setDocument((d) => ({
      ...d,
      shots: d.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  const sources = [
    ...context.snapshot.scenes.map((s) => [`scene:${s.id}`, s.name] as [string, string]),
    ...context.snapshot.project.assets
      .filter((a) => ['video', 'image', 'drawing'].includes(a.type))
      .map((a) => [`asset:${a.id}`, a.name] as [string, string]),
    ...context.snapshot.sequences
      .filter((s) => s.id !== sequence.id)
      .map((s) => [`sequence:${s.id}`, s.name] as [string, string]),
  ];
  const move = (id: string, to: number) =>
    setDocument((d) => {
      const shots = [...d.shots],
        index = shots.findIndex((s) => s.id === id);
      if (index < 0) return d;
      shots.splice(to, 0, ...shots.splice(index, 1));
      return { ...d, shots };
    });
  return (
    <>
      <PanelIntro title="分镜与转场">
        按镜头卡片组织场景和配音，拖动调整顺序。预览后将同一份分镜保存到时间轴。
      </PanelIntro>
      <div className="studio-tools">
        <button className={mode === 'shots' ? 'pressed' : ''} onClick={() => setMode('shots')}>
          分镜卡片
        </button>
        <button
          className={mode === 'transition' ? 'pressed' : ''}
          onClick={() => setMode('transition')}
        >
          场景转场
        </button>
        <SelectControl
          label="目标视频轨道"
          value={videoTrack}
          options={[
            ['', '新建分镜轨道'],
            ...sequence.tracks
              .filter((t) => t.type === 'video')
              .map((t) => [t.id, t.name] as [string, string]),
          ]}
          onChange={setVideoTrack}
        />
      </div>
      {mode === 'shots' ? (
        <>
          <div className="studio-grid">
            <SelectControl
              label="分镜资源"
              value={source}
              options={[['', '新建分镜'], ...resources.map((f) => [f, f] as [string, string])]}
              onChange={(file) => {
                setSource(file);
                setBase(context.snapshot.revision);
                setVideoTrack(
                  file
                    ? (sequence.tracks.find((t) =>
                        t.clips.some((c) =>
                          c.id.startsWith(`sb/${JSON.parse(context.snapshot.files[file]).id}/`),
                        ),
                      )?.id ?? '')
                    : '',
                );
                setDocument(
                  file
                    ? JSON.parse(context.snapshot.files[file])
                    : {
                        kind: 'storyboard',
                        version: 1,
                        id: 'sb-' + crypto.randomUUID().slice(0, 8),
                        name: '新分镜',
                        unit: 'frames',
                        start: 0,
                        chapters: [],
                        shots: [],
                      },
                );
              }}
            />
            <label className="studio-field">
              <span>分镜名称</span>
              <input
                value={document.name}
                onChange={(e) => setDocument((d) => ({ ...d, name: e.target.value }))}
              />
            </label>
            <SelectControl
              label="分镜时间单位"
              value={document.unit ?? 'frames'}
              options={[
                ['frames', '帧'],
                ['seconds', '秒'],
              ]}
              onChange={(unit) => setDocument((d) => ({ ...d, unit: unit as any }))}
            />
            <SelectControl
              label="配音轨道"
              value={audioTrack}
              options={[
                ['', '自动创建配音轨道'],
                ...sequence.tracks
                  .filter((t) => t.type === 'audio')
                  .map((t) => [t.id, t.name] as [string, string]),
              ]}
              onChange={setAudioTrack}
            />
          </div>
          <div className="studio-tools">
            <button
              className="secondary"
              onClick={() =>
                setDocument((d) => ({
                  ...d,
                  shots: [
                    ...d.shots,
                    {
                      id: 'shot-' + crypto.randomUUID().slice(0, 8),
                      name: `镜头 ${d.shots.length + 1}`,
                      source: { type: 'scene', id: context.sceneId },
                      duration:
                        document.unit === 'seconds'
                          ? 2
                          : Math.min(
                              60,
                              context.snapshot.scenes.find((s) => s.id === context.sceneId)
                                ?.duration ?? 60,
                            ),
                      sourceIn: 0,
                      speed: 1,
                      narration: [],
                    },
                  ],
                }))
              }
            >
              ＋ 添加镜头
            </button>
            <button
              onClick={() =>
                setDocument((d) => ({
                  ...d,
                  chapters: [
                    ...(d.chapters ?? []),
                    {
                      id: 'chapter-' + crypto.randomUUID().slice(0, 8),
                      name: `章节 ${(d.chapters?.length ?? 0) + 1}`,
                    },
                  ],
                }))
              }
            >
              ＋ 添加章节
            </button>
            <span>{document.shots.length} 个镜头</span>
          </div>
          {(document.chapters ?? []).map((chapter) => (
            <label className="chapter-chip" key={chapter.id}>
              <span>章节</span>
              <input
                aria-label={`章节 ${chapter.id} 名称`}
                value={chapter.name}
                onChange={(e) =>
                  setDocument((d) => ({
                    ...d,
                    chapters: d.chapters!.map((c) =>
                      c.id === chapter.id ? { ...c, name: e.target.value } : c,
                    ),
                  }))
                }
              />
            </label>
          ))}
          <div className="shot-cards">
            {document.shots.map((shot, index) => (
              <article
                key={shot.id}
                draggable
                onDragStart={() => setDrag(shot.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  move(drag, index);
                  setDrag('');
                }}
              >
                <header>
                  <span className="shot-index">{String(index + 1).padStart(2, '0')}</span>
                  <input
                    aria-label={`镜头 ${index + 1} 名称`}
                    value={shot.name}
                    onChange={(e) => updateShot(shot.id, { name: e.target.value })}
                  />
                  <button
                    aria-label={`删除镜头 ${index + 1}`}
                    onClick={() =>
                      setDocument((d) => ({ ...d, shots: d.shots.filter((s) => s.id !== shot.id) }))
                    }
                  >
                    ×
                  </button>
                </header>
                <div className="shot-thumbnail">
                  {shot.source.type === 'scene' ? (
                    <img
                      alt={shot.name}
                      loading="lazy"
                      src={`/api/frame?scene=${encodeURIComponent(shot.source.id)}&frame=0&width=240&revision=${context.snapshot.revision}`}
                    />
                  ) : (
                    <strong>{shot.source.type === 'asset' ? '素材镜头' : '嵌套序列'}</strong>
                  )}
                </div>
                <SelectControl
                  label={`镜头 ${index + 1} 来源`}
                  value={`${shot.source.type}:${shot.source.id}`}
                  options={sources}
                  onChange={(v) => {
                    const split = v.indexOf(':');
                    updateShot(shot.id, {
                      source: { type: v.slice(0, split), id: v.slice(split + 1) },
                    });
                  }}
                />
                <div className="studio-grid">
                  <NumberControl
                    label={`镜头 ${index + 1} 时长`}
                    value={shot.duration ?? 60}
                    min={0.01}
                    onChange={(duration) => updateShot(shot.id, { duration })}
                  />
                  <NumberControl
                    label={`镜头 ${index + 1} 源入点`}
                    value={shot.sourceIn ?? 0}
                    min={0}
                    onChange={(sourceIn) => updateShot(shot.id, { sourceIn })}
                  />
                  <SelectControl
                    label={`镜头 ${index + 1} 章节`}
                    value={shot.chapterId ?? ''}
                    options={[
                      ['', '无章节'],
                      ...(document.chapters ?? []).map((c) => [c.id, c.name] as [string, string]),
                    ]}
                    onChange={(chapterId) =>
                      updateShot(shot.id, { chapterId: chapterId || undefined })
                    }
                  />
                  <SelectControl
                    label={`镜头 ${index + 1} 配音`}
                    value={shot.narration?.[0]?.assetId ?? ''}
                    options={[
                      ['', '无配音'],
                      ...context.snapshot.project.assets
                        .filter((a) => a.type === 'audio')
                        .map((a) => [a.id, a.name] as [string, string]),
                    ]}
                    onChange={(assetId) =>
                      updateShot(shot.id, {
                        narration: assetId
                          ? [
                              {
                                id:
                                  shot.narration?.[0]?.id ??
                                  'narration-' + crypto.randomUUID().slice(0, 8),
                                assetId,
                                offset: 0,
                                sourceIn: 0,
                                volume: 1,
                              },
                            ]
                          : [],
                      })
                    }
                  />
                </div>
                <footer>
                  <button disabled={!index} onClick={() => move(shot.id, index - 1)}>
                    前移
                  </button>
                  <button
                    disabled={index === document.shots.length - 1}
                    onClick={() => move(shot.id, index + 1)}
                  >
                    后移
                  </button>
                </footer>
              </article>
            ))}
          </div>
          <CandidateActions
            context={context}
            changeKey={JSON.stringify([document, source, videoTrack, audioTrack])}
            prepare={() =>
              context.run('storyboardPlan', {
                revision: base,
                source: source || undefined,
                document,
                sequenceId: sequence.id,
                videoTrackId: videoTrack || newVideoId,
                operations: videoTrack
                  ? []
                  : [
                      {
                        type: 'addTrack',
                        sequenceId: sequence.id,
                        track: { id: newVideoId, name: '分镜', type: 'video', clips: [] },
                      },
                    ],
                audioTrackId: audioTrack || undefined,
              })
            }
          />
        </>
      ) : (
        <>
          <div className="studio-grid">
            <SelectControl
              label="转场来源场景"
              value={from}
              options={context.snapshot.scenes.map((s) => [s.id, s.name])}
              onChange={setFrom}
            />
            <SelectControl
              label="转场目标场景"
              value={to}
              options={context.snapshot.scenes.map((s) => [s.id, s.name])}
              onChange={setTo}
            />
            <SelectControl
              label="转场样式"
              value={style}
              options={['crossfade', 'slide', 'push', 'wipe', 'zoom', 'dip', 'iris', 'cut']}
              onChange={setStyle}
            />
            <NumberControl label="转场时长（帧）" value={duration} min={2} onChange={setDuration} />
            <NumberControl label="时间轴放置帧" value={at} min={0} onChange={setAt} />
          </div>
          <CandidateActions
            context={context}
            changeKey={`${from}:${to}:${style}:${at}:${duration}:${videoTrack}`}
            prepare={() =>
              context.run('transitionPlan', {
                revision: base,
                items: [
                  {
                    fromSceneId: from,
                    toSceneId: to,
                    style,
                    duration,
                    placement: {
                      sequenceId: sequence.id,
                      trackId: videoTrack || sequence.tracks.find((t) => t.type === 'video')?.id,
                      at,
                      extendSequence: true,
                    },
                  },
                ],
              })
            }
          />
        </>
      )}
    </>
  );
}
