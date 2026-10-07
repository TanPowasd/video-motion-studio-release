import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const root = path.resolve(process.argv[2]),
  packageRoot = path.resolve('release/Vmotion'),
  binary = path.join(packageRoot, 'Vmotion.exe'),
  cli = path.join(packageRoot, 'resources/app/dist/cli/index.mjs'),
  manifest = JSON.parse(await readFile(path.join(root, 'project.vmotion.json'), 'utf8'));
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
};
const call = (args) =>
  JSON.parse(
    execFileSync(binary, [cli, ...args, '--project', root], {
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
    }),
  );
const validation = call(['validate']),
  drawing = manifest.drawings[0];
if (!validation.valid) throw new Error('Packaged validation failed');
const document = call(['drawing', 'inspect', '--id', drawing.id]),
  preview = call([
    'drawing',
    'frame',
    '--id',
    drawing.id,
    '--width',
    '640',
    '--output',
    path.resolve('artifacts/drawing-packaged-preview.png'),
  ]),
  frame = call([
    'frame',
    '--frame',
    '96',
    '--width',
    '640',
    '--height',
    '360',
    '--output',
    path.resolve('artifacts/drawing-packaged-timeline.png'),
  ]);
const result = {
  validation,
  documentId: document.document.id,
  layers: document.document.layers.length,
  preview,
  frame,
};
await writeFile('artifacts/drawing-packaged-runtime.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
