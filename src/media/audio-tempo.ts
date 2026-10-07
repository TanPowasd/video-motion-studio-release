import path from 'node:path';
import { mkdir, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hash, safePath } from '../platform/project-files.js';
import { ffmpegBinary, runProcess, fingerprint } from './ffmpeg.js';
import { VmotionError } from '../core/model.js';
type Entry = { controller: AbortController; users: number; promise: Promise<string> };
const pending = new Map<string, Entry>();
export async function tempoSource(
  root: string,
  request: {
    source: string;
    fingerprint: string;
    sourceIn: number;
    sourceDuration: number;
    outputSamples: number;
    filter: string;
  },
  signal?: AbortSignal,
) {
  const key = hash(JSON.stringify({ version: 1, ...request })),
    file = safePath(root, `.vmotion/audio-tempo/${key}.wav`);
  if (signal?.aborted) throw new VmotionError('CANCELLED', 'Audio preparation cancelled');
  try {
    const info = await stat(file);
    if (info.size >= 44) return file;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let entry = pending.get(file);
  if (entry?.controller.signal.aborted) {
    await entry.promise.catch(() => {});
    entry = pending.get(file);
  }
  if (!entry) {
    const controller = new AbortController();
    const promise = (async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await runProcess(
          ffmpegBinary(),
          [
            '-y',
            '-v',
            'error',
            '-ss',
            request.sourceIn.toFixed(12),
            '-t',
            request.sourceDuration.toFixed(12),
            '-i',
            request.source,
            '-vn',
            '-af',
            `${request.filter},apad,atrim=end_sample=${request.outputSamples},asetpts=PTS-STARTPTS`,
            '-c:a',
            'pcm_f32le',
            '-rf64',
            'auto',
            '-f',
            'wav',
            temporary,
          ],
          controller.signal,
        );
        if ((await fingerprint(request.source)) !== request.fingerprint)
          throw new VmotionError(
            'ASSET_CHANGED',
            'Audio source changed while preparing speed cache',
            { file: request.source },
          );
        try {
          await rename(temporary, file);
        } catch (e) {
          const completed = await stat(file).catch(() => undefined);
          if (!completed || completed.size < 44) throw e;
        }
        return file;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    })();
    entry = { controller, users: 0, promise };
    pending.set(file, entry);
    void promise
      .finally(() => {
        if (pending.get(file)?.promise === promise) pending.delete(file);
      })
      .catch(() => {});
  }
  const active = entry;
  active.users++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(new VmotionError('CANCELLED', 'Audio preparation cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      active.promise.then(
        (value) => {
          signal?.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener('abort', cancel);
          reject(error);
        },
      );
      if (signal?.aborted) cancel();
    });
  } finally {
    active.users--;
    if (!active.users) active.controller.abort();
  }
}
