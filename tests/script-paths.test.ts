import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRootFromModuleUrl } from '../scripts/repo-root.mjs';

// Regression for the Windows verification report: `new URL(import.meta.url).pathname` produced
// `E:\E:\repo` and broke `npm run native:build` and `build-layout-wasm.mjs --check`.
describe('script repository-root resolution', () => {
  it('resolves Windows file URLs to a single-drive path', () => {
    expect(repoRootFromModuleUrl('file:///C:/x/scripts/build-native.mjs', { windows: true })).toBe('C:\\x');
    expect(repoRootFromModuleUrl('file:///E:/1017cs/video-motion-studio-main/scripts/build-layout-wasm.mjs', { windows: true })).toBe(
      'E:\\1017cs\\video-motion-studio-main',
    );
    expect(
      repoRootFromModuleUrl(pathToFileURL('E:\\新电脑 可复制\\vmotion\\scripts\\build-native.mjs', { windows: true }), { windows: true }),
    ).toBe('E:\\新电脑 可复制\\vmotion');
    expect(repoRootFromModuleUrl('file://server/share/repo/scripts/build-native.mjs', { windows: true })).toBe('\\\\server\\share\\repo');
    for (const root of ['C:\\x', 'E:\\1017cs\\video-motion-studio-main']) expect(root.match(/[A-Za-z]:/g)).toHaveLength(1);
  });

  it('resolves POSIX file URLs, including percent-encoded segments', () => {
    expect(repoRootFromModuleUrl('file:///home/u/repo/scripts/build-native.mjs', { windows: false })).toBe('/home/u/repo');
    expect(repoRootFromModuleUrl('file:///home/u/my%20repo/scripts/x.mjs', { windows: false })).toBe('/home/u/my repo');
  });

  it('finds this checkout from a real script URL', () => {
    expect(repoRootFromModuleUrl(pathToFileURL(path.resolve('scripts/build-native.mjs')))).toBe(process.cwd());
  });

  it('keeps file-URL pathname misuse out of scripts and sources', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) {
          if (name !== 'node_modules' && !name.startsWith('.')) walk(file);
        } else if (/\.(m|c)?[jt]sx?$/.test(name)) {
          readFileSync(file, 'utf8')
            .split('\n')
            .forEach((line, index) => {
              const code = line.trimStart();
              if (code.startsWith('//') || code.startsWith('*')) return;
              if (/URL\([^)]*import\.meta\.url[^)]*\)\.pathname/.test(code)) offenders.push(`${file}:${index + 1}`);
            });
        }
      }
    };
    for (const dir of ['scripts', 'src', 'electron'].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })) walk(dir);
    expect(offenders, 'use fileURLToPath / scripts/repo-root.mjs instead of URL.pathname').toEqual([]);
    for (const script of ['scripts/build-native.mjs', 'scripts/build-layout-wasm.mjs'])
      expect(readFileSync(script, 'utf8')).toContain('repoRootFromModuleUrl(import.meta.url)');
  });
});
