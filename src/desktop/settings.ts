import { readFileSync } from 'node:fs';
import { atomicWrite, json } from '../service/project.js';

/** Desktop app preferences (userData/settings.json). Unknown keys are preserved. */
export type ThemeSource = 'system' | 'dark' | 'light';
export interface DesktopSettings {
  theme: ThemeSource;
  [key: string]: unknown;
}
export const parseThemeSource = (value: unknown): ThemeSource =>
  value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
export function readSettings(file: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      return { ...raw, theme: parseThemeSource(raw.theme) };
  } catch {
    /* missing or unreadable: defaults */
  }
  return { theme: 'system' };
}
export async function writeSettings(file: string, settings: DesktopSettings) {
  await atomicWrite(file, json(settings));
}
/** Window background behind the page while it loads, matching theme.css --vm-bg-1. */
export const windowBackground = (dark: boolean) => (dark ? '#141518' : '#f3f0e9');
