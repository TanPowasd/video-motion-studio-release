import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from '../src/service/project.js';
it('keeps the original file during sharing violations and commits by rename once the handle clears', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-atomic-')),
    file = path.join(root, 'journal.json');
  await writeFile(file, 'before');
  let attempts = 0;
  try {
    await atomicWrite(file, 'after', async (from, to) => {
      attempts++;
      expect(await readFile(file, 'utf8')).toBe('before');
      if (attempts < 3) throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' });
      await rename(from, to);
    });
    expect(attempts).toBe(3);
    expect(await readFile(file, 'utf8')).toBe('after');
    expect(await readdir(root)).toEqual(['journal.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('bounds persistent failures, reports the target and leaves the original content without orphan temp files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-atomic-')),
    file = path.join(root, 'source.ts');
  await writeFile(file, 'before');
  let attempts = 0;
  try {
    await expect(
      atomicWrite(file, 'after', async () => {
        attempts++;
        throw Object.assign(new Error('Read only'), { code: 'EACCES' });
      }),
    ).rejects.toMatchObject({
      code: 'FILE_WRITE',
      details: { file, systemCode: 'EACCES', attempts: 6 },
    });
    expect(attempts).toBe(6);
    expect(await readFile(file, 'utf8')).toBe('before');
    expect(await readdir(root)).toEqual(['source.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('does not retry a non-transient failure or remove the existing target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-atomic-')),
    file = path.join(root, 'data.json');
  await writeFile(file, 'before');
  let attempts = 0;
  try {
    await expect(
      atomicWrite(file, 'after', async () => {
        attempts++;
        throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
      }),
    ).rejects.toMatchObject({ code: 'FILE_WRITE', details: { systemCode: 'ENOSPC', attempts: 1 } });
    expect(attempts).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('before');
    expect(await readdir(root)).toEqual(['data.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
