import React from 'react';
import type { Node } from '../core/model.js';
import { evaluateNode } from '../core/time.js';
export function MatrixInspector({
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
  const current = evaluateNode(node, frame);
  const change = (index: number, value: number) => {
    const matrix = [...node.matrix] as Node['matrix'],
      animations = structuredClone(node.animations);
    matrix[index] = value;
    const channel = animations.find((a) => a.property === `matrix.${index}`);
    if (channel) {
      const at = Math.round(frame);
      channel.keys = channel.keys.filter((k) => k.frame !== at);
      channel.keys.push({ frame: at, value, easing: 'easeInOut' });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
    return onChange({ matrix, animations });
  };
  return (
    <details className="matrix-inspector">
      <summary>高级变换 · 仿射矩阵</summary>
      <p className="hint">组合缩放、斜切与平移。常规变换在此矩阵之后作用。</p>
      <div className="field-grid">
        {['a · X→X', 'b · X→Y', 'c · Y→X', 'd · Y→Y', 'e · X 平移', 'f · Y 平移'].map(
          (label, index) => (
            <label className="number-field" key={index}>
              <span>{label}</span>
              <input
                aria-label={`矩阵 ${label}`}
                key={current.matrix[index]}
                type="number"
                step="any"
                defaultValue={Number(current.matrix[index].toFixed(5))}
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (
                    event.target.value.trim() &&
                    Number.isFinite(value) &&
                    value !== Number(current.matrix[index].toFixed(5))
                  )
                    change(index, value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <button
                type="button"
                title={`为矩阵 ${index} 添加关键帧`}
                onClick={() => onKey(`matrix.${index}`)}
              >
                ◇
              </button>
            </label>
          ),
        )}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange({
            matrix: [1, 0, 0, 1, 0, 0],
            animations: node.animations.filter((a) => !a.property.startsWith('matrix.')),
          })
        }
      >
        重置矩阵与动画
      </button>
    </details>
  );
}
