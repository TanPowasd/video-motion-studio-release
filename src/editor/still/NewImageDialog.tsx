import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icons.js';
import {
  STILL_MAX_SIDE,
  renderSizeIssue,
  stillPresets,
  stillTemplates,
  type StillTemplateId,
} from '../../core/still.js';
import './still.css';

export type NewImageSettings = {
  name: string;
  preset?: string;
  width: number;
  height: number;
  template: StillTemplateId;
  directory?: string;
};

/** Thumbnail of a template laid out in the chosen aspect ratio (pure CSS, no render call). */
function TemplateThumb({ id, width, height }: { id: StillTemplateId; width: number; height: number }) {
  const ratio = width / height,
    w = ratio >= 1 ? 72 : Math.max(26, 72 * ratio),
    h = ratio >= 1 ? Math.max(20, 72 / ratio) : 72;
  return (
    <span className={`still-template-thumb t-${id}`} style={{ width: w, height: h }} aria-hidden>
      <i />
      <b />
      <em />
    </span>
  );
}

export function NewImageDialog({
  mode,
  onCancel,
  onSubmit,
  initialDirectory = '',
  pickDirectory,
}: {
  mode: 'project' | 'scene';
  onCancel: () => void;
  onSubmit: (settings: NewImageSettings) => Promise<void>;
  initialDirectory?: string;
  pickDirectory?: (current: string) => Promise<string | undefined>;
}) {
  const [name, setName] = useState(mode === 'project' ? '未命名图片' : '图片 1'),
    [preset, setPreset] = useState<string>('xiaohongshu'),
    [width, setWidth] = useState(1242),
    [height, setHeight] = useState(1660),
    [template, setTemplate] = useState<StillTemplateId>('poster'),
    [directory, setDirectory] = useState(initialDirectory),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => setDirectory((d) => d || initialDirectory), [initialDirectory]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [busy, onCancel]);
  const selected = stillPresets.find((p) => p.id === preset);
  const issue = useMemo(() => renderSizeIssue(width, height, true), [width, height]);
  const groups = ['社交', '视频', '通用', '印刷'] as const;
  const choose = (id: string) => {
    setPreset(id);
    const p = stillPresets.find((v) => v.id === id);
    if (p) {
      setWidth(p.width);
      setHeight(p.height);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!name.trim()) return setError('请输入名称');
    if (issue) return setError(`尺寸超出范围：${issue}`);
    if (mode === 'project' && !directory) return setError('请选择保存位置');
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        ...(preset !== 'custom' ? { preset } : {}),
        width,
        height,
        template,
        ...(mode === 'project' ? { directory } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form ref={formRef} className="new-project-form still-new" onSubmit={submit}>
      <div className="project-form-heading">
        <div>
          <span className="still-eyebrow">图片 · 海报 · 封面</span>
          <h2>新建图片</h2>
        </div>
        <button type="button" aria-label="关闭新建图片" disabled={busy} onClick={onCancel}>
          <Icon name="close" />
        </button>
      </div>
      <fieldset disabled={busy}>
        <div className="still-new-grid">
          <div className="still-new-sizes" role="radiogroup" aria-label="尺寸预设">
            {groups.map((group) => (
              <div key={group} className="still-preset-group">
                <span className="still-preset-group-label">{group}</span>
                <div className="still-preset-list">
                  {stillPresets
                    .filter((p) => p.group === group)
                    .map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        role="radio"
                        aria-checked={preset === p.id}
                        className={`still-preset ${preset === p.id ? 'active' : ''}`}
                        onClick={() => choose(p.id)}
                        title={p.note}
                      >
                        <span
                          className="still-preset-shape"
                          style={{
                            width: p.width >= p.height ? 28 : Math.max(10, (28 * p.width) / p.height),
                            height: p.height >= p.width ? 28 : Math.max(8, (28 * p.height) / p.width),
                          }}
                        />
                        <span className="still-preset-text">
                          <strong>{p.name}</strong>
                          <small>
                            {p.bleed ? `${p.width - 2 * p.bleed}×${p.height - 2 * p.bleed} · ${p.dpi}dpi` : `${p.width}×${p.height}`}
                          </small>
                        </span>
                      </button>
                    ))}
                  {group === '印刷' && (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={preset === 'custom'}
                      className={`still-preset ${preset === 'custom' ? 'active' : ''}`}
                      onClick={() => setPreset('custom')}
                    >
                      <span className="still-preset-shape custom" />
                      <span className="still-preset-text">
                        <strong>自定义</strong>
                        <small>任意宽高</small>
                      </span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="still-new-side">
            <label>
              {mode === 'project' ? '项目名称' : '画板名称'}
              <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            {mode === 'project' && (
              <label>
                保存位置
                <div className="project-directory">
                  <input value={directory} onChange={(e) => setDirectory(e.target.value)} />
                  {pickDirectory && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        try {
                          const value = await pickDirectory(directory);
                          if (value) setDirectory(value);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      浏览…
                    </button>
                  )}
                </div>
              </label>
            )}
            <div className="project-form-grid">
              <label>
                宽度 px
                <input
                  type="number"
                  min={16}
                  max={STILL_MAX_SIDE}
                  value={width}
                  onChange={(e) => {
                    setWidth(Number(e.target.value));
                    setPreset('custom');
                  }}
                />
              </label>
              <label>
                高度 px
                <input
                  type="number"
                  min={16}
                  max={STILL_MAX_SIDE}
                  value={height}
                  onChange={(e) => {
                    setHeight(Number(e.target.value));
                    setPreset('custom');
                  }}
                />
              </label>
            </div>
            <p className="project-form-hint">
              {selected && preset !== 'custom'
                ? selected.note
                : `最大边 ${STILL_MAX_SIDE}px，约 4800 万像素以内`}
              {selected?.bleed && preset !== 'custom' ? ' · 导出时可裁掉出血' : ''}
            </p>
            <span className="still-field-label">起始模板</span>
            <div className="still-templates" role="radiogroup" aria-label="起始模板">
              {stillTemplates.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  role="radio"
                  aria-checked={template === t.id}
                  className={`still-template ${template === t.id ? 'active' : ''}`}
                  onClick={() => setTemplate(t.id)}
                  title={t.description}
                >
                  <TemplateThumb id={t.id} width={width} height={height} />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </fieldset>
      {error && (
        <p className="project-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-form-actions">
        <span className="still-size-readout">
          {width} × {height} px{issue ? ' · 超出范围' : ''}
        </span>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy || !!issue}>
          {busy ? '正在创建…' : mode === 'project' ? '创建并打开' : '创建画板'}
        </button>
      </div>
    </form>
  );
}
