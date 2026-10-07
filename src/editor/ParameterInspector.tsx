import React, { useState } from 'react';
import {
  resolveParameters,
  type Parameter,
  type ParameterDefinitions,
  parameterValue,
} from '../core/parameters.js';
type Update = (path: string, value: unknown) => Promise<unknown>;
type ArrayEdit = (
  action:
    | { type: 'insert' | 'remove'; path: string; index: number; value?: unknown }
    | { type: 'move'; path: string; from: number; to: number },
) => Promise<unknown>;
function Control({
  spec,
  path,
  value,
  onUpdate,
  onKey,
  onArray,
}: {
  spec: Parameter;
  path: string;
  value: unknown;
  onUpdate: Update;
  onKey: (path: string) => void;
  onArray: ArrayEdit;
}) {
  const [error, setError] = useState(''),
    [page, setPage] = useState(0),
    name = spec.label ?? path.split('.').at(-1)!,
    label = `参数 ${path}`;
  const commit = async (next: unknown) => {
    try {
      parameterValue(spec, next, `params.${path}`);
      setError('');
      await onUpdate(path, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const number = (field: string, numberSpec: Parameter, current: unknown) => (
    <Control
      key={field}
      spec={numberSpec}
      path={field}
      value={current}
      onUpdate={onUpdate}
      onKey={onKey}
      onArray={onArray}
    />
  );
  let content: React.ReactNode;
  if (spec.type === 'number')
    content = (
      <div className="parameter-number">
        <label>
          {name}
          <input
            aria-label={label}
            key={String(value)}
            type="number"
            defaultValue={Number(value)}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? (spec.integer ? 1 : 'any')}
            onBlur={(e) => {
              if (e.target.value !== '') {
                const next = Number(e.target.value);
                if (next !== value) void commit(next);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
        <button
          aria-label={`参数 ${path} 添加关键帧`}
          title="在当前帧添加关键帧"
          onClick={() => onKey(path)}
        >
          ◇
        </button>
      </div>
    );
  else if (spec.type === 'boolean')
    content = (
      <label className="parameter-check">
        <span>{name}</span>
        <input
          aria-label={label}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => void commit(e.target.checked)}
        />
      </label>
    );
  else if (spec.type === 'enum')
    content = (
      <label className="parameter-select">
        {name}
        <select
          aria-label={label}
          value={JSON.stringify(value)}
          onChange={(e) => void commit(JSON.parse(e.target.value))}
        >
          {spec.options.map((option) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  else if (spec.type === 'string' || spec.type === 'color')
    content = (
      <label className="parameter-string">
        <span>{name}</span>
        {spec.type === 'color' && (
          <input
            aria-label={`${label} 色板`}
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#ffffff'}
            onChange={(e) => void commit(e.target.value)}
          />
        )}
        <input
          aria-label={label}
          key={String(value)}
          defaultValue={String(value)}
          onBlur={(e) => {
            if (e.target.value !== value) void commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
    );
  else if (spec.type === 'vec2' || spec.type === 'vec3')
    content = (
      <details className="parameter-group" open>
        <summary>
          {name}
          <small>{spec.type}</small>
        </summary>
        {['x', 'y', ...(spec.type === 'vec3' ? ['z'] : [])].map((axis) =>
          number(
            `${path}.${axis}`,
            { type: 'number', min: spec.min, max: spec.max, step: spec.step },
            (value as Record<string, unknown>)[axis],
          ),
        )}
      </details>
    );
  else if (spec.type === 'object')
    content = (
      <details className="parameter-group" open>
        <summary>
          {name}
          <small>对象</small>
        </summary>
        {Object.entries(spec.properties).map(([key, child]) => (
          <Control
            key={key}
            spec={child}
            path={`${path}.${key}`}
            value={(value as Record<string, unknown>)[key]}
            onUpdate={onUpdate}
            onKey={onKey}
            onArray={onArray}
          />
        ))}
      </details>
    );
  else {
    const items = value as unknown[],
      start = Math.min(page * 20, Math.max(0, Math.ceil(items.length / 20) - 1) * 20);
    content = (
      <details className="parameter-group" open>
        <summary>
          {name}
          <small>{items.length} 项</small>
        </summary>
        {items.slice(start, start + 20).map((v, i) => (
          <div className="parameter-array-item" key={i + start}>
            <Control
              spec={spec.items}
              path={`${path}.${i + start}`}
              value={v}
              onUpdate={onUpdate}
              onKey={onKey}
              onArray={onArray}
            />
            <button
              aria-label={`上移 ${path}.${i + start}`}
              disabled={i + start === 0}
              onClick={() => onArray({ type: 'move', path, from: i + start, to: i + start - 1 })}
            >
              ↑
            </button>
            <button
              aria-label={`下移 ${path}.${i + start}`}
              disabled={i + start === items.length - 1}
              onClick={() => onArray({ type: 'move', path, from: i + start, to: i + start + 1 })}
            >
              ↓
            </button>
            <button
              aria-label={`移除 ${path}.${i + start}`}
              disabled={items.length <= (spec.minLength ?? 0)}
              onClick={() => onArray({ type: 'remove', path, index: i + start })}
            >
              ×
            </button>
          </div>
        ))}
        <div className="parameter-array-actions">
          <button
            disabled={items.length >= (spec.maxLength ?? 10000)}
            onClick={() => onArray({ type: 'insert', path, index: items.length })}
          >
            添加一项
          </button>
          {items.length > 20 && (
            <>
              <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {start + 1}–{Math.min(start + 20, items.length)}
              </span>
              <button disabled={start + 20 >= items.length} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </>
          )}
        </div>
        <details>
          <summary>JSON 编辑</summary>
          <textarea
            aria-label={`参数 ${path} JSON`}
            key={JSON.stringify(value)}
            defaultValue={JSON.stringify(value, null, 2)}
            onBlur={(e) => {
              try {
                const next = JSON.parse(e.target.value);
                if (JSON.stringify(next) !== JSON.stringify(value)) void commit(next);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          />
        </details>
      </details>
    );
  }
  return (
    <div className="parameter-control" title={spec.description}>
      {content}
      {error && <small className="parameter-error">{error}</small>}
    </div>
  );
}
export function ParameterInspector({
  specs,
  values,
  onUpdate,
  onKey,
  onReset,
  onArray,
}: {
  specs: ParameterDefinitions;
  values: Record<string, unknown>;
  onUpdate: Update;
  onKey: (path: string) => void;
  onReset: (path: string) => void;
  onArray: ArrayEdit;
}) {
  let resolved: Record<string, unknown>;
  try {
    resolved = resolveParameters(specs, values);
  } catch (e) {
    return <p className="parameter-error">{(e as Error).message}</p>;
  }
  return (
    <>
      {Object.entries(specs).map(([key, spec]) => (
        <div key={key} className="parameter-root">
          <Control
            spec={spec}
            path={key}
            value={resolved[key]}
            onUpdate={onUpdate}
            onKey={onKey}
            onArray={onArray}
          />
          <button
            className="parameter-reset"
            aria-label={`重置参数 ${key}`}
            onClick={() => onReset(key)}
          >
            重置
          </button>
          {spec.description && <small className="parameter-description">{spec.description}</small>}
        </div>
      ))}
    </>
  );
}
