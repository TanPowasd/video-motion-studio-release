import React from 'react';
import { Icon } from './Icons.js';
import { ProjectActions } from './ProjectHome.js';
export function WorkbenchHeader({
  projectName,
  workspace,
  canUndo,
  canRedo,
  saving,
  error,
  showLeft,
  showRight,
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
}: {
  projectName: string;
  workspace: string;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  error: string;
  showLeft: boolean;
  showRight: boolean;
  onWorkspace: (v: string) => void;
  onTools: () => void;
  onModal: (v: 'settings' | 'export') => void;
  onUndo: () => void;
  onRedo: () => void;
  onPlugin: () => void;
  onError: (e: string) => void;
  onPause: () => void;
  onLayout: (side: 'left' | 'right') => void;
  onReset: () => void;
}) {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">V</div>
          <span>Vmotion</span>
        </div>
        <ProjectActions onError={onError} onPause={onPause} />
        <button className="project-title" title="工程设置" onClick={() => onModal('settings')}>
          <Icon name="folder" />
          {projectName}
          <span className="tag">本地工程</span>
        </button>
        <div className="top-spacer" />
        <span className={`save-status ${error ? 'error' : ''}`} role="status">
          <i />
          {saving ? '正在保存' : error ? '需要检查' : '已保存到本地'}
        </span>
        <div className="history-buttons">
          <button aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
            <Icon name="undo" />
          </button>
          <button aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
            <Icon name="redo" />
          </button>
        </div>
        <button className="primary" onClick={() => onModal('export')}>
          <Icon name="export" />
          导出
        </button>
      </header>
      <nav className="workspaces" aria-label="工作区">
        <div className="workspace-segment">
          {[
            ['animation', 'layers', '动画'],
            ['editing', 'film', '剪辑'],
            ['music', 'music', '音乐'],
            ['drawing', 'brush', '绘画'],
          ].map(([id, icon, name]) => (
            <button
              key={id}
              className={workspace === id ? 'active' : ''}
              aria-pressed={workspace === id}
              onClick={() => (id === 'music' ? (location.hash = '#/music') : onWorkspace(id))}
            >
              <Icon name={icon} />
              {name}
            </button>
          ))}
        </div>
        <span className="workspace-divider" />
        <button className="studio-launch" aria-label="创作工具" onClick={onTools}>
          <Icon name="scene" />
          创作工具<span className="tag">8</span>
        </button>
        <button aria-label="插件管理" onClick={onPlugin}>
          插件
        </button>
        <div className="top-spacer" />
        <button
          className="layout-control"
          aria-label="显示工程面板"
          aria-pressed={showLeft}
          onClick={() => onLayout('left')}
        >
          <Icon name="panel" />
        </button>
        <button
          className="layout-control"
          aria-label="显示检查器"
          aria-pressed={showRight}
          onClick={() => onLayout('right')}
        >
          <Icon name="settings" />
        </button>
        <button onClick={onReset}>重置布局</button>
        <button aria-label="工程设置" onClick={() => onModal('settings')}>
          <Icon name="settings" />
        </button>
      </nav>
    </>
  );
}
