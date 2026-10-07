import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/preview-transport-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  windowsHide: true,
});
const allocator = net.createServer();
await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
const port = allocator.address().port;
await new Promise((resolve) => allocator.close(resolve));
const child = spawn(executable, [cli, 'serve', '--project', root, '--port', String(port)], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
  base = `http://127.0.0.1:${port}`,
  report = { root, packaged, samples: [] };
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += String(chunk)));
child.stdout.on('data', () => {});
const exit = new Promise((resolve) => child.once('exit', resolve));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'state' }),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, stderr);
  for (const width of [640, 1280]) {
    const height = (width * 9) / 16;
    for (let round = 0; round < 3; round++) {
      const frames = {};
      for (const format of ['png', 'rgba']) {
        const start = performance.now(),
          response = await fetch(
            `${base}/api/frame?frame=45&width=${width}&height=${height}&format=${format}`,
          ),
          buffer = Buffer.from(await response.arrayBuffer()),
          elapsed = performance.now() - start;
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-Vmotion-Format'), format);
        let pixels;
        if (format === 'png') {
          const image = await loadImage(buffer),
            canvas = createCanvas(width, height);
          canvas.getContext('2d').drawImage(image, 0, 0);
          pixels = Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data);
          canvas.width = 1;
        } else {
          assert.equal(buffer.length, width * height * 4);
          pixels = buffer;
        }
        frames[format] = {
          pixels,
          revision: response.headers.get('X-Vmotion-Revision'),
          frame: response.headers.get('X-Vmotion-Frame'),
        };
        report.samples.push({
          width,
          height,
          round,
          format,
          bytes: buffer.length,
          totalMs: elapsed,
          renderMs: Number(response.headers.get('X-Vmotion-Render-Ms')),
          transferPreparationMs: Number(response.headers.get('X-Vmotion-Encode-Ms')),
        });
      }
      assert.deepEqual(frames.png.pixels, frames.rgba.pixels);
      assert.equal(frames.png.revision, frames.rgba.revision);
      assert.equal(frames.rgba.frame, '45');
    }
  }
  const fresh = await fetch(
    `${base}/api/frame?scene=wave&frame=60&width=640&height=360&format=rgba`,
  ); // invalid scope uses last raw frame
  assert.equal(fresh.headers.get('X-Vmotion-Stale'), 'true');
  assert.equal(fresh.headers.get('X-Vmotion-Format'), 'rgba');
  report.checks = [
    'real packaged HTTP runtime',
    'lossless PNG/raw pixel parity at 640/1280',
    'version/frame/dimension/timing headers',
    'same-format last-good fallback',
    'bounded raw payload + no PNG encode path',
  ];
} finally {
  child.kill();
  await exit;
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
