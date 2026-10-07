import React, { useEffect, useRef, useState } from 'react';
import type { EffectGraph } from '../../core/effect-graph-schema.js';
import type { StudioContext } from './types.js';
import {
  CandidateActions,
  ColorControl,
  EmptySelection,
  NumberControl,
  PanelIntro,
  SelectControl,
  Toggle,
} from './Controls.js';
const labels: Record<string, string> = {
  input: '图层输入',
  solid: '纯色',
  texture: '纹理',
  noise: '噪声',
  pass: '基础特效',
  colorMatrix: '颜色矩阵',
  keyer: '抠像',
  channels: '通道合成',
  blend: '混合',
  mask: '遮罩',
  transform: '变换',
  displace: '置换',
  subgraph: '引用子图',
};
export function graphPorts(node: any): Array<[string, string]> {
  if (node.type === 'channels')
    return ['red', 'green', 'blue', 'alpha'].flatMap((c) =>
      typeof node[c] === 'object' ? [[c, node[c].input] as [string, string]] : [],
    );
  if (node.type === 'subgraph')
    return Object.entries(node.inputs ?? {}).map(([key, value]) => [
      'inputs.' + key,
      String(value),
    ]);
  return ['input', 'foreground', 'background', 'matte', 'map'].flatMap((key) =>
    typeof node[key] === 'string' ? [[key, node[key]] as [string, string]] : [],
  );
}
export function createGraphNode(type: string, input: string, id: string): any {
  const matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  if (type === 'input') return { id, type, slot: 'source' };
  if (type === 'solid') return { id, type, color: '#74cbb8', opacity: 1, space: 'layer' };
  if (type === 'noise')
    return {
      id,
      type,
      seed: 1,
      scale: 100,
      octaves: 3,
      evolution: 0,
      low: '#000000',
      high: '#ffffff',
      opacity: 1,
      space: 'layer',
    };
  if (type === 'texture')
    return { id, type, settings: { pattern: 'fbm' }, opacity: 1, space: 'layer' };
  if (type === 'blend')
    return { id, type, foreground: input, background: 'source', mode: 'screen', opacity: 0.5 };
  if (type === 'mask') return { id, type, input, matte: 'source', mode: 'alpha', feather: 0 };
  if (type === 'transform') return { id, type, input, matrix: [1, 0, 0, 1, 0, 0], space: 'layer' };
  if (type === 'displace') return { id, type, input, map: 'source', amountX: 20, amountY: 20 };
  if (type === 'channels')
    return {
      id,
      type,
      red: { input, channel: 'red' },
      green: { input, channel: 'green' },
      blue: { input, channel: 'blue' },
      alpha: { input, channel: 'alpha' },
    };
  if (type === 'colorMatrix') return { id, type, input, matrix, colorSpace: 'srgb' };
  if (type === 'keyer')
    return {
      id,
      type,
      input,
      mode: 'chroma',
      color: '#00ff00',
      threshold: 0.12,
      softness: 0.08,
      spill: 0,
      invert: false,
      view: 'color',
    };
  return {
    id,
    type: 'pass',
    input,
    effect:
      type === 'glow' ? { type, radius: 8, color: '#80cddf', intensity: 1 } : { type, radius: 8 },
  };
}
const initial = {
  kind: 'effect-graph',
  version: 1,
  name: '可视化特效图',
  nodes: [{ id: 'source', type: 'input', slot: 'source' }],
  output: 'source',
  parameters: {},
  links: [],
  outputs: {},
} as EffectGraph;
export default function GraphEditor({ context }: { context: StudioContext }) {
  const effects = context.node?.effects.filter((e) => e.type === 'effectGraph') ?? [],
    [effectId, setEffectId] = useState(effects[0]?.id ?? ''),
    [graph, setGraph] = useState<EffectGraph>(structuredClone(initial)),
    [selected, setSelected] = useState('source'),
    [base, setBase] = useState(context.snapshot.revision),
    [info, setInfo] = useState<any>(),
    [error, setError] = useState(''),
    [link, setLink] = useState(''),
    [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({}),
    [revision, setRevision] = useState(0);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const loadTicket = useRef(0);
  const drag = useRef<{ id: string; x: number; y: number; ox: number; oy: number } | undefined>(
    undefined,
  );
  const scope = {
    sceneId: context.sceneId,
    nodeId: context.node?.id,
    path: context.path,
    contextFrames: context.contextFrames,
    frame: context.frame,
  };
  const load = async () => {
    const ticket = ++loadTicket.current;
    setError('');
    setBase(context.snapshot.revision);
    setRevision((v) => v + 1);
    try {
      if (effectId) {
        const result = await context.run('effectGraphInspect', {
          revision: context.snapshot.revision,
          source: { ...scope, effectId },
          includeGraph: true,
        });
        if (ticket !== loadTicket.current) return;
        setInfo(result);
        setBindings(result.locator?.bindings ?? {});
        setGraph(result.graph);
        setSelected(result.graph.nodes[0]?.id ?? '');
      } else {
        setInfo(undefined);
        setBindings({});
        setGraph(structuredClone(initial));
        setSelected('source');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [effectId]);
  if (!context.node) return <EmptySelection />;
  const patch = (id: string, change: any) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) }));
    setRevision((v) => v + 1);
  };
  const point = (id: string, index: number) =>
    positions[id] ?? { x: 32 + (index % 4) * 214, y: 36 + Math.floor(index / 4) * 156 };
  const picked = graph.nodes.find((n) => n.id === selected) as any;
  const choices = graph.nodes
    .filter((n) => n.id !== selected)
    .map((n) => [n.id, `${labels[n.type]} · ${n.id}`] as [string, string]);
  const connect = (field: string, source: string) => {
    if (!source || source === selected) return;
    if (picked.type === 'channels')
      patch(selected, { [field]: { ...picked[field], input: source } });
    else if (field.startsWith('inputs.'))
      patch(selected, { inputs: { ...picked.inputs, [field.slice(7)]: source } });
    else patch(selected, { [field]: source });
    setLink('');
  };
  return (
    <>
      <PanelIntro title="特效节点图">
        从输出端口选择来源，再点击目标输入端口连接。拖动节点整理画布，修改参数后预览并保存。
      </PanelIntro>
      <div className="studio-tools">
        <SelectControl
          label="图层特效图"
          value={effectId}
          options={[['', '新建特效图'], ...effects.map((e) => [e.id, e.id] as [string, string])]}
          onChange={setEffectId}
        />
        <button onClick={() => void load()}>重新读取</button>
        <select
          aria-label="添加特效节点"
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const id = 'n-' + crypto.randomUUID().slice(0, 8),
              next = createGraphNode(e.target.value, selected || graph.output, id);
            setGraph((g) => ({ ...g, nodes: [...g.nodes, next] }));
            setSelected(id);
            setRevision((v) => v + 1);
          }}
        >
          <option value="">＋ 添加节点</option>
          {[
            'input',
            'solid',
            'noise',
            'texture',
            'colorMatrix',
            'keyer',
            'channels',
            'blend',
            'mask',
            'transform',
            'displace',
            'blur',
            'glow',
          ].map((t) => (
            <option key={t} value={t}>
              {labels[t] ?? (t === 'blur' ? '模糊' : '发光')}
            </option>
          ))}
        </select>
        <button
          disabled={!picked}
          onClick={() => {
            setGraph((g) => ({ ...g, output: selected }));
            setRevision((v) => v + 1);
          }}
        >
          设为输出
        </button>
        <button
          disabled={
            !picked ||
            graph.nodes.some((n) => graphPorts(n).some(([, id]) => id === selected)) ||
            graph.output === selected
          }
          onClick={() => {
            setGraph((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== selected) }));
            setSelected('source');
            setRevision((v) => v + 1);
          }}
        >
          删除节点
        </button>
        {link && (
          <span>
            连接来源：{link}
            <button onClick={() => setLink('')}>取消</button>
          </span>
        )}
      </div>
      <div className="graph-editor">
        <div className="graph-board" tabIndex={0} aria-label="节点画布">
          <div
            className="graph-space"
            style={{
              width: Math.max(880, ...graph.nodes.map((n, i) => point(n.id, i).x + 210)),
              height: Math.max(420, ...graph.nodes.map((n, i) => point(n.id, i).y + 140)),
            }}
          >
            <svg className="graph-wires">
              {graph.nodes.flatMap((n, i) =>
                graphPorts(n).map(([port, id], j) => {
                  const sourceIndex = graph.nodes.findIndex((s) => s.id === id);
                  if (sourceIndex < 0) return null;
                  const a = point(id, sourceIndex),
                    b = point(n.id, i);
                  return (
                    <path
                      key={n.id + port}
                      d={`M${a.x + 188} ${a.y + 54} C${a.x + 245} ${a.y + 54},${b.x - 60} ${b.y + 58 + j * 20},${b.x} ${b.y + 58 + j * 20}`}
                    />
                  );
                }),
              )}
            </svg>
            {graph.nodes.map((n, i) => {
              const p = point(n.id, i);
              return (
                <article
                  key={n.id}
                  className={`graph-node ${selected === n.id ? 'selected' : ''} ${graph.output === n.id ? 'output' : ''}`}
                  style={{ left: p.x, top: p.y }}
                  onClick={() => setSelected(n.id)}
                >
                  <header
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      drag.current = { id: n.id, x: e.clientX, y: e.clientY, ox: p.x, oy: p.y };
                    }}
                    onPointerMove={(e) => {
                      if (!drag.current) return;
                      const d = drag.current;
                      setPositions((v) => ({
                        ...v,
                        [d.id]: {
                          x: Math.max(0, d.ox + e.clientX - d.x),
                          y: Math.max(0, d.oy + e.clientY - d.y),
                        },
                      }));
                    }}
                    onPointerUp={() => {
                      drag.current = undefined;
                    }}
                    onPointerCancel={() => {
                      drag.current = undefined;
                    }}
                  >
                    <strong>{labels[n.type] ?? n.type}</strong>
                    <small>{n.id}</small>
                  </header>
                  <button
                    className={`graph-port output-port ${link === n.id ? 'linking' : ''}`}
                    aria-label={`连接 ${n.id} 输出`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLink(n.id);
                    }}
                  >
                    输出 ●
                  </button>
                  {graphPorts(n).map(([field]) => (
                    <button
                      key={field}
                      className="graph-port"
                      aria-label={`连接 ${n.id} ${field}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(n.id);
                        if (link && link !== n.id) {
                          const next = n as any;
                          if (n.type === 'channels')
                            patch(n.id, { [field]: { ...next[field], input: link } });
                          else if (field.startsWith('inputs.'))
                            patch(n.id, { inputs: { ...next.inputs, [field.slice(7)]: link } });
                          else patch(n.id, { [field]: link });
                          setLink('');
                        }
                      }}
                    >
                      ● {field}
                    </button>
                  ))}
                  {graph.output === n.id && <span className="graph-output-label">最终输出</span>}
                </article>
              );
            })}
          </div>
        </div>
        <aside className="graph-properties">
          <h3>{picked ? labels[picked.type] : '选择节点'}</h3>
          {picked && (
            <>
              {graphPorts(picked).map(([port, id]) => (
                <SelectControl
                  key={port}
                  label={`来源 ${port}`}
                  value={id}
                  options={choices}
                  onChange={(v) => connect(port, v)}
                />
              ))}
              {Object.entries(picked)
                .filter(
                  ([k, v]) =>
                    typeof v === 'number' ||
                    typeof v === 'boolean' ||
                    (typeof v === 'string' &&
                      k !== 'id' &&
                      k !== 'type' &&
                      !graphPorts(picked).some(([p]) => p === k)),
                )
                .map(([field, value]) =>
                  typeof value === 'number' ? (
                    <NumberControl
                      key={field}
                      label={field}
                      value={value}
                      step={0.01}
                      onChange={(v) => patch(selected, { [field]: v })}
                    />
                  ) : typeof value === 'boolean' ? (
                    <Toggle
                      key={field}
                      label={field}
                      value={value}
                      onChange={(v) => patch(selected, { [field]: v })}
                    />
                  ) : String(value).startsWith('#') ? (
                    <ColorControl
                      key={field}
                      label={field}
                      value={String(value)}
                      onChange={(v) => patch(selected, { [field]: v })}
                    />
                  ) : ['mode', 'space', 'colorSpace', 'view'].includes(field) ? (
                    <SelectControl
                      key={field}
                      label={field}
                      value={String(value)}
                      options={
                        field === 'space'
                          ? ['layer', 'canvas']
                          : field === 'colorSpace'
                            ? ['srgb', 'linear']
                            : field === 'view'
                              ? ['color', 'matte']
                              : picked.type === 'keyer'
                                ? ['chroma', 'luma']
                                : picked.type === 'mask'
                                  ? ['alpha', 'alphaInverted', 'luma', 'lumaInverted']
                                  : [
                                      'source-over',
                                      'screen',
                                      'multiply',
                                      'overlay',
                                      'difference',
                                      'lighter',
                                      'darken',
                                      'lighten',
                                    ]
                      }
                      onChange={(v) => patch(selected, { [field]: v })}
                    />
                  ) : (
                    <label key={field} className="studio-field">
                      <span>{field}</span>
                      <input
                        value={String(value)}
                        onChange={(e) => patch(selected, { [field]: e.target.value })}
                      />
                    </label>
                  ),
                )}
              {picked.type === 'channels' &&
                (['red', 'green', 'blue', 'alpha'] as const).map((channel) => (
                  <fieldset key={channel}>
                    <legend>{channel}</legend>
                    <Toggle
                      label={`${channel} 常量`}
                      value={typeof picked[channel] === 'number'}
                      onChange={(constant) =>
                        patch(selected, {
                          [channel]: constant
                            ? 1
                            : {
                                input: graph.output === selected ? 'source' : graph.output,
                                channel,
                              },
                        })
                      }
                    />
                    {typeof picked[channel] === 'number' ? (
                      <NumberControl
                        label={`${channel} 常量值`}
                        value={picked[channel]}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => patch(selected, { [channel]: value })}
                      />
                    ) : (
                      <SelectControl
                        label={`${channel} 来源通道`}
                        value={picked[channel].channel}
                        options={['red', 'green', 'blue', 'alpha', 'luma']}
                        onChange={(value) =>
                          patch(selected, { [channel]: { ...picked[channel], channel: value } })
                        }
                      />
                    )}
                  </fieldset>
                ))}
              {picked.type === 'input' && picked.slot !== 'source' && (
                <SelectControl
                  label="输入绑定图层"
                  value={bindings[picked.slot] ?? ''}
                  options={[
                    ['', '选择素材图层'],
                    ...(context.nodes ?? [])
                      .filter((n) => n.id !== context.node!.id)
                      .map((n) => [n.id, n.name || n.id] as [string, string]),
                  ]}
                  onChange={(id) => {
                    setBindings((b) => ({ ...b, [picked.slot]: id }));
                    setRevision((v) => v + 1);
                  }}
                />
              )}
              {picked.matrix && (
                <div
                  className={`matrix-controls ${picked.type === 'colorMatrix' ? 'color-matrix' : ''}`}
                >
                  {picked.matrix.map((v: number, i: number) => (
                    <NumberControl
                      key={i}
                      label={`矩阵 ${i + 1}`}
                      value={v}
                      step={0.05}
                      onChange={(value) =>
                        patch(selected, {
                          matrix: picked.matrix.map((n: number, j: number) =>
                            j === i ? value : n,
                          ),
                        })
                      }
                    />
                  ))}
                </div>
              )}
              {picked.effect && (
                <>
                  <SelectControl
                    label="基础特效"
                    value={picked.effect.type}
                    options={['blur', 'glow', 'color', 'shadow', 'pixelate', 'grain']}
                    onChange={(type) =>
                      patch(selected, {
                        effect:
                          type === 'shadow'
                            ? { type, color: '#000000', blur: 12, x: 5, y: 5 }
                            : type === 'grain'
                              ? { type, amount: 0.2, seed: 1 }
                              : type === 'pixelate'
                                ? { type, size: 8 }
                                : type === 'color'
                                  ? { type, brightness: 1, contrast: 1, saturation: 1, hue: 0 }
                                  : type === 'glow'
                                    ? { type, color: '#80cddf', radius: 8, intensity: 1 }
                                    : { type, radius: 8 },
                      })
                    }
                  />
                  {Object.entries(picked.effect)
                    .filter(([, v]) => typeof v === 'number')
                    .map(([key, value]) => (
                      <NumberControl
                        key={key}
                        label={key}
                        value={Number(value)}
                        step={0.1}
                        onChange={(v) =>
                          patch(selected, { effect: { ...picked.effect, [key]: v } })
                        }
                      />
                    ))}
                </>
              )}
              {picked.settings && (
                <>
                  <SelectControl
                    label="纹理类型"
                    value={picked.settings.pattern ?? 'fbm'}
                    options={[
                      'fbm',
                      'turbulence',
                      'ridged',
                      'cellular',
                      'marble',
                      'waves',
                      'checker',
                    ]}
                    onChange={(pattern) =>
                      patch(selected, { settings: { ...picked.settings, pattern } })
                    }
                  />
                  <NumberControl
                    label="纹理尺度"
                    value={picked.settings.scale ?? 100}
                    min={1}
                    onChange={(scale) =>
                      patch(selected, { settings: { ...picked.settings, scale } })
                    }
                  />
                </>
              )}
            </>
          )}
        </aside>
      </div>
      {base !== context.snapshot.revision && (
        <p className="studio-error">工程已变化，请重新读取后编辑。</p>
      )}
      {error && <p className="studio-error">{error}</p>}
      <CandidateActions
        context={context}
        changeKey={`${revision}:${effectId}`}
        prepare={() =>
          context.run('effectGraphPlan', {
            revision: base,
            graph,
            ...(info?.resources?.[0] && effects.find((e) => e.id === effectId)?.source
              ? { source: info.resources[0].file, expectedHash: info.resources[0].hash }
              : {}),
            targets: [
              {
                ...scope,
                action: effectId ? 'update' : 'append',
                effectId: effectId || undefined,
                params: effects.find((e) => e.id === effectId)?.params ?? {},
                bindings,
              },
            ],
          })
        }
      />
    </>
  );
}
