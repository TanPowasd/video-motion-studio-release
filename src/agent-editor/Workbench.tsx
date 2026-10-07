import React, { useEffect, useRef, useState } from 'react';
import type { ApplicationState, RpcInput } from '../service/rpc-contract.js';
import { CodeEditor } from '../editor/CodeEditor.js';
import '../editor/desktop-api.js';
import { agentRpc, discovery, record, textValue } from './client.js';
type Context = Awaited<ReturnType<typeof contextRequest>>;
const contextRequest = () => agentRpc('projectContext', { limit: 100, offset: 0 });
type Review = {
  request: RpcInput<'projectPreflight'>;
  check: Awaited<ReturnType<typeof preflightRequest>>;
  draft: string;
  path: string;
};
const preflightRequest = (request: RpcInput<'projectPreflight'>) =>
  agentRpc('projectPreflight', request);
type Tab = 'connect' | 'source' | 'tools' | 'review' | 'tasks';
const tabs: Array<[Tab, string]> = [
  ['connect', 'MCP / CLI'],
  ['source', '项目源码'],
  ['tools', '工具目录'],
  ['review', '候选与诊断'],
  ['tasks', '渲染任务'],
];
export function AgentWorkbench() {
  const [state, setState] = useState<ApplicationState>(),
    [context, setContext] = useState<Context>(),
    [tab, setTab] = useState<Tab>('connect'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const [query, setQuery] = useState(''),
    [tools, setTools] = useState<unknown>(),
    [tool, setTool] = useState(''),
    [schema, setSchema] = useState<unknown>(),
    [argumentsText, setArgumentsText] = useState('{}'),
    [toolResult, setToolResult] = useState<unknown>();
  const [path, setPath] = useState(''),
    [source, setSource] = useState(''),
    [base, setBase] = useState<{ hash: string; version: 'active' | 'pending'; source: string }>(),
    [review, setReview] = useState<Review>();
  const [frame, setFrame] = useState(0),
    [scene, setScene] = useState(''),
    [planId, setPlanId] = useState(''),
    [candidate, setCandidate] = useState<unknown>(),
    [status, setStatus] = useState('');
  const [newProject, setNewProject] = useState('');
  const mounted = useRef(true),
    sourceRef = useRef({ path, source, base });
  sourceRef.current = { path, source, base };
  const refresh = async () => {
    const result = await agentRpc('state', {});
    if (mounted.current) setState(result);
    return result;
  };
  const task = async (label: string, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    setStatus('');
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  };
  useEffect(() => {
    let live = true;
    mounted.current = true;
    const load = async () => {
      try {
        const s = await agentRpc('state', {}),
          c = await contextRequest();
        if (live) {
          setState(s);
          setContext(c);
          setScene((old) => old || c.scenes[0]?.id || '');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    const route = () => {
      const [name, search] = location.hash.slice(2).split('?');
      if (tabs.some(([id]) => id === name)) setTab(name as Tab);
      const requested = new URLSearchParams(search).get('path');
      if (requested) setPath(requested);
    };
    route();
    window.addEventListener('hashchange', route);
    return () => {
      live = false;
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener('hashchange', route);
    };
  }, []);
  useEffect(() => {
    if (!state || !path) return;
    let live = true;
    void (async () => {
      try {
        const version = state.pendingFiles ? 'pending' : 'active';
        let first = await agentRpc('projectFileRead', {
            path,
            startLine: 1,
            lineCount: 1000,
            version,
          }),
          content = first.content,
          next = first.nextLine;
        while (next) {
          const chunk = await agentRpc('projectFileRead', {
            path,
            startLine: next,
            lineCount: 1000,
            version,
          });
          if (chunk.hash !== first.hash)
            throw new Error('FILE_HASH_CONFLICT: 文件在读取时发生变化');
          content += '\n' + chunk.content;
          next = chunk.nextLine;
          if (content.length > 8 * 1024 * 1024)
            throw new Error('SOURCE_BUDGET: 源文件超出编辑器预算');
        }
        if (live) {
          let draft = content;
          try {
            const old = sessionStorage.getItem(`agent-draft:${state.root}:${path}`);
            if (old) {
              const stored = JSON.parse(old);
              if (typeof stored.source === 'string') draft = stored.source;
            }
          } catch {}
          setSource(draft);
          setBase({ hash: first.hash, version: first.version, source: content });
          setReview(undefined);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [path, state?.root]);
  useEffect(() => {
    if (state && path && base) {
      const timer = setTimeout(() => {
        try {
          if (source === base.source)
            sessionStorage.removeItem(`agent-draft:${state.root}:${path}`);
          else
            sessionStorage.setItem(`agent-draft:${state.root}:${path}`, JSON.stringify({ source }));
        } catch {}
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [source, path, base, state?.root]);
  const inspectSource = () =>
    task('检查源码候选', async () => {
      if (!base || !state) throw new Error('先读取源文件');
      const s = await refresh(),
        request: RpcInput<'projectPreflight'> = {
          revision: s.snapshot.revision,
          version: base.version,
          files: [{ type: 'replace', path, expectedHash: base.hash, content: source }],
          samples: scene ? [{ sceneId: scene, frame }] : [],
          width: 320,
          determinism: true,
          inline: true,
        };
      const check = await preflightRequest(request);
      setReview({ request, check, draft: source, path });
    });
  const applySource = () =>
    task('提交准确候选', async () => {
      if (!review?.check.valid || review.draft !== source || review.path !== path)
        throw new Error('候选过期，请重新检查');
      const applied = await agentRpc('projectApply', {
        ...review.request,
        inline: false,
        expectedCandidateRevision: review.check.candidateRevision,
      });
      if (!applied.applied) throw new Error('候选未提交');
      const acceptedFile = await agentRpc('projectFileRead', {
        path,
        startLine: 1,
        lineCount: 1000,
        version: 'active',
      });
      setBase({ hash: acceptedFile.hash, version: 'active', source });
      setReview(undefined);
      await refresh();
      setStatus('已原子提交；可共享一次撤销');
    });
  const result = record(toolResult),
    media = record(result.result),
    blocks = Array.isArray(media.content) ? media.content : [];
  const selectTab = (id: Tab) => {
    setTab(id);
    location.hash = '#/' + id;
  };
  if (!state)
    return (
      <main className="agent-home">
        <h1>Vmotion Agent 工作台</h1>
        <p>文件 / CLI / MCP / 候选检查</p>
        <p>先打开一个本地工程。程序不调用 AI 模型。</p>
        <button
          disabled={!window.vmotionDesktop}
          onClick={() => void window.vmotionDesktop?.openProject()}
        >
          打开项目
        </button>
        <label>
          通过 CLI 创建
          <input
            value={newProject}
            placeholder="D:\\视频工程"
            onChange={(e) => setNewProject(e.target.value)}
          />
        </label>
        <pre>vmotion init --project {newProject || 'D:\\视频工程'}</pre>
        <p role="alert">{error}</p>
        <a href="/">创作工作站</a>
      </main>
    );
  return (
    <div className="agent-app">
      <header className="agent-header">
        <strong>
          Vmotion <span>AGENT WORKBENCH</span>
        </strong>
        <span>{state.snapshot.project.name}</span>
        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (window.vmotionDesktop) {
              e.preventDefault();
              void window.vmotionDesktop.openStudioWorkbench();
            }
          }}
        >
          打开创作工作站
        </a>
        <button
          onClick={() =>
            void task('刷新', async () => {
              await refresh();
              setContext(await contextRequest());
            })
          }
        >
          刷新
        </button>
      </header>
      <nav className="agent-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => selectTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="agent-meta">
        <span>
          revision <code>{state.snapshot.revision.slice(0, 16)}</code>
        </span>
        <span>{context?.files.total ?? 0} 项源文件</span>
        <span>{state.diagnostics.length} 条诊断</span>
        <span>{busy || status || '本地共享工程服务'}</span>
      </div>
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      <main className="agent-content">
        {tab === 'connect' && (
          <section>
            <h1>接入当前工程</h1>
            <p>外部 agent 使用工具与文件操作项目。这里提供工程接口和检查，不内置模型或聊天会话。</p>
            <h2>MCP 配置</h2>
            <pre aria-label="MCP 配置">
              {JSON.stringify({ mcpServers: { vmotion: state.connection } }, null, 2)}
            </pre>
            <button
              onClick={() =>
                void navigator.clipboard.writeText(
                  JSON.stringify({ mcpServers: { vmotion: state.connection } }, null, 2),
                )
              }
            >
              复制 MCP 配置
            </button>
            <h2>CLI</h2>
            <pre>{`vmotion inspect --project "${state.root}" --json\nvmotion validate --project "${state.root}" --json\nvmotion mcp --project "${state.root}"`}</pre>
            <button onClick={() => void navigator.clipboard.writeText(state.root)}>
              复制项目路径
            </button>
            <p>
              按需发现：tools_search → tool_schema → tool_call。修改：project_preflight →
              project_apply，准确候选、版本检查与创作端共享撤销。
            </p>
          </section>
        )}
        {tab === 'source' && (
          <div className="agent-source">
            <aside>
              <h2>工程文件</h2>
              {context?.files.items.map((f) => (
                <button
                  key={f.path}
                  className={f.path === path ? 'active' : ''}
                  onClick={() => setPath(f.path)}
                >
                  {f.path}
                  <small>{f.bytes} bytes</small>
                </button>
              ))}
              {context && context.files.total > context.files.items.length && (
                <button
                  onClick={() =>
                    void task('文件分页', async () => {
                      const next = await agentRpc('projectContext', {
                        offset: context.files.items.length,
                        limit: 100,
                      });
                      setContext({
                        ...context,
                        files: {
                          ...context.files,
                          items: [...context.files.items, ...next.files.items],
                        },
                      });
                    })
                  }
                >
                  更多文件
                </button>
              )}
            </aside>
            <section>
              <div className="agent-source-toolbar">
                <input
                  aria-label="Agent 源文件路径"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
                <select
                  aria-label="Agent 检查场景"
                  value={scene}
                  onChange={(e) => setScene(e.target.value)}
                >
                  {context?.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Agent 检查帧"
                  type="number"
                  min={0}
                  value={frame}
                  onChange={(e) => setFrame(Number(e.target.value))}
                />
                <button disabled={!!busy || !base} onClick={inspectSource}>
                  预检源码
                </button>
                <button
                  disabled={!!busy || !review?.check.valid || review.draft !== source}
                  onClick={applySource}
                >
                  提交候选
                </button>
              </div>
              <CodeEditor
                value={source}
                readOnly={!!busy}
                onChange={(value) => {
                  setSource(value);
                  setReview(undefined);
                }}
              />
              {review && (
                <div className="agent-review">
                  <strong>{review.check.valid ? '预检通过' : '预检失败'}</strong>
                  <code>{review.check.candidateRevision}</code>
                  <pre>
                    {JSON.stringify(
                      { diagnostics: review.check.diagnostics, samples: review.check.samples },
                      null,
                      2,
                    )}
                  </pre>
                  {review.check.data && (
                    <img alt="源码候选画面" src={`data:image/png;base64,${review.check.data}`} />
                  )}
                </div>
              )}
            </section>
          </div>
        )}
        {tab === 'tools' && (
          <section>
            <h1>按需工具目录</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void task('搜索工具', async () =>
                  setTools(await discovery('search', { query, limit: 24 })),
                );
              }}
            >
              <input
                aria-label="Agent 工具搜索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="audio / drawing / effects / render"
              />
              <button disabled={!!busy}>搜索</button>
            </form>
            <div className="agent-tool-list">
              {(Array.isArray(record(tools).items) ? (record(tools).items as unknown[]) : []).map(
                (item, i) => {
                  const t = record(item);
                  return (
                    <button
                      key={i}
                      onClick={() =>
                        void task('读取 Schema', async () => {
                          const name = textValue(t.name);
                          setTool(name);
                          setSchema(await discovery('schema', { name }));
                          setArgumentsText('{}');
                        })
                      }
                    >
                      <b>{textValue(t.name)}</b>
                      <span>{textValue(t.description)}</span>
                    </button>
                  );
                },
              )}
            </div>
            {schema !== undefined && (
              <>
                <h2>{tool}</h2>
                <pre aria-label="工具 Schema">{JSON.stringify(schema, null, 2)}</pre>
                <textarea
                  aria-label="Agent 工具参数"
                  value={argumentsText}
                  onChange={(e) => setArgumentsText(e.target.value)}
                />
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void task('执行工具', async () => {
                      setToolResult(
                        await agentRpc('agentToolInvoke', {
                          name: tool,
                          arguments: JSON.parse(argumentsText),
                          inline: true,
                        }),
                      );
                      await refresh();
                    })
                  }
                >
                  执行工具
                </button>
              </>
            )}
            {toolResult !== undefined && (
              <>
                <pre aria-label="Agent 工具结果">
                  {JSON.stringify(result.value ?? toolResult, null, 2)}
                </pre>
                {blocks.map((b, i) => {
                  const v = record(b);
                  return v.type === 'image' && typeof v.data === 'string' ? (
                    <img
                      key={i}
                      alt="工具返回画面"
                      src={`data:${textValue(v.mimeType)};base64,${v.data}`}
                    />
                  ) : v.type === 'audio' && typeof v.data === 'string' ? (
                    <audio
                      key={i}
                      controls
                      src={`data:${textValue(v.mimeType)};base64,${v.data}`}
                    />
                  ) : null;
                })}
              </>
            )}
          </section>
        )}
        {tab === 'review' && (
          <section>
            <h1>候选、诊断与共享历史</h1>
            <div className="agent-actions">
              <input
                aria-label="Agent planId"
                value={planId}
                onChange={(e) => {
                  setPlanId(e.target.value);
                  setCandidate(undefined);
                }}
                placeholder="planId / SHA-256"
              />
              <button
                disabled={!!busy || !planId}
                onClick={() =>
                  void task('预检计划', async () =>
                    setCandidate(await agentRpc('projectPreflight', { planId, inline: true })),
                  )
                }
              >
                预检 planId
              </button>
              <button
                disabled={!!busy || record(candidate).valid !== true || !planId}
                onClick={() =>
                  void task('提交计划', async () => {
                    await agentRpc('projectApply', {
                      planId,
                      expectedCandidateRevision: textValue(record(candidate).candidateRevision),
                    });
                    setCandidate(undefined);
                    await refresh();
                  })
                }
              >
                原样提交
              </button>
              <button
                disabled={!!busy || !state.canUndo}
                onClick={() =>
                  void task('撤销', async () => {
                    await agentRpc('undo', {});
                    await refresh();
                  })
                }
              >
                共享撤销
              </button>
              <button
                disabled={!!busy || !state.canRedo}
                onClick={() =>
                  void task('重做', async () => {
                    await agentRpc('redo', {});
                    await refresh();
                  })
                }
              >
                共享重做
              </button>
            </div>
            {candidate !== undefined && <pre>{JSON.stringify(candidate, null, 2)}</pre>}
            <pre aria-label="Agent 诊断">
              {JSON.stringify(
                {
                  diagnostics: state.diagnostics,
                  conflicts: state.conflicts,
                  pendingFiles: state.pendingFiles,
                },
                null,
                2,
              )}
            </pre>
          </section>
        )}
        {tab === 'tasks' && (
          <section>
            <h1>渲染任务</h1>
            <p>通过 render_start 创建任务；CLI、MCP 和创作端的导出都在这里共享进度与取消。</p>
            {state.jobs.map((job) => (
              <article key={job.id}>
                <h2>{job.id}</h2>
                <p>
                  {job.status} · {job.progress}% · revision {job.revision}
                </p>
                <pre>{job.output}</pre>
                {['queued', 'running'].includes(job.status) && (
                  <button
                    onClick={() =>
                      void task('取消渲染', async () => {
                        await agentRpc('cancel', { id: job.id });
                        await refresh();
                      })
                    }
                  >
                    取消任务
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
      </main>
      <footer className="agent-footer">
        AGENT · 文件 / CLI / MCP · 无模型接入 · 创作界面与自动化入口独立
      </footer>
    </div>
  );
}
