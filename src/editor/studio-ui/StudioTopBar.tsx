import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icons.js';
import { ProjectActions } from '../ProjectHome.js';
import { ThemeSwitch } from '../ThemeSwitch.js';
import { MODES, type StudioMode } from './model.js';
import { formatAgo, prettyClient } from './change-feed.js';

export interface AgentStatus {
  hold: boolean;
  clients: Array<{ client: string; lastSeen: number; active: boolean }>;
}
export interface Crumb {
  label: string;
  onClick?: () => void;
}
export interface MoreAction {
  id: string;
  label: string;
  icon: string;
  keys?: string;
  pressed?: boolean;
  run: () => void;
}

/**
 * Studio top bar: identity + breadcrumb, the six-mode switcher, and the human-in-the-loop
 * status (MCP connection, file watching, follow AI) next to preview/export.
 */
export function StudioTopBar({
  projectName,
  crumbs,
  mode,
  workspace,
  onMode,
  onSubWorkspace,
  agents,
  lastExternal,
  now,
  followAi,
  onFollowAi,
  previewing,
  onPreview,
  onExport,
  exportLabel,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saving,
  error,
  onPlugin,
  onError,
  onPause,
  more,
}: {
  projectName: string;
  crumbs: Crumb[];
  mode: StudioMode;
  workspace: string;
  onMode: (mode: StudioMode) => void;
  onSubWorkspace: (id: 'drawing' | 'code') => void;
  agents?: AgentStatus;
  /** Most recent external (file/MCP) change, for the file-watch pill. */
  lastExternal?: { at: number; label: string };
  now: number;
  followAi: boolean;
  onFollowAi: (value: boolean) => void;
  previewing: boolean;
  onPreview: () => void;
  onExport: () => void;
  exportLabel?: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  saving: boolean;
  error: string;
  onPlugin: () => void;
  onError: (message: string) => void;
  onPause: () => void;
  more: MoreAction[];
}) {
  const active = agents?.clients.filter((c) => c.active) ?? [],
    connected = active.length > 0,
    client = connected ? prettyClient(active[0].client) : undefined;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', escape);
    };
  }, [menu]);
  const sub = workspace === 'code' || workspace === 'drawing';
  return (
    <header className="topbar studio-topbar">
      <div className="st-identity">
        <div className="st-logo" title="Vmotion Studio" aria-hidden>
          <i />
        </div>
        <ProjectActions onError={onError} onPause={onPause} />
        <strong className="st-project" title={projectName}>
          {projectName}
        </strong>
        <nav className="st-crumbs" aria-label="当前位置">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span className="st-crumb-sep">{i === 0 ? '/' : '·'}</span>
              {c.onClick ? (
                <button className="st-crumb" onClick={c.onClick} title={c.label}>
                  {c.label}
                </button>
              ) : (
                <span className="st-crumb current" title={c.label}>
                  {c.label}
                </span>
              )}
            </React.Fragment>
          ))}
        </nav>
      </div>
      <nav className="workspaces st-modes" aria-label="创作模式">
        <div className="st-mode-pill" role="tablist">
          {MODES.map((m) => {
            const on = !sub && m.id === mode;
            return (
              <button
                key={m.id}
                role="tab"
                aria-selected={on}
                className={on ? 'active' : ''}
                data-mode={m.id}
                title={`${m.name} · ${m.hint} · ${m.keys}`}
                onClick={() => onMode(m.id)}
              >
                <Icon name={m.icon} size={14} />
                <span className="st-mode-label">{m.name}</span>
              </button>
            );
          })}
        </div>
        <div className="st-sub" role="group" aria-label="更多工作区">
          <button
            className={workspace === 'drawing' ? 'active' : ''}
            title="逐帧绘画（画稿）"
            onClick={() => onSubWorkspace('drawing')}
          >
            <Icon name="brush" size={13} />
            <span className="st-mode-label">绘画</span>
          </button>
          <button
            className={workspace === 'code' ? 'active' : ''}
            title="TypeScript 组件代码"
            onClick={() => onSubWorkspace('code')}
          >
            <Icon name="code" size={13} />
            <span className="st-mode-label">代码</span>
          </button>
        </div>
      </nav>
      <div className="st-status">
        <button
          className={`st-pill st-mcp ${connected ? 'on' : ''} ${agents?.hold ? 'held' : ''}`}
          aria-label="连接 MCP"
          title={
            connected
              ? `${client} 通过 MCP 连接本工程${agents?.hold ? '（已暂停 AI 修改）' : ''} · 点击查看连接配置`
              : '没有外部 AI 连接 · 点击复制 MCP 配置'
          }
          onClick={() => window.dispatchEvent(new Event('vmotion:connect-mcp'))}
        >
          <i className="st-dot" />
          {connected ? (
            <>
              <span className="st-pill-strong">{client}</span>
              <span className="st-pill-muted">{agents?.hold ? '已暂停' : '已连接 · MCP'}</span>
            </>
          ) : (
            <span className="st-pill-muted">未连接 · MCP</span>
          )}
        </button>
        <span
          className="st-pill st-watch"
          title="工程目录中的 JSON / TypeScript 被外部修改时会自动同步，并记入改动记录"
          role="status"
        >
          <span className="st-pill-muted">监听文件</span>
          <span className="st-pill-mono">
            {lastExternal
              ? `${lastExternal.label.split('/').at(-1)} · ${formatAgo(now - lastExternal.at)}`
              : 'scenes/*.json'}
          </span>
        </span>
        <label className={`st-follow ${followAi ? 'on' : ''}`} title="外部 AI 改动后，自动跳到对应场景、对象和时间">
          <span>跟随 AI</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="跟随 AI"
            checked={followAi}
            onChange={(e) => onFollowAi(e.target.checked)}
          />
          <i aria-hidden />
        </label>
      </div>
      <div className="st-actions">
        <span className={`st-save ${saving ? 'saving' : ''} ${error ? 'error' : ''}`} role="status" title={error || (saving ? '正在保存' : '已保存到本地')}>
          <i />
        </span>
        <button className="icon-button" aria-label="Undo" title="撤销 · Ctrl+Z" disabled={!canUndo} onClick={onUndo}>
          <Icon name="undo" size={16} />
        </button>
        <button className="icon-button" aria-label="Redo" title="重做 · Ctrl+Shift+Z" disabled={!canRedo} onClick={onRedo}>
          <Icon name="redo" size={16} />
        </button>
        <button className="icon-button" aria-label="插件管理" title="插件管理" onClick={onPlugin}>
          <Icon name="plug" size={16} />
        </button>
        <div className="st-more" ref={menuRef}>
          <button
            className="icon-button"
            aria-label="更多"
            aria-expanded={menu}
            title="命令、面板、设置"
            onClick={() => setMenu((v) => !v)}
          >
            <span className="st-ellipsis">⋯</span>
          </button>
          {menu && (
            <div className="st-menu" role="menu">
              <div className="st-menu-theme" role="group" aria-label="外观">
                <span>外观</span>
                <ThemeSwitch />
              </div>
              {more.map((a) => (
                <button
                  key={a.id}
                  role="menuitemcheckbox"
                  aria-checked={a.pressed}
                  onClick={() => {
                    setMenu(false);
                    a.run();
                  }}
                >
                  <Icon name={a.icon} size={14} />
                  <span>{a.label}</span>
                  {a.pressed !== undefined && <b className={a.pressed ? 'on' : ''} />}
                  {a.keys && <kbd>{a.keys}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className={`st-preview ${previewing ? 'on' : ''}`} title="全屏预览播放 · Esc 退出" onClick={onPreview}>
          {previewing ? '退出预览' : '预览'}
          <Icon name={previewing ? 'close' : 'play'} size={12} />
        </button>
        <button className="primary st-export" title="导出视频、图像序列、音频或图片" onClick={onExport}>
          {exportLabel ?? '导出'}
        </button>
      </div>
    </header>
  );
}
