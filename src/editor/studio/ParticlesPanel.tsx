import React, { useState } from 'react';
import { particleFieldSchema, particleState } from '../../core/particle-field.js';
import type { StudioContext } from './types.js';
import {
  CandidateActions,
  ColorControl,
  NumberControl,
  PanelIntro,
  SelectControl,
  Toggle,
  VectorControl,
} from './Controls.js';
export default function ParticlesPanel({ context }: { context: StudioContext }) {
  const [settings, setSettings] = useState(() =>
      particleFieldSchema.parse({
        origin: { x: context.snapshot.project.width / 2, y: context.snapshot.project.height / 2 },
      }),
    ),
    [name, setName] = useState('粒子场'),
    [glow, setGlow] = useState(true),
    [base] = useState(context.snapshot.revision);
  const patch = (p: any) => setSettings((s) => ({ ...s, ...p }));
  let state: ReturnType<typeof particleState> | undefined;
  try {
    state = particleState(
      settings,
      (context.frame * context.snapshot.project.fps.den) / context.snapshot.project.fps.num,
    );
  } catch {}
  const width = context.snapshot.project.width,
    height = context.snapshot.project.height;
  return (
    <>
      <PanelIntro title="粒子发射器">
        设置发射范围、运动与生命周期。下方是当前帧的位置示意，候选预览使用真实渲染。
      </PanelIntro>
      <div className="particles-layout">
        <div className="particle-diagram">
          <svg viewBox={`0 0 ${width} ${height}`} aria-label="粒子分布预览">
            <path
              className="particle-axis"
              d={`M0 ${settings.origin.y}H${width}M${settings.origin.x} 0V${height}`}
            />
            {state?.records.slice(0, 1000).map((p: any) => (
              <circle
                key={p.id}
                cx={p.x ?? p.position?.x}
                cy={p.y ?? p.position?.y}
                r={Math.max(2, p.radius ?? 4)}
                fill={p.color ?? settings.colors[0]}
                opacity={p.opacity ?? 0.7}
              />
            ))}
            <circle
              cx={settings.origin.x}
              cy={settings.origin.y}
              r={12}
              fill="none"
              stroke="#ffffff"
              strokeWidth={3}
            />
          </svg>
          <span>
            {state?.records.length ?? 0} 个活动粒子 · {context.frame.toFixed(0)} 帧
          </span>
        </div>
        <div className="studio-grid">
          <label className="studio-field">
            <span>发射器名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <SelectControl
            label="发射模式"
            value={settings.mode}
            options={[
              ['burst', '爆发'],
              ['continuous', '持续'],
            ]}
            onChange={(mode) => patch({ mode })}
          />
          <SelectControl
            label="发射形状"
            value={settings.emission}
            options={[
              ['point', '点'],
              ['box', '矩形'],
              ['disk', '圆盘'],
              ['line', '线'],
            ]}
            onChange={(emission) => patch({ emission })}
          />
          <SelectControl
            label="粒子形状"
            value={settings.shape}
            options={[
              ['circle', '圆'],
              ['square', '方块'],
              ['streak', '条纹'],
            ]}
            onChange={(shape) => patch({ shape })}
          />
          {(
            [
              'seed',
              'count',
              'rate',
              'maxAlive',
              'direction',
              'spread',
              'drag',
              'spin',
              'opacity',
              'endScale',
            ] as const
          ).map((key) => (
            <NumberControl
              key={key}
              label={
                {
                  seed: '随机种子',
                  count: '爆发数量',
                  rate: '每秒发射',
                  maxAlive: '活动数量上限',
                  direction: '方向角度',
                  spread: '扩散角度',
                  drag: '阻力',
                  spin: '自转速度',
                  opacity: '透明度',
                  endScale: '结束缩放',
                }[key]
              }
              value={settings[key]}
              step={['drag', 'opacity', 'endScale'].includes(key) ? 0.05 : 1}
              onChange={(v) => patch({ [key]: v })}
            />
          ))}
          {(['speed', 'lifetime', 'size'] as const).map((key) => (
            <fieldset key={key}>
              <legend>{{ speed: '速度', lifetime: '寿命（秒）', size: '尺寸' }[key]}</legend>
              {(['min', 'max'] as const).map((side) => (
                <NumberControl
                  key={side}
                  label={`${key} ${side}`}
                  value={settings[key][side]}
                  step={key === 'lifetime' ? 0.1 : 1}
                  onChange={(v) => patch({ [key]: { ...settings[key], [side]: v } })}
                />
              ))}
            </fieldset>
          ))}
          <VectorControl
            label="发射中心"
            value={settings.origin}
            onChange={(origin) => patch({ origin })}
          />
          <VectorControl
            label="发射范围"
            value={settings.area}
            onChange={(area) => patch({ area })}
          />
          <VectorControl
            label="重力"
            value={settings.gravity}
            onChange={(gravity) => patch({ gravity })}
          />
          <ColorControl
            label="粒子颜色"
            value={settings.colors[0]}
            onChange={(color) => patch({ colors: [color, ...settings.colors.slice(1)] })}
          />
          <Toggle label="添加发光" value={glow} onChange={setGlow} />
        </div>
      </div>
      <CandidateActions
        context={context}
        changeKey={JSON.stringify([settings, name, glow])}
        prepare={() =>
          context.run('particlesPlan', {
            revision: base,
            sceneId: context.sceneId,
            path: context.path,
            contextFrames: context.contextFrames,
            frame: context.frame,
            name,
            settings,
            effects: glow
              ? [{ type: 'glow', radius: 10, color: settings.colors[0], intensity: 0.8 }]
              : [],
          })
        }
      />
    </>
  );
}
