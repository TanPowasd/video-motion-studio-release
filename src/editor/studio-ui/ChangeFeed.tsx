import React, { useEffect, useMemo, useRef } from 'react';
import { Icon } from '../Icons.js';
import {
  describeEntry,
  describeTarget,
  fieldLabel,
  formatAgo,
  groupChanges,
  isHead,
  undoStepsFor,
  whoOf,
  type ChangeEntry,
  type ChangeTarget,
  type FeedGroup,
} from './change-feed.js';
import type { AgentStatus } from './StudioTopBar.js';

export type FeedFilter = 'all' | 'ai' | 'me';

/**
 * 改动记录: every change to the project grouped into turns (an AI batch or your own edits).
 * Built from the service change journal; undo goes through the shared history.
 */
export function ChangeFeed({
  entries,
  head,
  reviewed,
  filter,
  now,
  agents,
  focusId,
  busy,
  onFilter,
  onKeep,
  onUndo,
  onHold,
  onReveal,
  onDiff,
  onConnect,
}: {
  entries: ChangeEntry[];
  head: string;
  reviewed: ReadonlySet<string>;
  filter: FeedFilter;
  now: number;
  agents?: AgentStatus;
  /** Entry to scroll into view and flash (e.g. from a canvas chip or scene badge). */
  focusId?: string;
  busy: boolean;
  onFilter: (f: FeedFilter) => void;
  onKeep: (group: FeedGroup) => void;
  onUndo: (steps: number, group: FeedGroup) => void;
  onHold: (hold: boolean) => void;
  onReveal: (entry: ChangeEntry, target?: ChangeTarget) => void;
  onDiff: (group: FeedGroup) => void;
  onConnect: () => void;
}) {
  const groups = useMemo(() => groupChanges(entries), [entries]);
  const shown = groups.filter((g) => filter === 'all' || g.who === filter);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-entry="${focusId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.classList.add('flash');
    const t = setTimeout(() => el?.classList.remove('flash'), 1400);
    return () => clearTimeout(t);
  }, [focusId]);
  const activeClients = new Set(agents?.clients.filter((c) => c.active).map((c) => c.client));
  return (
    <section className="change-feed" aria-label="改动记录">
      <header className="cf-head">
        <h2>{groups.length ? `${groups.length} 组 · ${entries.length} 次提交` : '暂无记录'}</h2>
        <div className="cf-filter" role="tablist" aria-label="筛选改动">
          {(
            [
              ['all', '全部'],
              ['ai', 'AI'],
              ['me', '我'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => onFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {agents?.hold && (
        <div className="cf-hold" role="status">
          <Icon name="pause" size={13} />
          <span>已暂停 AI：MCP 写入会被拒绝，外部文件改动等你恢复后再同步。</span>
          <button onClick={() => onHold(false)}>恢复</button>
        </div>
      )}
      <div className="cf-list" ref={list}>
        {!shown.length && (
          <div className="cf-empty">
            <div className="cf-empty-mark" aria-hidden>
              <i />
              <i />
            </div>
            <strong>{filter === 'me' ? '你还没有改动' : filter === 'ai' ? '还没有 AI 改动' : '还没有改动'}</strong>
            <p>外部 AI 通过 MCP 或直接修改工程文件时，这里会按批次列出每一处改动，可逐条定位、撤销或整组保留。</p>
            {filter !== 'me' && !activeClients.size && (
              <button className="secondary" onClick={onConnect}>
                连接 MCP
              </button>
            )}
          </div>
        )}
        {shown.map((group, index) => {
          const steps = undoStepsFor(group, entries, head),
            kept = group.entries.every((e) => reviewed.has(e.id)),
            live =
              group.kind === 'mcp' &&
              index === 0 &&
              now - group.endedAt < 20_000 &&
              (!group.client || activeClients.has(group.client)),
            lines = group.entries.flatMap(describeEntry).reverse();
          return (
            <article
              key={group.id}
              className={`cf-group ${group.who} ${live ? 'live' : ''} ${kept ? 'kept' : ''}`}
              aria-label={`${group.actor} 的改动`}
            >
              <header>
                <span className={`cf-avatar ${group.who}`}>{group.who === 'ai' ? 'AI' : '我'}</span>
                <strong>{group.actor}</strong>
                {live && <span className="cf-typing" aria-label="进行中"><i /><i /><i /></span>}
                <time title={new Date(group.endedAt).toLocaleString()}>{live ? '进行中' : formatAgo(now - group.endedAt)}</time>
              </header>
              {group.intent ? (
                <p className="cf-intent">“{group.intent}”</p>
              ) : group.who === 'ai' && group.kind === 'file' ? (
                <p className="cf-intent plain">直接修改文件</p>
              ) : group.who === 'ai' && group.kind === 'cli' ? (
                <p className="cf-intent plain">命令行 / 脚本</p>
              ) : null}
              <ul>
                {lines.slice(0, 12).map((line) => (
                  <li key={line.key} data-entry={line.entry.id}>
                    <button
                      className="cf-line"
                      title={line.target ? '定位到画布 / 时间线' : undefined}
                      disabled={!line.target}
                      onClick={() => onReveal(line.entry, line.target)}
                    >
                      <span className="cf-text">{line.text}</span>
                      {line.source && <code>{line.source}</code>}
                    </button>
                    {isHead(line.entry, entries, head) && group.entries.length > 1 && (
                      <button className="cf-mini" disabled={busy} title="撤销这一步" onClick={() => onUndo(1, group)}>
                        撤销
                      </button>
                    )}
                  </li>
                ))}
                {lines.length > 12 && <li className="cf-more">还有 {lines.length - 12} 项…</li>}
              </ul>
              <footer>
                {group.who === 'ai' && !kept && (
                  <button className="cf-keep" disabled={busy} onClick={() => onKeep(group)}>
                    全部保留
                  </button>
                )}
                {group.who === 'ai' && kept && <span className="cf-kept-note"><Icon name="check" size={12} /> 已保留</span>}
                <button
                  disabled={busy || !steps}
                  title={steps ? `撤销这一组（共 ${steps} 步，共享撤销历史）` : '之后还有改动：需先撤销更新的改动'}
                  onClick={() => onUndo(steps, group)}
                >
                  {group.entries.length > 1 ? '整组撤销' : '撤销'}
                </button>
                <button onClick={() => onDiff(group)}>查看差异</button>
                {group.who === 'ai' && index === 0 && group.kind === 'mcp' && !agents?.hold && (
                  <button onClick={() => onHold(true)} title="暂停外部 AI 写入工程（只读工具仍可用）">
                    暂停 AI
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

const fmt = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);

/** Field-level difference for one turn (values for scalar fields; files and revisions). */
export function DiffDialog({ group, onClose, onReveal }: { group: FeedGroup; onClose: () => void; onReveal: (entry: ChangeEntry, target?: ChangeTarget) => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <div className="vm-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="vm-sheet cf-diff"
        role="dialog"
        aria-modal="true"
        aria-label="改动差异"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <header>
          <span className={`cf-avatar ${group.who}`}>{group.who === 'ai' ? 'AI' : '我'}</span>
          <h2>
            {group.actor} · {group.entries.length} 次提交
          </h2>
          <button ref={close} className="icon-button" aria-label="关闭差异" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cf-diff-body">
          {group.entries
            .slice()
            .reverse()
            .map((entry) => (
              <section key={entry.id}>
                <h3>
                  <span>{new Date(entry.at).toLocaleTimeString()}</span>
                  <code>{entry.tool ?? entry.action}</code>
                  <span className="mono">
                    {entry.previous.slice(0, 8)} → {entry.revision.slice(0, 8)}
                  </span>
                </h3>
                {entry.targets.map((t, i) => (
                  <div key={i} className={`cf-diff-target ${t.change}`}>
                    <button className="cf-diff-name" onClick={() => onReveal(entry, t)}>
                      {describeTarget(t)}
                    </button>
                    {t.fields && (
                      <table>
                        <tbody>
                          {t.fields.map((f) => (
                            <tr key={f}>
                              <th>{fieldLabel(f)}<small>{f}</small></th>
                              {t.values?.[f] ? (
                                <>
                                  <td className="before">{fmt(t.values[f][0])}</td>
                                  <td className="arrow">→</td>
                                  <td className="after">{fmt(t.values[f][1])}</td>
                                </>
                              ) : (
                                <td colSpan={3} className="complex">结构化值已修改（在属性面板中查看当前值）</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
                <p className="cf-diff-files">
                  {entry.files.map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </p>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
export { whoOf };
