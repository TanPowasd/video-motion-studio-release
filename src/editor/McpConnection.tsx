import React, { useEffect, useState } from 'react';
import { rpcTyped } from './state/rpc-client.js';
import type { ApplicationState } from '../service/rpc-contract.js';
export const openMcpConnection = () => window.dispatchEvent(new Event('vmotion:connect-mcp'));
export function McpConnectionButton() {
  return (
    <button onClick={openMcpConnection} aria-label="连接 MCP">
      连接 MCP
    </button>
  );
}
export function McpConnection() {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<ApplicationState>(),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    const show = () => {
      setState(undefined);
      setError('');
      setCopied(false);
      setOpen(true);
    };
    window.addEventListener('vmotion:connect-mcp', show);
    document.documentElement.dataset.mcpConnectionReady = 'true';
    return () => {
      delete document.documentElement.dataset.mcpConnectionReady;
      window.removeEventListener('vmotion:connect-mcp', show);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void rpcTyped('state', {})
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        if (live) setError('请先新建或打开项目，然后复制当前工程的 MCP 配置。');
      });
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      live = false;
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (!open) return null;
  const config = state
    ? JSON.stringify({ mcpServers: { vmotion: state.connection } }, null, 2)
    : '';
  return (
    <div className="project-modal" role="dialog" aria-modal="true" aria-label="连接 MCP">
      <section
        className="mcp-connection"
        style={{
          maxWidth: 760,
          width: '90%',
          background: 'var(--vm-bg-2)',
          border: '1px solid var(--vm-line-3)',
          boxShadow: 'var(--vm-shadow-3)',
          padding: 24,
          borderRadius: 10,
          display: 'grid',
          gap: 12,
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>连接外部 AI / MCP</h2>
          <button className="secondary" aria-label="关闭 MCP 连接" onClick={() => setOpen(false)}>
            关闭
          </button>
        </header>
        <p>
          AI 在外部通过项目文件或 MCP
          修改工程；你直接用当前界面编辑。双方共享素材、预览、版本和撤销。软件不调用 AI 模型。
        </p>
        {state && (
          <>
            <pre
              aria-label="MCP 配置"
              style={{
                overflow: 'auto',
                maxHeight: '50vh',
                whiteSpace: 'pre-wrap',
                background: 'var(--vm-bg-1)',
                border: '1px solid var(--vm-line-2)',
                borderRadius: 6,
                padding: 16,
              }}
            >
              {config}
            </pre>
            <button
              className="primary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(config)
                  .then(() => setCopied(true))
                  .catch((e) => setError((e as Error).message))
              }
            >
              {copied ? '已复制' : '复制 MCP 配置'}
            </button>
            <p>项目路径：{state.root}</p>
          </>
        )}
        {!state && !error && <p>正在读取当前工程…</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
