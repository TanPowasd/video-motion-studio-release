import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  THEME_STORAGE_KEY,
  THEME_TOGGLE_KEYS,
  applyTheme,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  toggledTheme,
  writeThemePreference,
  type ThemePreference,
} from '../src/editor/theme.js';
import { readSettings, writeSettings, parseThemeSource, windowBackground } from '../src/desktop/settings.js';

const read = (file: string) => readFileSync(path.resolve(file), 'utf8');
const memory = (initial?: Record<string, string>) => {
  const data = new Map(Object.entries(initial ?? {}));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('theme preference', () => {
  it('resolves system / dark / light against the OS scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(parseThemePreference('nonsense')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
    expect(toggledTheme('dark')).toBe('light');
    expect(toggledTheme('light')).toBe('dark');
  });

  it('persists to storage and prefers the desktop setting', () => {
    const s = memory();
    expect(readThemePreference(s)).toBe('system');
    writeThemePreference(s, 'light');
    expect(s.data.get(THEME_STORAGE_KEY)).toBe('light');
    expect(readThemePreference(s)).toBe('light');
    // Electron: the editor origin changes per project, so the settings file wins.
    expect(readThemePreference(s, 'dark')).toBe('dark');
    expect(readThemePreference(s, 'bogus')).toBe('light');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readThemePreference(broken)).toBe('system');
    expect(() => writeThemePreference(broken, 'dark')).not.toThrow();
  });

  it('applies data-theme, data-theme-pref and color-scheme', () => {
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: '' } };
    applyTheme(root, 'system', 'light');
    expect(root.dataset).toEqual({ theme: 'light', themePref: 'system' });
    expect(root.style.colorScheme).toBe('light');
  });

  it('index.html boot script matches theme.ts (no flash of the wrong theme)', () => {
    const html = read('src/editor/index.html');
    const script = html.match(/<script id="vm-theme-boot">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    // It must run before the module entry.
    expect(html.indexOf('vm-theme-boot')).toBeLessThan(html.indexOf('/main.tsx'));
    const prefs: Array<string | null> = [null, 'system', 'dark', 'light', 'garbage'];
    for (const stored of prefs)
      for (const desktop of [undefined, 'dark', 'light', 'system'] as const)
        for (const systemDark of [true, false]) {
          const attrs: Record<string, string> = {};
          const style = { colorScheme: '' };
          const window = {
            vmotionDesktop: desktop ? { themePreference: desktop } : undefined,
            matchMedia: () => ({ matches: systemDark }),
          };
          vm.runInNewContext(script!, {
            window,
            localStorage: memory(stored === null ? {} : { [THEME_STORAGE_KEY]: stored }),
            document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), style } },
          });
          const preference = readThemePreference(
            memory(stored === null ? {} : { [THEME_STORAGE_KEY]: stored }),
            desktop,
          );
          expect(attrs['data-theme-pref']).toBe(preference);
          expect(attrs['data-theme']).toBe(resolveTheme(preference, systemDark));
          expect(style.colorScheme).toBe(attrs['data-theme']);
        }
  });

  it('stores the desktop preference in settings.json and keeps other keys', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vm-settings-'));
    const file = path.join(dir, 'settings.json');
    expect(readSettings(file)).toEqual({ theme: 'system' });
    writeFileSync(file, JSON.stringify({ theme: 'purple', other: 1 }));
    expect(readSettings(file)).toEqual({ theme: 'system', other: 1 });
    await writeSettings(file, { ...readSettings(file), theme: 'light' });
    expect(readSettings(file)).toEqual({ theme: 'light', other: 1 });
    writeFileSync(file, '{not json');
    expect(readSettings(file).theme).toBe('system');
    expect(parseThemeSource('dark')).toBe('dark');
    expect(windowBackground(true)).toBe(tokens('dark')['--vm-bg-1']);
    expect(windowBackground(false)).toBe(tokens('light')['--vm-bg-1']);
  });

  it('lists the toggle shortcut on the ? sheet', async () => {
    const { SHORTCUT_GROUPS } = await import('../src/editor/CommandPalette.js');
    expect(SHORTCUT_GROUPS.flatMap((g) => g.items).some(([, keys]) => keys === THEME_TOGGLE_KEYS)).toBe(true);
  });
});

