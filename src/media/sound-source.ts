import path from 'node:path';
import { open, stat, unlink, readFile } from 'node:fs/promises';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { openSync, closeSync, readSync } from 'node:fs';
import { compileSound, SoundRenderer, SOUND_RATE, type SoundSample } from '../core/sound.js';
import { VmotionError, type Snapshot, type Asset } from '../core/model.js';
import { atomicWrite, hash, json, safePath } from '../platform/project-files.js';
import { fingerprint, ffmpegBinary, runProcess, probe } from './ffmpeg.js';
import {
  audioHostBinary,
  pluginConfigs,
  pluginFingerprint,
  SoundPluginSession,
} from './audio-plugin-host.js';
const pending = new Map<string, Promise<string>>();
const samplePending = new Map<string, Promise<void>>();
export function soundResource(snapshot: Snapshot, asset: Asset) {
  if (!asset.soundSource)
    throw new VmotionError('SOUND_SOURCE', 'Asset is not an editable sound resource', {
      assetId: asset.id,
    });
  const content = snapshot.files[asset.soundSource];
  if (content === undefined)
    throw new VmotionError('SOUND_SOURCE', 'Missing sound resource in the fixed project snapshot', {
      assetId: asset.id,
      source: asset.soundSource,
    });
  const compiled = compileSound(JSON.parse(content));
  return { ...compiled, source: asset.soundSource, hash: hash(content) };
}
export async function soundDependencies(root: string, snapshot: Snapshot, asset: Asset) {
  const compiled = soundResource(snapshot, asset),
    ids = [
      ...new Set(
        compiled.document.tracks.flatMap((t) =>
          t.instrument.type === 'sample' ? [t.instrument.assetId] : [],
        ),
      ),
    ],
    checks = [];
  for (const id of ids) {
    const sample = snapshot.project.assets.find((a) => a.id === id);
    if (!sample || !['audio', 'video'].includes(sample.type) || sample.soundSource)
      throw new VmotionError(
        'SOUND_SAMPLE',
        'Sampling requires an existing audio/video asset; recursive sound resources are rejected',
        { assetId: id },
      );
    checks.push({ assetId: id, fingerprint: await fingerprint(path.resolve(root, sample.path)) });
  }
  const pluginChecks = await Promise.all(
    pluginConfigs(compiled.document).map(async (config) => ({
      format: config.format,
      path: config.path,
      classId: config.classId,
      fingerprint: await pluginFingerprint(config),
    })),
  );
  return { compiled, checks, pluginChecks };
}
function waveHeader(samples: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SOUND_RATE, 24);
  header.writeUInt32LE(SOUND_RATE * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 8, 40);
  return header;
}
export async function audioSourceFile(
  root: string,
  snapshot: Snapshot,
  asset: Asset,
  signal?: AbortSignal,
): Promise<string> {
  if (!asset.soundSource) return path.resolve(root, asset.path);
  if (signal?.aborted) throw new VmotionError('CANCELLED', 'Sound rendering cancelled');
  const { compiled, checks, pluginChecks } = await soundDependencies(root, snapshot, asset),
    key = hash(
      json({
        engine: 'sound-3-external-plugins',
        audioHost: pluginChecks.length ? audioHostBinary() : undefined,
        source: compiled.hash,
        checks,
        pluginChecks,
        paths: checks.map((c) => snapshot.project.assets.find((a) => a.id === c.assetId)!.path),
      }),
    ),
    output = safePath(root, `.vmotion/sound-cache/${key}.wav`),
    report = output + '.json';
  const verify = async () => {
    for (const check of pluginChecks) {
      if ((await pluginFingerprint({ ...check, parameters: {} })) !== check.fingerprint)
        throw new VmotionError('AUDIO_PLUGIN_CHANGED', 'Audio plugin changed during render', check);
    }
    for (const check of checks) {
      const sample = snapshot.project.assets.find((a) => a.id === check.assetId)!;
      if ((await fingerprint(path.resolve(root, sample.path))) !== check.fingerprint)
        throw new VmotionError('ASSET_CHANGED', 'Sample changed during sound rendering', check);
    }
  };
  try {
    const info = await stat(output);
    if (info.size === 44 + compiled.sampleCount * 8) {
      await stat(report);
      await verify();
      return output;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const existing = pending.get(output);
  if (existing) {
    await existing;
    await verify();
    return output;
  }
  const task = (async () => {
    const pluginSession = new SoundPluginSession(compiled.document);
    const samples = new Map<string, SoundSample>(),
      descriptors: number[] = [];
    let sampleBytes = 0;
    try {
      for (const { track, enabled } of compiled.tracks) {
        const instrument = track.instrument;
        if (instrument.type !== 'sample' || !enabled) continue;
        const source = snapshot.project.assets.find((a) => a.id === instrument.assetId)!,
          file = path.resolve(root, source.path),
          info = await probe(file),
          duration = Number(info.format.duration),
          audio = info.streams.find((s) => s.codec_type === 'audio');
        if (!audio || instrument.sourceIn + instrument.sourceDuration > duration + 1 / SOUND_RATE)
          throw new VmotionError(
            'SOUND_SAMPLE_RANGE',
            'Sample window must be inside audible source',
            { trackId: track.id, duration },
          );
        const count = Math.round(instrument.sourceDuration * SOUND_RATE),
          sampleKey = hash(
            json({
              path: file,
              fingerprint: checks.find((c) => c.assetId === source.id)?.fingerprint,
              in: instrument.sourceIn,
              duration: instrument.sourceDuration,
            }),
          ),
          sampleFile = safePath(root, `.vmotion/sound-samples/${sampleKey}.pcm`);
        sampleBytes += count * 8;
        if (sampleBytes > 2 * 1024 * 1024 * 1024)
          throw new VmotionError('SOUND_BUDGET', 'Decoded sample disk bank exceeds 2 GB');
        let cached = false;
        try {
          cached = (await stat(sampleFile)).size === count * 8;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (!cached) {
          const decoding = samplePending.get(sampleFile);
          if (decoding) await decoding;
          else {
            const decode = (async () => {
              await atomicWrite(sampleFile + '.partial', Buffer.alloc(0));
              await runProcess(
                ffmpegBinary(),
                [
                  '-y',
                  '-v',
                  'error',
                  '-ss',
                  String(instrument.sourceIn),
                  '-i',
                  file,
                  '-vn',
                  '-af',
                  `${audio.channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo'},aresample=48000,apad,atrim=end_sample=${count}`,
                  '-ac',
                  '2',
                  '-ar',
                  String(SOUND_RATE),
                  '-c:a',
                  'pcm_f32le',
                  '-f',
                  'f32le',
                  sampleFile + '.partial',
                ],
                signal,
              );
              const { rename } = await import('node:fs/promises');
              await rename(sampleFile + '.partial', sampleFile);
            })();
            samplePending.set(sampleFile, decode);
            try {
              await decode;
            } finally {
              samplePending.delete(sampleFile);
            }
          }
        }
        if ((await stat(sampleFile)).size !== count * 8)
          throw new VmotionError('SOUND_SAMPLE_COUNT', 'Sample decoder returned the wrong length');
        const fd = openSync(sampleFile, 'r'),
          pages = new Map<number, Buffer>();
        descriptors.push(fd);
        samples.set(track.id, {
          length: count,
          read(index, ch) {
            const page = Math.floor(index / 4096);
            let data = pages.get(page);
            if (!data) {
              const first = page * 4096;
              data = Buffer.alloc(Math.min(4096, count - first) * 8);
              const bytes = readSync(fd, data, 0, data.length, first * 8);
              if (bytes !== data.length)
                throw new VmotionError('SOUND_SAMPLE_COUNT', 'Incomplete sample cache');
              if (pages.size >= 8) pages.delete(pages.keys().next().value!);
              pages.set(page, data);
            }
            const value = data.readFloatLE((index % 4096) * 8 + ch * 4);
            if (!Number.isFinite(value))
              throw new VmotionError('SOUND_SAMPLE_VALUE', 'Sample contains nonfinite audio');
            return value;
          },
        });
      }
      const renderer = new SoundRenderer(compiled.document, samples),
        temporary = output + '.partial';
      await atomicWrite(temporary, waveHeader(compiled.sampleCount));
      const handle = await open(temporary, 'a');
      let peak = 0,
        sum = 0,
        clipped = 0;
      try {
        while (renderer.position < compiled.sampleCount) {
          if (signal?.aborted) throw new VmotionError('CANCELLED', 'Sound rendering cancelled');
          const count = Math.min(4096, compiled.sampleCount - renderer.position),
            block = await renderer.processAsync(count, pluginSession.process),
            bytes = Buffer.allocUnsafe(count * 8);
          for (let i = 0; i < count; i++) {
            const l = block.left[i],
              r = block.right[i];
            peak = Math.max(peak, Math.abs(l), Math.abs(r));
            sum += (l * l + r * r) / 2;
            if (Math.max(Math.abs(l), Math.abs(r)) >= 1) clipped++;
            bytes.writeFloatLE(l, i * 8);
            bytes.writeFloatLE(r, i * 8 + 4);
          }
          await handle.write(bytes);
          await yieldTask();
        }
      } catch (e) {
        await handle.close();
        await unlink(temporary).catch(() => {});
        throw e;
      }
      await handle.close();
      await verify();
      // Content-addressed output permits concurrent readers; publication is atomic.
      const { rename } = await import('node:fs/promises');
      await rename(temporary, output);
      await atomicWrite(
        report,
        json({
          source: compiled.source,
          sourceHash: compiled.hash,
          checks,
          sampleRate: SOUND_RATE,
          sampleCount: compiled.sampleCount,
          channels: 2,
          duration: compiled.duration,
          peak,
          rms: Math.sqrt(sum / compiled.sampleCount),
          clippedSampleRatio: clipped / compiled.sampleCount,
        }),
      );
      return output;
    } finally {
      await pluginSession.close();
      for (const fd of descriptors) closeSync(fd);
    }
  })();
  pending.set(output, task);
  try {
    return await task;
  } finally {
    pending.delete(output);
  }
}
export async function soundRange(
  root: string,
  snapshot: Snapshot,
  asset: Asset,
  startSample: number,
  sampleCount: number,
  signal?: AbortSignal,
) {
  const file = await audioSourceFile(root, snapshot, asset, signal),
    compiled = soundResource(snapshot, asset);
  if (startSample >= compiled.sampleCount)
    throw new VmotionError('SOUND_RANGE', 'Requested audio starts beyond the sound resource');
  const count = Math.min(sampleCount, compiled.sampleCount - startSample),
    buffer = Buffer.alloc(count * 8),
    handle = await open(file, 'r');
  try {
    const result = await handle.read(buffer, 0, buffer.length, 44 + startSample * 8);
    if (result.bytesRead !== buffer.length)
      throw new VmotionError('SOUND_CACHE', 'Incomplete sound cache');
  } finally {
    await handle.close();
  }
  return {
    buffer,
    sampleCount: count,
    sampleRate: SOUND_RATE,
    channels: 2,
    duration: count / SOUND_RATE,
    report: JSON.parse(await readFile(file + '.json', 'utf8')),
  };
}
