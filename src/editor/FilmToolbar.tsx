import React, { useState } from 'react';
import type { Sequence } from '../core/model.js';
import type { SequenceAction } from '../core/editing.js';
export function FilmToolbar({
  sequence,
  frame,
  selectedClipIds,
  onEdit,
  onCaptions,
}: {
  sequence: Sequence;
  frame: number;
  selectedClipIds: string[];
  onEdit: (actions: SequenceAction[]) => Promise<unknown>;
  onCaptions: (content: string, format: 'srt' | 'vtt') => Promise<unknown>;
}) {
  const [bpm, setBpm] = useState(120),
    [busy, setBusy] = useState(false),
    clips = sequence.tracks.flatMap((t) => t.clips),
    selectedClipId = selectedClipIds.at(-1) ?? '',
    clip = clips.find((c) => c.id === selectedClipId),
    range = sequence.workArea,
    cutIds = clips
      .filter(
        (c) => selectedClipIds.includes(c.id) && c.start < frame && c.start + c.duration > frame,
      )
      .map((c) => c.id);
  const edit = async (action: SequenceAction) => {
    setBusy(true);
    try {
      await onEdit([action]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="film-toolbar">
      <select
        aria-label="剪辑工作流"
        value={sequence.workflow ?? 'general'}
        onChange={(e) =>
          void edit({ type: 'workflow', mode: e.target.value as 'general' | 'remix' | 'film' })
        }
      >
        <option value="general">通用剪辑</option>
        <option value="remix">二创 / 节拍编排</option>
        <option value="film">电影 / 镜头剪辑</option>
      </select>
      <button
        disabled={busy || !cutIds.length}
        title="分割 · Ctrl+B"
        onClick={() => void edit({ type: 'split', frame, clipIds: cutIds })}
      >
        分割
      </button>
      <button
        disabled={busy || !clip}
        title="裁切入点到播放头"
        onClick={() => void edit({ type: 'trim', clipId: selectedClipId, edge: 'in', frame })}
      >
        裁切入点
      </button>
      <button
        disabled={busy || !clip}
        title="裁切出点到播放头之后"
        onClick={() =>
          void edit({ type: 'trim', clipId: selectedClipId, edge: 'out', frame: frame + 1 })
        }
      >
        裁切出点
      </button>
      <button
        disabled={busy || !clip}
        title="删除片段时间并移动后续全部轨道"
        onClick={() => void edit({ type: 'remove', clipIds: selectedClipIds, ripple: true })}
      >
        波纹删除
      </button>
      {selectedClipIds.length > 1 && (
        <button
          disabled={busy}
          onClick={() => void edit({ type: 'link', clipIds: selectedClipIds })}
        >
          链接 {selectedClipIds.length} 段
        </button>
      )}
      <label className="caption-import-button">
        导入字幕
        <input
          aria-label="导入字幕文件"
          type="file"
          accept=".srt,.vtt"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              await onCaptions(
                await file.text(),
                file.name.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
              );
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
      </label>
      <span className="toolbar-separator" />
      <button
        disabled={busy}
        title="标记入点 · I"
        onClick={() => void edit({ type: 'rangeIn', frame })}
      >
        I 入点
      </button>
      <button
        disabled={busy}
        title="标记出点 · O"
        onClick={() => void edit({ type: 'rangeOut', frame })}
      >
        O 出点
      </button>
      {range && (
        <>
          <span className="film-range">
            {range.start}–{range.end}f
          </span>
          <button disabled={busy} onClick={() => void edit({ type: 'clearRange' })}>
            清除范围
          </button>
        </>
      )}
      {sequence.workflow === 'remix' && (
        <>
          <label>
            BPM
            <input
              aria-label="节拍 BPM"
              type="number"
              min={20}
              max={400}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
          </label>
          <button
            disabled={busy || !Number.isFinite(bpm) || bpm < 20 || bpm > 400}
            onClick={() =>
              void edit({
                type: 'beatGrid',
                bpm,
                start: range?.start ?? 0,
                end: range?.end ?? sequence.duration,
              })
            }
          >
            生成节拍
          </button>
        </>
      )}
    </div>
  );
}