// ── Tokens ────────────────────────────────────────────────────────────────
function block(selector: RegExp) {
  const css = read('src/editor/theme.css');
  const m = css.match(selector);
  if (!m) throw new Error(`missing block ${selector}`);
  return m[1];
}
function tokens(theme: 'dark' | 'light') {
  const body =
    theme === 'dark'
      ? block(/:root,\s*:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)
      : block(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/);
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  ) as Record<string, string>;
}
const hex = (v: string) => {
  const m = v.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a hex colour: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
};
const luminance = (v: string) =>
  hex(v)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('theme tokens', () => {
  it('dark and light define the same colour tokens', () => {
    const dark = Object.keys(tokens('dark')).filter((k) => !/^--vm-(accent|human)/.test(k));
    const light = Object.keys(tokens('light'));
    expect(light.sort()).toEqual(dark.sort());
  });

  it('light palette keeps text ≥ 4.5:1 and coral/mint marks ≥ 3:1 on its surfaces', () => {
    const t = tokens('light');
    const surfaces = ['--vm-bg-1', '--vm-bg-2', '--vm-bg-3'].map((k) => t[k]);
    for (const k of ['--vm-text-1', '--vm-text-2', '--vm-text-3', '--vm-text-4', '--vm-coral-text', '--vm-ai-text', '--vm-purple', '--vm-danger', '--vm-warning', '--vm-success', '--vm-orange-text'])
      for (const s of surfaces) expect(contrast(t[k], s), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
    // Text on tinted selection backgrounds.
    expect(contrast(t['--vm-coral-text'], t['--vm-coral-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--vm-ai-text'], t['--vm-ai-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--vm-text-1'], t['--vm-fill-selected'])).toBeGreaterThanOrEqual(4.5);
    // Text on solid fills (primary button, music button).
    expect(contrast(t['--vm-coral-on'], t['--vm-coral'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--vm-orange-on'], t['--vm-orange'])).toBeGreaterThanOrEqual(4.5);
    // Non-text marks: outlines, highlights, playhead, keyframes.
    for (const k of ['--vm-coral', '--vm-ai', '--vm-playhead', '--vm-key'])
      for (const s of surfaces) expect(contrast(t[k], s), `${k} on ${s}`).toBeGreaterThanOrEqual(3);
    // Tooltip is inverted in light mode.
    expect(contrast(t['--vm-tooltip-text'], t['--vm-tooltip-bg'])).toBeGreaterThanOrEqual(7);
  });

  it('dark palette keeps primary/secondary/muted text readable', () => {
    const t = tokens('dark');
    for (const k of ['--vm-text-1', '--vm-text-2', '--vm-text-3', '--vm-coral-text', '--vm-ai-text'])
      for (const s of ['--vm-bg-1', '--vm-bg-2']) expect(contrast(t[k], t[s]), k).toBeGreaterThanOrEqual(4.5);
  });

  // Component CSS must take colours from tokens. A literal that is genuinely theme-independent
  // (white sheen on a coral button, colours of the video frame) carries a `theme-ok` comment.
  it('editor chrome has no raw colours outside theme.css', () => {
    const files = [
      'src/editor/workbench.css',
      'src/editor/studio-shell.css',
      'src/editor/studio-ui/studio-ui.css',
      'src/editor/studio/studio.css',
      'src/editor/music/music.css',
      'src/editor/plugin-manager.css',
      'src/editor/project-home.css',
      'src/editor/still/still.css',
      'src/editor/glyphs/glyphs.css',
      'src/editor/BezierEditor.tsx',
      'src/editor/CurveEditor.tsx',
      'src/editor/music/PianoRoll.tsx',
    ];
    const offenders: string[] = [];
    for (const file of files)
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/theme-ok/.test(line)) return;
          const code = file.endsWith('.tsx') ? line : line.replace(/\/\*.*?\*\//g, '');
          if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(code)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    expect(offenders).toEqual([]);
    // theme.css: literals only inside the two token blocks (plus allow-listed lines).
    const css = read('src/editor/theme.css')
      .replace(/:root,\s*:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/, '')
      .replace(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/, '');
    const stray = css.split('\n').filter((l) => !/theme-ok/.test(l) && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l));
    expect(stray).toEqual([]);
  });
});

describe('timeline playhead', () => {
  // The knob (span) and the 1px line (container + i) must share a centre. A previous
  // `left:-4px` from workbench.css plus `margin-left:-5px` from studio-shell.css put the
  // knob 4px left of the line. Measured in Chromium by work/theme/playhead_check.py.
  it('centres the knob on the line', () => {
    const shell = read('src/editor/studio-shell.css');
    const knob = shell.match(/\.tl-playhead > span \{([\s\S]*?)\}/)![1];
    const width = Number(shell.match(/--tl-knob:\s*(\d+)px/)![1]);
    expect(width % 2).toBe(1); // odd → whole-pixel offset, no half-pixel blur
    expect(knob).toMatch(/left: calc\(\(1px - var\(--tl-knob\)\) \/ 2\) !important/);
    expect(knob).toMatch(/margin-left: 0 !important/);
    const line = shell.match(/\.tl-playhead > i \{([\s\S]*?)\}/)![1];
    expect(line).toMatch(/width: 1px/);
    const base = read('src/editor/workbench.css').match(/\.tl-playhead \{([\s\S]*?)\}/)![1];
    expect(base).toMatch(/width: 1px/);
  });
});
