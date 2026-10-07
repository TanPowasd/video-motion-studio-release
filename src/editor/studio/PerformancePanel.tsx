import React, { useState } from 'react';
import type { StudioContext } from './types.js';
import { NumberControl, PanelIntro, SelectControl } from './Controls.js';
export default function PerformancePanel({ context }: { context: StudioContext }) {
  const [gpu, setGpu] = useState('auto'),
    [width, setWidth] = useState(1280),
    [result, setResult] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [compare, setCompare] = useState(true);
  const measure = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(
        await context.run(compare ? 'renderCompare' : 'renderProfile', {
          revision: context.snapshot.revision,
          sceneId: context.sceneId,
          path: context.path,
          contextFrames: context.contextFrames,
          frames: [context.frame],
          width,
          repeat: 2,
          ...(compare
            ? {
                pixelTolerance: 2,
                baseline: { gpu: 'cpu', graphOptimize: true },
                optimized: { gpu },
              }
            : { gpu }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const before = result?.baseline?.summary?.warmMeanMs,
    after = result?.optimized?.summary?.warmMeanMs ?? result?.summary?.warmMeanMs,
    device = result?.optimized?.gpu ?? result?.cache?.gpu;
  return (
    <>
      <PanelIntro title="渲染与性能">
        对照同一工程和采样帧，查看设备、渲染耗时和像素一致性。GPU
        当前加速颜色矩阵、抠像和单输入通道链。
      </PanelIntro>
      <div className="studio-grid">
        <SelectControl
          label="测量模式"
          value={compare ? 'compare' : 'profile'}
          options={[
            ['compare', '与 CPU 对照'],
            ['profile', '单后端测量'],
          ]}
          onChange={(v) => {
            setCompare(v === 'compare');
            setResult(undefined);
          }}
        />
        <SelectControl
          label="特效渲染设备"
          value={gpu}
          options={[
            ['auto', '自动选择'],
            ['cpu', 'CPU'],
            ['gpu', '要求硬件 GPU'],
          ]}
          onChange={setGpu}
        />
        <NumberControl
          label="性能测量宽度"
          value={width}
          min={160}
          max={3840}
          onChange={setWidth}
        />
      </div>
      <button className="primary" disabled={busy} onClick={() => void measure()}>
        {busy ? '正在测量…' : '运行性能检查'}
      </button>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="inspection-metrics">
            {compare && (
              <span>
                CPU 热帧<strong>{before?.toFixed(2)} ms</strong>
              </span>
            )}
            <span>
              当前热帧<strong>{after?.toFixed(2)} ms</strong>
            </span>
            <span>
              采样一致性
              <strong>
                {compare
                  ? result.equivalence.matched
                    ? '容差内一致'
                    : '存在差异'
                  : result.determinism.mismatchFrames.length
                    ? '不稳定'
                    : '重复稳定'}
              </strong>
            </span>
          </div>
          <div className="performance-device">
            <strong>{device?.adapter?.name ?? 'CPU 绘制'}</strong>
            <span>
              {device?.adapter?.backend ?? device?.status} · {device?.requests ?? 0} 次 GPU 执行
            </span>
            <dl>
              <dt>缓冲保留</dt>
              <dd>{((device?.retainedBytes ?? 0) / 1048576).toFixed(2)} MiB</dd>
              <dt>CPU 舍入修正</dt>
              <dd>{device?.correctedPixels ?? 0} 像素</dd>
              <dt>执行回退</dt>
              <dd>{device?.fallbacks ?? 0}</dd>
            </dl>
          </div>
          <p className="hint">
            包含渲染、GPU 传输与读回，图片编码不计入。单场景采样不代表整片帧率。
          </p>
        </>
      )}
    </>
  );
}
