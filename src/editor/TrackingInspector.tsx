import React, { useEffect, useState } from 'react';
import type { Node, Snapshot } from '../core/model.js';
export function TrackingInspector({
  node,
  snapshot,
  sceneId,
  path,
  contextFrames,
  duration,
  rpc,
  onApplied,
}: {
  node: Node;
  snapshot: Snapshot;
  sceneId: string;
  path: string[];
  contextFrames: number[];
  duration: number;
  rpc: (method: string, params: unknown) => Promise<any>;
  onApplied: () => Promise<unknown>;
}) {
  const asset = snapshot.project.assets.find((a) => a.id === node.assetId),
    [job, setJob] = useState<any>(),
    [report, setReport] = useState<any>(),
    [evidence, setEvidence] = useState(''),
    [file, setFile] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(
      Math.min(
        3600,
        Math.max(
          1,
          Math.ceil(
            Number(
              asset?.metadata.duration ??
                duration / (snapshot.project.fps.num / snapshot.project.fps.den),
            ) *
              (snapshot.project.fps.num / snapshot.project.fps.den),
          ),
        ),
      ),
    ),
    [width, setWidth] = useState(640),
    [seeds, setSeeds] = useState('[]'),
    [zoom, setZoom] = useState(1.08),
    [smoothing, setSmoothing] = useState(12),
    [replace, setReplace] = useState(false),
    [localStart, setLocalStart] = useState(0),
    [localEnd, setLocalEnd] = useState(Math.min(duration, end));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!job || !['running', 'queued'].includes(job.status)) return;
    let active = true;
    const timer = setInterval(() => {
      rpc('trackingAnalyze', { action: 'status', id: job.id })
        .then((j) => {
          if (active) setJob(j);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (job?.status !== 'completed') return;
    let active = true;
    rpc('trackingInspect', { analysisId: job.analysisId })
      .then((r) => {
        if (active) setReport(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [job?.analysisId]);
  if (node.type !== 'video' || !asset) return null;
  const ref = file ? { file } : { analysisId: job?.analysisId },
    active = job && ['running', 'queued'].includes(job.status);
  const plan = async (stabilize: boolean) => {
    const p = await rpc('trackingPlan', {
      ...ref,
      revision: snapshot.revision,
      bindings: stabilize
        ? [
            {
              sceneId,
              path,
              contextFrames,
              sourceNodeId: node.id,
              targetNodeId: node.id,
              mode: 'stabilize',
              model: 'similarity',
              pointIds: report.points.items.filter((p: any) => p.lost === 0).map((p: any) => p.id),
              startFrame: localStart,
              endFrame: localEnd,
              smoothingRadius: smoothing,
              zoom,
              replaceChannels: replace,
            },
          ]
        : [],
    });
    const checked = await rpc('projectPreflight', p.candidate);
    if (!checked.valid) throw new Error(checked.diagnostics.map((d: any) => d.message).join('\n'));
    await rpc('projectApply', p.apply);
    setFile(p.resource.file);
    await onApplied();
  };
  return (
    <details className="tracking-inspector">
      <summary>运动跟踪 / 稳定</summary>
      <p>在源视频像素中选择点，或自动检测纹理角点。失跟不会自动补轨迹。</p>
      <div className="tracking-range">
        <label>
          源入点
          <input
            aria-label="跟踪源入点"
            type="number"
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          />
        </label>
        <label>
          源出点
          <input
            aria-label="跟踪源出点"
            type="number"
            value={end}
            onChange={(e) => setEnd(Number(e.target.value))}
          />
        </label>
        <label>
          分析宽度
          <input
            aria-label="跟踪分析宽度"
            type="number"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        点 / 重设种子 JSON
        <textarea
          aria-label="跟踪种子 JSON"
          value={seeds}
          onChange={(e) => setSeeds(e.target.value)}
        />
      </label>
      <button
        disabled={busy || active}
        onClick={() =>
          void run(async () => {
            const points = JSON.parse(seeds);
            setReport(undefined);
            setEvidence('');
            setFile('');
            setJob(
              await rpc('trackingAnalyze', {
                request: {
                  assetId: asset.id,
                  revision: snapshot.revision,
                  start,
                  end,
                  width,
                  points,
                },
              }),
            );
          })
        }
      >
        分析运动
      </button>
      {active && (
        <button
          onClick={() =>
            void run(async () =>
              setJob(await rpc('trackingAnalyze', { action: 'cancel', id: job.id })),
            )
          }
        >
          取消跟踪
        </button>
      )}
      {job && (
        <p className="tracking-status">
          {job.status} · {(job.progress * 100).toFixed(0)}% · {job.frame}f
          {job.error ? ' · ' + job.error.message : ''}
        </p>
      )}
      {report && (
        <>
          <small>
            {report.points.items
              .map((p: any) => `${p.id}: ${p.valid} 有效 / ${p.lost} 失跟`)
              .join(' · ')}
          </small>
          <div className="tracking-range">
            <label>
              本地入点
              <input
                aria-label="稳定本地入点"
                type="number"
                value={localStart}
                onChange={(e) => setLocalStart(Number(e.target.value))}
              />
            </label>
            <label>
              本地出点
              <input
                aria-label="稳定本地出点"
                type="number"
                value={localEnd}
                onChange={(e) => setLocalEnd(Number(e.target.value))}
              />
            </label>
          </div>
          <div>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await rpc('trackingEvidence', {
                    ...ref,
                    frames: [start, Math.floor((start + end - 1) / 2), end - 1],
                    width: 320,
                    inline: true,
                  });
                  setEvidence('data:image/png;base64,' + r.data);
                })
              }
            >
              查看跟踪证据
            </button>
            <button disabled={busy || !!file} onClick={() => void run(() => plan(false))}>
              保存轨迹资源
            </button>
          </div>
          <label>
            平滑半径（0 锁定）
            <input
              aria-label="稳定平滑半径"
              type="number"
              value={smoothing}
              onChange={(e) => setSmoothing(Number(e.target.value))}
            />
          </label>
          <label>
            裁边缩放
            <input
              aria-label="稳定裁边缩放"
              type="number"
              step=".01"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            合并并替换已有矩阵关键帧
          </label>
          <small>再次烘焙会叠加当前矩阵；更新已有跟踪时先撤销该次绑定。</small>
          <button
            disabled={busy || report.points.items.filter((p: any) => p.lost === 0).length < 2}
            onClick={() => void run(() => plan(true))}
          >
            稳定当前视频
          </button>
          <small>透明边缘可能保留；缩放由你指定。素材和其它动画不会被烘焙成视频。</small>
        </>
      )}
      {evidence && <img src={evidence} alt="跟踪点与置信度证据" />}
      {file && <small>{file}</small>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
