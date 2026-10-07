import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { publishPackage, acquirePackageLock } from '../scripts/package-publish.js';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-publish-')),
    stage = path.join(root, '.staging-test'),
    target = path.join(root, 'Vmotion');
  await mkdir(stage);
  await mkdir(target);
  await writeFile(path.join(stage, 'Vmotion.exe'), 'new');
  await writeFile(path.join(target, 'Vmotion.exe'), 'old');
  return { root, stage, target };
}
it('retries transient Windows publication errors and preserves the prior recoverable package', async () => {
  const f = await fixture();
  let failures = 0;
  try {
    const result = await publishPackage(f.stage, f.target, {
      wait: async () => {},
      renameFile: async (from, to) => {
        if (from === f.stage && failures++ < 2)
          throw Object.assign(new Error('busy'), { code: 'EPERM' });
        await rename(from, to);
      },
    });
    expect(await readFile(path.join(f.target, 'Vmotion.exe'), 'utf8')).toBe('new');
    expect(await readFile(path.join(result.backup!, 'Vmotion.exe'), 'utf8')).toBe('old');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('restores the old launch directory when new publication fails and retains the staged result', async () => {
  const f = await fixture();
  try {
    await expect(
      publishPackage(f.stage, f.target, {
        wait: async () => {},
        renameFile: async (from, to) => {
          if (from === f.stage) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
          await rename(from, to);
        },
      }),
    ).rejects.toThrow('previous package restored');
    expect(await readFile(path.join(f.target, 'Vmotion.exe'), 'utf8')).toBe('old');
    expect(await readFile(path.join(f.stage, 'Vmotion.exe'), 'utf8')).toBe('new');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('prevents concurrent publishers and rejects paths leaving the verified release siblings', async () => {
  const f = await fixture();
  try {
    const release = await acquirePackageLock(f.root);
    await expect(acquirePackageLock(f.root)).rejects.toThrow('already running');
    await release();
    const again = await acquirePackageLock(f.root);
    await again();
    await expect(
      publishPackage(f.stage, path.join(f.root, 'elsewhere', 'Vmotion')),
    ).rejects.toThrow('siblings');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
