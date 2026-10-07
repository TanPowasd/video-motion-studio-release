import React, { useState } from 'react';
import type { StudioContext } from './types.js';
import { NumberControl, PanelIntro, ResultImage, SelectControl } from './Controls.js';
export default function ReviewPanel({ context }: { context: StudioContext }) {
  const [mode, setMode] = useState('color'),
    [width, setWidth] = useState(640),
    [alpha, setAlpha] = useState('weighted'),
    [frames, setFrames] = useState(String(context.frame)),
    [result, setResult] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const inspect = async () => {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const times = frames
        .split(/[，,\s]+/)
        .filter(Boolean)
        .map(Number);
      if (!times.length || times.some((n) => !Number.isFinite(n) || n < 0))
        throw new Error('请输入有效的采样帧');
      const request = { revision: context.snapshot.revision, width, frames: times, inline: true };
      const value = await context.run(
        mode === 'color' ? 'colorScopes' : mode === 'impact' ? 'layerImpact' : 'frameCompare',
        mode === 'impact'
          ? {
              ...request,
              sceneId: context.sceneId,
              nodeIds: context.selected.map((s) => s.nodeId),
              frames: times,
            }
          : {
              ...request,
              scope: {
                sceneId: context.sceneId,
                path: context.path,
                contextFrames: context.contextFrames,
              },
              ...(mode === 'color' ? { alpha } : {}),
            },
      );
      setResult(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PanelIntro title="画面检查">
        检查指定帧的真实画面、颜色与图层影响。统计描述变化，最终效果结合图片判断。
      </PanelIntro>
      <div className="studio-grid">
        <SelectControl
          label="检查方式"
          value={mode}
          options={[
            ['color', '颜色示波器'],
            ['impact', '图层隐藏影响'],
            ['compare', '候选画面对比'],
          ]}
          onChange={(v) => {
            setMode(v);
            setResult(undefined);
          }}
        />
        <NumberControl label="检查宽度" value={width} min={160} max={3840} onChange={setWidth} />
        <label className="studio-field">
          <span>采样帧（逗号分隔）</span>
          <input
            aria-label="检查采样帧"
            value={frames}
            onChange={(e) => setFrames(e.target.value)}
          />
        </label>
        {mode === 'color' && (
          <SelectControl
            label="透明度统计"
            value={alpha}
            options={[
              ['weighted', '按透明度加权'],
              ['visible', '非透明像素'],
              ['black', '合成到黑底'],
            ]}
            onChange={setAlpha}
          />
        )}
      </div>
      {mode === 'compare' && (
        <p className="hint">检查同一帧的重复渲染稳定性。自动化候选对比在 Agent 工作台进行。</p>
      )}
      <button
        className="primary"
        disabled={busy || (mode === 'impact' && !context.selected.length)}
        onClick={() => void inspect()}
      >
        {busy ? '正在检查…' : '运行画面检查'}
      </button>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="inspection-metrics">
            <span>
              采样<strong>{result.samples?.length ?? 0}</strong>
            </span>
            <span>
              工作量<strong>{((result.coverage?.renderedPixels ?? 0) / 1e6).toFixed(2)} Mpx</strong>
            </span>
            <span>
              范围<strong>{context.path.length ? '局部画布' : '场景画布'}</strong>
            </span>
          </div>
          <ResultImage result={result} alt="原生画面检查证据" />
          {mode === 'color' ? (
            <table className="studio-table">
              <thead>
                <tr>
                  <th>帧</th>
                  <th>亮度均值</th>
                  <th>亮度方差</th>
                  <th>透明度</th>
                  <th>像素覆盖</th>
                </tr>
              </thead>
              <tbody>
                {result.samples.map((s: any) => (
                  <tr key={s.frame}>
                    <td>{s.frame}</td>
                    <td>{s.summary.channels[3].mean?.toFixed(4) ?? '无可见像素'}</td>
                    <td>{s.summary.lumaVariance?.toFixed(4) ?? '—'}</td>
                    <td>{s.coverage.meanAlpha.toFixed(3)}</td>
                    <td>{s.coverage.fullPixelCoverage ? '完整' : '抽样'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="studio-table">
              <thead>
                <tr>
                  <th>帧 / 对象</th>
                  <th>变化面积</th>
                  <th>最大差异</th>
                  <th>稳定性</th>
                </tr>
              </thead>
              <tbody>
                {result.samples.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {s.frame} {s.nodeId ?? ''}
                    </td>
                    <td>{(s.changedRatio * 100).toFixed(3)}%</td>
                    <td>{s.maximum8bit.toFixed(3)}</td>
                    <td>{s.result === 'inconclusive' ? '不确定' : '采样稳定'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">
            检查只覆盖所选时间和分辨率。图层影响是临时隐藏后的画面差异，不是对象可见率。
          </p>
        </>
      )}
    </>
  );
}
