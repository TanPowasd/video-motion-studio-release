import React, { useEffect, useState, useRef } from 'react';
import type { StudioContext } from './types.js';
export function NumberControl({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  commitOnBlur = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  commitOnBlur?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <label className="studio-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          const next = Number(text);
          if (text !== '' && Number.isFinite(next)) {
            if (commitOnBlur && next !== value) onChange(next);
            setText(String(next));
          } else setText(String(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') return;
          const v = Number(e.target.value);
          if (!commitOnBlur && Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}
export function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<string | [string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const [id, name] = typeof o === 'string' ? [o, o] : o;
          return (
            <option key={id} value={id}>
              {name}
            </option>
          );
        })}
      </select>
    </label>
  );
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="studio-toggle">
      <input
        aria-label={label}
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
export function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="color"
        value={/^#[\da-f]{6}$/i.test(value) ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function VectorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z?: number };
  onChange: (v: any) => void;
}) {
  return (
    <fieldset className="studio-vector">
      <legend>{label}</legend>
      {Object.entries(value).map(([axis, v]) => (
        <NumberControl
          key={axis}
          label={`${label} ${axis.toUpperCase()}`}
          value={v!}
          step={0.1}
          onChange={(next) => onChange({ ...value, [axis]: next })}
        />
      ))}
    </fieldset>
  );
}
export function PanelIntro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <header className="studio-intro">
      <h2>{title}</h2>
      <p>{children}</p>
    </header>
  );
}
export function EmptySelection() {
  return (
    <div className="studio-empty">
      <strong>先选择一个图层</strong>
      <p>在画布、图层列表或时间轴中选择对象，再打开此工具。</p>
    </div>
  );
}
export function CandidateActions({
  context,
  prepare,
  changeKey,
}: {
  context: StudioContext;
  prepare: () => Promise<any>;
  changeKey?: unknown;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState<{ plan: any; check: any; key: unknown }>();
  const liveKey = useRef(changeKey);
  liveKey.current = changeKey;
  useEffect(() => setReview(undefined), [changeKey]);
  const stale =
    review && (review.plan.baseRevision !== context.snapshot.revision || review.key !== changeKey);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="candidate-bar">
      <div className="candidate-buttons">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              setReview(undefined);
              const key = changeKey;
              const plan = await prepare();
              if (!plan?.candidate || !plan?.apply) throw new Error('未生成可提交的候选');
              const check = await context.run('projectPreflight', {
                ...plan.candidate,
                inline: true,
              });
              if (liveKey.current !== key) return;
              setReview({ plan, check, key });
              if (!check.valid)
                throw new Error(
                  (check.diagnostics ?? [])
                    .filter((d: any) => d.severity === 'error')
                    .map((d: any) => d.message)
                    .join('\n') || '候选未通过检查',
                );
            })
          }
        >
          {busy ? '正在检查…' : '预览修改'}
        </button>
        <button
          className="primary"
          disabled={busy || !review?.check.valid || !!stale}
          onClick={() =>
            void work(async () => {
              await context.run('projectApply', review!.plan.apply);
              context.onApplied();
            })
          }
        >
          应用修改
        </button>
        <span>保存后可一次撤销</span>
      </div>
      {stale && <p role="alert">工程已变化，请重新检查这份修改。</p>}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {review?.check.data && (
        <details open>
          <summary>候选画面</summary>
          <img alt="候选修改预览" src={`data:image/png;base64,${review.check.data}`} />
        </details>
      )}
    </div>
  );
}
export function ResultImage({ result, alt }: { result: any; alt: string }) {
  return result?.data ? (
    <img
      className="studio-evidence"
      alt={alt}
      src={`data:${result.mimeType ?? 'image/png'};base64,${result.data}`}
    />
  ) : null;
}
