import { it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveHttp } from '../src/service/http.js';
it('serves both runtime font URLs locally with their original response contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-font-route-')),
    previous = process.env.VMOTION_RUNTIME;
  await mkdir(path.join(root, 'fonts'));
  await writeFile(path.join(root, 'manifest.json'), '{}');
  await writeFile(path.join(root, 'fonts/NotoSansSC-Regular.otf'), 'regular');
  await writeFile(path.join(root, 'fonts/NotoSansSC-Bold.otf'), 'bold');
  process.env.VMOTION_RUNTIME = root;
  const server = await serveHttp(undefined, 0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server');
    for (const name of ['font.otf', 'font-bold.otf']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/runtime/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('font/otf');
      expect(await response.text()).toBe(name.includes('bold') ? 'bold' : 'regular');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.VMOTION_RUNTIME;
    else process.env.VMOTION_RUNTIME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
