import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const publicRoots = [
  'src/',
  'crates/',
  'native-audio/',
  'schemas/',
  'tests/',
  'examples/',
  '.github/',
];
export const publicRootFiles = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.agent.config.ts',
  'vitest.config.ts',
  '.gitignore',
  '.gitattributes',
  'LICENSE',
  'README.md',
  'AGENTS.md',
]);
const excludedScripts =
  /^scripts\/(?:create-codex-film|codex-film|create-riemann|deepseek|create-deepseek|qa-deepseek|publish-github|github-)/;
export function publishableSource(file: string) {
  if (
    file
      .split('/')
      .some((part) =>
        [
          '.git',
          '.vmotion',
          'node_modules',
          'target',
          'exports',
          'profile',
          'dist',
          'release',
        ].includes(part),
      )
  )
    return false;
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|err\d*\.txt)$/.test(file) ||
    /\.(?:log|tmp|zip|exe|dll)$/i.test(file)
  )
    return false;
  if (/\.(?:wav|mp3|mp4|mkv|flac|otf|ttf|woff2?)$/i.test(file) && !file.startsWith('examples/'))
    return false;
  if (file === 'docs/WORK-STATUS.md') return false;
  if (file.startsWith('docs/')) return true;
  if (file.startsWith('scripts/')) return !excludedScripts.test(file);
  return publicRootFiles.has(file) || publicRoots.some((root) => file.startsWith(root));
}
const git = (args: string[]) => {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw Error('Git source inspection failed');
  return r.stdout.trim();
};
export async function exportPublicRelease(root = process.cwd()) {
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status) throw Error('Commit the verified product source before public snapshot export');
  const files = git(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(publishableSource)
    .sort();
  if (!files.includes('src/agent-editor/main.tsx') || !files.includes('src/editor/main.tsx'))
    throw Error('Both release surfaces must be tracked');
  const work = path.join(root, 'artifacts');
  await mkdir(work, { recursive: true });
  const output = await mkdtemp(path.join(work, 'public-release-'));
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const file of files) {
    const source = path.resolve(root, file),
      target = path.join(output, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const bytes = await readFile(target);
    entries.push({
      path: file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const manifest = {
    version: 1,
    project: 'Vmotion',
    sourceCommit: git(['rev-parse', 'HEAD']),
    license: 'Apache-2.0',
    surfaces: { studio: 'src/editor', agent: 'src/agent-editor' },
    entries,
  };
  await writeFile(
    path.join(output, 'SOURCE-MANIFEST.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  for (const file of ['src/editor/LICENSE', 'src/agent-editor/LICENSE'])
    if (!(await readFile(path.join(output, file), 'utf8')).includes('Apache License'))
      throw Error('Every public interface must have an open-source license');
  // Public source lacks private productions, so CI does not imply they are published.
  return {
    output,
    sourceCommit: manifest.sourceCommit,
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await exportPublicRelease(), null, 2));
}
