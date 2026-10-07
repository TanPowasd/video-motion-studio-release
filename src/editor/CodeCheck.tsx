import React from 'react';
import type { Diagnostic } from '../core/model.js';
export type CodeCheckReport = {
  valid: boolean;
  diagnostics: Diagnostic[];
  samples: Array<{ frame: number; status: string }>;
  data?: string;
};
export function CodeCheck({
  report,
  onClose,
  onJump,
}: {
  report: CodeCheckReport;
  onClose: () => void;
  onJump: (diagnostic: Diagnostic) => void;
}) {
  return (
    <section
      className={`code-check ${report.valid ? 'passed' : 'failed'}`}
      aria-label="代码预检结果"
    >
      <div className="code-check-header">
        <strong>{report.valid ? '预检通过' : '预检未通过'}</strong>
        <span>{report.samples.filter((s) => s.status === 'passed').length} 个画面检查通过</span>
        <button aria-label="关闭预检结果" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="code-check-content">
        {report.data && <img src={`data:image/png;base64,${report.data}`} alt="候选代码画面预检" />}
        <div>
          {report.diagnostics.length ? (
            report.diagnostics.map((diagnostic, i) => (
              <button className="code-diagnostic" key={i} onClick={() => onJump(diagnostic)}>
                <span>
                  {diagnostic.file?.split(/[\\/]/).at(-1) ?? '工程'}
                  {diagnostic.line ? `:${diagnostic.line}` : ''}
                  {diagnostic.column ? `:${diagnostic.column}` : ''}
                </span>
                <small>{diagnostic.message}</small>
              </button>
            ))
          ) : (
            <p>格式、类型与所选画面均通过检查。预检结果没有写入工程。</p>
          )}
        </div>
      </div>
    </section>
  );
}
