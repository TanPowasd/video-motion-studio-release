import React, { useLayoutEffect, useRef, useEffect, useMemo, useState } from 'react';
import { tokenize, completions } from './code-highlight.js';

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  jumpTo,
  language = 'tsx',
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  jumpTo?: { line: number; column?: number };
  /** Highlighting/completion mode; 'tsx' adds JSX tags, props and style keys. */
  language?: 'ts' | 'tsx' | 'text';
}) {
  const input = useRef<HTMLTextAreaElement>(null),
    gutter = useRef<HTMLDivElement>(null),
    lines = useRef<HTMLDivElement>(null),
    highlight = useRef<HTMLPreElement>(null);
  const [suggest, setSuggest] = useState<{
    items: string[];
    index: number;
    start: number;
    caret: number;
    top: number;
    left: number;
  }>();
  const tokens = useMemo(
    () => (language === 'text' || value.length > 400_000 ? [] : tokenize(value, language === 'tsx')),
    [value, language],
  );
  const sync = () => {
    if (!input.current || !lines.current) return;
    lines.current.style.transform = `translateY(${-input.current.scrollTop}px)`;
    if (highlight.current)
      highlight.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`;
  };
  const updateSuggestions = (text: string, caret: number) => {
    if (language === 'text' || readOnly) return setSuggest(undefined);
    const found = completions(text, caret);
    if (!found.items.length || (!found.prefix && found.kind === 'code')) return setSuggest(undefined);
    const editor = input.current!,
      style = getComputedStyle(editor),
      lineHeight = parseFloat(style.lineHeight),
      row = text.slice(0, caret).split('\n').length - 1,
      column = found.start - (text.lastIndexOf('\n', found.start - 1) + 1),
      ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    const charWidth = ctx.measureText('M').width;
    setSuggest({
      items: found.items,
      index: 0,
      start: found.start,
      caret,
      top: parseFloat(style.paddingTop) + (row + 1) * lineHeight - editor.scrollTop,
      left: parseFloat(style.paddingLeft) + column * charWidth - editor.scrollLeft,
    });
  };
  const accept = (word: string) => {
    if (!suggest) return;
    const next = value.slice(0, suggest.start) + word + value.slice(suggest.caret);
    onChange(next);
    const t = input.current!,
      at = suggest.start + word.length;
    setSuggest(undefined);
    requestAnimationFrame(() => {
      t.selectionStart = t.selectionEnd = at;
      sync();
    });
  };
  useLayoutEffect(sync, [value, tokens]);
  useLayoutEffect(() => {
    if (!jumpTo || !input.current) return;
    const editor = input.current,
      rows = value.split('\n'),
      line = Math.max(1, Math.min(rows.length, jumpTo.line)),
      offset =
        rows.slice(0, line - 1).reduce((n, row) => n + row.length + 1, 0) +
        Math.min(rows[line - 1].length, Math.max(0, (jumpTo.column ?? 1) - 1));
    editor.focus();
    editor.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
    editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
    sync();
  }, [jumpTo]);
  useEffect(() => {
    const element = gutter.current!,
      wheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        const editor = input.current!,
          lineHeight = parseFloat(getComputedStyle(editor).lineHeight),
          amount =
            event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? editor.clientHeight : 1;
        editor.scrollTop += event.deltaY * amount;
        sync();
      };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  return (
    <div className="code-area">
      <div ref={gutter} className="code-gutter" aria-hidden="true">
        <div ref={lines} className="code-gutter-lines">
          {value.split('\n').map((_, i) => (
            <div className="code-line-number" data-line={i + 1} key={i}>
              {i + 1}
            </div>
          ))}
        </div>
      </div>
      <div className="code-input">
        <pre ref={highlight} className="code-highlight" aria-hidden="true">
          {tokens.map((t, i) =>
            t.kind === 'plain' ? (
              t.text
            ) : (
              <span key={i} className={`tok-${t.kind}`}>
                {t.text}
              </span>
            ),
          )}
          {'\n'}
        </pre>
        <textarea
          readOnly={readOnly}
          ref={input}
          spellCheck={false}
          wrap="off"
          aria-label="TypeScript 组件源码"
          className={tokens.length ? 'highlighted' : undefined}
          value={value}
          onScroll={() => {
            sync();
            setSuggest(undefined);
          }}
          onBlur={() => setSuggest(undefined)}
          onChange={(e) => {
            onChange(e.target.value);
            updateSuggestions(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (suggest) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setSuggest({ ...suggest, index: (suggest.index + step + suggest.items.length) % suggest.items.length });
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                accept(suggest.items[suggest.index]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setSuggest(undefined);
                return;
              }
            }
            if (e.key === ' ' && e.ctrlKey) {
              e.preventDefault();
              updateSuggestions(value, e.currentTarget.selectionStart);
              return;
            }
            if (e.key === 'Tab') {
              if (readOnly) return;
              e.preventDefault();
              const t = e.currentTarget,
                start = t.selectionStart;
              onChange(value.slice(0, start) + '  ' + value.slice(t.selectionEnd));
              requestAnimationFrame(() => {
                t.selectionStart = t.selectionEnd = start + 2;
                sync();
              });
            }
          }}
        />
        {suggest && (
          <ul className="code-suggest" role="listbox" style={{ top: suggest.top, left: suggest.left }}>
            {suggest.items.map((item, i) => (
              <li
                key={item}
                role="option"
                aria-selected={i === suggest.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="code-help">组件生成原生场景节点，可编辑参数与属性面板共用。</div>
    </div>
  );
}
