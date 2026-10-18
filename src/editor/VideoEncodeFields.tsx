import React, { useState } from 'react';
import type { Operation } from '../core/model.js';
import type {
  EncoderMode,
  VideoCodec,
  VideoExportSettings,
  VideoQuality,
} from '../core/video-export-schema.js';

const encoderLabels: Record<EncoderMode, string> = {
  auto: '自动（硬件优先，检测失败用软件）',
  software: '软件编码（x264/x265/SVT-AV1）',
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  amf: 'AMD AMF',
  mediafoundation: 'Windows Media Foundation',
  videotoolbox: 'Apple VideoToolbox',
  vaapi: 'Linux VA-API',
};
const codecLabels: Record<VideoCodec, string> = {
  h264: 'H.264（兼容性最好）',
  hevc: 'HEVC / H.265',
  av1: 'AV1',
};
interface ProbeRow {
  codec: VideoCodec;
  encoder: string;
  listed: boolean;
  ok?: boolean;
  ms?: number;
  error?: string;
}

/** MP4 encoder/codec/quality fields of the export dialog. Values seed from project videoExport. */
export function VideoEncodeFields({
  value,
  saved,
  onChange,
  run,
  transact,
}: {
  value: VideoExportSettings;
  saved?: VideoExportSettings;
  onChange: (value: VideoExportSettings) => void;
  run: (method: string, params?: unknown) => Promise<any>;
  transact: (operations: Operation[]) => Promise<unknown>;
}) {
  const [probe, setProbe] = useState<{
    rows: ProbeRow[];
    software: Record<string, string | null>;
  }>();
  const [probing, setProbing] = useState(false);
  const codec = value.codec ?? 'h264',
    quality = value.quality ?? {},
    setQuality = (patch: Partial<VideoQuality>) => {
      const next = { ...quality, ...patch };
      for (const key of Object.keys(next) as (keyof VideoQuality)[])
        if (next[key] === undefined) delete next[key];
      onChange({ ...value, quality: Object.keys(next).length ? next : undefined });
    },
    dirty = JSON.stringify(value) !== JSON.stringify(saved ?? {});
  return (
    <>
      <label className="modal-field">
        视频编码器
        <select
          aria-label="导出视频编码器"
          value={value.encoder ?? 'auto'}
          onChange={(e) => onChange({ ...value, encoder: e.target.value as EncoderMode })}
        >
          {(Object.keys(encoderLabels) as EncoderMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {encoderLabels[mode]}
            </option>
          ))}
        </select>
      </label>
      <div className="encode-fields">
        <label className="modal-field">
          编码格式
          <select
            aria-label="导出视频编码格式"
            value={codec}
            onChange={(e) => {
              const next = e.target.value as VideoCodec;
              onChange({
                ...value,
                codec: next,
                quality:
                  next === 'h264' && quality.bitDepth === 10
                    ? { ...quality, bitDepth: undefined }
                    : value.quality,
              });
            }}
          >
            {(Object.keys(codecLabels) as VideoCodec[]).map((c) => (
              <option key={c} value={c}>
                {codecLabels[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="modal-field">
          速度 / 质量
          <select
            aria-label="编码预设"
            value={quality.preset ?? ''}
            onChange={(e) =>
              setQuality({ preset: (e.target.value || undefined) as VideoQuality['preset'] })
            }
          >
            <option value="">默认</option>
            <option value="speed">速度优先</option>
            <option value="balanced">平衡</option>
            <option value="quality">质量优先</option>
          </select>
        </label>
        <label className="modal-field">
          CRF 质量值
          <input
            aria-label="CRF 质量值"
            type="number"
            min={0}
            max={codec === 'av1' ? 63 : 51}
            placeholder="默认"
            value={quality.crf ?? ''}
            onChange={(e) =>
              setQuality({
                crf: e.target.value === '' ? undefined : Math.round(Number(e.target.value)),
              })
            }
          />
        </label>
      </div>
      {codec !== 'h264' && (
        <label className="modal-check">
          <input
            type="checkbox"
            checked={quality.bitDepth === 10}
            onChange={(e) => setQuality({ bitDepth: e.target.checked ? 10 : undefined })}
          />
          10-bit 输出（需要编码器支持 Main10）
        </label>
      )}
      <p className="hint">
        自动模式会用一次真实小样编码确认硬件可用；已开始的导出在续渲染时固定同一编码器，中途失败会停止任务而不混用编码器。
      </p>
      <div className="encode-actions">
        <button
          className="secondary"
          disabled={probing}
          onClick={async () => {
            setProbing(true);
            try {
              const result = await run('encoderProbe', { codecs: [codec] });
              if (result) setProbe(result);
            } finally {
              setProbing(false);
            }
          }}
        >
          {probing ? '检测中…' : '检测硬件编码'}
        </button>
        <button
          className="secondary"
          disabled={!dirty}
          onClick={() =>
            transact([
              {
                type: 'updateProject',
                patch: { videoExport: Object.keys(value).length ? value : undefined },
              },
            ])
          }
        >
          设为工程默认
        </button>
      </div>
      {probe && (
        <ul className="encode-probe" aria-label="硬件编码检测结果">
          {probe.rows
            .filter((row) => row.codec === codec)
            .map((row) => (
              <li key={row.encoder} className={row.ok ? 'ok' : 'failed'}>
                <strong>{row.encoder}</strong>
                <span>
                  {!row.listed
                    ? '当前 FFmpeg 未内置'
                    : row.ok
                      ? `可用 · 测试编码 ${row.ms} ms`
                      : `不可用 · ${row.error ?? '测试编码失败'}`}
                </span>
              </li>
            ))}
          <li className="ok">
            <strong>软件</strong>
            <span>{probe.software[codec] ?? '当前 FFmpeg 缺少该格式的软件编码器'}</span>
          </li>
        </ul>
      )}
    </>
  );
}
