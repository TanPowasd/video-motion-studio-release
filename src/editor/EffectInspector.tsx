import React from 'react';
import { effectSchema, type Effect, type Node } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
import { makeWarpGrid } from '../core/warp-grid.js';
const names: Record<Effect['type'], string> = {
  program:'自定义 Python / WGSL',
  gradientMap: '渐变映射',
  radialRays: '径向光束',
  bloom: '多级辉光',
  blur: '模糊',
  glow: '发光',
  color: '色彩调整',
  shadow: '投影',
  chromaKey: '颜色抠像',
  levels: '色阶',
  curves: '曲线调色',
  lut3d: '3D LUT',
  vignette: '暗角',
  grain: '颗粒',
  displacement: '程序化位移',
  pixelate: '像素化',
  waveWarp: '波形扭曲',
  twirl: '旋转扭曲',
  bulge: '膨胀/收缩',
  rgbSplit: 'RGB 分离',
  linearWipe: '线性擦除',
  radialWipe: '圆形展开',
  motionBlur: '运动模糊',
  echo: '时间拖尾',
  liquify: '液化笔刷场',
  effectGraph: '特效节点图',
  meshWarp: '网格变形',
  cornerPin: '四角透视',
};
const labels: Record<string, string> = {
  length: '延伸长度',
  decay: '衰减',
  samples: '采样数',
  levels: '光晕层数',
  radius: '半径',
  intensity: '强度',
  threshold: '亮部阈值',
  brightness: '亮度',
  contrast: '对比度',
  saturation: '饱和度',
  hue: '色相',
  blur: '模糊',
  x: '水平偏移',
  y: '垂直偏移',
  tolerance: '容差',
  softness: '柔和边缘',
  despill: '溢色抑制',
  inputBlack: '输入黑点',
  inputWhite: '输入白点',
  gamma: 'Gamma',
  outputBlack: '输出黑点',
  outputWhite: '输出白点',
  amount: '数量',
  amountX: '水平位移',
  amountY: '垂直位移',
  scale: '噪声尺度',
  seed: '随机种子',
  evolution: '演化',
  octaves: '细节层数',
  size: '尺寸',
  monochrome: '单色',
  animated: '逐帧变化',
};
const animatable = new Set([
  'length',
  'decay',
  'radius',
  'intensity',
  'threshold',
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'amount',
  'amountX',
  'amountY',
  'scale',
  'evolution',
  'size',
  'gamma',
  'inputBlack',
  'inputWhite',
  'outputBlack',
  'outputWhite',
  'tolerance',
  'softness',
  'despill',
  'blur',
  'x',
  'y',
]);
export function EffectInspector({
  node,
  frame,
  onChange,
  onKey,
}: {
  node: Node;
  frame: number;
  onChange: (patch: Partial<Node>) => unknown;
  onKey: (property: string) => void;
}) {
  const evaluated = evaluateNode(node, frame);
  function change(index: number, key: string, value: unknown) {
    const effects = structuredClone(node.effects),
      animations = structuredClone(node.animations);
    (effects[index] as any)[key] = value;
    const channel = animations.find((a) => a.property === `effects.${index}.${key}`);
    if (channel && typeof value === 'number') {
      const at = Math.round(frame);
      channel.keys = channel.keys.filter((k) => k.frame !== at);
      channel.keys.push({ frame: at, value, easing: 'easeInOut' });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
    onChange({ effects, animations });
  }
  function reorder(from: number, to: number) {
    if (to < 0 || to >= node.effects.length) return;
    const effects = [...node.effects];
    [effects[from], effects[to]] = [effects[to], effects[from]];
    const animations = node.animations.map((a) => {
      const match = /^effects\.(\d+)\.(.+)$/.exec(a.property);
      if (!match) return a;
      const index = Number(match[1]);
      return {
        ...a,
        property: `effects.${index === from ? to : index === to ? from : index}.${match[2]}`,
      };
    });
    onChange({ effects, animations });
  }
  function remove(index: number) {
    onChange({
      effects: node.effects.filter((_, i) => i !== index),
      animations: node.animations.flatMap((a) => {
        const match = /^effects\.(\d+)\.(.+)$/.exec(a.property);
        if (!match) return [a];
        const number = Number(match[1]);
        return number === index
          ? []
          : [{ ...a, property: `effects.${number > index ? number - 1 : number}.${match[2]}` }];
      }),
    });
  }
  return (
    <div className="effects-panel">
      <div className="effects-add">
        <select
          aria-label="添加效果"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            const type = event.target.value;
            const effect = effectSchema.parse(
              type === 'gradientMap'
                ? {
                    type,
                    stops: [
                      { offset: 0, color: '#16334e' },
                      { offset: 1, color: '#b7ead4' },
                    ],
                  }
                : type === 'meshWarp'
                  ? { type, columns: 2, rows: 2, points: makeWarpGrid(2, 2) }
                  : type === 'cornerPin'
                    ? {
                        type,
                        corners: [
                          { x: 0, y: 0 },
                          { x: 1, y: 0 },
                          { x: 1, y: 1 },
                          { x: 0, y: 1 },
                        ],
                      }
                    : type === 'glow'
                      ? { type, color: '#8aaeff', radius: 18 }
                      : type === 'blur'
                        ? { type, radius: 8 }
                        : type === 'shadow'
                          ? { type, color: '#000000', blur: 15, x: 8, y: 10 }
                          : type === 'chromaKey'
                            ? { type, color: '#00ff00' }
                            : type === 'curves'
                              ? {
                                  type,
                                  master: [
                                    { x: 0, y: 0 },
                                    { x: 0.5, y: 0.58 },
                                    { x: 1, y: 1 },
                                  ],
                                }
                              : { type },
            );
            onChange({ effects: [...node.effects, effect] });
          }}
        >
          <option value="">＋ 添加效果</option>
          {Object.entries(names)
            .filter(([key]) => key !== 'lut3d' && key !== 'effectGraph'&&key!=='program')
            .map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
      </div>
      {node.effects.length === 0 && <p className="hint">效果从上到下执行，可与参数关键帧组合。</p>}
      {evaluated.effects.map((effect, index) => (
        <div className="effect-card" key={index + effect.type}>
          <div className="effect-heading">
            <strong>
              {index + 1}. {names[effect.type]}
            </strong>
            <button
              title="效果上移"
              onClick={() => reorder(index, index - 1)}
              disabled={index === 0}
            >
              ↑
            </button>
            <button
              title="效果下移"
              onClick={() => reorder(index, index + 1)}
              disabled={index === node.effects.length - 1}
            >
              ↓
            </button>
            <button title="移除效果" onClick={() => remove(index)}>
              ×
            </button>
          </div>
          {effect.type === 'effectGraph' && (
            <div className="hint">
              <p className="mono">{effect.source ?? effect.graph?.name}</p>
              <p>
                {effect.graph ? `${effect.graph.nodes.length} 个节点 · ` : ''}参数：
                {Object.keys(effect.params).join('、') || '使用资源默认值'}
              </p>
              <p>打开顶部“创作工具 → 特效节点”编辑连线与参数。</p>
            </div>
          )}
          {Object.entries(effect)
            .filter(([key]) => key !== 'type')
            .map(([key, value]) =>
              typeof value === 'number' ? (
                <label className="number-field" key={key}>
                  <span>{labels[key] ?? key}</span>
                  <input
                    aria-label={`${names[effect.type]} ${labels[key] ?? key}`}
                    type="number"
                    step="any"
                    key={String(value)}
                    defaultValue={Number(value.toFixed(3))}
                    onBlur={(e) => {
                      const number = Number(e.target.value);
                      if (Number.isFinite(number) && number !== value) change(index, key, number);
                    }}
                  />
                  {animatable.has(key) &&
                    key !== 'columns' &&
                    key !== 'rows' &&
                    key !== 'samples' && (
                      <button
                        title={`${key} 添加关键帧`}
                        onClick={() => onKey(`effects.${index}.${key}`)}
                      >
                        ◇
                      </button>
                    )}
                </label>
              ) : typeof value === 'boolean' ? (
                <label className="effect-toggle" key={key}>
                  {labels[key] ?? key}
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => change(index, key, e.target.checked)}
                  />
                </label>
              ) : typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? (
                <label className="color-row" key={key}>
                  颜色
                  <input
                    aria-label={`${names[effect.type]} 颜色`}
                    type="color"
                    value={value}
                    onChange={(e) => change(index, key, e.target.value)}
                  />
                </label>
              ) : key === 'edge' ? (
                <label className="select-row" key={key}>
                  边缘
                  <select
                    value={String(value)}
                    onChange={(e) => change(index, key, e.target.value)}
                  >
                    <option value="transparent">透明</option>
                    <option value="clamp">延伸</option>
                    <option value="wrap">循环</option>
                  </select>
                </label>
              ) : key === 'master' || key === 'red' || key === 'green' || key === 'blue' ? (
                <label className="effect-data" key={key}>
                  {key}
                  <textarea
                    aria-label={`曲线 ${key}`}
                    defaultValue={JSON.stringify(value)}
                    onBlur={(e) => {
                      try {
                        change(index, key, JSON.parse(e.target.value));
                      } catch {
                        e.target.setCustomValidity('请输入有效 JSON 曲线');
                        e.target.reportValidity();
                      }
                    }}
                  />
                </label>
              ) : null,
            )}
        </div>
      ))}
    </div>
  );
}
