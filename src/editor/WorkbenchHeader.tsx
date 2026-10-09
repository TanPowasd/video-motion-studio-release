import React from 'react';
import { Icon } from './Icons.js';
import { ProjectActions } from './ProjectHome.js';
export const WORKSPACES = [
  { id: 'animation', icon: 'layers', name: '动画', keys: 'Ctrl+1' },
  { id: 'editing', icon: 'film', name: '剪辑', keys: 'Ctrl+2' },
  { id: 'music', icon: 'music', name: '音乐', keys: 'Ctrl+3' },
  { id: 'drawing', icon: 'brush', name: '绘画', keys: 'Ctrl+4' },
  { id: 'code', icon: 'code', name: '代码', keys: 'Ctrl+5' },
] as const;
/**
 * Single-row Studio title bar: identity + project on the left, the workspace switcher
 * in the middle, document state and global actions on the right.
 */
export function WorkbenchHeader({
  projectName,
  workspace,
  canUndo,
  canRedo,
  saving,
  error,
  showLeft,
  showRight,
  showTimeline,
  onWorkspace,
  onTools,
  onModal,
  onUndo,
  onRedo,
  onPlugin,
  onError,
  onPause,
  onLayout,
  onReset,
  onPalette,
  onShortcuts,
  exportLabel,
}: {
  projectName: string;
  workspace: string;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  error: string;
  showLeft: boolean;
  showRight: boolean;
  showTimeline: boolean;
  onWorkspace: (v: string) => void;
  onTools: () => void;
  onModal: (v: 'settings' | 'connect' | 'export') => void;
  onUndo: () => void;
  onRedo: () => void;
  onPlugin: () => void;
  onError: (e: string) => void;
  onPause: () => void;
  onLayout: (side: 'left' | 'right' | 'timeline') => void;
  onReset: () => void;
  onPalette: () => void;
  onShortcuts: () => void;
  /** Overrides the export button label (image mode shows 导出图片). */
  exportLabel?: string;
}) {
  return (
    <header className="topbar">
      <div className="topbar-start">
        <div className="brand" title="Vmotion Studio">
          <div className="brand-mark">V</div>
          <span className="brand-name">Vmotion</span>
        </div>
        <ProjectActions onError={onError} onPause={onPause} />
        <button className="project-title" title="工程设置" onClick={() => onModal('settings')}>
          <Icon name="folder" size={15} />
          <span className="project-title-name">{projectName}</span>
          <span className="tag">本地工程</span>
        </button>
      </div>
      <nav className="workspaces" aria-label="工作区">
        <div className="workspace-segment" role="group">
          {WORKSPACES.map(({ id, icon, name, keys }) => (
            <button
              key={id}
              className={workspace === id ? 'active' : ''}
              aria-pressed={workspace === id}
              title={`${name}工作区 · ${keys}`}
              onClick={() => (id === 'music' ? (location.hash = '#/music') : onWorkspace(id))}
            >
              <Icon name={icon} size={15} />
              <span className="workspace-label">{name}</span>
            </button>
          ))}
        </div>
        <span className="workspace-divider" />
        <button className="studio-launch" aria-label="创作工具" title="创作工具：图形、运动、空间、粒子等 8 个工具" onClick={onTools}>
          <Icon name="sparkles" size={15} />
          <span className="workspace-label">创作工具</span>
          <span className="tag">8</span>
        </button>
        <button className="plugin-launch" aria-label="插件管理" title="插件管理" onClick={onPlugin}>
          <Icon name="plug" size={15} />
          <span className="workspace-label">插件</span>
        </button>
      </nav>
      <div className="topbar-end">
        <span
          className={`save-status ${saving ? 'saving' : ''} ${error ? 'error' : ''}`}
          role="status"
          title={error || undefined}
        >
          <i />
          <span>{saving ? '正在保存' : error ? '需要检查' : '已保存到本地'}</span>
        </span>
        <div className="history-buttons">
          <button className="icon-button" aria-label="Undo" title="撤销 · Ctrl+Z" disabled={!canUndo} onClick={onUndo}>
            <Icon name="undo" size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Redo"
            title="重做 · Ctrl+Shift+Z"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Icon name="redo" size={16} />
          </button>
        </div>
        <div className="layout-buttons" role="group" aria-label="面板布局">
          <button
            className="icon-button layout-control"
            aria-label="显示工程面板"
            title="工程面板 · Ctrl+Alt+L"
            aria-pressed={showLeft}
            onClick={() => onLayout('left')}
          >
            <Icon name="sidebarLeft" size={16} />
          </button>
          <button
            className="icon-button layout-control"
            aria-label="显示时间轴"
            title="展开 / 折叠时间轴 · Ctrl+Alt+T"
            aria-pressed={showTimeline}
            onClick={() => onLayout('timeline')}
          >
            <Icon name="panelBottom" size={16} />
          </button>
          <button
            className="icon-button layout-control"
            aria-label="显示检查器"
            title="检查器 · Ctrl+Alt+I"
            aria-pressed={showRight}
            onClick={() => onLayout('right')}
          >
            <Icon name="sidebarRight" size={16} />
          </button>
          <button className="icon-button" aria-label="重置布局" title="重置布局" onClick={onReset}>
            <Icon name="reset" size={15} />
          </button>
        </div>
        <button className="command-button" aria-label="命令面板" title="命令面板 · Ctrl+K" onClick={onPalette}>
          <Icon name="search" size={14} />
          <span>搜索命令</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="icon-button" aria-label="键盘快捷键" title="键盘快捷键 · ?" onClick={onShortcuts}>
          <Icon name="keyboard" size={16} />
        </button>
        <button className="icon-button" aria-label="工程设置" title="工程设置" onClick={() => onModal('settings')}>
          <Icon name="settings" size={16} />
        </button>
        <button className="subtle" aria-label="连接 MCP" title="复制 MCP 配置，让外部 AI 连接本工程" onClick={() => onModal('connect')}>
          <Icon name="link" size={15} />
          <span className="topbar-label">连接 MCP</span>
        </button>
        <button
          className="primary"
          title={exportLabel ? '导出 PNG / JPEG / WebP 图片' : '导出视频、图像序列或音频'}
          onClick={() => onModal('export')}
        >
          <Icon name="export" size={15} />
          {exportLabel ?? '导出'}
        </button>
      </div>
    </header>
  );
}
