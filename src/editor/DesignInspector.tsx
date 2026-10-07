import React, { useEffect, useState } from 'react';
import type { Node } from '../core/model.js';
export function DesignInspector({
  node,
  revision,
  sceneId,
  path,
  contextFrames,
  frame,
  rpc,
  onApplied,
}: {
  node: Node;
  revision: string;
  sceneId: string;
  path: string[];
  contextFrames: number[];
  frame: number;
  rpc: (method: string, params: unknown) => Promise<any>;
  onApplied: () => Promise<unknown>;
}) {
  const [theme, setTheme] = useState<any>(),
    [template, setTemplate] = useState<any>(),
    [templates, setTemplates] = useState<any[]>([]),
    [source, setSource] = useState(''),
    [links, setLinks] = useState('{}'),
    [version, setVersion] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const target = { sceneId, nodeId: node.id, path, contextFrames, frame };
  useEffect(() => {
    let alive = true;
    setError('');
    setTheme(undefined);
    setTemplate(undefined);
    if (node.theme)
      rpc('themeInspect', { target })
        .then((v) => {
          if (alive) setTheme(v);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    if (node.templateInstance) {
      rpc('templateInspect', { target })
        .then((v) => {
          if (alive) setTemplate(v);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
      rpc('templateInspect', {})
        .then((v) => {
          if (alive) setTemplates(v.templates.items);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }
    return () => {
      alive = false;
    };
  }, [node.id, revision]);
  async function plan(method: string, request: unknown) {
    setBusy(true);
    setError('');
    try {
      const p = await rpc(method, { revision, ...(request as object) }),
        check = await rpc('projectPreflight', p.candidate);
      if (!check.valid) throw new Error(check.diagnostics.map((d: any) => d.message).join('\n'));
      await rpc('projectApply', p.apply);
      await onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="design-inspector">
      <details>
        <summary>品牌主题 {node.theme ? '· 已关联' : ''}</summary>
        {theme?.fields?.map((f: any) => (
          <div className="theme-field" key={f.property}>
            <code>{f.property}</code>
            <small>
              {f.token} · {f.source}
            </small>
            <span>
              {typeof f.effective === 'object' ? JSON.stringify(f.effective) : String(f.effective)}
            </span>
          </div>
        ))}
        {node.theme ? (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void plan('themePlan', { targets: [{ ...target, action: 'clearLocal' }] })
              }
            >
              恢复跟随主题
            </button>
            <button
              disabled={busy}
              onClick={() => void plan('themePlan', { targets: [{ ...target, action: 'detach' }] })}
            >
              解除主题关联
            </button>
          </>
        ) : (
          <>
            <label>
              主题资源
              <input
                aria-label="主题资源路径"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="components/themes/brand.json"
              />
            </label>
            <label>
              属性 → Token
              <textarea
                aria-label="主题属性绑定"
                value={links}
                onChange={(e) => setLinks(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !source}
              onClick={() => {
                try {
                  const values = JSON.parse(links);
                  void plan('themePlan', { source, targets: [{ ...target, links: values }] });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              绑定主题
            </button>
          </>
        )}
      </details>
      {node.templateInstance && (
        <details>
          <summary>
            模板实例 ·{' '}
            {node.templateInstance.mode === 'local'
              ? '本地副本'
              : `v${template?.template?.version ?? '…'}`}
          </summary>
          {template && (
            <p>
              {template.template.name} · {template.template.capturedFiles} 个固定源文件
            </p>
          )}
          {node.templateInstance.mode === 'linked' && (
            <>
              <label>
                升级版本
                <select
                  aria-label="升级模板版本"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  <option value="">选择已发布版本</option>
                  {templates
                    .filter(
                      (t) =>
                        t.id === template?.template?.id && t.file !== node.templateInstance!.source,
                    )
                    .map((t) => (
                      <option key={t.file} value={t.file}>
                        v{t.version} · {t.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={busy || !version}
                onClick={() =>
                  void plan('templatePlan', { upgrades: [{ ...target, source: version }] })
                }
              >
                预检并升级实例
              </button>
              <button
                disabled={busy}
                onClick={() => void plan('templatePlan', { detach: [target] })}
              >
                建立可编辑本地副本
              </button>
            </>
          )}
          <small>参数与内部覆盖保留。版本源码更新需要发布新版本。</small>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
