import { describe, it, expect } from 'vitest';
import {
  MODES,
  inferMode,
  layoutKey,
  modeFromShortcut,
  parseLayout,
  readLayout,
  responsive,
  studioDefaults,
  workspaceForMode,
  writeLayout,
} from '../src/editor/studio-ui/model.js';
import {
  describeTarget,
  formatAgo,
  groupChanges,
  isHead,
  nodeHighlights,
  sceneBadges,
  undoStepsFor,
  clipHighlights,
  type ChangeEntry,
} from '../src/editor/studio-ui/change-feed.js';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};
let n = 0;
const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  id: `e${++n}`,
  at: 1_000_000 + n * 1000,
  kind: 'mcp',
  client: 'claude-code',
  action: 'edit',
  revision: `r${n}`,
  previous: `r${n - 1}`,
  files: ['scenes/title.json'],
  targets: [],
  ...over,
});

describe('studio shell model', () => {
  it('has six ordered modes with unique Ctrl+digit shortcuts', () => {
    expect(MODES.map((m) => m.name)).toEqual(['剪辑', '动效', '特效', '音乐', '图片', '文字']);
    expect(new Set(MODES.map((m) => m.keys)).size).toBe(6);
    expect(modeFromShortcut({ key: '3', code: 'Digit3', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('effects');
    expect(modeFromShortcut({ key: '!', code: 'Digit1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBeUndefined();
    expect(modeFromShortcut({ key: '7', code: 'Digit7', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeUndefined();
    expect(modeFromShortcut({ key: '1', code: 'Digit1', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeUndefined();
    expect(workspaceForMode('edit')).toBe('editing');
    expect(workspaceForMode('music')).toBe('music');
    expect(workspaceForMode('type')).toBe('animation');
  });
  it('persists layout per project and sanitises stale values', () => {
    const store = memory();
    writeLayout(store, 'p1', { ...studioDefaults, mode: 'type', left: 300, rightTab: 'inspector', followAi: false });
    expect(readLayout(store, 'p1')).toMatchObject({ mode: 'type', left: 300, rightTab: 'inspector', followAi: false });
    expect(readLayout(store, 'p2')).toEqual(studioDefaults);
    expect(store.data.has(layoutKey('p1'))).toBe(true);
    expect(parseLayout({ mode: 'nope', left: 99999, right: -4, timeline: 'x' })).toMatchObject({
      mode: studioDefaults.mode,
      left: 420,
      right: studioDefaults.right,
      timeline: studioDefaults.timeline,
    });
    store.setItem(layoutKey('bad'), '{oops');
    expect(readLayout(store, 'bad')).toEqual(studioDefaults);
  });
  it('infers the truthful mode from route and workspace', () => {
    expect(inferMode('motion', 'animation', '#/music/abc', false)).toBe('music');
    expect(inferMode('type', 'editing', '#/project', false)).toBe('edit');
    expect(inferMode('type', 'animation', '#/composition/a', false)).toBe('type');
    expect(inferMode('edit', 'animation', '#/composition/a', false)).toBe('motion');
    expect(inferMode('motion', 'animation', '#/composition/a', true)).toBe('still');
    expect(inferMode('still', 'animation', '#/composition/a', false)).toBe('motion');
  });
  it('collapses panels progressively on narrow windows', () => {
    expect(responsive(1600)).toEqual({ rightDrawer: false, compactStrip: false, compactTop: false });
    expect(responsive(1180).rightDrawer).toBe(true);
    expect(responsive(900).compactStrip).toBe(true);
  });
});

describe('change feed', () => {
  it('groups consecutive changes by actor into turns, newest first', () => {
    const a = entry({}),
      b = entry({}),
      me = entry({ kind: 'ui', client: undefined }),
      c = entry({ kind: 'file', client: undefined, at: me.at + 500_000 });
    const groups = groupChanges([c, a, me, b]);
    expect(groups.map((g) => [g.actor, g.who, g.entries.length])).toEqual([
      ['外部文件', 'ai', 1],
      ['你', 'me', 1],
      ['Claude Code', 'ai', 2],
    ]);
  });
  it('describes targets with before → after values', () => {
    expect(
      describeTarget({ kind: 'node', change: 'changed', id: 't', name: '标题', fields: ['fontSize'], values: { fontSize: [64, 76] } }),
    ).toBe('标题 字号 64 → 76');
    expect(describeTarget({ kind: 'scene', change: 'added', id: 'outro', name: '片尾' })).toBe('新建 场景 片尾');
    expect(
      describeTarget({ kind: 'node', change: 'changed', name: '副标题', fields: ['letterSpacing', 'y'] }),
    ).toBe('副标题 字距、位置');
    expect(formatAgo(8_000)).toBe('8 秒前');
    expect(formatAgo(130_000)).toBe('2 分钟前');
  });
  it('derives highlights and scene badges from unreviewed AI work only', () => {
    const now = 2_000_000;
    const ai = entry({
        targets: [
          { kind: 'node', change: 'changed', id: 'sub', sceneId: 'title', name: '副标题', fields: ['y'] },
          { kind: 'node', change: 'added', id: 'glow', sceneId: 'title', name: '光晕' },
        ],
      }),
      created = entry({ targets: [{ kind: 'scene', change: 'added', id: 'outro', sceneId: 'outro', name: '片尾' }, { kind: 'clip', change: 'added', id: 'outro-clip', sceneId: 'outro' }] }),
      mine = entry({ kind: 'ui', targets: [{ kind: 'node', change: 'changed', id: 'head', sceneId: 'title' }] });
    const all = [ai, created, mine];
    const lights = nodeHighlights(all, new Set(), now);
    expect([...lights.keys()].sort()).toEqual(['glow', 'sub']);
    expect(lights.get('glow')!.created).toBe(true);
    expect(clipHighlights(all, new Set(), now).get('outro-clip')?.created).toBe(true);
    const badges = sceneBadges(all, new Set(), now);
    expect(badges.get('title')).toEqual({ changed: 2, created: false });
    expect(badges.get('outro')?.created).toBe(true);
    // 全部保留 marks entries reviewed: highlights disappear.
    expect(nodeHighlights(all, new Set([ai.id]), now).size).toBe(0);
  });
  it('only offers group undo when the group is the head of the shared history', () => {
    const first = entry({ kind: 'ui' }),
      a = entry({}),
      b = entry({});
    const groups = groupChanges([first, a, b]);
    expect(undoStepsFor(groups[0], [first, a, b], b.revision)).toBe(2);
    expect(undoStepsFor(groups[1], [first, a, b], b.revision)).toBe(0);
    expect(undoStepsFor(groups[0], [first, a, b], 'someone-else')).toBe(0);
    expect(isHead(b, [first, a, b], b.revision)).toBe(true);
    expect(isHead(a, [first, a, b], b.revision)).toBe(false);
    const broken = entry({ previous: 'unrelated' });
    expect(undoStepsFor(groupChanges([first, a, b, broken])[0], [first, a, b, broken], broken.revision)).toBe(0);
  });
});

describe('shortcut sheet', () => {
  it('lists every mode key and no stale workspace keys or duplicate bindings', async () => {
    const { SHORTCUT_GROUPS } = await import('../src/editor/CommandPalette.js');
    const items = SHORTCUT_GROUPS.flatMap((g) => g.items);
    for (const m of MODES) {
      expect(items.some(([label, keys]) => keys === m.keys && label.startsWith(m.name))).toBe(true);
    }
    expect(items.some(([, keys]) => keys.includes('Ctrl+1 / Ctrl+5'))).toBe(false);
    expect(items.some(([, keys]) => keys.split(' / ').includes('/'))).toBe(true);
    // Within one group a key combo must mean one thing.
    for (const g of SHORTCUT_GROUPS) {
      const seen = new Map<string, string>();
      for (const [label, keys] of g.items)
        for (const k of keys.split(' / ')) {
          if (/[\u4e00-\u9fff]/.test(k)) continue; // mouse gestures ("拖动…")
          expect(seen.get(k) ?? label, `${g.title}: ${k}`).toBe(label);
          seen.set(k, label);
        }
    }
  });
});

describe('context toolbar placement', () => {
  it('avoids the selection and nearby objects, flipping to the free side', async () => {
    const { placeToolbar } = await import('../src/editor/studio-ui/model.js');
    const canvas = { width: 1920, height: 1080 };
    const size = { width: 520, height: 60 };
    const title = { x: 560, y: 380, width: 800, height: 160 };
    const subtitle = { x: 660, y: 560, width: 600, height: 70 };
    const backdrop = { x: 0, y: 0, width: 1920, height: 1080 };
    // Subtitle selected, title just above it: the bar must go below, not over the title.
    const p = placeToolbar(subtitle, size, canvas, [title, backdrop]);
    expect(p.side).toBe('below');
    expect(p.y).toBeGreaterThanOrEqual(subtitle.y + subtitle.height);
    // A large band under the subtitle (a backdrop shape) must not push the bar onto the title.
    const band = { x: 0, y: 600, width: 1920, height: 480 };
    expect(placeToolbar(subtitle, size, canvas, [{ ...title, weight: 2 }, band]).side).toBe('below');
    // Nothing above: prefer above.
    expect(placeToolbar(title, size, canvas, [backdrop]).side).toBe('above');
    // Object at the very top: flips below and stays on canvas.
    const top = placeToolbar({ x: 700, y: 0, width: 400, height: 80 }, size, canvas, []);
    expect(top.side).toBe('below');
    expect(top.x).toBeGreaterThanOrEqual(0);
    // Full-canvas selection: sits inside instead of off-canvas.
    expect(placeToolbar(backdrop, size, canvas, []).side).toBe('inside');
  });
});
