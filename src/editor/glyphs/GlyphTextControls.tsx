import React, { lazy, Suspense, useEffect, useState } from 'react';
import type { Node } from '../../core/model.js';
import { fallbackLabels, inspectGlyphs, type GlyphSetSummary } from './glyph-api.js';
import './glyphs.css';

const GlyphPanel = lazy(() => import('./GlyphPanel.js').then((m) => ({ default: m.GlyphPanel })));

/** 字形库 select + fallback for a text layer, plus the entry to the 字形 panel. */
export function GlyphTextControls({
  node,
  revision,
  update,
  onApplied,
}: {
  node: Node;
  revision: string;
  update: (patch: Partial<Node>) => unknown;
  onApplied: () => Promise<unknown>;
}) {
  const [sets, setSets] = useState<GlyphSetSummary[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    inspectGlyphs({})
      .then((r) => alive && setSets(r.sets))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [revision]);
  const current = node.glyphSet ?? '',
    known = sets.some((s) => s.id === current);
  return (
    <div className="glyph-text-controls">
      <label className="glyph-row">
        <span>字形库</span>
        <select
          aria-label="字形库"
          value={current}
          onChange={(e) => update(e.target.value ? { glyphSet: e.target.value } : { glyphSet: null })}
        >
          <option value="">无（仅字体）</option>
          {sets.map((s) => (
            <option key={s.id} value={s.id} disabled={!!s.error}>
              {(s.name ?? s.id) + (s.builtin ? '（内置）' : '')}
            </option>
          ))}
          {current && !known && <option value={current}>{current}（缺失）</option>}
        </select>
      </label>
      {current && (
        <label className="glyph-row">
          <span>缺字</span>
          <select
            aria-label="缺字回退"
            value={node.glyphFallback ?? 'font'}
            onChange={(e) => update({ glyphFallback: e.target.value as Node['glyphFallback'] })}
          >
            {Object.entries(fallbackLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="glyph-open" onClick={() => setOpen(true)}>
        字形面板…
      </button>
      {error && <p className="glyph-error">{error}</p>}
      {open && (
        <Suspense fallback={null}>
          <GlyphPanel
            initialSet={current || sets.find((s) => !s.builtin)?.id || 'builtin:demo'}
            sampleText={node.text}
            revision={revision}
            onClose={() => setOpen(false)}
            onApplied={onApplied}
          />
        </Suspense>
      )}
    </div>
  );
}
