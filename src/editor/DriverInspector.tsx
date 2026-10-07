import React, { useState } from 'react';
import type { Node } from '../core/model.js';
import { NumberControl, SelectControl, Toggle } from './studio/Controls.js';
export function DriverInspector({
  node,
  onChange,
  onKey,
}: {
  node: Node;
  onChange: (patch: Partial<Node>) => unknown;
  onKey: (property: string) => void;
}) {
  const [property, setProperty] = useState('x'),
    [expression, setExpression] = useState('value + sin(time * 2) * 40'),
    [svg, setSvg] = useState('M0 0 C120 -80 240 80 360 0');
  const expressions = node.expressions ?? {};
  return (
    <div className="driver-controls">
      <details open>
        <summary>属性表达式</summary>
        {Object.entries(expressions).map(([key, source]) => (
          <label key={key} className="driver-expression">
            <span>
              {key}
              <button
                aria-label={`删除 ${key} 表达式`}
                onClick={() => {
                  const next = { ...expressions };
                  delete next[key];
                  onChange({ expressions: next });
                }}
              >
                ×
              </button>
            </span>
            <textarea
              aria-label={`${key} 属性表达式`}
              defaultValue={source}
              key={source}
              rows={3}
              spellCheck={false}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== source)
                  onChange({ expressions: { ...expressions, [key]: e.target.value } });
              }}
            />
          </label>
        ))}
        <div className="driver-add">
          <input
            aria-label="新表达式属性"
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            placeholder="x / opacity / rotation"
          />
          <textarea
            aria-label="新属性表达式"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            rows={2}
            spellCheck={false}
          />
          <button
            className="secondary"
            disabled={!property.trim() || !expression.trim()}
            onClick={() =>
              onChange({ expressions: { ...expressions, [property.trim()]: expression.trim() } })
            }
          >
            添加表达式
          </button>
        </div>
      </details>
      <details>
        <summary>布局约束</summary>
        {!node.layout ? (
          <button
            className="secondary"
            disabled={!!node.motionPath}
            onClick={() =>
              onChange({
                layout: {
                  reference: 'scene',
                  x: { at: 'center', self: 'center', offset: 0 },
                  y: { at: 'center', self: 'center', offset: 0 },
                },
              })
            }
          >
            添加居中布局
          </button>
        ) : (
          <>
            <SelectControl
              label="布局参考"
              value={typeof node.layout.reference === 'string' ? node.layout.reference : 'object'}
              options={['scene', 'parent', 'object']}
              onChange={(v) => {
                if (v !== 'object')
                  onChange({ layout: { ...node.layout!, reference: v as 'scene' | 'parent' } });
              }}
            />
            <input
              aria-label="布局参考图层 ID"
              placeholder="输入图层 ID 并失焦，可使用对象参考"
              defaultValue={
                typeof node.layout.reference === 'object' ? node.layout.reference.nodeId : ''
              }
              onBlur={(e) => {
                if (e.target.value)
                  onChange({ layout: { ...node.layout!, reference: { nodeId: e.target.value } } });
              }}
            />
            {(['x', 'y'] as const).map((axis) => {
              const anchor = node.layout![axis];
              return (
                <div key={axis}>
                  <Toggle
                    label={`${axis.toUpperCase()} 轴锚点`}
                    value={!!anchor}
                    onChange={(enabled) =>
                      onChange({
                        layout: {
                          ...node.layout!,
                          [axis]: enabled ? { at: 'center', self: 'center', offset: 0 } : undefined,
                        },
                      })
                    }
                  />
                  {anchor && (
                    <>
                      <SelectControl
                        label={`${axis.toUpperCase()} 参考锚点`}
                        value={anchor.at}
                        options={['start', 'center', 'end']}
                        onChange={(at) =>
                          onChange({
                            layout: { ...node.layout!, [axis]: { ...anchor, at } },
                          } as any)
                        }
                      />
                      <SelectControl
                        label={`${axis.toUpperCase()} 对象锚点`}
                        value={anchor.self}
                        options={['start', 'center', 'end']}
                        onChange={(self) =>
                          onChange({
                            layout: { ...node.layout!, [axis]: { ...anchor, self } },
                          } as any)
                        }
                      />
                      <NumberControl
                        commitOnBlur
                        label={`${axis.toUpperCase()} 布局偏移`}
                        value={anchor.offset}
                        onChange={(offset) =>
                          onChange({ layout: { ...node.layout!, [axis]: { ...anchor, offset } } })
                        }
                      />
                    </>
                  )}
                </div>
              );
            })}
            {(['width', 'height'] as const).map((axis) => {
              const size = node.layout![axis];
              return (
                <div key={axis}>
                  <Toggle
                    label={axis === 'width' ? '约束宽度' : '约束高度'}
                    value={!!size}
                    onChange={(enabled) =>
                      onChange({
                        layout: {
                          ...node.layout!,
                          [axis]: enabled ? { value: 0.5, unit: 'fraction', min: 0 } : undefined,
                          aspectRatio: enabled ? undefined : node.layout!.aspectRatio,
                        },
                      })
                    }
                  />
                  {size && (
                    <>
                      <NumberControl
                        commitOnBlur
                        label={axis === 'width' ? '布局宽度' : '布局高度'}
                        value={size.value}
                        min={0}
                        step={0.01}
                        onChange={(value) =>
                          onChange({ layout: { ...node.layout!, [axis]: { ...size, value } } })
                        }
                      />
                      <SelectControl
                        label={`${axis} 单位`}
                        value={size.unit}
                        options={[
                          ['fraction', '参考比例'],
                          ['pixels', '像素'],
                        ]}
                        onChange={(unit) =>
                          onChange({
                            layout: { ...node.layout!, [axis]: { ...size, unit } },
                          } as any)
                        }
                      />
                    </>
                  )}
                </div>
              );
            })}
            <button onClick={() => onChange({ layout: null })}>解除布局约束</button>
          </>
        )}
      </details>
      <details>
        <summary>曲线路径动作</summary>
        {!node.motionPath ? (
          <>
            <textarea
              aria-label="SVG 运动路径"
              value={svg}
              onChange={(e) => setSvg(e.target.value)}
              rows={3}
            />
            <button
              className="secondary"
              disabled={!!(node.layout?.x || node.layout?.y)}
              onClick={() =>
                onChange({
                  motionPath: {
                    path: svg,
                    useRendered: false,
                    progress: 0,
                    repeat: 'clamp',
                    autoRotate: true,
                    rotationOffset: 0,
                    anchor: 'center',
                    offsetX: 0,
                    offsetY: 0,
                  },
                })
              }
            >
              添加路径动作
            </button>
            {(node.layout?.x || node.layout?.y) && (
              <p className="hint">布局已控制位置。先解除位置锚点或布局约束，再添加路径动作。</p>
            )}
          </>
        ) : (
          <>
            {node.motionPath.path && (
              <textarea
                aria-label="编辑 SVG 运动路径"
                key={node.motionPath.path}
                defaultValue={node.motionPath.path}
                rows={3}
                onBlur={(e) =>
                  onChange({ motionPath: { ...node.motionPath!, path: e.target.value } })
                }
              />
            )}
            <div className="driver-path-plot">
              <svg viewBox="-40 -120 440 240">
                <path
                  d={node.motionPath.path ?? ''}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <NumberControl
              commitOnBlur
              label="路径进度"
              value={node.motionPath.progress}
              step={0.01}
              onChange={(progress) => onChange({ motionPath: { ...node.motionPath!, progress } })}
            />
            <button onClick={() => onKey('motionPath.progress')}>◇ 添加路径进度关键帧</button>
            <Toggle
              label="自动朝向"
              value={node.motionPath.autoRotate}
              onChange={(autoRotate) =>
                onChange({ motionPath: { ...node.motionPath!, autoRotate } })
              }
            />
            <SelectControl
              label="路径重复"
              value={node.motionPath.repeat}
              options={['clamp', 'loop', 'pingpong']}
              onChange={(repeat) =>
                onChange({ motionPath: { ...node.motionPath!, repeat } } as any)
              }
            />
            <NumberControl
              commitOnBlur
              label="朝向偏移"
              value={node.motionPath.rotationOffset}
              onChange={(rotationOffset) =>
                onChange({ motionPath: { ...node.motionPath!, rotationOffset } })
              }
            />
            <button onClick={() => onChange({ motionPath: null })}>解除路径动作</button>
          </>
        )}
      </details>
    </div>
  );
}
