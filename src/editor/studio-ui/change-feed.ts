/**
 * Change feed logic: turns the service change journal into reviewable groups ("turns"),
 * human-readable lines, canvas/timeline highlights and scene badges. Pure functions.
 */
import type { ChangeEntry, ChangeTarget } from '../../service/change-journal.js';
export type { ChangeEntry, ChangeTarget };

export type Who = 'ai' | 'me';
/** External origins (MCP clients, CLI automation, direct file edits) count as AI. */
export const whoOf = (entry: Pick<ChangeEntry, 'kind'>): Who => (entry.kind === 'ui' ? 'me' : 'ai');
export function actorName(entry: Pick<ChangeEntry, 'kind' | 'client'>) {
  if (entry.kind === 'ui') return '你';
  if (entry.kind === 'mcp') return prettyClient(entry.client) ?? 'MCP 客户端';
  if (entry.kind === 'cli') return '命令行';
  return '外部文件';
}
const knownClients: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  claude: 'Claude',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  codex: 'Codex',
  'codex-mcp-client': 'Codex',
  windsurf: 'Windsurf',
  cline: 'Cline',
  'gemini-cli': 'Gemini CLI',
  'agent-web': 'Agent 接口',
};
export function prettyClient(client?: string) {
  if (!client) return undefined;
  return knownClients[client.toLowerCase()] ?? client;
}

export interface FeedGroup {
  id: string;
  who: Who;
  kind: ChangeEntry['kind'];
  actor: string;
  client?: string;
  intent?: string;
  startedAt: number;
  endedAt: number;
  /** Oldest first. */
  entries: ChangeEntry[];
}
/**
 * Groups consecutive entries by the same actor into one turn. A new turn starts when the
 * actor changes, the gap exceeds `gapMs`, or the caller supplies a different intent.
 */
export function groupChanges(entries: ChangeEntry[], gapMs = 120_000): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    const last = groups.at(-1),
      actor = actorName(entry);
    if (
      last &&
      last.actor === actor &&
      last.kind === entry.kind &&
      entry.at - last.endedAt <= gapMs &&
      (!entry.intent || !last.intent || entry.intent === last.intent)
    ) {
      last.entries.push(entry);
      last.endedAt = entry.at;
      last.intent ??= entry.intent;
      continue;
    }
    groups.push({
      id: entry.id,
      who: whoOf(entry),
      kind: entry.kind,
      actor,
      client: entry.client,
      intent: entry.intent,
      startedAt: entry.at,
      endedAt: entry.at,
      entries: [entry],
    });
  }
  return groups.reverse();
}

const FIELD_LABELS: Record<string, string> = {
  x: '位置',
  y: '位置',
  width: '尺寸',
  height: '尺寸',
  rotation: '旋转',
  scaleX: '缩放',
  scaleY: '缩放',
  opacity: '不透明度',
  fill: '颜色',
  stroke: '描边',
  strokeWidth: '描边',
  text: '文字',
  fontFamily: '字体',
  fontSize: '字号',
  fontWeight: '字重',
  letterSpacing: '字距',
  lineHeight: '行高',
  align: '对齐',
  glyphSet: '字形库',
  glyphFallback: '缺字回退',
  animations: '动画',
  animationLayers: '动画层',
  textAnimator: '逐字动画',
  effects: '特效',
  effectStack: '特效',
  graphics: '图形',
  start: '时间',
  end: '时间',
  duration: '时长',
  sourceIn: '入点',
  speed: '变速',
  volume: '音量',
  fadeIn: '淡入',
  fadeOut: '淡出',
  visible: '显示',
  name: '名称',
  background: '背景',
  blur: '模糊',
  blend: '混合',
  params: '参数',
  path: '路径',
  points: '形状',
  radius: '圆角',
  still: '画板',
  nodes: '图层',
  transition: '转场',
  reveal: '显现',
  brightness: '亮度',
  saturation: '饱和度',
};
export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;
const KIND_LABELS: Record<ChangeTarget['kind'], string> = {
  project: '工程',
  scene: '场景',
  node: '图层',
  sequence: '序列',
  clip: '片段',
  asset: '素材',
  file: '文件',
};
const fmt = (v: unknown) =>
  typeof v === 'number' ? String(Math.round(v * 100) / 100) : typeof v === 'string' ? v : String(v);
