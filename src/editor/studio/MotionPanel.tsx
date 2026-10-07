import React, { useState } from 'react';
import { editAnimationLayers, type AnimationLayerAction } from '../../core/animation-layers.js';
import { getNumericPath } from '../../core/time.js';
import { CurveEditor } from '../CurveEditor.js';
import type { StudioContext } from './types.js';
import {
  CandidateActions,
  EmptySelection,
  NumberControl,
  PanelIntro,
  SelectControl,
  Toggle,
} from './Controls.js';
export default function MotionPanel({ context }: { context: StudioContext }) {
  const [mode, setMode] = useState('templates'),
    [template, setTemplate] = useState('fadeSlide'),
    [start, setStart] = useState(context.frame),
    [duration, setDuration] = useState(30),
    [stagger, setStagger] = useState(6),
    [distance, setDistance] = useState(60),
    [blend, setBlend] = useState('replace'),
    [weight, setWeight] = useState(1),
    [repeat, setRepeat] = useState('constant');
  const [draft, setDraft] = useState(context.node),
    [actions, setActions] = useState<AnimationLayerAction[]>([]),
    [error, setError] = useState(''),
    [property, setProperty] = useState('x'),
    [chosen, setChosen] = useState(draft?.animationLayers?.[0]?.id ?? ''),
    [base] = useState(context.snapshot.revision);
  if (!context.node || !draft) return <EmptySelection />;
  const scope = {
    sceneId: context.sceneId,
    nodeId: context.node.id,
    path: context.path,
    contextFrames: context.contextFrames,
    frame: context.frame,
  };
  const edit = (action: AnimationLayerAction) => {
    try {
      setDraft(editAnimationLayers(draft, [action]));
      setActions((a) => [...a, action]);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const layer = draft.animationLayers?.find((l) => l.id === chosen);
  return (
    <>
      <PanelIntro title="动作与动画层">
        模板可同时应用到多个图层。动画层保留普通关键帧，用权重与混合模式组合动作。
      </PanelIntro>
      <div className="studio-tools">
        <button
          className={mode === 'templates' ? 'pressed' : ''}
          onClick={() => setMode('templates')}
        >
          动作模板
        </button>
        <button className={mode === 'layers' ? 'pressed' : ''} onClick={() => setMode('layers')}>
          动画叠加层
        </button>
      </div>
      {mode === 'templates' ? (
        <>
          <div className="motion-presets">
            {[
              ['fadeSlide', '滑入', '从透明到清晰，沿方向进入'],
              ['pop', '弹出', '缩放和透明度一起入场'],
              ['pulse', '呼吸', '周期缩放与节奏'],
              ['fadeOut', '淡出', '保留位置，逐渐退出'],
              ['wipeText', '文字展开', '按字显示内容'],
            ].map(([id, name, hint]) => (
              <button
                key={id}
                aria-pressed={template === id}
                className={template === id ? 'selected' : ''}
                onClick={() => setTemplate(id)}
              >
                <div className={`motion-glyph ${id}`}>
                  <i />
                </div>
                <strong>{name}</strong>
                <small>{hint}</small>
              </button>
            ))}
          </div>
          <div className="studio-grid">
            <NumberControl label="动作起始帧" value={start} min={0} onChange={setStart} />
            <NumberControl label="动作时长" value={duration} min={1} onChange={setDuration} />
            <NumberControl label="图层错峰帧数" value={stagger} min={0} onChange={setStagger} />
            <NumberControl label="运动距离" value={distance} onChange={setDistance} />
            <NumberControl
              label="动作权重"
              value={weight}
              min={0}
              max={1}
              step={0.05}
              onChange={setWeight}
            />
            <SelectControl
              label="动作混合"
              value={blend}
              options={[
                ['add', '加法'],
                ['multiply', '乘法'],
                ['replace', '替换'],
              ]}
              onChange={setBlend}
            />
            <SelectControl
              label="结束后行为"
              value={repeat}
              options={['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong']}
              onChange={setRepeat}
            />
          </div>
          <div className="motion-targets">
            <h3>应用对象 · {context.selected.length}</h3>
            {context.selected.map((s, i) => (
              <div key={s.nodeId}>
                <span>{s.nodeId}</span>
                <span>
                  {start + i * stagger}–{start + i * stagger + duration} 帧
                </span>
              </div>
            ))}
          </div>
          <CandidateActions
            context={context}
            changeKey={`${template}:${start}:${duration}:${stagger}:${distance}:${weight}:${blend}:${repeat}:${context.selected.map((s) => s.nodeId).join()}`}
            prepare={() =>
              context.run('motionPlan', {
                revision: base,
                output: 'layers',
                cues: [
                  {
                    id: 'motion-' + crypto.randomUUID().slice(0, 8),
                    template: { builtin: template },
                    parameters: template === 'fadeSlide' ? { dy: distance } : {},
                    start,
                    duration,
                    blend,
                    weight,
                    after: repeat,
                  },
                ],
                targets: context.selected.map((s, i) => ({
                  sceneId: context.sceneId,
                  ...s,
                  frame: undefined,
                  referenceFrame: s.frame,
                  offset: i * stagger,
                })),
              })
            }
          />
        </>
      ) : (
        <>
          <div className="studio-tools">
            <label className="studio-field">
              <span>动画属性</span>
              <input
                aria-label="动画层属性"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
              />
            </label>
            <button
              onClick={() => {
                let value = 0;
                try {
                  value = getNumericPath(draft, property);
                } catch (e) {
                  setError((e as Error).message);
                  return;
                }
                const id = 'layer-' + crypto.randomUUID().slice(0, 8);
                edit({
                  type: 'append',
                  layer: {
                    id,
                    name: '新动画层',
                    blend: 'add',
                    enabled: true,
                    weight: 1,
                    start: 0,
                    rate: 1,
                    offset: 0,
                    channels: [
                      {
                        property,
                        keys: [
                          { frame: 0, value: 0, easing: 'easeInOut' },
                          {
                            frame: 30,
                            value: property.includes('scale')
                              ? 0.2
                              : Math.max(20, Math.abs(value) * 0.1),
                            easing: 'linear',
                          },
                        ],
                      },
                    ],
                  },
                });
                setChosen(id);
              }}
            >
              ＋ 添加动画层
            </button>
          </div>
          <div className="layer-editor">
            <aside>
              {(draft.animationLayers ?? []).map((l, index) => (
                <button
                  key={l.id}
                  aria-label={`选择动画层 ${l.name}`}
                  className={chosen === l.id ? 'selected' : ''}
                  onClick={() => setChosen(l.id)}
                >
                  <span>{index + 1}</span>
                  <strong>{l.name}</strong>
                  <small>
                    {l.blend} · {l.channels.length} 通道
                  </small>
                </button>
              ))}
            </aside>
            <div>
              {layer ? (
                <>
                  <div className="studio-tools">
                    <Toggle
                      label="启用动画层"
                      value={layer.enabled}
                      onChange={(enabled) => edit({ type: 'toggle', id: layer.id, enabled })}
                    />
                    <button
                      onClick={() =>
                        edit({
                          type: 'duplicate',
                          id: layer.id,
                          newId: 'layer-' + crypto.randomUUID().slice(0, 8),
                        })
                      }
                    >
                      复制
                    </button>
                    <button
                      disabled={
                        (draft.animationLayers ?? []).findIndex((l) => l.id === layer.id) < 1
                      }
                      onClick={() =>
                        edit({
                          type: 'move',
                          id: layer.id,
                          index:
                            (draft.animationLayers ?? []).findIndex((l) => l.id === layer.id) - 1,
                        })
                      }
                    >
                      上移
                    </button>
                    <button onClick={() => edit({ type: 'remove', id: layer.id })}>删除</button>
                  </div>
                  <div className="studio-grid">
                    <label className="studio-field">
                      <span>动画层名称</span>
                      <input
                        value={layer.name}
                        onChange={(e) =>
                          edit({ type: 'update', id: layer.id, patch: { name: e.target.value } })
                        }
                      />
                    </label>
                    <SelectControl
                      label="动画层混合模式"
                      value={layer.blend}
                      options={['add', 'multiply', 'replace']}
                      onChange={(blend) => edit({ type: 'update', id: layer.id, patch: { blend } })}
                    />
                    {[
                      ['weight', '权重'],
                      ['start', '起始帧'],
                      ['offset', '局部偏移'],
                      ['rate', '播放速率'],
                    ].map(([key, label]) => (
                      <NumberControl
                        key={key}
                        label={label}
                        value={(layer as any)[key]}
                        step={key === 'weight' ? 0.05 : 1}
                        onChange={(v) =>
                          edit({ type: 'update', id: layer.id, patch: { [key]: v } })
                        }
                      />
                    ))}
                  </div>
                  {layer.channels.map((c) => (
                    <section key={c.property} className="layer-channel">
                      <h3>{c.property}</h3>
                      <CurveEditor
                        keys={c.keys}
                        selectedFrames={[]}
                        onSelect={() => {}}
                        onChange={(keys) =>
                          edit({
                            type: 'channels',
                            id: layer.id,
                            actions: [
                              { type: 'remove', properties: [c.property] },
                              { type: 'upsert', property: c.property, keys },
                            ],
                          })
                        }
                      />
                      <div className="studio-grid">
                        {(['before', 'after'] as const).map((side) => (
                          <SelectControl
                            key={side}
                            label={side === 'before' ? '首帧前' : '末帧后'}
                            value={c[side] ?? 'constant'}
                            options={['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong']}
                            onChange={(value) =>
                              edit({
                                type: 'update',
                                id: layer.id,
                                patch: {
                                  channels: layer.channels.map((channel) =>
                                    channel.property === c.property
                                      ? { ...channel, [side]: value }
                                      : channel,
                                  ),
                                },
                              })
                            }
                          />
                        ))}
                      </div>
                      {c.keys.map((k, index) => (
                        <div key={index} className="layer-key">
                          <NumberControl
                            label={`${c.property} 关键帧 ${index + 1} 时间`}
                            value={k.frame}
                            onChange={(value) =>
                              edit({
                                type: 'update',
                                id: layer.id,
                                patch: {
                                  channels: layer.channels.map((channel) =>
                                    channel.property === c.property
                                      ? {
                                          ...channel,
                                          keys: c.keys.map((key, i) =>
                                            i === index ? { ...key, frame: value } : key,
                                          ),
                                        }
                                      : channel,
                                  ),
                                },
                              })
                            }
                          />
                          <NumberControl
                            label={`${c.property} 关键帧 ${index + 1} 值`}
                            value={k.value}
                            step={0.1}
                            onChange={(value) =>
                              edit({
                                type: 'update',
                                id: layer.id,
                                patch: {
                                  channels: layer.channels.map((channel) =>
                                    channel.property === c.property
                                      ? {
                                          ...channel,
                                          keys: c.keys.map((key, i) =>
                                            i === index ? { ...key, value } : key,
                                          ),
                                        }
                                      : channel,
                                  ),
                                },
                              })
                            }
                          />
                        </div>
                      ))}
                    </section>
                  ))}
                </>
              ) : (
                <div className="studio-empty">添加或选择一个动画层</div>
              )}
            </div>
          </div>
          {error && <p className="studio-error">{error}</p>}
          <CandidateActions
            context={context}
            changeKey={actions.length}
            prepare={() => {
              if (!actions.length) throw new Error('请先编辑动画层');
              return context.run('animationLayersPlan', {
                revision: base,
                targets: [{ ...scope, actions }],
              });
            }}
          />
        </>
      )}
    </>
  );
}
