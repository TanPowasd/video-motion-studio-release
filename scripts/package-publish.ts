import { mkdir, open, readFile, unlink, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
export async function acquirePackageLock(release: string) {
  await mkdir(release, { recursive: true });
  const file = path.join(release, '.package.lock'),
    token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      handle = await open(file, 'wx');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const lock = JSON.parse(await readFile(file, 'utf8'));
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive)
        throw new Error(
          `Package publication is already running (pid ${lock.pid}); wait for that process.`,
        );
      await unlink(file);
    }
  if (!handle) throw new Error('Could not acquire package lock');
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
  );
  await handle.close();
  return async () => {
    const lock = JSON.parse(await readFile(file, 'utf8'));
    if (lock.token === token) await unlink(file);
  };
}
export async function publishPackage(
  stage: string,
  target: string,
  options: { renameFile?: typeof rename; wait?: (ms: number) => Promise<unknown> } = {},
) {
  stage = path.resolve(stage);
  target = path.resolve(target);
  if (
    path.dirname(stage) !== path.dirname(target) ||
    !path.basename(stage).startsWith('.staging-') ||
    path.basename(target) !== 'Vmotion'
  )
    throw new Error(
      'Publication paths must be staging/Vmotion siblings inside one release directory',
    );
  const move = options.renameFile ?? rename,
    pause = options.wait ?? wait,
    backup = path.join(
      path.dirname(target),
      `Vmotion-previous-${Date.now()}-${randomUUID().slice(0, 6)}`,
    );
  const retry = async (from: string, to: string) => {
    const delays = [40, 100, 200, 400, 800, 1000];
    for (let attempt = 0; ; attempt++)
      try {
        await move(from, to);
        return;
      } catch (e) {
        if (
          attempt >= delays.length ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')
        )
          throw e;
        await pause(delays[attempt]);
      }
  };
  await stat(path.join(stage, 'Vmotion.exe'));
  let previous = false;
  try {
    await stat(target);
    previous = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (previous) await retry(target, backup);
  try {
    await retry(stage, target);
  } catch (error) {
    if (previous) {
      try {
        await retry(backup, target);
      } catch (rollback) {
        throw new Error(
          `Package publication failed; previous package remains at ${backup} and staging at ${stage}. Rollback failed: ${(rollback as Error).message}`,
          { cause: error },
        );
      }
    }
    throw new Error(
      `Package publication failed; ${previous ? 'previous package restored' : 'staging preserved'}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return { target, backup: previous ? backup : undefined };
}
