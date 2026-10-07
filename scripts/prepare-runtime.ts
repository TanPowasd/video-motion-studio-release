import { mkdir, readFile, writeFile, copyFile, rename, stat } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { unzipSync } from 'fflate';
export async function prepareRuntime(root: string) {
  const lock = JSON.parse(await readFile(path.join(root, 'scripts/runtime-lock.json'), 'utf8')),
    cache = path.join(root, 'artifacts/runtime-download'),
    runtime = path.join(root, 'dist/runtime');
  await mkdir(cache, { recursive: true });
  const digest = async (file: string) => {
    const hash = createHash('sha256');
    for await (const part of createReadStream(file)) hash.update(part);
    return hash.digest('hex');
  };
  const writeChanged = async (file: string, data: Uint8Array) => {
    const expected = createHash('sha256').update(data).digest('hex');
    if (existsSync(file) && (await digest(file)) === expected) return;
    await writeFile(file, data);
  };
  const copyChanged = async (source: string, target: string) => {
    if (existsSync(target) && (await digest(source)) === (await digest(target))) return;
    await copyFile(source, target);
  };
  for (const entry of lock.files as Array<{ name: string; url: string; sha256: string }>) {
    if (
      path.basename(entry.name) !== entry.name ||
      !/^https:\/\//.test(entry.url) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw Error('Invalid runtime lock entry');
    const file = path.join(cache, entry.name);
    if (!existsSync(file)) {
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body)
        throw Error(`Runtime download ${entry.name}: HTTP ${response.status}`);
      const partial = file + '.' + randomUUID() + '.partial';
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(partial));
      if ((await digest(partial)) !== entry.sha256)
        throw Error('Runtime digest mismatch: ' + entry.name);
      await rename(partial, file);
    }
    if ((await digest(file)) !== entry.sha256)
      throw Error('Cached runtime digest mismatch: ' + entry.name);
  }
  await mkdir(path.join(runtime, 'media/bin'), { recursive: true });
  await mkdir(path.join(runtime, 'fonts'), { recursive: true });
  await mkdir(path.join(runtime, 'licenses'), { recursive: true });
  await mkdir(path.join(runtime, 'sources'), { recursive: true });
  const archive = unzipSync(await readFile(path.join(cache, 'ffmpeg.zip'))),
    files: string[] = [];
  for (const [name, data] of Object.entries(archive)) {
    const basename = path.posix.basename(name);
    if (
      name.includes('/bin/') &&
      (basename === 'ffmpeg.exe' || basename === 'ffprobe.exe' || basename.endsWith('.dll'))
    ) {
      await writeChanged(path.join(runtime, 'media/bin', basename), data);
      files.push('media/bin/' + basename);
    }
    if (name.endsWith('/LICENSE.txt'))
      await writeChanged(path.join(runtime, 'licenses/FFmpeg-LGPL-3.0.txt'), data);
  }
  for (const name of ['ffmpeg.exe', 'ffprobe.exe'])
    await stat(path.join(runtime, 'media/bin', name));
  await mkdir(path.join(runtime, 'python'), { recursive: true });
  const python = unzipSync(await readFile(path.join(cache, 'python-embed.zip')));
  for (const [name, data] of Object.entries(python)) {
    if (name.includes('/') || name.includes('\\') || name === '..')
      throw Error('Unexpected Python archive path');
    await writeChanged(path.join(runtime, 'python', name), data);
    files.push('python/' + name);
    if (name === 'LICENSE.txt')
      await writeChanged(path.join(runtime, 'licenses/Python-LICENSE.txt'), data);
  }
  await stat(path.join(runtime, 'python/python.exe'));
  for (const file of ['NotoSansSC-Regular.otf', 'NotoSansSC-Bold.otf'])
    await copyChanged(path.join(cache, file), path.join(runtime, 'fonts', file));
  await copyChanged(
    path.join(cache, 'NotoSansSC-LICENSE.txt'),
    path.join(runtime, 'licenses/NotoSansSC-OFL.txt'),
  );
  for (const file of ['ffmpeg-source.tar.gz', 'ffmpeg-build.zip'])
    await copyChanged(path.join(cache, file), path.join(runtime, 'sources', file));
  const version = execFileSync(path.join(runtime, 'media/bin/ffmpeg.exe'), ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (/--enable-(?:gpl|nonfree)(?:\s|$)/.test(version))
    throw Error('Selected media runtime must be an LGPL build');
  const manifest = {
    version: 1,
    platform: lock.platform,
    ffmpeg: version.split(/\r?\n/)[0],
    configuration: version.split(/\r?\n/).find((line) => line.startsWith('configuration:')),
    provenance: lock.files,
    files: await Promise.all(
      [
        ...files,
        'fonts/NotoSansSC-Regular.otf',
        'fonts/NotoSansSC-Bold.otf',
        'licenses/FFmpeg-LGPL-3.0.txt',
        'licenses/NotoSansSC-OFL.txt',
        'sources/ffmpeg-source.tar.gz',
        'sources/ffmpeg-build.zip',
      ].map(async (file) => ({
        file,
        bytes: (await stat(path.join(runtime, file))).size,
        sha256: await digest(path.join(runtime, file)),
      })),
    ),
  };
  await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(
    path.join(runtime, 'licenses/NOTICE.txt'),
    'FFmpeg shared LGPL build from BtbN, unchanged DLLs/executables; no application linking. FFmpeg source and build recipes are in ../sources with pinned origins/hashes in ../manifest.json. Build recipes identify third-party dependencies and source locations. FFmpeg dependencies retain their respective upstream licenses. Noto Sans SC is distributed under SIL OFL 1.1; its license accompanies the font. Vmotion and Electron/native dependency licenses remain in the portable application.\r\n',
  );
  return { runtime, manifest };
}
