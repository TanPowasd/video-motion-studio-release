/**
 * Interface theme preference: 跟随系统 / 暗色 / 亮色.
 *
 * The preference is applied as `data-theme="dark"|"light"` (resolved) and
 * `data-theme-pref="system"|"dark"|"light"` on <html>; every colour comes from the
 * tokens in theme.css. index.html applies the same logic in an inline script before
 * React mounts so there is no flash of the wrong theme (kept in sync by a test).
 *
 * Persistence: localStorage (`vmotion.theme`) everywhere, plus the desktop settings
 * file through the preload bridge. In Electron the editor origin changes with the local
 * server port on every project switch, so the desktop value is the source of truth there.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'vmotion.theme';
export const THEME_PREFERENCES: ReadonlyArray<{ id: ThemePreference; label: string; icon: string }> = [
  { id: 'system', label: '跟随系统', icon: 'monitor' },
  { id: 'dark', label: '暗色', icon: 'moon' },
  { id: 'light', label: '亮色', icon: 'sun' },
];
/** Keyboard shortcut that flips between dark and light (explicit preference). */
export const THEME_TOGGLE_KEYS = 'Ctrl+Alt+D';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}
/** Desktop settings win (stable across server ports); then localStorage; default system. */
export function readThemePreference(storage?: StorageLike | null, desktop?: unknown): ThemePreference {
  if (desktop === 'dark' || desktop === 'light' || desktop === 'system') return desktop;
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}
export function writeThemePreference(storage: StorageLike | null | undefined, preference: ThemePreference) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* storage may be disabled; the in-memory value still applies for this session */
  }
}
/** Next explicit theme for the toggle shortcut: always the opposite of what is visible. */
export function toggledTheme(resolved: ResolvedTheme): ThemePreference {
  return resolved === 'dark' ? 'light' : 'dark';
}
export function themeCommandLabel(target: ThemePreference) {
  return target === 'system' ? '跟随系统主题' : target === 'dark' ? '切换到暗色主题' : '切换到亮色主题';
}
export function applyTheme(
  root: { dataset: DOMStringMap; style: { colorScheme: string } },
  preference: ThemePreference,
  resolved: ResolvedTheme,
) {
  root.dataset.theme = resolved;
  root.dataset.themePref = preference;
  root.style.colorScheme = resolved;
}

// ── Runtime store (browser only) ─────────────────────────────────────────
const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();
let current: { preference: ThemePreference; resolved: ResolvedTheme } | undefined;
const media = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined;
const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
function compute(preference: ThemePreference) {
  return { preference, resolved: resolveTheme(preference, media()?.matches ?? true) };
}
function publish(next: { preference: ThemePreference; resolved: ResolvedTheme }, animate: boolean) {
  const changed = !current || current.preference !== next.preference || current.resolved !== next.resolved;
  current = next;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (animate && changed && root.dataset.theme && root.dataset.theme !== next.resolved) {
      // Brief colour cross-fade; theme.css disables it under prefers-reduced-motion.
      root.classList.add('vm-theme-transition');
      window.setTimeout(() => root.classList.remove('vm-theme-transition'), 260);
    }
    applyTheme(root, next.preference, next.resolved);
  }
  if (changed) listeners.forEach((l) => l());
}
let started = false;
export function startTheme() {
  if (started || typeof window === 'undefined') return;
  started = true;
  publish(compute(readThemePreference(storage(), window.vmotionDesktop?.themePreference)), false);
  media()?.addEventListener?.('change', () => current && publish(compute(current.preference), true));
  // Another window (or the agent page) changed the preference.
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) publish(compute(parseThemePreference(e.newValue)), true);
  });
}
export function getTheme() {
  if (!current) {
    startTheme();
    if (!current) current = compute('system');
  }
  return current;
}
export function setThemePreference(preference: ThemePreference) {
  startTheme();
  writeThemePreference(storage(), preference);
  void window.vmotionDesktop?.setThemePreference?.(preference)?.catch?.(() => {});
  publish(compute(preference), true);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  return { ...theme, setPreference: setThemePreference };
}
