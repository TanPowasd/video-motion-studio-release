import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.js';
import { rpc } from './state/rpc-client.js';
import './plugin-manager.css';

type Call = (method: string, params?: unknown) => Promise<any>;
type Item = {
  id: string;
  name: string;
  version: string;
  origin: 'builtin' | 'project';
  enabled: boolean;
  tools: number;
  contributions?: number;
  categories?: string[];
  status?: 'ok' | 'warning' | 'error';
  pinned?: 'content' | 'manifest' | 'none';
  problems?: number;
  source?: string;
  runtime?: string;
  moduleTools?: number;
};
type Fix = {
  label: string;
  actions?: unknown[];
  install?: { id: string; range?: string };
  openFile?: string;
};
type Problem = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  id?: string;
  file?: string;
  dependency?: string;
  fixes: Fix[] | number;
};
type InstallSource =
  | { type: 'bundle'; path?: string; base64?: string; name?: string }
  | { type: 'folder'; path: string }
  | { type: 'git'; url: string; ref?: string; subdir?: string };

const CATEGORY_LABELS: Record<string, string> = {
  core: '工程',
  animation: '动画',
  composition: '合成',
  effects: '特效',
  vector: '矢量',
  drawing: '绘画',
  media: '素材',
  editing: '剪辑',
  audio: '声音',
  '3d': '三维',
  math: '数学',
  render: '渲染',
  recovery: '恢复',
};
const KIND_LABELS: Record<string, string> = {
  component: '组件',
  effectGraph: '效果图',
  motion: '动作',
  theme: '主题',
  sound: '声音',
  sceneTemplate: '场景模板',
};
const CHANGE_LABELS: Record<string, string> = {
  install: '新安装',
  upgrade: '升级',
  downgrade: '降级',
  reinstall: '重新安装',
  unchanged: '无变化',
};
const DEP_LABELS: Record<string, string> = {
  builtin: '内置满足',
  installed: '已安装',
  enable: '将启用',
  bundled: '随包安装',
  upgrade: '随包升级',
  missing: '缺失',
  conflict: '版本冲突',
};
const short = (hash?: string) => (hash ? hash.slice(0, 12) : '—');
const bytes = (n?: number) =>
  n === undefined
    ? ''
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
function paramSummary(definition: any) {
  if (!definition || typeof definition !== 'object') return '';
  const parts = [definition.type ?? 'any'];
  if (definition.default !== undefined) parts.push(`默认 ${JSON.stringify(definition.default)}`);
  if (definition.min !== undefined || definition.max !== undefined)
    parts.push(`${definition.min ?? '−∞'}…${definition.max ?? '∞'}`);
  if (Array.isArray(definition.options)) parts.push(definition.options.join(' / '));
  return parts.join(' · ');
}
function Badge({ tone = 'neutral', children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`vm-plg-badge ${tone}`}>{children}</span>;
}

