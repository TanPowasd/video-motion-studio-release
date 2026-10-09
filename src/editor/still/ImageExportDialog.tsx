import React, { useEffect, useState } from 'react';
import { Icon } from '../Icons.js';
import type { Scene, Snapshot } from '../../core/model.js';
import { renderSizeIssue, stillGuides } from '../../core/still.js';
import './still.css';

type Run = (method: string, params?: unknown) => Promise<any>;
type Exported = {
  variant: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  dpi: number | null;
  format: string;
};

const formats = [
  { id: 'png', label: 'PNG', hint: '无损 · 支持透明' },
  { id: 'jpeg', label: 'JPEG', hint: '体积小 · 不透明' },
  { id: 'webp', label: 'WebP', hint: '网页 · 支持透明' },
] as const;

export function ImageExportDialog({
  snapshot,
  scene,
  root,
  run,
  onClose,
}: {
  snapshot: Snapshot;
  scene: Scene;
  root: string;
  run: Run;
  onClose: () => void;
}) {
  const g = stillGuides(scene, snapshot.project);
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png'),
    [quality, setQuality] = useState(90),
    [scale, setScale] = useState(1),
    [transparent, setTransparent] = useState(g.still.transparent),
    [trim, setTrim] = useState(false),
    [variants, setVariants] = useState<string[]>([]),
    [output, setOutput] = useState(`${root}/exports/images`),
    [previews, setPreviews] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState<{ images: Exported[]; warnings?: string[] }>();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [busy, onClose]);
  useEffect(() => {
    let active = true;
    run('imageExport', {
      sceneId: scene.id,
      variants: 'all',
      preview: { maxSide: 160 },
      ...(transparent && format !== 'jpeg' ? { transparent: true } : { transparent: false }),
    })
      .then((result) => {
        if (active && result?.images)
          setPreviews(
            Object.fromEntries(result.images.map((i: { variant: string; dataUrl: string }) => [i.variant, i.dataUrl])),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [snapshot.revision, scene.id, transparent, format === 'jpeg']);
  const alpha = format !== 'jpeg';
  const main = {
    width: Math.round(g.width * scale) - (trim ? 2 * Math.round(g.still.bleed * scale) : 0),
    height: Math.round(g.height * scale) - (trim ? 2 * Math.round(g.still.bleed * scale) : 0),
  };
  const issue = renderSizeIssue(Math.round(g.width * scale), Math.round(g.height * scale), true);
  const dpi = Math.round(g.still.dpi * scale);
  const count = 1 + variants.length;
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await run('imageExport', {
        sceneId: scene.id,
        revision: snapshot.revision,
        format,
        quality,
        scale,
        transparent: alpha && transparent,
        trim,
        ...(variants.length ? { variants } : {}),
        output: count === 1 ? `${output}/${scene.name.replace(/[<>:"/\\|?*]+/g, '-')}${scale !== 1 ? `@${scale}x` : ''}${trim && g.still.bleed ? '-trim' : ''}.${format === 'jpeg' ? 'jpg' : format}` : output,
      });
      if (!result) throw new Error('导出失败，请查看工程诊断');
      setDone(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal still-export"
        role="dialog"
        aria-modal="true"
        aria-label="导出图片"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" aria-label="关闭导出图片" onClick={onClose} disabled={busy}>
          <Icon name="close" />
        </button>
        <span className="eyebrow">静态图片</span>
        <h2>导出图片</h2>
        <p>与预览使用同一原生渲染，按倍率重新绘制文字和矢量，不做放大插值。</p>
        {done ? (
          <div className="still-export-done">
            <div className="still-export-done-head">
              <Icon name="check" />
              已导出 {done.images.length} 张图片
            </div>
            <ul>
              {done.images.map((i) => (
                <li key={i.path}>
                  <span className="still-export-file" title={i.path}>
                    {i.path.split(/[\\/]/).at(-1)}
                  </span>
                  <span>
                    {i.width}×{i.height} · {(i.bytes / 1024).toFixed(0)} KB{i.dpi ? ` · ${i.dpi}dpi` : ''}
                  </span>
                  <button
                    className="subtle"
                    title="复制路径"
                    onClick={() => void navigator.clipboard?.writeText(i.path)}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                </li>
              ))}
            </ul>
            {done.warnings?.map((w) => (
              <p key={w} className="still-export-warning">
                {w}
              </p>
            ))}
            <div className="project-form-actions">
              <button className="secondary" onClick={() => setDone(undefined)}>
                继续导出
              </button>
              <button className="primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="still-export-body">
              <div className="still-export-preview">
                <div className={`still-export-thumb ${alpha && transparent ? 'checker' : ''}`}>
                  {previews.main ? <img src={previews.main} alt="导出预览" /> : <span>正在生成预览…</span>}
                </div>
                <strong>{scene.name}</strong>
                <small>
                  {main.width} × {main.height} px · {dpi} dpi
                </small>
              </div>
              <div className="still-export-options">
                <span className="still-field-label">格式</span>
                <div className="still-segment" role="radiogroup" aria-label="导出格式">
                  {formats.map((f) => (
                    <button
                      key={f.id}
                      role="radio"
                      aria-checked={format === f.id}
                      className={format === f.id ? 'active' : ''}
                      onClick={() => setFormat(f.id)}
                      title={f.hint}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                {format !== 'png' && (
                  <label className="still-range">
                    <span>
                      质量 <b>{quality}</b>
                    </span>
                    <input
                      aria-label="导出质量"
                      type="range"
                      min={40}
                      max={100}
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                    />
                  </label>
                )}
                <span className="still-field-label">倍率</span>
                <div className="still-segment" role="radiogroup" aria-label="导出倍率">
                  {[1, 2, 3].map((v) => (
                    <button
                      key={v}
                      role="radio"
                      aria-checked={scale === v}
                      className={scale === v ? 'active' : ''}
                      onClick={() => setScale(v)}
                    >
                      {v}x
                    </button>
                  ))}
                </div>
                <label className="still-check">
                  <input
                    type="checkbox"
                    checked={alpha && transparent}
                    disabled={!alpha}
                    onChange={(e) => setTransparent(e.target.checked)}
                  />
                  透明背景{alpha ? '' : '（JPEG 不支持）'}
                </label>
                {g.still.bleed > 0 && (
                  <label className="still-check">
                    <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
                    裁掉出血（{Math.round(g.still.bleed)}px）
                  </label>
                )}
              </div>
            </div>
            {g.still.variants.length > 0 && (
              <div className="still-export-variants">
                <span className="still-field-label">同时导出尺寸变体</span>
                <div className="still-variant-list">
                  {g.still.variants.map((v) => (
                    <label key={v.id} className={`still-variant ${variants.includes(v.id) ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={variants.includes(v.id)}
                        onChange={(e) =>
                          setVariants((list) =>
                            e.target.checked ? [...list, v.id] : list.filter((id) => id !== v.id),
                          )
                        }
                      />
                      <span className={`still-variant-thumb ${alpha && transparent ? 'checker' : ''}`}>
                        {previews[v.id] && <img src={previews[v.id]} alt="" />}
                      </span>
                      <span>
                        <strong>{v.name}</strong>
                        <small>
                          {Math.round(v.width * scale)}×{Math.round(v.height * scale)} ·{' '}
                          {v.fit === 'contain' ? '完整显示' : v.fit === 'cover' ? '裁切填满' : '重新排版'}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="modal-field">
              输出文件夹
              <input aria-label="输出文件夹" value={output} onChange={(e) => setOutput(e.target.value)} />
            </label>
            <div className="export-summary">
              <span>
                数量<strong>{count} 张</strong>
              </span>
              <span>
                尺寸<strong>{main.width} × {main.height}</strong>
              </span>
              <span>
                分辨率<strong>{format === 'webp' ? '—' : `${dpi} dpi`}</strong>
              </span>
            </div>
            {(issue || error) && (
              <p className="project-form-error" role="alert">
                {issue ? `${scale}x 超出图片像素预算：${issue}` : error}
              </p>
            )}
            <button className="primary modal-primary" disabled={busy || !!issue} onClick={start}>
              <Icon name="export" />
              {busy ? '正在导出…' : `导出 ${format.toUpperCase()}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
