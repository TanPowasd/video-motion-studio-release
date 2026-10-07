import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(file)));
    else if (file.endsWith('.ts') || file.endsWith('.tsx')) result.push(file);
  }
  return result;
}

it('keeps core independent from service project file helpers', async () => {
  const root = path.resolve('src');
  for (const directory of ['core']) {
    for (const file of await files(path.join(root, directory))) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"]\.\.\/service\/project\.js['"]/);
    }
  }
});
