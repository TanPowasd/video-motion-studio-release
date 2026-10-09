import React, { useCallback, useEffect, useState, useRef } from 'react';
import './desktop-api.js';
import { Icon } from './Icons.js';
import { McpConnectionButton } from './McpConnection.js';
import { projectCreationSchema, type ProjectHome as HomeData } from '../core/project-creation.js';
import './project-home.css';
import { NewImageDialog } from './still/NewImageDialog.js';

export function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState('未命名项目'),
    [directory, setDirectory] = useState('');
  const [template, setTemplate] = useState<'blank' | 'science'>('blank');
  const [width, setWidth] = useState(1920),
    [height, setHeight] = useState(1080);
  const [fps, setFps] = useState('30/1'),
    [duration, setDuration] = useState(10);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== 'Tab') return;
      const fields = Array.from(
        formRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) ?? [],
      ).filter((field) => !field.closest('fieldset:disabled'));
      const first = fields[0],
        last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onCancel]);
  useEffect(() => {
    let active = true;
    window.vmotionDesktop
      ?.projectHome()
      .then((data) => {
        if (active) setDirectory(data.directory);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const [num, den] = fps.split('/').map(Number);
    const parsed = projectCreationSchema.safeParse({
      name,
      template,
      width,
      height,
      fps: { num, den },
      durationSeconds: duration,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
      );
      return;
    }
    if (!directory) {
      setError('请选择项目保存位置');
      return;
    }
    setBusy(true);
    try {
      await window.vmotionDesktop!.createProject({ ...parsed.data, directory });
      onCreated?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form ref={formRef} className="new-project-form" onSubmit={create}>
      <div className="project-form-heading">
        <h2>新建项目</h2>
        <button type="button" aria-label="关闭新建项目" disabled={busy} onClick={onCancel}>
          <Icon name="close" />
        </button>
      </div>
      <fieldset disabled={busy}>
        <label>
          项目名称
          <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          保存位置
          <div className="project-directory">
            <input value={directory} onChange={(e) => setDirectory(e.target.value)} />
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  const value = await window.vmotionDesktop!.pickProjectDirectory(directory);
                  if (value) setDirectory(value);
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              浏览…
            </button>
          </div>
        </label>
        <label>
          起始内容
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value as 'blank' | 'science')}
          >
            <option value="blank">空白工程</option>
            <option value="science">科普示例 · 波的几何</option>
          </select>
        </label>
        <p className="project-form-hint">
          {template === 'blank'
            ? '创建空合成和主序列，从自己的素材或组件开始。'
            : '包含文字、公式和可编辑的 TypeScript 波形组件。'}
        </p>
        <div className="project-form-grid">
          <label>
            宽度
            <input
              type="number"
              min={16}
              max={3840}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
          <label>
            高度
            <input
              type="number"
              min={16}
              max={2160}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
          <label>
            帧率
            <select value={fps} onChange={(e) => setFps(e.target.value)}>
              {[
                ['24/1', '24'],
                ['25/1', '25'],
                ['30000/1001', '29.97'],
                ['30/1', '30'],
                ['50/1', '50'],
                ['60000/1001', '59.94'],
                ['60/1', '60'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label} fps
                </option>
              ))}
            </select>
          </label>
          <label>
            初始时长（秒）
            <input
              type="number"
              min={1}
              max={7200}
              step="any"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="project-form-hint">
          项目文件夹：{directory}
          {directory.endsWith('\\') || directory.endsWith('/') ? '' : '\\'}
          {name.trim()}
          <br />
          SDR · sRGB · 48 kHz
        </p>
      </fieldset>
      {error && (
        <p className="project-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy || !window.vmotionDesktop}>
          {busy ? '正在创建…' : '创建并打开'}
        </button>
      </div>
    </form>
  );
}

export function ProjectActions({
  onError,
  onPause,
}: {
  onError: (message: string) => void;
  onPause: () => void;
}) {
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false);
  const action = useCallback(
    async (fn: () => Promise<void>) => {
      onPause();
      setBusy(true);
      try {
        await fn();
      } catch (error) {
        onError((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onPause, onError],
  );
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !window.vmotionDesktop ||
        busy ||
        creating ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        onPause();
        setCreating(true);
      }
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void action(() => window.vmotionDesktop!.openProject());
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [action, busy, creating, onPause]);
  if (!window.vmotionDesktop) return null;
  return (
    <>
      <div className="project-actions">
        <button
          disabled={busy}
          title="返回项目首页"
          aria-label="项目首页"
          onClick={() => action(() => window.vmotionDesktop!.showHome())}
        >
          <Icon name="grid" />
        </button>
        <button
          disabled={busy}
          title="Ctrl+N"
          onClick={() => {
            onPause();
            setCreating(true);
          }}
        >
          <Icon name="plus" size={15} />
          新建
        </button>
        <button
          disabled={busy}
          title="Ctrl+O"
          onClick={() => action(() => window.vmotionDesktop!.openProject())}
        >
          <Icon name="folder" size={15} />
          打开
        </button>
      </div>
      {creating && (
        <div className="project-modal" role="dialog" aria-modal="true" aria-label="新建项目">
          <NewProjectForm onCancel={() => setCreating(false)} />
        </div>
      )}
    </>
  );
}

export function NewImageProject({ onCancel }: { onCancel: () => void }) {
  const [directory, setDirectory] = useState('');
  useEffect(() => {
    window.vmotionDesktop
      ?.projectHome()
      .then((data) => setDirectory(data.directory))
      .catch(() => {});
  }, []);
  return (
    <NewImageDialog
      mode="project"
      initialDirectory={directory}
      onCancel={onCancel}
      pickDirectory={(current) => window.vmotionDesktop!.pickProjectDirectory(current)}
      onSubmit={async (settings) => {
        if (!window.vmotionDesktop) throw new Error('请在桌面版新建图片项目');
        await window.vmotionDesktop.createProject({
          name: settings.name,
          directory: settings.directory!,
          kind: 'still',
          ...(settings.preset ? { preset: settings.preset } : {}),
          stillTemplate: settings.template,
          width: settings.width,
          height: settings.height,
        });
      }}
    />
  );
}

export function ProjectHome() {
  const [home, setHome] = useState<HomeData>(),
    [creating, setCreating] = useState(false),
    [creatingImage, setCreatingImage] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    window.vmotionDesktop
      ?.projectHome()
      .then(setHome)
      .catch((error) => setError(error.message));
  }, []);
  const open = useCallback(async (root?: string) => {
    setBusy(true);
    setError('');
    try {
      await window.vmotionDesktop!.openProject(root);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (busy || creating || creatingImage || !(event.ctrlKey || event.metaKey) || event.altKey)
        return;
      if (event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault();
        setCreatingImage(true);
        return;
      }
      if (event.shiftKey) return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setCreating(true);
      }
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void open();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, busy, creating, creatingImage]);
  return (
    <main className="project-home">
      <header>
        <div className="brand">
          <div className="brand-mark">V</div>
          <span className="brand-name">Vmotion</span>
        </div>
        <span>本地创作工作站</span>
        <McpConnectionButton />
      </header>
      <div className="project-home-content">
        <section className="project-home-intro">
          <div className="project-home-eyebrow">PROJECTS / 项目</div>
          <h1>从一个新项目开始</h1>
          <p>动画、剪辑、音乐、绘画与平面图片，共用一个可编辑工程。</p>
          <div className="project-home-buttons">
            <button
              className="primary"
              disabled={busy || !window.vmotionDesktop}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" />
              新建项目 <kbd>Ctrl N</kbd>
            </button>
            <button
              className="secondary"
              disabled={busy || !window.vmotionDesktop}
              onClick={() => setCreatingImage(true)}
              title="海报、封面、缩略图与社交图片"
            >
              <Icon name="image" />
              新建图片 <kbd>Ctrl Shift N</kbd>
            </button>
            <button
              className="secondary"
              disabled={busy || !window.vmotionDesktop}
              onClick={() => open()}
            >
              <Icon name="folder" />
              打开项目 <kbd>Ctrl O</kbd>
            </button>
          </div>
        </section>
        <section className="project-home-recent">
          <h2>最近项目</h2>
          {home?.recent.length ? (
            <div className="recent-projects">
              {home.recent.map((entry) => (
                <button
                  key={entry.root}
                  disabled={busy || entry.available === false}
                  onClick={() => open(entry.root)}
                  title={entry.root}
                >
                  <div className="recent-project-icon">
                    <Icon name="scene" size={23} />
                  </div>
                  <span className="recent-project-detail">
                    <strong>{entry.name}</strong>
                    <span>{entry.root}</span>
                  </span>
                  <span className="recent-project-date">
                    {entry.available === false
                      ? '文件夹已移动或删除'
                      : new Date(entry.openedAt).toLocaleDateString('zh-CN')}
                  </span>
                  <Icon name="arrow" size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-empty">
              <Icon name="folder" size={28} />
              <p>还没有打开过项目</p>
              <span>创建空白工程，或打开含 project.vmotion.json 的项目文件夹。</span>
            </div>
          )}
        </section>
        {error && (
          <p className="project-form-error" role="alert">
            {error}
          </p>
        )}
        {!window.vmotionDesktop && <p className="project-form-hint">请在桌面版新建或打开项目。</p>}
      </div>
      <footer>所有项目保存在本机 · 无需账号</footer>
      {creating && (
        <div className="project-modal" role="dialog" aria-modal="true" aria-label="新建项目">
          <NewProjectForm onCancel={() => setCreating(false)} />
        </div>
      )}
      {creatingImage && (
        <div className="project-modal" role="dialog" aria-modal="true" aria-label="新建图片">
          <NewImageProject onCancel={() => setCreatingImage(false)} />
        </div>
      )}
    </main>
  );
}
