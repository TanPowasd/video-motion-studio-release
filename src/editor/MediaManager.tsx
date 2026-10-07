import React, { useEffect, useState } from 'react';
export function MediaManager({
  run,
  onClose,
}: {
  run: (method: string, params?: unknown) => Promise<any>;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<any[]>([]),
    [cache, setCache] = useState<any>(),
    [jobs, setJobs] = useState<any[]>([]),
    [paths, setPaths] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [budget, setBudget] = useState(1024),
    [plan, setPlan] = useState<any>(),
    [policy, setPolicy] = useState<'compatible' | 'replace'>('compatible');
  const refresh = async () => {
    const [status, usage, queue] = await Promise.all([
      run('mediaStatus', { limit: 100 }),
      run('cacheInspect', {}),
      run('mediaProxy', { action: 'status' }),
    ]);
    if (status) setAssets(status.assets.items);
    if (usage) setCache(usage);
    if (queue) setJobs(queue.jobs ?? []);
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(
      () =>
        void run('mediaProxy', { action: 'status' }).then((queue) => {
          if (queue) setJobs(queue.jobs ?? []);
        }),
      1500,
    );
    return () => clearInterval(timer);
  }, []);
  const task = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (jobs.some((job) => job.status === 'completed')) void refresh();
  }, [jobs.map((job) => `${job.id}:${job.status}`).join('|')]);
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        className="media-manager"
        role="dialog"
        aria-label="媒体与缓存"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>媒体与缓存</strong>
            <small>修复素材链接，管理代理与磁盘空间</small>
          </div>
          <button disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="media-actions">
          <button
            disabled={busy}
            onClick={() =>
              task(async () => {
                const result = await run('mediaProxy', { action: 'release' });
                if (!result) throw new Error('请先暂停预览再释放素材读取');
              })
            }
          >
            释放预览读取
          </button>
          <button disabled={busy} onClick={() => task(refresh)}>
            刷新
          </button>
          <label>
            重链接方式
            <select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
              <option value="compatible">保持尺寸与时长</option>
              <option value="replace">替换为不同素材</option>
            </select>
          </label>
          <small>代理用于本地预览；最终导出使用原素材。</small>
        </div>
        <main>
          <div className="media-entries">
            {assets.length ? (
              assets.map((asset) => (
                <article key={asset.id}>
                  <div>
                    <strong>{asset.name}</strong>
                    <span>
                      {asset.status === 'ready' ? '素材可用' : '素材缺失或无效'} ·{' '}
                      {asset.proxy.status === 'ready'
                        ? `代理 ${asset.proxy.width}×${asset.proxy.height}`
                        : '未生成可用代理'}
                    </span>
                    <small>{asset.path}</small>
                  </div>
                  <div>
                    {asset.type === 'video' && (
                      <button
                        disabled={busy || asset.status !== 'ready'}
                        onClick={() =>
                          task(async () => {
                            const result = await run('mediaProxy', {
                              action: 'start',
                              assetIds: [asset.id],
                              width: 960,
                            });
                            if (!result) throw new Error('代理任务未能启动');
                            setJobs((current) => [...current, ...result.jobs]);
                          })
                        }
                      >
                        生成代理
                      </button>
                    )}
                  </div>
                  {!asset.soundSource && ['image', 'video', 'audio'].includes(asset.type) && (
                    <div className="media-relink">
                      <input
                        aria-label={`${asset.name} 新路径`}
                        placeholder="新的素材文件完整路径"
                        value={paths[asset.id] ?? ''}
                        onChange={(e) => setPaths({ ...paths, [asset.id]: e.target.value })}
                      />
                      <button
                        disabled={busy || !paths[asset.id]}
                        onClick={() =>
                          task(async () => {
                            const planned = await run('mediaRelinkPlan', {
                              items: [
                                {
                                  assetId: asset.id,
                                  path: paths[asset.id],
                                  expectedPath: asset.path,
                                  policy,
                                },
                              ],
                            });
                            if (!planned) throw new Error('重链接检查未通过，请检查素材信息');
                            const checked = await run('projectPreflight', planned.candidate);
                            if (!checked?.valid) throw new Error('候选工程仍有错误，链接未修改');
                            const saved = await run('projectApply', planned.apply);
                            if (!saved?.applied) throw new Error('保存未完成');
                            await refresh();
                          })
                        }
                      >
                        检查并重链接
                      </button>
                    </div>
                  )}
                </article>
              ))
            ) : (
              <p className="hint">当前工程尚未导入素材。</p>
            )}
          </div>
          {jobs.length > 0 && (
            <div className="media-jobs">
              {jobs.map((job) => (
                <div key={job.id}>
                  <span>
                    {job.status === 'completed'
                      ? '代理已完成'
                      : job.status === 'failed'
                        ? '代理失败'
                        : job.status === 'cancelled'
                          ? '已取消'
                          : `生成代理 ${Math.round(job.progress * 100)}%`}
                  </span>
                  {['queued', 'running'].includes(job.status) && (
                    <button onClick={() => run('mediaProxy', { action: 'cancel', jobId: job.id })}>
                      取消
                    </button>
                  )}
                  {job.error && <small>{job.error}</small>}
                </div>
              ))}
            </div>
          )}
          <div className="media-cache">
            <strong>
              可重建缓存 {(Number(cache?.totalBytes ?? 0) / 1024 ** 2).toFixed(1)} MiB
            </strong>
            <label>
              保留预算 / MiB
              <input
                aria-label="缓存保留预算"
                type="number"
                min="0"
                value={budget}
                onChange={(e) => {
                  setBudget(Math.max(0, Number(e.target.value)));
                  setPlan(undefined);
                }}
              />
            </label>
            <button
              disabled={busy}
              onClick={() =>
                task(async () => {
                  const value = await run('cachePlan', {
                    maxBytes: Math.round(budget * 1024 ** 2),
                    minAgeSeconds: 3600,
                  });
                  if (!value) throw new Error('缓存检查未完成');
                  setPlan(value);
                })
              }
            >
              检查可清理内容
            </button>
            {plan && (
              <div>
                <p>
                  可回收 {(plan.proposedBytes / 1024 ** 2).toFixed(1)} MiB · {plan.fileCount} 个文件
                </p>
                <button
                  disabled={busy || !plan.fileCount}
                  onClick={() =>
                    task(async () => {
                      const result = await run('cacheApply', plan.apply);
                      if (!result) throw new Error('当前任务正在使用缓存，请在空闲时再清理');
                      setPlan(undefined);
                      await refresh();
                    })
                  }
                >
                  清理所列缓存
                </button>
              </div>
            )}
            <p className="hint">
              只检查一小时前的可重建缓存。素材、源码、历史、待提交候选、检查点和使用中的文件受到保护。
            </p>
          </div>
        </main>
        {error && <footer className="sound-error">{error}</footer>}
      </section>
    </div>
  );
}