/** One-line description of a target, e.g. "标题 字号 64 → 76" or "新建 场景 片尾". */
export function describeTarget(t: ChangeTarget): string {
  const name = t.name ?? t.id ?? KIND_LABELS[t.kind];
  if (t.change === 'added') return `新建 ${KIND_LABELS[t.kind]} ${name}`;
  if (t.change === 'removed') return `删除 ${KIND_LABELS[t.kind]} ${name}`;
  const fields = t.fields ?? [];
  const values = Object.entries(t.values ?? {});
  if (values.length === 1 && fields.length === 1) {
    const [field, [a, b]] = values[0];
    if (typeof a === 'number' || (typeof a === 'string' && String(a).length <= 16 && String(b).length <= 16))
      return `${name} ${fieldLabel(field)} ${fmt(a)} → ${fmt(b)}`;
  }
  const labels = [...new Set(fields.map(fieldLabel))];
  return labels.length ? `${name} ${labels.slice(0, 3).join('、')}${labels.length > 3 ? ' 等' : ''}` : `${name} 已修改`;
}
export interface FeedLine {
  key: string;
  text: string;
  /** MCP tool name or changed file path. */
  source?: string;
  target?: ChangeTarget;
  entry: ChangeEntry;
}
export function describeEntry(entry: ChangeEntry): FeedLine[] {
  const source =
    entry.action === 'undo' ? '撤销' : entry.action === 'redo' ? '重做' : entry.tool ?? entry.files[0];
  const structured = entry.targets.filter((t) => t.kind !== 'file' || entry.targets.length === 1);
  const lines: FeedLine[] = (structured.length ? structured : entry.targets).map((t, i) => ({
    key: `${entry.id}:${i}`,
    text: (entry.action === 'undo' ? '撤销：' : entry.action === 'redo' ? '重做：' : '') + describeTarget(t),
    source: entry.kind === 'file' || entry.kind === 'cli' ? (t.sceneId || t.sequenceId ? fileFor(entry, t) : source) : source,
    target: t,
    entry,
  }));
  if (!lines.length)
    lines.push({ key: entry.id, text: entry.files.join('、') || '工程已更新', source, entry });
  if (entry.truncated)
    lines.push({ key: `${entry.id}:more`, text: '…还有更多改动', entry });
  return lines;
}
function fileFor(entry: ChangeEntry, t: ChangeTarget) {
  const id = t.kind === 'clip' || t.kind === 'sequence' ? t.sequenceId : (t.sceneId ?? t.sequenceId);
  return entry.files.find((f) => id && f.includes(id)) ?? entry.files[0];
}

export function formatAgo(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** AI entries the user has not yet kept/undone, newest first. */
export function pendingAi(entries: ChangeEntry[], reviewed: ReadonlySet<string>, now: number, windowMs = 6 * 3600_000) {
  return entries
    .filter((e) => whoOf(e) === 'ai' && !reviewed.has(e.id) && now - e.at <= windowMs && e.action !== 'undo')
    .sort((a, b) => b.at - a.at);
}
export interface Highlight {
  nodeId: string;
  sceneId?: string;
  entry: ChangeEntry;
  target: ChangeTarget;
  created: boolean;
  text: string;
}
/** Latest unreviewed AI change per node (for dashed mint outlines + chips). */
export function nodeHighlights(entries: ChangeEntry[], reviewed: ReadonlySet<string>, now: number) {
  const map = new Map<string, Highlight>();
  for (const entry of pendingAi(entries, reviewed, now))
    for (const target of entry.targets)
      if (target.kind === 'node' && target.id && target.change !== 'removed' && !map.has(target.id))
        map.set(target.id, {
          nodeId: target.id,
          sceneId: target.sceneId,
          entry,
          target,
          created: target.change === 'added',
          text: describeTarget(target).replace(new RegExp(`^${escape(target.name ?? '')}\\s*`), ''),
        });
  return map;
}
/** Clips touched by unreviewed AI changes. */
export function clipHighlights(entries: ChangeEntry[], reviewed: ReadonlySet<string>, now: number) {
  const map = new Map<string, { created: boolean; entry: ChangeEntry }>();
  for (const entry of pendingAi(entries, reviewed, now))
    for (const t of entry.targets)
      if (t.kind === 'clip' && t.id && t.change !== 'removed' && !map.has(t.id))
        map.set(t.id, { created: t.change === 'added', entry });
  return map;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export interface SceneBadge {
  changed: number;
  created: boolean;
}
export function sceneBadges(entries: ChangeEntry[], reviewed: ReadonlySet<string>, now: number) {
  const badges = new Map<string, SceneBadge>();
  const touched = new Map<string, Set<string>>();
  for (const entry of pendingAi(entries, reviewed, now))
    for (const t of entry.targets) {
      const sceneId = t.kind === 'scene' ? t.id : t.kind === 'node' ? t.sceneId : undefined;
      if (!sceneId || t.change === 'removed') continue;
      const badge = badges.get(sceneId) ?? { changed: 0, created: false };
      if (t.kind === 'scene' && t.change === 'added') badge.created = true;
      const set = touched.get(sceneId) ?? new Set<string>();
      set.add(`${t.kind}:${t.id}`);
      touched.set(sceneId, set);
      badge.changed = set.size;
      badges.set(sceneId, badge);
    }
  return badges;
}
/**
 * How many shared-history undo steps revert `group`, or 0 when it cannot be reverted
 * without also reverting later changes. Every edit/external entry is one undo step; the
 * group must be the newest work and form an unbroken revision chain ending at `head`.
 */
export function undoStepsFor(group: FeedGroup, all: ChangeEntry[], head: string) {
  const newest = [...all].sort((a, b) => a.at - b.at).at(-1);
  if (!newest || group.entries.at(-1)?.id !== newest.id || newest.revision !== head) return 0;
  let steps = 0,
    expected = head;
  for (const entry of [...group.entries].reverse()) {
    if (entry.action !== 'edit' && entry.action !== 'external') return 0;
    if (entry.revision !== expected) return 0;
    expected = entry.previous;
    steps++;
  }
  return steps;
}
/** True when `entry` is the current head of the shared history (plain Undo reverts it). */
export const isHead = (entry: ChangeEntry, all: ChangeEntry[], head: string) =>
  entry.revision === head && [...all].sort((a, b) => a.at - b.at).at(-1)?.id === entry.id &&
  (entry.action === 'edit' || entry.action === 'external');

/** Where to reveal a change: the first structured target. */
export function revealTarget(entry: ChangeEntry) {
  return (
    entry.targets.find((t) => t.kind === 'node' && t.change !== 'removed') ??
    entry.targets.find((t) => t.kind === 'clip' && t.change !== 'removed') ??
    entry.targets.find((t) => t.kind === 'scene' && t.change !== 'removed')
  );
}