export function PluginManager({
  run,
  revision,
  onClose,
  onOpenFile,
  initialView = 'list',
  client = rpc as Call,
}: {
  run: (method: string, params?: unknown) => Promise<any>;
  revision: string;
  onClose: () => void;
  onOpenFile?: (file: string) => void;
  initialView?: 'list' | 'install';
  client?: Call;
}) {
  const [items, setItems] = useState<Item[]>(),
    [problems, setProblems] = useState<Problem[]>([]),
    [loadError, setLoadError] = useState(''),
    [selectedId, setSelectedId] = useState<string>(),
    [detail, setDetail] = useState<any>(),
    [detailLoading, setDetailLoading] = useState(false),
    [query, setQuery] = useState(''),
    [origin, setOrigin] = useState<'all' | 'builtin' | 'project'>('all'),
    [state, setState] = useState<'all' | 'enabled' | 'disabled' | 'problems'>('all'),
    [category, setCategory] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false),
    [view, setView] = useState<'list' | 'install'>(initialView),
    [installHint, setInstallHint] = useState<{ id: string; range?: string }>();
  const dialogRef = useRef<HTMLElement>(null),
    listRef = useRef<HTMLDivElement>(null),
    searchRef = useRef<HTMLInputElement>(null),
    restore = useRef<HTMLElement | null>(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
  useEffect(() => {
    (initialView === 'install' ? undefined : searchRef.current)?.focus();
    const previous = restore.current;
    return () => previous?.focus?.();
  }, []);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const all: Item[] = [];
      let offset: number | undefined = 0,
        found: Problem[] = [];
      while (offset !== undefined) {
        const page: any = await client('pluginsInspect', { offset, limit: 50 });
        all.push(...page.items);
        if (page.problems) found = page.problems;
        offset = page.nextOffset;
      }
      setItems(all);
      setProblems(found);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [revision, load]);
  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        setDetail(await client('pluginsInspect', { id, includeParameters: true }));
      } catch (e) {
        setDetail({ error: (e as Error).message });
      } finally {
        setDetailLoading(false);
      }
    },
    [client],
  );
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [selectedId, view]);
  useEffect(() => {
    setConfirmRemove(false);
    if (selectedId) void loadDetail(selectedId);
    else setDetail(undefined);
  }, [selectedId, revision, loadDetail]);

  const categories = useMemo(
    () => [...new Set((items ?? []).flatMap((i) => i.categories ?? []))].sort(),
    [items],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (item) =>
        (origin === 'all' || item.origin === origin) &&
        (state === 'all' ||
          (state === 'enabled' && item.enabled) ||
          (state === 'disabled' && !item.enabled) ||
          (state === 'problems' && item.status && item.status !== 'ok')) &&
        (!category || item.categories?.includes(category)) &&
        (!q || `${item.id} ${item.name}`.toLowerCase().includes(q)),
    );
  }, [items, query, origin, state, category]);
  const filtering = !!query.trim() || origin !== 'all' || state !== 'all' || !!category;
  const resetFilters = () => {
    setQuery('');
    setOrigin('all');
    setState('all');
    setCategory('');
  };
  const project = filtered.filter((i) => i.origin === 'project'),
    builtin = filtered.filter((i) => i.origin === 'builtin'),
    ordered = [...project, ...builtin];
  useEffect(() => {
    if (items && !selectedId && ordered.length && view === 'list')
      setSelectedId((project[0] ?? ordered[0]).id);
  }, [items]);
  useEffect(() => {
    if (view === 'list' && items && ordered.length && !ordered.some((i) => i.id === selectedId))
      setSelectedId(ordered[0].id);
  }, [query, origin, state, category]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId ?? '')}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  async function commit(planned: any) {
    const check = await client('projectPreflight', planned.candidate);
    if (!check?.valid)
      throw new Error(
        (check?.diagnostics ?? [])
          .filter((d: any) => d.severity === 'error')
          .map((d: any) => d.message)
          .join('\n') || '预检未通过',
      );
    await client('projectApply', planned.apply);
    void run('state');
  }
  async function edit(actions: unknown[], label: string) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const planned = await client('pluginsPlan', { revision, actions });
      await commit(planned);
      setNotice(`${label}：已应用，可用 Ctrl+Z 撤销`);
      setConfirmRemove(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function undo() {
    setBusy('撤销');
    setError('');
    try {
      await client('undo');
      void run('state');
      setNotice('已撤销上一步');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function pack(id: string) {
    setBusy('打包');
    setError('');
    try {
      const result = await client('pluginsPack', { id, base64: true });
      const blob = new Blob([Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))], {
        type: 'application/zip',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${id}-${result.version}.vmplugin`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      setNotice(
        `已打包 ${result.plugins.length} 个插件（${bytes(result.bytes)}），保存于 ${result.output}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const openFile = (file: string) => {
    if (!onOpenFile) return;
    onOpenFile(file);
    onClose();
  };
  const runFix = (fix: Fix) => {
    if (fix.actions) void edit(fix.actions, fix.label);
    else if (fix.install) {
      setInstallHint(fix.install);
      setView('install');
    } else if (fix.openFile) openFile(fix.openFile);
  };

  const move = (delta: number) => {
    if (!ordered.length) return;
    const index = ordered.findIndex((i) => i.id === selectedId);
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))];
    setSelectedId(next.id);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const typing = (e.target as HTMLElement).closest('input,textarea,select');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmRemove) setConfirmRemove(false);
      else if (view === 'install') setView('list');
      else onClose();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog (simple focus trap).
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (view !== 'list') return;
    if (
      e.key === 'Enter' &&
      (e.target === listRef.current || e.target === searchRef.current) &&
      selectedId
    ) {
      e.preventDefault();
      mainRef.current
        ?.querySelector<HTMLElement>('.vm-plg-actions button, .vm-plg-fixes button, button')
        ?.focus();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (
      (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
      (!typing || typing === searchRef.current)
    ) {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      if (typing !== searchRef.current) listRef.current?.focus();
    } else if ((e.key === 'Home' || e.key === 'End') && !typing) {
      e.preventDefault();
      if (ordered.length) setSelectedId((e.key === 'Home' ? ordered[0] : ordered.at(-1)!).id);
    }
  };

  const projectCount = (items ?? []).filter((i) => i.origin === 'project').length;
  const row = (item: Item) => (
    <div
      key={item.id}
      role="option"
      id={`plg-${item.id}`}
      data-id={item.id}
      aria-selected={item.id === selectedId}
      className={`vm-plg-row${item.enabled ? '' : ' disabled'}`}
      onClick={() => {
        setView('list');
        setSelectedId(item.id);
      }}
    >
      <span className={`vm-plg-dot ${item.status ?? 'ok'}${item.enabled ? '' : ' off'}`} />
      <span className="vm-plg-row-main">
        <strong>{item.name}</strong>
        <code>
          {item.id} · {item.version}
        </code>
      </span>
      <span className="vm-plg-row-badges">
        {!item.enabled && <Badge>已禁用</Badge>}
        {item.pinned && item.pinned !== 'none' && (
          <span className="vm-plg-icon" title="已固定版本" aria-label="已固定版本">
            <Icon name="lock" size={13} />
          </span>
        )}
        {!!item.problems && (
          <Badge tone={item.status === 'error' ? 'danger' : 'warning'}>{item.problems}</Badge>
        )}
        <span className="vm-plg-count">
          {item.tools || !item.contributions ? `${item.tools} 工具` : `${item.contributions} 资源`}
        </span>
      </span>
    </div>
  );

  return (
    <div
      className="project-modal vm-plg-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="vm-plg"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="插件与创作包"
        onKeyDown={onKeyDown}
      >
        <header className="vm-plg-header">
          <div className="vm-plg-title">
            <Icon name="plug" size={18} />
            <div>
              <h2>插件与创作包</h2>
              <p>
                {items
                  ? `${projectCount} 个项目插件 · ${items.length - projectCount} 个内置模块`
                  : '正在读取插件…'}
                {problems.length > 0 && (
                  <button
                    className={`vm-plg-linkish ${problems.some((p) => p.severity === 'error') ? 'danger' : 'warning'}`}
                    onClick={() => setState('problems')}
                  >
                    {problems.some((p) => p.severity === 'error')
                      ? `${problems.length} 个问题`
                      : `${problems.length} 个提示`}
                  </button>
                )}
              </p>
            </div>
          </div>
          <div className="vm-plg-header-actions">
            <button
              className={view === 'install' ? 'primary pressed' : 'primary'}
              onClick={() => setView(view === 'install' ? 'list' : 'install')}
            >
              <Icon name="plus" size={14} /> 安装插件…
            </button>
            <button
              className="subtle"
              disabled={!!busy}
              onClick={() => void undo()}
              title="撤销上一步插件更改"
            >
              <Icon name="undo" size={14} /> 撤销
            </button>
            <button className="icon-button" aria-label="关闭" onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        <div className="vm-plg-body">
          <aside className="vm-plg-sidebar">
            <label className="vm-plg-search">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                aria-label="搜索插件"
                placeholder="搜索名称或 ID"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setView('list');
                }}
              />
              <kbd>/</kbd>
            </label>
            <div className="vm-plg-filters" role="group" aria-label="筛选">
              <div className="vm-plg-seg" role="radiogroup" aria-label="来源">
                {(
                  [
                    ['all', '全部'],
                    ['project', '项目'],
                    ['builtin', '内置'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={origin === value}
                    onClick={() => setOrigin(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                aria-label="状态"
                value={state}
                onChange={(e) => setState(e.target.value as any)}
              >
                <option value="all">全部状态</option>
                <option value="enabled">已启用</option>
                <option value="disabled">已禁用</option>
                <option value="problems">有问题</option>
              </select>
              <select
                aria-label="分类"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">全部分类</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
            </div>
            <div
              className="vm-plg-list"
              role="listbox"
              aria-label="插件列表"
              tabIndex={0}
              ref={listRef}
              aria-activedescendant={selectedId ? `plg-${selectedId}` : undefined}
            >
              {!items && !loadError && (
                <div className="vm-plg-skeleton" aria-busy="true">
                  {Array.from({ length: 6 }, (_, i) => (
                    <span key={i} />
                  ))}
                </div>
              )}
              {loadError && (
                <div className="vm-plg-state error" role="alert">
                  <strong>无法读取插件</strong>
                  <p>{loadError}</p>
                  <button onClick={() => void load()}>重试</button>
                </div>
              )}
              {items && !ordered.length && (
                <div className="vm-empty">
                  <Icon name={state === 'problems' ? 'check' : 'search'} size={22} />
                  <strong>{state === 'problems' ? '没有需要处理的问题' : '没有匹配的插件'}</strong>
                  <span>
                    {state === 'problems'
                      ? '所有插件的依赖与完整性检查都已通过。'
                      : '调整搜索或筛选条件。'}
                  </span>
                  <button className="secondary" onClick={resetFilters}>
                    清除筛选
                  </button>
                </div>
              )}
              {items && origin !== 'builtin' && (project.length > 0 || !filtering) && (
                <div className="vm-plg-group">项目插件 · {project.length}</div>
              )}
              {items && origin !== 'builtin' && !projectCount && !filtering && (
                <div className="vm-plg-inline-empty">
                  <span>此工程还没有项目插件。</span>
                  <button className="vm-plg-linkish" onClick={() => setView('install')}>
                    从文件、文件夹或 Git 安装
                  </button>
                </div>
              )}
              {project.map(row)}
              {builtin.length > 0 && (
                <div className="vm-plg-group">内置模块 · {builtin.length}</div>
              )}
              {builtin.map(row)}
            </div>
            <footer className="vm-plg-keys">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> 选择
              </span>
              <span>
                <kbd>/</kbd> 搜索
              </span>
              <span>
                <kbd>Esc</kbd> 关闭
              </span>
            </footer>
          </aside>
          <main className="vm-plg-main" ref={mainRef}>
            {view === 'install' ? (
              <InstallPanel
                client={client}
                revision={revision}
                hint={installHint}
                commit={commit}
                onDone={async (message, id) => {
                  setNotice(message);
                  setView('list');
                  setInstallHint(undefined);
                  await load();
                  if (id) setSelectedId(id);
                }}
                onCancel={() => {
                  setView('list');
                  setInstallHint(undefined);
                }}
              />
            ) : !selectedId || (items && !ordered.some((i) => i.id === selectedId)) ? (
              <div className="vm-empty vm-plg-placeholder">
                <Icon name="plug" size={28} />
                <strong>{selectedId ? '当前筛选下没有选中的插件' : '选择一个插件'}</strong>
                <span>查看版本、依赖、贡献、工具参数与完整性。</span>
              </div>
            ) : detailLoading && (!detail || detail.items?.[0]?.id !== selectedId) ? (
              <div
                className="vm-plg-detail-skeleton"
                aria-busy="true"
                aria-label="正在读取插件详情"
              >
                <span className="title" />
                <span />
                <span className="short" />
                <span className="block" />
                <span className="block" />
              </div>
            ) : detail?.error ? (
              <div className="vm-plg-state error" role="alert">
                <strong>无法读取插件详情</strong>
                <p>{detail.error}</p>
                <button onClick={() => void loadDetail(selectedId)}>重试</button>
              </div>
            ) : detail ? (
              <Detail
                loading={detailLoading}
                detail={detail}
                busy={busy}
                confirmRemove={confirmRemove}
                setConfirmRemove={setConfirmRemove}
                edit={edit}
                pack={pack}
                runFix={runFix}
                openFile={onOpenFile ? openFile : undefined}
                select={setSelectedId}
              />
            ) : null}
          </main>
        </div>
        {(error || notice || busy) && (
          <div
            className={`vm-plg-status ${error ? 'error' : busy ? 'busy' : 'ok'}`}
            role={error ? 'alert' : 'status'}
          >
            {busy ? (
              <span className="vm-plg-spinner" />
            ) : (
              <Icon name={error ? 'close' : 'check'} size={14} />
            )}
            <span>{error || (busy ? `${busy}：正在生成候选并预检…` : notice)}</span>
            {(error || notice) && !busy && (
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="vm-plg-section">
      <h4>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function Detail({
  loading,
  detail,
  busy,
  confirmRemove,
  setConfirmRemove,
  edit,
  pack,
  runFix,
  openFile,
  select,
}: {
  loading: boolean;
  detail: any;
  busy: string;
  confirmRemove: boolean;
  setConfirmRemove: (v: boolean) => void;
  edit: (actions: unknown[], label: string) => Promise<void>;
  pack: (id: string) => Promise<void>;
  runFix: (fix: Fix) => void;
  openFile?: (file: string) => void;
  select: (id: string) => void;
}) {
  const item: Item = detail.items[0];
  const project = item.origin === 'project',
    registration = detail.registration ?? {},
    pinned = registration.pinned && registration.pinned !== 'none',
    problems: Problem[] = detail.problems ?? [],
    known = !!detail.tools;
  const FileLink = ({ file }: { file: string }) =>
    openFile ? (
      <button className="vm-plg-file" onClick={() => openFile(file)} title="在代码工作区打开">
        <code>{file}</code>
      </button>
    ) : (
      <code className="vm-plg-file">{file}</code>
    );
  return (
    <div className={`vm-plg-detail${loading ? ' refreshing' : ''}`} aria-busy={loading}>
      <div className="vm-plg-detail-head">
        <div>
          <div className="vm-plg-detail-title">
            <h3>{item.name}</h3>
            <Badge tone="accent">v{item.version}</Badge>
            {project ? <Badge>项目插件</Badge> : <Badge>内置模块</Badge>}
            {!item.enabled && <Badge tone="warning">已禁用</Badge>}
            {item.status === 'error' && <Badge tone="danger">有错误</Badge>}
          </div>
          <code className="vm-plg-id">{item.id}</code>
          {detail.description && <p className="vm-plg-desc">{detail.description}</p>}
          {!project && (
            <p className="vm-plg-desc">
              内置模块随 Vmotion 发布，始终启用。已接入插件：{item.moduleTools} / {item.tools}{' '}
              个工具，由统一注册表分发（{item.runtime}）。
            </p>
          )}
        </div>
        {project && known && (
          <div className="vm-plg-actions">
            <button
              className={item.enabled ? 'secondary' : 'primary'}
              disabled={!!busy}
              onClick={() =>
                void edit(
                  [{ type: 'toggle', id: item.id, enabled: !item.enabled }],
                  item.enabled ? '禁用' : '启用',
                )
              }
            >
              {item.enabled ? '禁用' : '启用'}
            </button>
            <button
              className="secondary"
              disabled={!!busy}
              title={
                pinned
                  ? '允许修改源码，不再校验内容 hash'
                  : '固定当前内容 hash，修改源码前需解除固定'
              }
              onClick={() =>
                void edit(
                  [{ type: 'toggle', id: item.id, enabled: item.enabled, pin: !pinned }],
                  pinned ? '解除固定' : '固定版本',
                )
              }
            >
              <Icon name={pinned ? 'unlock' : 'lock'} size={13} />{' '}
              {pinned ? '解除固定' : '固定版本'}
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => void pack(item.id)}>
              <Icon name="export" size={13} /> 打包
            </button>
            {openFile && item.source && (
              <button className="secondary" onClick={() => openFile(item.source!)}>
                <Icon name="code" size={13} /> 打开清单
              </button>
            )}
            {confirmRemove ? (
              <span className="vm-plg-confirm" role="group" aria-label="确认移除">
                <span>移除注册？文件会保留。</span>
                <button
                  className="danger"
                  disabled={!!busy}
                  autoFocus
                  onClick={() => void edit([{ type: 'remove', id: item.id }], '移除注册')}
                >
                  确认移除
                </button>
                <button className="subtle" onClick={() => setConfirmRemove(false)}>
                  取消
                </button>
              </span>
            ) : (
              <button className="danger" disabled={!!busy} onClick={() => setConfirmRemove(true)}>
                <Icon name="delete" size={13} /> 移除
              </button>
            )}
          </div>
        )}
        {project && !known && (
          <div className="vm-plg-actions">
            <button
              className="danger"
              disabled={!!busy}
              onClick={() => void edit([{ type: 'remove', source: item.source }], '移除注册')}
            >
              移除注册（保留文件）
            </button>
          </div>
        )}
      </div>

      {problems.length > 0 && (
        <Section title="问题与修复" count={problems.length}>
          <ul className="vm-plg-problems">
            {problems.map((problem, index) => (
              <li key={index} className={problem.severity}>
                <div>
                  <strong>{problem.message}</strong>
                  <code>
                    {problem.code}
                    {problem.file ? ` · ${problem.file}` : ''}
                  </code>
                </div>
                {Array.isArray(problem.fixes) && problem.fixes.length > 0 && (
                  <div className="vm-plg-fixes">
                    {problem.fixes.map((fix, fixIndex) => (
                      <button
                        key={fix.label}
                        className={fixIndex === 0 ? 'primary' : 'secondary'}
                        disabled={!!busy || (!!fix.openFile && !openFile)}
                        onClick={() => runFix(fix)}
                      >
                        {fix.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {project && (detail.dependencyStatus?.length ?? 0) + (detail.dependents?.length ?? 0) > 0 && (
        <Section title="依赖" count={detail.dependencyStatus?.length ?? 0}>
          <table className="vm-plg-table">
            <thead>
              <tr>
                <th>插件</th>
                <th>要求</th>
                <th>当前</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {detail.dependencyStatus?.map((dep: any) => (
                <tr key={dep.id}>
                  <td>
                    <button
                      className="vm-plg-linkish"
                      onClick={() => dep.origin !== 'missing' && select(dep.id)}
                    >
                      {dep.id}
                    </button>
                  </td>
                  <td>
                    <code>{dep.range}</code>
                  </td>
                  <td>{dep.version ?? '—'}</td>
                  <td>
                    {dep.satisfied ? (
                      <Badge tone="success">{dep.origin === 'builtin' ? '内置' : '满足'}</Badge>
                    ) : dep.origin === 'missing' ? (
                      <Badge tone="danger">缺失</Badge>
                    ) : dep.enabled === false ? (
                      <Badge tone="warning">已禁用</Badge>
                    ) : (
                      <Badge tone="danger">不兼容</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.dependents?.length > 0 && (
            <p className="vm-plg-note">
              被依赖：
              {detail.dependents.map((d: any) => (
                <button key={d.id} className="vm-plg-linkish" onClick={() => select(d.id)}>
                  {d.id} <code>{d.range}</code>
                </button>
              ))}
            </p>
          )}
        </Section>
      )}
      {!project && Object.keys(detail.dependencies ?? {}).length > 0 && (
        <Section title="依赖">
          <div className="vm-plg-chips">
            {Object.entries(detail.dependencies).map(([id, range]) => (
              <span key={id} className="vm-plg-chip">
                {id} <code>{String(range)}</code>
              </span>
            ))}
          </div>
        </Section>
      )}

      {project && detail.contributions?.length > 0 && (
        <Section title="贡献资源" count={detail.contributions.length}>
          <ul className="vm-plg-cards">
            {detail.contributions.map((c: any) => (
              <li key={c.id}>
                <div className="vm-plg-card-head">
                  <strong>{c.name}</strong>
                  <Badge>{KIND_LABELS[c.kind] ?? c.kind}</Badge>
                </div>
                {c.description && <p>{c.description}</p>}
                <FileLink file={c.source} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {project && detail.tools?.length > 0 && (
        <Section title="工具" count={detail.tools.length}>
          <ul className="vm-plg-cards">
            {detail.tools.map((tool: any) => (
              <li key={tool.id}>
                <div className="vm-plg-card-head">
                  <code className="vm-plg-toolname">{tool.name}</code>
                  <Badge tone={tool.mode === 'plan' ? 'accent' : 'neutral'}>
                    {tool.mode === 'plan' ? '候选' : '查询'}
                  </Badge>
                  {tool.categories?.map((c: string) => (
                    <span key={c} className="vm-plg-cat">
                      {CATEGORY_LABELS[c] ?? c}
                    </span>
                  ))}
                </div>
                <p>{tool.description}</p>
                {tool.parameters && Object.keys(tool.parameters).length > 0 && (
                  <dl className="vm-plg-params">
                    {Object.entries(tool.parameters).map(([name, definition]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>{paramSummary(definition)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {tool.reads && Object.values(tool.reads).some(Boolean) && (
                  <p className="vm-plg-note">
                    读取上下文：
                    {Object.entries(tool.reads)
                      .filter(([, v]) => v)
                      .map(
                        ([k]) =>
                          ({ scenes: '场景', sequences: '序列', assets: '素材', files: '文件' })[
                            k
                          ] ?? k,
                      )
                      .join('、')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {!project && detail.capabilities?.length > 0 && (
        <Section title="能力" count={detail.capabilities.length}>
          <ul className="vm-plg-caps">
            {(
              detail.capabilityDetails ?? detail.capabilities.map((name: string) => ({ name }))
            ).map((cap: any) => (
              <li key={cap.name}>
                <div className="vm-plg-card-head">
                  <code className="vm-plg-toolname">{cap.name}</code>
                  {cap.readOnly !== undefined && (
                    <Badge tone={cap.readOnly ? 'neutral' : 'accent'}>
                      {cap.readOnly ? '只读' : '写入/候选'}
                    </Badge>
                  )}
                </div>
                {cap.description && <p>{cap.description}</p>}
                {cap.parameters?.length > 0 && (
                  <p className="vm-plg-note">参数：{cap.parameters.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {project && known && (
        <Section title="版本固定与完整性">
          <dl className="vm-plg-kv">
            <div>
              <dt>固定状态</dt>
              <dd>
                {registration.pinned === 'content' ? (
                  <Badge tone={registration.pinMatches === false ? 'danger' : 'success'}>
                    {registration.pinMatches === false ? '内容已变化' : '已固定内容'}
                  </Badge>
                ) : registration.pinned === 'manifest' ? (
                  <Badge tone="warning">仅固定清单（旧格式）</Badge>
                ) : (
                  <Badge>未固定，源码可直接修改</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt>内容 hash</dt>
              <dd>
                <code title={registration.contentHash}>{short(registration.contentHash)}</code>
              </dd>
            </div>
            <div>
              <dt>清单 hash</dt>
              <dd>
                <code title={registration.manifestHash}>{short(registration.manifestHash)}</code>
              </dd>
            </div>
            <div className="wide">
              <dt>清单</dt>
              <dd>
                <FileLink file={registration.source} />
              </dd>
            </div>
          </dl>
        </Section>
      )}
      {project && detail.files?.length > 0 && (
        <Section title="文件" count={detail.files.length}>
          <ul className="vm-plg-files">
            {detail.files.map((file: any) => (
              <li key={file.path}>
                <FileLink file={file.path} />
                <span>{file.missing ? <Badge tone="danger">缺失</Badge> : bytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function InstallPanel({
  client,
  revision,
  hint,
  commit,
  onDone,
  onCancel,
}: {
  client: Call;
  revision: string;
  hint?: { id: string; range?: string };
  commit: (planned: any) => Promise<void>;
  onDone: (message: string, id?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'bundle' | 'folder' | 'git' | 'register'>('bundle'),
    [path, setPath] = useState(''),
    [file, setFile] = useState<{ name: string; base64: string; size: number }>(),
    [url, setUrl] = useState(''),
    [ref, setRef] = useState(''),
    [subdir, setSubdir] = useState(''),
    [pin, setPin] = useState(false),
    [withDeps, setWithDeps] = useState(true),
    [allowDowngrade, setAllowDowngrade] = useState(false),
    [overwrite, setOverwrite] = useState(false),
    [preview, setPreview] = useState<any>(),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(
    () => setPreview(undefined),
    [kind, path, file, url, ref, subdir, pin, withDeps, allowDowngrade, overwrite],
  );
  const source = (): InstallSource | undefined =>
    kind === 'register'
      ? undefined
      : kind === 'bundle'
        ? file
          ? { type: 'bundle', base64: file.base64, name: file.name }
          : path.trim()
            ? { type: 'bundle', path: path.trim() }
            : undefined
        : kind === 'folder'
          ? path.trim()
            ? { type: 'folder', path: path.trim() }
            : undefined
          : url.trim()
            ? {
                type: 'git',
                url: url.trim(),
                ...(ref.trim() ? { ref: ref.trim() } : {}),
                ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
              }
            : undefined;
  const ready = kind === 'register' ? /^components\/.+\.json$/.test(path.trim()) : !!source();
  async function plan() {
    setBusy('正在读取并校验插件包…');
    setError('');
    try {
      if (kind === 'register') {
        const planned = await client('pluginsPlan', {
          revision,
          actions: [{ type: 'register', source: path.trim(), pin }],
        });
        const entry = planned.summary.plugins.find((p: any) => p.source === path.trim());
        setPreview({
          ...planned,
          summary: {
            ...planned.summary,
            install: {
              origin: { type: 'project', path: path.trim() },
              digest: entry?.contentHash,
              fileEdits: 0,
              root: entry?.id,
              dependencies: Object.entries(entry?.dependencies ?? {}).map(([id, range]) => ({
                from: entry.id,
                id,
                range,
                status: id.startsWith('vmotion.') ? 'builtin' : 'installed',
              })),
              skipped: [],
              plugins: [
                {
                  id: entry?.id,
                  name: entry?.name,
                  role: 'root',
                  change: 'install',
                  to: entry?.version,
                  source: path.trim(),
                  pinned: pin,
                  files: { added: 0, changed: 0, unchanged: entry?.files ?? 0, stale: [] },
                  tools: { added: [], removed: [] },
                  contributions: { added: [], removed: [] },
                },
              ],
            },
          },
        });
        return;
      }
      setPreview(
        await client('pluginsInstall', {
          revision,
          source: source(),
          ...(pin ? { pin: true } : {}),
          dependencies: withDeps ? 'bundled' : 'none',
          allowDowngrade,
          overwrite,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function apply() {
    setBusy('正在预检并应用候选…');
    setError('');
    try {
      await commit(preview);
      const root = preview.summary.install.plugins.find((p: any) => p.role === 'root');
      await onDone(
        `已${CHANGE_LABELS[root?.change] ?? '安装'} ${root?.id}@${root?.to}，可用 Ctrl+Z 撤销`,
        root?.id,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const pick = async () => {
    const desktop = window.vmotionDesktop;
    if (desktop?.pickPluginSource) {
      const picked = await desktop.pickPluginSource(kind === 'folder' ? 'folder' : 'file');
      if (picked) setPath(picked);
    }
  };
  const install = preview?.summary?.install;
  const upToDate =
    !!install &&
    install.fileEdits === 0 &&
    !pin &&
    install.plugins.every((p: any) => p.change === 'unchanged') &&
    !install.dependencies.some((d: any) => d.status === 'enable');
  return (
    <div className="vm-plg-install">
      <div className="vm-plg-detail-head">
        <div>
          <div className="vm-plg-detail-title">
            <h3>安装插件</h3>
          </div>
          <p className="vm-plg-desc">
            从 .vmplugin / .zip 包、本地文件夹或 Git
            仓库安装。先生成候选预览，确认版本差异后再预检并应用；整个安装可一次撤销。
          </p>
          {hint && (
            <p className="vm-plg-hint">
              需要依赖 <code>{hint.id}</code> {hint.range && <code>{hint.range}</code>}
              ，请选择包含它的插件包。
            </p>
          )}
        </div>
      </div>
      <div className="vm-plg-tabs" role="tablist" aria-label="安装来源">
        {(
          [
            ['bundle', '插件包文件'],
            ['folder', '文件夹'],
            ['git', 'Git 仓库'],
            ['register', '工程内清单'],
          ] as const
        ).map(([value, label], index) => (
          <button
            key={value}
            ref={index === 0 ? first : undefined}
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              setKind(value);
              setPath('');
              setFile(undefined);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="vm-plg-form">
        {kind === 'bundle' && (
          <>
            <label className="vm-plg-drop">
              <input
                type="file"
                accept=".vmplugin,.zip"
                onChange={async (e) => {
                  const chosen = e.target.files?.[0];
                  if (!chosen) return;
                  const buffer = new Uint8Array(await chosen.arrayBuffer());
                  let binary = '';
                  for (let i = 0; i < buffer.length; i += 0x8000)
                    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
                  setFile({ name: chosen.name, base64: btoa(binary), size: chosen.size });
                  setPath('');
                }}
              />
              <Icon name="folder" size={18} />
              <span>
                {file
                  ? `${file.name} · ${bytes(file.size)}`
                  : '拖放或点击选择 .vmplugin / .zip 文件'}
              </span>
            </label>
            <div className="vm-plg-field">
              <span>或本机路径</span>
              <div className="vm-plg-inline">
                <input
                  aria-label="插件包路径"
                  placeholder="D:\plugins\example.lab-1.0.0.vmplugin"
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setFile(undefined);
                  }}
                />
                {window.vmotionDesktop?.pickPluginSource && (
                  <button className="secondary" onClick={() => void pick()}>
                    浏览…
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        {kind === 'folder' && (
          <div className="vm-plg-field">
            <span>文件夹路径</span>
            <div className="vm-plg-inline">
              <input
                aria-label="插件文件夹路径"
                placeholder="包含 plugin.json 的文件夹，或解压后的 .vmplugin"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
              {window.vmotionDesktop?.pickPluginSource && (
                <button className="secondary" onClick={() => void pick()}>
                  浏览…
                </button>
              )}
            </div>
          </div>
        )}
        {kind === 'git' && (
          <>
            <div className="vm-plg-field">
              <span>仓库 URL</span>
              <input
                aria-label="Git 仓库 URL"
                placeholder="https://github.com/user/vmotion-plugin.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="vm-plg-grid2">
              <div className="vm-plg-field">
                <span>分支 / 标签 / 提交</span>
                <input
                  aria-label="Git 引用"
                  placeholder="main 或 v1.2.0"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </div>
              <div className="vm-plg-field">
                <span>子目录（可选）</span>
                <input
                  aria-label="仓库子目录"
                  placeholder="components/plugins/lab"
                  value={subdir}
                  onChange={(e) => setSubdir(e.target.value)}
                />
              </div>
            </div>
            <p className="vm-plg-note">使用本机 git 克隆；需要网络时由你显式发起，不会自动更新。</p>
          </>
        )}
        {kind === 'register' && (
          <div className="vm-plg-field">
            <span>注册工程中已有的插件清单（components/ 下的 JSON）</span>
            <input
              aria-label="插件清单路径"
              placeholder="components/plugins/package/plugin.json"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
        )}
        <div className="vm-plg-options">
          <label>
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />{' '}
            固定版本（内容 hash）
          </label>
          <label>
            <input
              type="checkbox"
              checked={withDeps}
              onChange={(e) => setWithDeps(e.target.checked)}
            />{' '}
            安装包内附带的依赖
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowDowngrade}
              onChange={(e) => setAllowDowngrade(e.target.checked)}
            />{' '}
            允许降级
          </label>
          <label>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />{' '}
            覆盖冲突文件
          </label>
        </div>
        <div className="vm-plg-form-actions">
          <button className="subtle" onClick={onCancel}>
            取消
          </button>
          <button
            className={preview ? 'secondary' : 'primary'}
            disabled={!ready || !!busy}
            onClick={() => void plan()}
          >
            生成候选预览
          </button>
        </div>
      </div>
      {busy && (
        <div className="vm-plg-state" aria-busy="true">
          <span className="vm-plg-spinner" /> {busy}
        </div>
      )}
      {error && (
        <div className="vm-plg-state error" role="alert">
          <strong>无法安装</strong>
          <p>{error}</p>
        </div>
      )}
      {install && (
        <div className="vm-plg-preview" aria-label="安装候选预览">
          <h4>
            候选预览
            <span>
              {install.fileEdits} 个文件变更 · 基于版本 <code>{short(preview.baseRevision)}</code>
            </span>
          </h4>
          <p className="vm-plg-note">
            来源：
            {install.origin.type === 'project'
              ? `工程文件 ${install.origin.path}`
              : install.origin.type === 'git'
                ? `${install.origin.url} @ ${String(install.origin.commit).slice(0, 10)}`
                : (install.origin.path ?? install.origin.name ?? '上传的插件包')}
            {' · '}包摘要 <code>{short(install.digest)}</code>
          </p>
          <ul className="vm-plg-cards">
            {install.plugins.map((p: any) => (
              <li key={p.id} className={`vm-plg-change ${p.change}`}>
                <div className="vm-plg-card-head">
                  <strong>{p.name}</strong>
                  <code>{p.id}</code>
                  <Badge
                    tone={
                      p.change === 'upgrade' || p.change === 'install'
                        ? 'success'
                        : p.change === 'downgrade'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {CHANGE_LABELS[p.change] ?? p.change}
                  </Badge>
                  {p.role === 'dependency' && <Badge>依赖</Badge>}
                  {p.pinned && <Badge tone="accent">将固定</Badge>}
                </div>
                <p className="vm-plg-version">
                  {p.from ? (
                    <>
                      <code>{p.from}</code> → <code>{p.to}</code>
                    </>
                  ) : (
                    <code>{p.to}</code>
                  )}
                  <span>
                    文件 +{p.files.added} ~{p.files.changed} ={p.files.unchanged}
                    {p.files.stale.length > 0 && ` · ${p.files.stale.length} 个旧文件保留`}
                  </span>
                </p>
                <p className="vm-plg-note">
                  安装到 <code>{p.source}</code>
                  {p.previousSource && (
                    <>
                      {' '}
                      （原 <code>{p.previousSource}</code>）
                    </>
                  )}
                </p>
                <div className="vm-plg-chips">
                  {p.tools.added.map((t: string) => (
                    <span key={'t+' + t} className="vm-plg-chip add">
                      + 工具 {t}
                    </span>
                  ))}
                  {p.tools.removed.map((t: string) => (
                    <span key={'t-' + t} className="vm-plg-chip remove">
                      − 工具 {t}
                    </span>
                  ))}
                  {p.contributions.added.map((t: string) => (
                    <span key={'c+' + t} className="vm-plg-chip add">
                      + 资源 {t}
                    </span>
                  ))}
                  {p.contributions.removed.map((t: string) => (
                    <span key={'c-' + t} className="vm-plg-chip remove">
                      − 资源 {t}
                    </span>
                  ))}
                  {Object.entries(p.dependencies ?? {}).map(([id, change]: [string, any]) => (
                    <span key={'d' + id} className="vm-plg-chip">
                      依赖 {id}: {change.from ?? '无'} → {change.to ?? '移除'}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {install.dependencies.length > 0 && (
            <table className="vm-plg-table">
              <thead>
                <tr>
                  <th>依赖</th>
                  <th>要求方</th>
                  <th>要求</th>
                  <th>版本</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {install.dependencies.map((d: any) => (
                  <tr key={d.from + d.id}>
                    <td>{d.id}</td>
                    <td>{d.from}</td>
                    <td>
                      <code>{d.range}</code>
                    </td>
                    <td>
                      {d.installedVersion ? `${d.installedVersion} → ` : ''}
                      {d.version ?? '—'}
                    </td>
                    <td>
                      <Badge
                        tone={
                          d.status === 'missing' || d.status === 'conflict' ? 'danger' : 'success'
                        }
                      >
                        {DEP_LABELS[d.status] ?? d.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {install.skipped.length > 0 && (
            <p className="vm-plg-note">
              工程中已有满足要求的版本，跳过包内副本：{install.skipped.join(', ')}
            </p>
          )}
          <div className="vm-plg-form-actions">
            <button className="subtle" onClick={() => setPreview(undefined)}>
              放弃候选
            </button>
            {upToDate && <span className="vm-plg-note">已是最新，无需应用。</span>}
            <button className="primary" disabled={!!busy || upToDate} onClick={() => void apply()}>
              预检并应用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
