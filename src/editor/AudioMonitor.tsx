import React from 'react';
export function AudioMonitor({
  status,
  muted,
  volume,
  onMute,
  onVolume,
  enabled,
}: {
  status: { phase: string; message?: string; peak: number; rms: number; bufferedSeconds: number };
  muted: boolean;
  volume: number;
  onMute: () => void;
  onVolume: (value: number) => void;
  enabled: boolean;
}) {
  const label =
    status.phase === 'error'
      ? '声音预览错误'
      : status.phase === 'buffering'
        ? '声音缓冲中'
        : status.phase === 'playing'
          ? '声音播放中'
          : enabled
            ? '声音预览'
            : '合成预览';
  return (
    <div
      className={`audio-monitor phase-${status.phase}`}
      aria-label="声音预览状态"
      data-phase={status.phase}
      data-buffered-seconds={status.bufferedSeconds.toFixed(2)}
      data-peak={status.peak.toFixed(4)}
      title={status.message ?? (enabled ? '48 kHz 本地混音预览' : '声音在主时间轴预览')}
    >
      <span className="audio-monitor-label">{label}</span>
      {enabled && (
        <>
          <button
            aria-label={muted ? '开启监听声音' : '静音监听声音'}
            aria-pressed={muted}
            onClick={onMute}
          >
            {muted ? '静音' : '监听'}
          </button>
          <input
            aria-label="监听音量"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
          <div className="audio-level" aria-label="声音电平">
            <i style={{ width: `${Math.min(100, status.peak * 100)}%` }} />
          </div>
        </>
      )}
      {status.message && <small>{status.message}</small>}
    </div>
  );
}
