import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyGlyphPlan,
  imageSrc,
  inspectGlyphs,
  previewGlyphPlan,
  type GlyphAdjust,
  type GlyphStyle,
  type InspectResult,
} from './glyph-api.js';
import './glyphs.css';

type Tab = 'coverage' | 'compose' | 'components' | 'glyphs' | 'style';
const tabs: Array<[Tab, string]> = [
  ['coverage', '覆盖率'],
  ['compose', '拼字'],
  ['components', '部件'],
  ['glyphs', '字形'],
  ['style', '笔画'],
];
const operators = ['⿰', '⿱', '⿲', '⿳', '⿴', '⿵', '⿶', '⿷', '⿸', '⿹', '⿺', '⿻'];
const operatorNames: Record<string, string> = {
  '⿰': '左右',
  '⿱': '上下',
  '⿲': '左中右',
  '⿳': '上中下',
  '⿴': '全包围',
  '⿵': '上三包',
  '⿶': '下三包',
  '⿷': '左三包',
  '⿸': '左上包',
  '⿹': '右上包',
  '⿺': '左下包',
  '⿻': '叠加',
};
const surround = new Set(['⿴', '⿵', '⿶', '⿷', '⿸', '⿹', '⿺']);

function useDebounced<T>(value: T, ms = 160) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlyphPanel({
  initialSet,
  sampleText,
  revision,
  onClose,
  onApplied,
}: {
  initialSet: string;
  sampleText: string;
  revision: string;
  onClose: () => void;
  onApplied: () => Promise<unknown>;
}) {
  const [setId, setSetId] = useState(initialSet),
    [tab, setTab] = useState<Tab>('coverage'),
    [info, setInfo] = useState<InspectResult>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0);
  const builtin = setId.startsWith('builtin:') || !!info?.sets.find((s) => s.id === setId)?.builtin;
  const dialogRef = useRef<HTMLDivElement>(null),
    /** Hand-off from coverage/list tabs to the 拼字 tab (read once when it mounts). */
    handoff = useRef<Handoff>({});
  const pick = (next: Handoff) => {
    handoff.current = next;
    setTab('compose');
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', listener);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onClose]);
  useEffect(() => {
    let alive = true;
    inspectGlyphs({ set: setId })
      .then((r) => alive && (setInfo(r), setError('')))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [setId, revision, version]);

  /** Built-in sets are read-only: the first edit creates an editable project set that extends it. */
  const editableId = useMemo(() => {
    if (!builtin) return setId;
    const ids = new Set(info?.sets.map((s) => s.id));
    let n = 1,
      id = 'my-glyphs';
    while (ids.has(id)) id = `my-glyphs-${++n}`;
    return id;
  }, [builtin, info, setId]);
  const createAction = builtin
    ? [{ action: 'create', id: editableId, name: '我的字形库', extends: setId.startsWith('builtin:') ? setId : `builtin:${setId}` }]
    : [];
  async function commit(actions: unknown[], message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await applyGlyphPlan({ set: editableId, actions: [...createAction, ...actions] });
      await onApplied();
      if (builtin) setSetId(editableId);
      setVersion((v) => v + 1);
      setNotice(message + (builtin ? `（已新建可编辑字形库 ${editableId}，继承 ${setId}）` : ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop glyph-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="glyph-panel" role="dialog" aria-label="字形面板" tabIndex={-1} ref={dialogRef}>
        <header className="glyph-panel-head">
          <div>
            <span className="glyph-eyebrow">偏旁部件拼字</span>
            <h2>字形</h2>
          </div>
          <select aria-label="当前字形库" value={setId} onChange={(e) => setSetId(e.target.value)}>
            {info?.sets.map((s) => (
              <option key={s.id} value={s.id} disabled={!!s.error}>
                {(s.name ?? s.id) + (s.builtin ? '（内置，只读）' : '')}
              </option>
            ))}
          </select>
          {info?.set && (
            <span className="glyph-meta">
              {info.set.components} 部件 · {info.set.glyphs} 字
            </span>
          )}
          <button type="button" className="glyph-close" aria-label="关闭" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        <nav className="glyph-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="glyph-body">
          {tab === 'coverage' && <CoverageTab setId={setId} sampleText={sampleText} revision={revision} version={version} onPick={(char) => pick({ char })} />}
          {tab === 'compose' && <ComposeTab setId={setId} busy={busy} builtin={builtin} handoff={handoff} onSave={(char, ids, adjust) => commit([{ action: 'setGlyph', char, glyph: adjust ? { ids, adjust: { '': adjust } } : ids }], `已保存「${char}」`)} />}
          {tab === 'components' && <ListTab setId={setId} kind="components" version={version} onPick={(id) => pick({ insert: id })} />}
          {tab === 'glyphs' && <ListTab setId={setId} kind="glyphs" version={version} onPick={(char, ids) => pick({ char, ids })} />}
          {tab === 'style' && info?.set && info.set.id === setId && (
            <StyleTab
              key={info.set.id + JSON.stringify(info.set.style)}
              setId={setId}
              style={info.set.style}
              sampleText={sampleText}
              createAction={createAction}
              editableId={editableId}
              busy={busy}
              onApply={(style) => commit([{ action: 'setStyle', style }], '已更新笔画参数')}
            />
          )}
        </div>
        <footer className="glyph-foot">
          {error ? <p className="glyph-error" role="alert">{error}</p> : notice ? <p className="glyph-notice">{notice}</p> : <p className="glyph-hint">编辑经过预检后一次写入，可撤销。完整的笔画编辑器将在后续版本提供。</p>}
        </footer>
      </div>
    </div>
  );
}
type Handoff = { char?: string; insert?: string; ids?: string };

function CoverageTab({ setId, sampleText, revision, version, onPick }: { setId: string; sampleText: string; revision: string; version: number; onPick: (char: string) => void }) {
  const [result, setResult] = useState<InspectResult>(),
    [scope, setScope] = useState<'project' | 'set'>('project'),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    inspectGlyphs({ project: true, ...(scope === 'set' ? { set: setId } : {}), limit: 200, ...(sampleText.trim() ? { set: setId, preview: sampleText.slice(0, 60), previewSize: 56 } : {}) })
      .then((r) => alive && (setResult(r), setError('')))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [setId, scope, revision, version, sampleText]);
  const reports = result?.project ?? [];
  return (
    <div className="glyph-coverage">
      <div className="glyph-toolbar">
        <label>
          <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> 工程中所有使用字形库的文字
        </label>
        <label>
          <input type="radio" checked={scope === 'set'} onChange={() => setScope('set')} /> 只看当前字形库
        </label>
      </div>
      {error && <p className="glyph-error">{error}</p>}
      {result?.data && (
        <figure className="glyph-sample">
          <figcaption>当前图层文字预览（红框 = 缺字）</figcaption>
          <img src={imageSrc(result.data)} alt="当前图层文字的字形预览" />
        </figure>
      )}
      {!reports.length && <p className="glyph-empty">工程中还没有文字图层或字幕使用字形库。在文字检查器中选择「字形库」即可开始。</p>}
      {reports.map((r) => (
        <section key={r.set} className="glyph-report">
          <header>
            <strong>{r.set}</strong>
            {r.error ? (
              <span className="glyph-bad">字形库缺失</span>
            ) : (
              <>
                <meter min={0} max={1} value={r.ratio ?? 0} />
                <span>
                  {Math.round((r.ratio ?? 0) * 1000) / 10}% · {r.coveredUnique}/{r.unique} 字 · {r.layers} 处
                </span>
              </>
            )}
          </header>
          {!!r.missing?.length && (
            <ul className="glyph-missing">
              {r.missing.map((m) => (
                <li key={m.char}>
                  <button type="button" onClick={() => onPick(m.char)} title={`${m.reason}${m.needs ? ' · 缺部件 ' + m.needs.join(' ') : ''}\n${(m.where ?? []).join('\n')}`}>
                    <b>{m.char}</b>
                    <small>×{m.count}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {r.missing && !r.missing.length && !r.error && <p className="glyph-ok">全部覆盖</p>}
        </section>
      ))}
    </div>
  );
}

function ComposeTab({ setId, busy, builtin, handoff, onSave }: { setId: string; busy: boolean; builtin: boolean; handoff: React.MutableRefObject<Handoff>; onSave: (char: string, ids: string, adjust?: GlyphAdjust) => void }) {
  const [expression, setExpression] = useState(() => handoff.current.ids ?? '⿰氵⿱木口'),
    [char, setChar] = useState(() => handoff.current.char ?? ''),
    [ratio, setRatio] = useState<number | undefined>(),
    [inner, setInner] = useState<[number, number, number, number] | undefined>(),
    [preview, setPreview] = useState<InspectResult>();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (handoff.current.insert) {
      const id = handoff.current.insert;
      setExpression((e) => e + (Array.from(id).length === 1 ? id : `{${id}}`));
    }
    handoff.current = {};
  }, []);
  const root = Array.from(expression.trim())[0] ?? '',
    adjust: GlyphAdjust | undefined =
      ratio !== undefined && (root === '⿰' || root === '⿱') ? { ratio } : inner && surround.has(root) ? { inner } : undefined,
    request = useDebounced(JSON.stringify({ expression, adjust }));
  useEffect(() => {
    const { expression: e, adjust: a } = JSON.parse(request);
    if (!e.trim()) return;
    let alive = true;
    inspectGlyphs({ set: setId, expression: e, ...(a ? { adjust: { '': a } } : {}), previewSize: 200 })
      .then((r) => alive && setPreview(r))
      .catch((err) => alive && setPreview({ sets: [], revision: '', expression: { ok: false, message: (err as Error).message } }));
    return () => {
      alive = false;
    };
  }, [request, setId]);
  const insert = (text: string) => {
    const el = inputRef.current,
      at = el?.selectionStart ?? expression.length;
    setExpression(expression.slice(0, at) + text + expression.slice(at));
    requestAnimationFrame(() => el?.setSelectionRange(at + text.length, at + text.length));
  };
  return (
    <div className="glyph-compose">
      <div className="glyph-compose-form">
        <label className="glyph-field">
          <span>IDS 拼字式</span>
          <input ref={inputRef} aria-label="IDS 拼字式" value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} />
        </label>
        <div className="glyph-operators" aria-label="结构">
          {operators.map((op) => (
            <button key={op} type="button" title={operatorNames[op]} onClick={() => insert(op)}>
              <span>{op}</span>
              <small>{operatorNames[op]}</small>
            </button>
          ))}
        </div>
        {(root === '⿰' || root === '⿱') && (
          <label className="glyph-field">
            <span>
              {root === '⿰' ? '左侧宽度' : '上部高度'} {ratio === undefined ? '（自动）' : `${Math.round(ratio * 100)}%`}
            </span>
            <input type="range" min={0.15} max={0.85} step={0.01} value={ratio ?? 0.5} onChange={(e) => setRatio(Number(e.target.value))} aria-label="分割比例" />
            {ratio !== undefined && (
              <button type="button" className="glyph-link" onClick={() => setRatio(undefined)}>
                恢复自动
              </button>
            )}
          </label>
        )}
        {surround.has(root) && (
          <div className="glyph-inner">
            <span>内部区域 {inner ? '' : '（自动）'}</span>
            {(['左', '上', '宽', '高'] as const).map((label, i) => (
              <label key={label}>
                {label}
                <input
                  type="range"
                  min={i < 2 ? 0 : 0.2}
                  max={i < 2 ? 0.6 : 1}
                  step={0.01}
                  value={(inner ?? [0.25, 0.25, 0.6, 0.6])[i]}
                  aria-label={`内部区域${label}`}
                  onChange={(e) => {
                    const next = [...(inner ?? [0.25, 0.25, 0.6, 0.6])] as [number, number, number, number];
                    next[i] = Number(e.target.value);
                    if (next[0] + next[2] > 1) next[2] = 1 - next[0];
                    if (next[1] + next[3] > 1) next[3] = 1 - next[1];
                    setInner(next);
                  }}
                />
              </label>
            ))}
            {inner && (
              <button type="button" className="glyph-link" onClick={() => setInner(undefined)}>
                恢复自动
              </button>
            )}
          </div>
        )}
        <div className="glyph-save">
          <label className="glyph-field">
            <span>保存为字符</span>
            <input aria-label="保存为字符" value={char} maxLength={4} onChange={(e) => setChar(e.target.value)} placeholder="例如 湘" />
          </label>
          <button type="button" className="primary" disabled={busy || !char.trim() || !preview?.expression?.ok} onClick={() => onSave(char.trim(), expression.trim(), adjust)}>
            {builtin ? '新建字形库并保存' : '保存到字形库'}
          </button>
        </div>
      </div>
      <figure className="glyph-live">
        {preview?.data && <img src={imageSrc(preview.data)} alt="拼字预览" />}
        <figcaption>
          {preview?.expression?.ok ? `部件：${preview.expression.leaves?.join(' ')}` : <span className="glyph-error">{preview?.expression?.message ?? '输入拼字式'}</span>}
        </figcaption>
      </figure>
    </div>
  );
}

function ListTab({ setId, kind, version, onPick }: { setId: string; kind: 'components' | 'glyphs'; version: number; onPick: (id: string, ids?: string) => void }) {
  const [result, setResult] = useState<InspectResult>(),
    [offset, setOffset] = useState(0),
    [filter, setFilter] = useState('');
  const limit = 96;
  useEffect(() => {
    let alive = true;
    inspectGlyphs({ set: setId, [kind]: true, offset, limit })
      .then(async (r) => {
        const keys = kind === 'components' ? r.components!.items.map((c) => c.id) : r.glyphs!.items.map((g) => g.char);
        const single = keys.filter((k) => Array.from(k).length === 1).join('');
        const sheet = single ? await inspectGlyphs({ set: setId, preview: single, previewSize: 56 }) : undefined;
        if (alive) setResult({ ...r, data: sheet?.data });
      })
      .catch(() => alive && setResult(undefined));
    return () => {
      alive = false;
    };
  }, [setId, kind, offset, version]);
  const items =
    kind === 'components'
      ? (result?.components?.items ?? []).map((c) => ({ key: c.id, label: c.name ?? c.ids ?? `${c.strokes} 笔`, ids: c.ids }))
      : (result?.glyphs?.items ?? []).map((g) => ({ key: g.char, label: g.ids ?? (g.explicit ? '路径' : ''), ids: g.ids }));
  const total = kind === 'components' ? result?.components?.total : result?.glyphs?.total;
  const shown = items.filter((i) => !filter || i.key.includes(filter) || i.label.includes(filter));
  return (
    <div className="glyph-list">
      <div className="glyph-toolbar">
        <input aria-label="筛选" placeholder="筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span>
          {offset + 1}–{Math.min(offset + limit, total ?? 0)} / {total ?? 0}
        </span>
        <button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - limit))}>
          上一页
        </button>
        <button type="button" disabled={offset + limit >= (total ?? 0)} onClick={() => setOffset(offset + limit)}>
          下一页
        </button>
      </div>
      {result?.data && <img className="glyph-sheet" src={imageSrc(result.data)} alt={kind === 'components' ? '部件预览' : '字形预览'} />}
      <ul className="glyph-items">
        {shown.map((i) => (
          <li key={i.key}>
            <button type="button" onClick={() => onPick(i.key, i.ids)} title={kind === 'components' ? '插入到拼字式' : '在拼字中编辑'}>
              <b>{i.key}</b>
              <small>{i.label}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StyleTab({ setId, style, sampleText, createAction, editableId, busy, onApply }: { setId: string; style: GlyphStyle; sampleText: string; createAction: unknown[]; editableId: string; busy: boolean; onApply: (style: GlyphStyle) => void }) {
  const [draft, setDraft] = useState(style),
    [image, setImage] = useState<string>(),
    [error, setError] = useState(''),
    sample = (sampleText.trim() || '明月照江河森林好想你').replace(/\s+/g, '').slice(0, 8),
    request = useDebounced(JSON.stringify(draft), 220);
  useEffect(() => {
    let alive = true;
    previewGlyphPlan({ set: editableId, actions: [...createAction, { action: 'setStyle', style: JSON.parse(request) }], preview: sample, previewSize: 112 })
      .then((r) => alive && (setImage(r.data), setError('')))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
    // createAction is derived from setId/editableId
  }, [request, setId, editableId, sample]);
  const slider = (key: keyof GlyphStyle, label: string, min: number, max: number, step: number, unit = '') => (
    <label className="glyph-field">
      <span>
        {label} <em>{Number(draft[key]).toFixed(step < 1 ? 2 : 0)}{unit}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={draft[key] as number} aria-label={label} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
    </label>
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(style);
  return (
    <div className="glyph-style">
      <div className="glyph-style-form">
        {slider('strokeWidth', '笔画粗细', 16, 200, 1)}
        {slider('roundness', '转角圆润', 0, 1, 0.01)}
        {slider('slant', '倾斜', -20, 20, 1, '°')}
        {slider('strokeScaling', '嵌套部件减细', 0, 1, 0.01)}
        <label className="glyph-field">
          <span>笔端</span>
          <select value={draft.cap} onChange={(e) => setDraft({ ...draft, cap: e.target.value as GlyphStyle['cap'], join: e.target.value === 'round' ? 'round' : 'miter' })}>
            <option value="round">圆头</option>
            <option value="square">方头</option>
            <option value="butt">平头</option>
          </select>
        </label>
        <div className="glyph-save">
          <button type="button" onClick={() => setDraft(style)} disabled={!changed || busy}>
            还原
          </button>
          <button type="button" className="primary" disabled={!changed || busy} onClick={() => onApply(draft)}>
            {createAction.length ? '新建字形库并应用' : '应用'}
          </button>
        </div>
      </div>
      <figure className="glyph-live">
        {image && <img src={imageSrc(image)} alt="笔画参数预览" />}
        <figcaption>{error ? <span className="glyph-error">{error}</span> : '预览（未保存）'}</figcaption>
      </figure>
    </div>
  );
}
