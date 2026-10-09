import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.js';
export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  /** Extra words that should match the search (English aliases, synonyms). */
  keywords?: string;
  icon?: string;
  keys?: string;
  disabled?: boolean;
  run: () => void;
}
/** Splits "Ctrl+Shift+Z" into individual key chips. */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="vm-keys">
      {keys.split(' / ').map((combo, index) => (
        <React.Fragment key={combo}>
          {index > 0 && <span className="vm-keys-or">/</span>}
          {combo.split('+').map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '');
function score(command: PaletteCommand, query: string) {
  if (!query) return 1;
  const haystack = normalize(`${command.label} ${command.group} ${command.keywords ?? ''}`);
  const label = normalize(command.label);
  if (label.startsWith(query)) return 4;
  if (label.includes(query)) return 3;
  if (haystack.includes(query)) return 2;
  // Ordered character match ("dcbj" → "导出..." won't work for CJK, but works for latin aliases).
  let at = 0;
  for (const char of query) {
    at = haystack.indexOf(char, at);
    if (at < 0) return 0;
    at++;
  }
  return 1;
}
/** Ctrl+K command palette: fuzzy-searchable list of every Studio action. */
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const results = useMemo(() => {
    const q = normalize(query);
    return commands
      .map((command, index) => ({ command, index, score: score(command, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (q ? b.score - a.score : 0) || a.index - b.index)
      .map((entry) => entry.command);
  }, [commands, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    input.current?.focus();
    const previous = restore.current;
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const execute = (command?: PaletteCommand) => {
    if (!command || command.disabled) return;
    onClose();
    // Let the palette unmount (and focus restore) before the command opens its own UI.
    requestAnimationFrame(() => command.run());
  };
  let lastGroup = '';
  return (
    <div className="vm-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="vm-sheet vm-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((value) => Math.min(results.length - 1, value + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((value) => Math.max(0, value - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            execute(results[active]);
          }
        }}
      >
        <label className="vm-palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            aria-label="搜索命令"
            placeholder="搜索命令、工作区、面板…"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="vm-palette-list"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="vm-palette-list" id="vm-palette-list" role="listbox" ref={list}>
          {results.length === 0 && <div className="vm-palette-empty">没有匹配的命令</div>}
          {results.map((command, index) => {
            const header = !query && command.group !== lastGroup;
            lastGroup = command.group;
            return (
              <React.Fragment key={command.id}>
                {header && <div className="vm-palette-group">{command.group}</div>}
                <button
                  className="vm-palette-item"
                  role="option"
                  data-index={index}
                  aria-selected={index === active}
                  disabled={command.disabled}
                  onPointerMove={() => setActive(index)}
                  onClick={() => execute(command)}
                >
                  <Icon name={command.icon ?? 'arrow'} size={15} />
                  <span className="vm-palette-label">{command.label}</span>
                  {query && <span className="vm-palette-meta">{command.group}</span>}
                  {command.keys && <Keys keys={command.keys} />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <footer className="vm-sheet-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 执行
          </span>
          <span>
            <kbd>?</kbd> 全部快捷键
          </span>
        </footer>
      </div>
    </div>
  );
}
export interface ShortcutGroup {
  title: string;
  items: Array<[label: string, keys: string]>;
}
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      ['搜索对象 / 命令', 'Ctrl+K / /'],
      ['命令面板（备用）', 'Ctrl+Shift+P'],
      ['键盘快捷键', '?'],
      ['撤销', 'Ctrl+Z'],
      ['重做', 'Ctrl+Shift+Z'],
      ['保存', 'Ctrl+S'],
      ['新建 / 打开项目', 'Ctrl+N / Ctrl+O'],
      ['切换亮色 / 暗色主题', 'Ctrl+Alt+D'],
    ],
  },
  {
    title: '模式与面板',
    items: [
      ['剪辑模式', 'Ctrl+1'],
      ['动效模式', 'Ctrl+2'],
      ['特效模式', 'Ctrl+3'],
      ['音乐模式', 'Ctrl+4'],
      ['图片模式', 'Ctrl+5'],
      ['文字模式', 'Ctrl+6'],
      ['场景与图层栏', 'Ctrl+Alt+L'],
      ['改动记录 / 属性栏', 'Ctrl+Alt+I'],
      ['展开 / 折叠时间线', 'Ctrl+Alt+T'],
      ['退出预览 / 关闭抽屉与菜单', 'Esc'],
      ['调整面板大小', '拖动分隔条 / 方向键'],
      ['恢复面板默认大小', '双击分隔条'],
    ],
  },
  {
    title: '播放',
    items: [
      ['播放 / 暂停', 'Space'],
      ['上一帧 / 下一帧', '← / →'],
      ['第一帧 / 最后一帧', 'Home / End'],
      ['拖动刻度尺定位', '按住刻度尺拖动'],
    ],
  },
  {
    title: '时间轴',
    items: [
      ['缩放时间轴', 'Ctrl+滚轮'],
      ['横向滚动', 'Shift+滚轮'],
      ['全选关键帧', 'Ctrl+A'],
      ['复制 / 粘贴关键帧', 'Ctrl+C / Ctrl+V'],
      ['删除选中关键帧', 'Delete'],
      ['取消关键帧选择', 'Esc'],
    ],
  },
  {
    title: '动画图层',
    items: [
      ['编组 / 解组', 'Ctrl+G / Ctrl+Shift+G'],
      ['复制图层', 'Ctrl+D'],
      ['删除图层', 'Delete'],
      ['多选图层', 'Ctrl+单击'],
      ['平移画布', 'Alt+拖动 / 中键'],
      ['缩放画布', 'Ctrl+滚轮'],
    ],
  },
  {
    title: '剪辑',
    items: [
      ['在播放头分割', 'Ctrl+B'],
      ['设置入点 / 出点', 'I / O'],
      ['删除片段', 'Delete'],
      ['波纹删除', 'Shift+Delete'],
      ['多选片段', 'Ctrl+单击'],
    ],
  },
  {
    title: '绘画',
    items: [
      ['画笔 / 橡皮 / 移动', 'B / E / V'],
      ['撤销笔画', 'Ctrl+Z'],
      ['退出', 'Esc'],
    ],
  },
];
/** "?" cheat sheet listing every keyboard shortcut grouped by context. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <div className="vm-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="vm-sheet vm-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <Icon name="keyboard" size={18} />
          <h2>键盘快捷键</h2>
          <button ref={close} className="icon-button" aria-label="关闭快捷键" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="vm-shortcut-grid">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map(([label, keys]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <Keys keys={keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
