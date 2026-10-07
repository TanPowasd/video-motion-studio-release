import React, { useLayoutEffect, useRef, useEffect } from 'react';

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  jumpTo,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  jumpTo?: { line: number; column?: number };
}) {
  const input = useRef<HTMLTextAreaElement>(null),
    gutter = useRef<HTMLDivElement>(null),
    lines = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (!input.current || !lines.current) return;
    lines.current.style.transform = `translateY(${-input.current.scrollTop}px)`;
  };
  useLayoutEffect(sync, [value]);
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
      <textarea
        readOnly={readOnly}
        ref={input}
        spellCheck={false}
        wrap="off"
        aria-label="TypeScript 组件源码"
        value={value}
        onScroll={sync}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
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
      <div className="code-help">组件生成原生场景节点，可编辑参数与属性面板共用。</div>
    </div>
  );
}
