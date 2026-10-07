import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { VmotionError } from '../core/model.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function safePath(root: string, relative: string) {
  const base = path.resolve(root);
  const file = path.resolve(root, relative);
  if (file !== base && !file.startsWith(base + path.sep))
    throw new VmotionError('PATH_OUTSIDE_PROJECT', `Path leaves the project: ${relative}`);
  return file;
}

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export async function atomicWrite(
  file: string,
  content: string | Buffer,
  renameFile: typeof rename = rename,
) {
  return atomicSave(file, (temporary) => writeFile(temporary, content), renameFile);
}

/** Publish large media without allocating the entire file in JavaScript memory. */
export async function atomicCopy(source: string, file: string) {
  return atomicSave(file, (temporary) => copyFile(source, temporary), rename);
}

async function atomicSave(
  file: string,
  write: (temporary: string) => Promise<unknown>,
  renameFile: typeof rename,
) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let attempts = 0;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await write(temporary);
    const waits = [10, 25, 50, 100, 200];
    for (;;) {
      attempts++;
      try {
        await renameFile(temporary, file);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempts > waits.length || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw e;
        await delay(waits[attempts - 1]);
      }
    }
  } catch (e) {
    await unlink(temporary).catch(() => {});
    throw new VmotionError(
      'FILE_WRITE',
      `Atomic save failed for ${file}: ${(e as Error).message}`,
      { file, systemCode: (e as NodeJS.ErrnoException).code, attempts },
    );
  }
}
