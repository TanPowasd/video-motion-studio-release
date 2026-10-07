import React, { useEffect, useState, useRef } from 'react';
export function PluginManager({
  run,
  revision,
  onClose,
}: {
  run: (method: string, params?: unknown) => Promise<any>;
  revision: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<any>(),
    [selected, setSelected] = useState<any>(),
    [source, setSource] = useState(''),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) detail.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  async function load() {
    try {
      setReport(await run('pluginsInspect', { offset, limit: 16 }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [revision, offset]);
  async function edit(actions: unknown[]) {
    setBusy(true);
    setError('');
    try {
      const p = await run('pluginsPlan', { revision, actions });
      if (!p) throw new Error('无法生成插件候选');
      const check = await run('projectPreflight', p.candidate);
      if (!check?.valid)
        throw new Error(check?.diagnostics?.map((d: any) => d.message).join('\n') ?? '预检失败');
      await run('projectApply', p.apply);
      setSelected(undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-modal" role="dialog" aria-modal="true" aria-label="插件与创作包">
      <section className="plugin-manager">
        <header>
          <h2>插件与创作包</h2>
          <button onClick={onClose}>关闭</button>
        </header>
        <p>管理本地功能模块、组件和创作资源。</p>
        <div className="plugin-register">
          <input
            aria-label="插件清单路径"
            placeholder="components/plugins/package/plugin.json"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <button
            disabled={busy || !source}
            onClick={() => void edit([{ type: 'register', source }])}
          >
            注册本地插件
          </button>
        </div>
        <div className="plugin-list">
          {report?.items.map((p: any) => (
            <article key={p.id}>
              <button onClick={async () => setSelected(await run('pluginsInspect', { id: p.id }))}>
                <strong>{p.name}</strong>
                <code>
                  {p.id} · {p.version}
                </code>
              </button>
              <span>
                {p.origin === 'builtin' ? '内置' : '项目'} · {p.tools} 工具 ·{' '}
                {p.enabled ? '已启用' : '已禁用'}
              </span>
              {p.origin === 'project' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void edit([{ type: 'toggle', id: p.id, enabled: !p.enabled }])}
                  >
                    {p.enabled ? '禁用' : '启用'}
                  </button>
                  <button disabled={busy} onClick={() => void edit([{ type: 'remove', id: p.id }])}>
                    移除注册
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
        <footer>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 16))}>
            上一页
          </button>
          <span>{report?.total ?? 0} 个插件</span>
          <button disabled={!report?.nextOffset} onClick={() => setOffset(report.nextOffset)}>
            下一页
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              await run('undo');
              await load();
            }}
          >
            撤销
          </button>
        </footer>
        {selected && (
          <div className="plugin-detail" ref={detail}>
            <h3>{selected.items[0]?.name}</h3>
            {selected.items[0]?.origin === 'builtin' && (
              <p>
                已接入插件：{selected.items[0].moduleTools} / {selected.items[0].tools} 个工具
              </p>
            )}
            {selected.tools?.map((t: any) => (
              <p key={t.id}>
                <code>{t.name}</code> · {t.mode}
                <br />
                {t.description}
              </p>
            ))}
            {selected.contributions?.map((c: any) => (
              <p key={c.id}>
                {c.name} · {c.kind}
                <br />
                <code>{c.source}</code>
              </p>
            ))}
            {selected.capabilities?.map((name: string) => (
              <code key={name}>{name} </code>
            ))}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
