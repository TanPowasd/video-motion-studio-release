import React, { useEffect, useRef } from 'react';
import type { VisualFinding } from '../core/visual-audit.js';
import type { Diagnostic } from '../core/model.js';
export type VisualAuditReport = {
  revision: string;
  sceneId: string;
  path: string[];
  findings: Array<VisualFinding & { index: number }>;
  summary: { errors: number; reviews: number; omitted: number; status: string };
  frames: Array<{ frame: number; status: string }>;
  data?: string;
  limitations: string[];
  diagnostics: Diagnostic[];
};
export function VisualAuditPanel({
  report,
  revision,
  onClose,
  onFinding,
}: {
  report: VisualAuditReport;
  revision: string;
  onClose: () => void;
  onFinding: (finding: VisualFinding) => void;
}) {
  const stale = report.revision !== revision;
  const panel = useRef<HTMLElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),summary,[tabindex="0"]',
            ) ?? [],
          ).filter((element) => element.getClientRects().length > 0),
          first = elements[0],
          last = elements.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="visual-check-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className={`visual-check status-${report.summary.status}`}
        aria-label="画面检查结果"
        role="dialog"
        aria-modal="true"
      >
        <div className="visual-check-header">
          <strong>
            {report.summary.status === 'failed'
              ? '发现确定问题'
              : report.summary.status === 'incomplete'
                ? '检查预算不足，请缩小范围'
                : report.summary.status === 'review'
                  ? '有画面提示需确认'
                  : '采样画面检查完成'}
          </strong>
          <span>
            {report.summary.errors} 问题 · {report.summary.reviews} 提示 · {report.frames.length} 帧
          </span>
          <span className="mono">
            {report.revision.slice(0, 8)}
            {stale ? ' · 工程已更新' : ''}
          </span>
          <button aria-label="关闭画面检查" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="visual-check-content">
          {report.data && <img src={`data:image/png;base64,${report.data}`} alt="画面检查标注图" />}
          <div className="visual-check-findings">
            {report.findings.length ? (
              report.findings.map((finding) => (
                <button
                  key={finding.index}
                  disabled={stale}
                  onClick={() => onFinding(finding)}
                  title={`${finding.nodeId} · ${finding.code}`}
                >
                  <span className={`finding-number severity-${finding.severity}`}>
                    {finding.index}
                  </span>
                  <span>
                    <strong>
                      {finding.name || '工程'} · {finding.frame}f
                    </strong>
                    <small>{finding.message}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>
                {report.diagnostics.length
                  ? '部分帧无法完成检查，详见错误诊断。'
                  : '所选时间点未触发检查规则。仍需要查看实际画面。'}
              </p>
            )}
            {report.diagnostics.map((diagnostic, index) => (
              <p className="parameter-error" key={index}>
                {diagnostic.file ?? diagnostic.path ?? '工程'}: {diagnostic.message}
              </p>
            ))}
            {report.summary.omitted > 0 && <p>部分结果超出检查预算；请按图层筛选后继续检查。</p>}
          </div>
        </div>
        <details className="visual-check-limits">
          <summary>检查范围</summary>
          {report.limitations.map((limit, i) => (
            <p key={i}>{limit}</p>
          ))}
        </details>
      </section>
    </div>
  );
}
