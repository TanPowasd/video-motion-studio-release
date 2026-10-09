import React from 'react';
import type { Project, Scene } from '../../core/model.js';
import { Icon } from '../Icons.js';
import type { SceneBadge } from './change-feed.js';

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** Vertical scene strip: thumbnails, durations, AI badges and 新场景. */
export function SceneStrip({
  scenes,
  project,
  revision,
  fps,
  activeId,
  badges,
  compact,
  onOpen,
  onNew,
  onReveal,
}: {
  scenes: Scene[];
  project: Project;
  revision: string;
  fps: number;
  activeId?: string;
  badges: Map<string, SceneBadge>;
  compact?: boolean;
  onOpen: (scene: Scene) => void;
  onNew: () => void;
  /** Clicking an AI badge reveals that scene's changes in the change feed. */
  onReveal: (scene: Scene) => void;
}) {
  return (
    <section className={`scene-strip ${compact ? 'compact' : ''}`} aria-label="场景">
      <header className="ss-head">
        <span>场景</span>
        <small>{scenes.length}</small>
      </header>
      <div className="ss-list">
        {scenes.map((s, i) => {
          const w = s.width ?? project.width,
            h = s.height ?? project.height,
            tw = 240,
            th = Math.max(16, Math.round((tw * h) / Math.max(1, w))),
            badge = badges.get(s.id),
            mid = s.still ? 0 : Math.min(s.duration - 1, Math.round(s.duration * 0.5));
          return (
            <div
              key={s.id}
              className={`scene-row ss-card ${activeId === s.id ? 'selected' : ''} ${badge ? 'ai' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`场景 ${i + 1} ${s.name}`}
              aria-current={activeId === s.id ? 'true' : undefined}
              onClick={() => onOpen(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(s);
                }
              }}
            >
              <div className={`ss-thumb ${s.still ? 'still' : ''}`} style={{ background: s.background }}>
                <img
                  loading="lazy"
                  alt=""
                  src={`/api/frame?frame=${mid}&width=${tw}&height=${th}&scene=${encodeURIComponent(s.id)}&revision=${revision}`}
                />
                {compact && <span className="ss-index">{i + 1}</span>}
              </div>
              <div className="ss-meta">
                <span className="ss-name" title={s.name}>
                  <b>{i + 1}</b> {s.name}
                </span>
                {badge ? (
                  <button
                    className={`ss-badge ${badge.created ? 'created' : ''}`}
                    title="在改动记录中查看"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReveal(s);
                    }}
                  >
                    {badge.created ? 'AI 新建' : `AI 改动 ${badge.changed}`}
                  </button>
                ) : (
                  <span className="ss-dur">{s.still ? `${w}×${h}` : clock(s.duration / fps)}</span>
                )}
              </div>
            </div>
          );
        })}
        <button className="ss-new" onClick={onNew} aria-label="新场景">
          <Icon name="plus" size={14} />
          <span>新场景</span>
        </button>
      </div>
    </section>
  );
}
