import { Application } from '../src/service/application.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, json } from '../src/service/project.js';
const root = path.resolve('productions/riemann'),
  app = await new Application(root).open(false);
await mkdir('artifacts/riemann-qa', { recursive: true });
try {
  const validation = await app.dispatch('validate');
  if (!validation.valid) throw new Error(JSON.stringify(validation.diagnostics));
  const sheet = createCanvas(1920, Math.ceil(app.service.snapshot.scenes.length / 4) * 305),
    ctx = sheet.getContext('2d');
  ctx.fillStyle = '#e9e7e1';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  for (const [index, scene] of app.service.snapshot.scenes.entries()) {
    const frame = Math.min(scene.duration - 1, Math.max(120, Math.round(scene.duration * 0.45))),
      result = await app.frame({ frame, sceneId: scene.id, width: 1920, height: 1080 });
    await atomicWrite(
      path.resolve(`artifacts/riemann-qa/${String(index).padStart(2, '0')}-${scene.id}.png`),
      result.buffer,
    );
    const image = await loadImage(result.buffer),
      x = (index % 4) * 480,
      y = Math.floor(index / 4) * 305;
    ctx.drawImage(image, x, y, 480, 270);
    ctx.font = '18px "Microsoft YaHei"';
    ctx.fillStyle = '#21304d';
    ctx.fillText(`${index + 1}. ${scene.name}`, x + 12, y + 290);
  }
  await atomicWrite(path.resolve('artifacts/riemann-contact-sheet.png'), await sheet.encode('png'));
  await atomicWrite(path.resolve('artifacts/riemann-qa/validation.json'), json(validation));
  console.log(
    json({
      valid: true,
      scenes: app.service.snapshot.scenes.length,
      frames: app.service.snapshot.sequences[0].duration,
      sheet: path.resolve('artifacts/riemann-contact-sheet.png'),
    }),
  );
} finally {
  await app.close();
}
