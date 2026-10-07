import React, { useState } from 'react';
import type { Node } from '../core/model.js';
import type { GraphicsAction } from '../core/graphics-stack.js';
import type { PathTextInput } from '../core/typography-schema.js';
export function GraphicsInspector({
  node,
  onEdit,
}: {
  node: Node;
  onEdit: (request: {
    textActions?: GraphicsAction[];
    shapeActions?: GraphicsAction[];
    pathText?: PathTextInput | null;
  }) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!['text', 'rect', 'ellipse', 'path'].includes(node.type)) return null;
  const text = node.type === 'text',
    items = text ? node.textAnimators : node.shapeOperators;
  const edit = async (request: Parameters<typeof onEdit>[0]) => {
    setBusy(true);
    setError('');
    try {
      await onEdit(request);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action = (a: GraphicsAction) => edit(text ? { textActions: [a] } : { shapeActions: [a] });
  return (
    <details className="graphics-inspector">
      <summary>
        {text ? '文字范围动画 / 路径文字' : '形状算子栈'} · {items.length}
      </summary>
      {items.map((item, index) => (
        <div key={item.id} className="select-row">
          <label>
            <input
              type="checkbox"
              checked={item.enabled}
              disabled={busy}
              onChange={(e) =>
                void action({ type: 'toggle', target: { id: item.id }, enabled: e.target.checked })
              }
            />
            {'type' in item ? item.type : item.selector.unit} · {index + 1}
          </label>
          <button
            title="上移"
            disabled={busy || !index}
            onClick={() => void action({ type: 'move', target: { id: item.id }, to: index - 1 })}
          >
            ↑
          </button>
          <button
            title="下移"
            disabled={busy || index === items.length - 1}
            onClick={() => void action({ type: 'move', target: { id: item.id }, to: index + 1 })}
          >
            ↓
          </button>
          <button
            title="复制"
            disabled={busy}
            onClick={() => void action({ type: 'copy', target: { id: item.id } })}
          >
            ＋
          </button>
          <button
            title="删除"
            disabled={busy}
            onClick={() => void action({ type: 'remove', target: { id: item.id } })}
          >
            ×
          </button>
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void action({
            type: 'append',
            item: text
              ? {
                  id: crypto.randomUUID(),
                  selector: { unit: 'grapheme' },
                  values: { y: 24, opacity: 0 },
                }
              : { id: crypto.randomUUID(), type: 'round', radius: 12 },
          })
        }
      >
        {text ? '添加字素选择器' : '添加圆角算子'}
      </button>
      {text && (
        <label>
          路径文字 SVG
          <textarea
            aria-label="路径文字 SVG"
            key={node.pathText?.path ?? node.id}
            defaultValue={node.pathText?.path ?? ''}
            disabled={busy}
            onBlur={(e) => {
              const path = e.target.value.trim();
              if (path !== (node.pathText?.path ?? ''))
                void edit({ pathText: path ? { ...node.pathText, path } : null });
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
