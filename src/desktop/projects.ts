import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite, json } from '../service/project.js';
import type { RecentProject } from '../core/project-creation.js';

const recentSchema = z.array(
  z.object({ root: z.string(), name: z.string(), openedAt: z.string() }),
);
export function projectFolder(parent: string, name: string) {
  if (!path.isAbsolute(parent)) throw new Error('请选择绝对路径作为项目保存位置');
  if (
    !name ||
    name !== name.trim() ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw new Error('项目名称不能包含 Windows 路径保留字符或保留名称');
  const root = path.resolve(parent, name);
  if (path.dirname(root) !== path.resolve(parent)) throw new Error('项目必须保存到所选文件夹中');
  return root;
}
export function projectRoot(input: string) {
  const root = path.resolve(input);
  return path.basename(root).toLowerCase() === 'project.vmotion.json' ? path.dirname(root) : root;
}
export async function readRecent(file: string): Promise<RecentProject[]> {
  try {
    return recentSchema.parse(JSON.parse(await readFile(file, 'utf8'))).slice(0, 12);
  } catch {
    return [];
  }
}
export async function availableRecent(file: string) {
  return Promise.all(
    (await readRecent(file)).map(async (entry) => ({
      ...entry,
      available: await access(path.join(entry.root, 'project.vmotion.json')).then(
        () => true,
        () => false,
      ),
    })),
  );
}
export async function rememberProject(file: string, root: string, name: string) {
  const key = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const recent = [
    { root: path.resolve(root), name, openedAt: new Date().toISOString() },
    ...(await readRecent(file)).filter((entry) => key(entry.root) !== key(root)),
  ].slice(0, 12);
  await atomicWrite(file, json(recent));
}
