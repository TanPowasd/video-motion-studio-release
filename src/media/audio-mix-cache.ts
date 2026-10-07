import path from 'node:path';
import { open, stat, rename, unlink, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { VmotionError, assetSchema, type Snapshot, type Sequence } from '../core/model.js';
import { SequenceMixRenderer, compileAudioMix } from '../core/audio-mix.js';
import { audioClips, audioMixPlan, sampleAtFrame } from './audio.js';
import { ffmpegBinary, runProcess, fingerprint } from './ffmpeg.js';
import { soundDependencies, soundResource } from './sound-source.js';
import { audioHostBinary } from './audio-plugin-host.js';
import { hash, json, safePath, atomicWrite } from '../platform/project-files.js';
import { normalizeAudio } from './audio-loudness.js';
type Entry = { controller: AbortController; users: number; promise: Promise<string> };
const pending = new Map<string, Entry>();
export function hasAudioMix(
  snapshot: Snapshot,
  sequenceId: string,
  ancestors: string[] = [],
): boolean {
  if (ancestors.includes(sequenceId) || ancestors.length > 32)
    throw new VmotionError('NESTING_DEPTH', 'Audio mix sequence nesting is cyclic or too deep');
  const sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audio sequence not found');
  return (
    !!sequence.mix ||
    sequence.tracks.some((t) =>
      t.clips.some(
        (c) => c.sequenceId && hasAudioMix(snapshot, c.sequenceId!, [...ancestors, sequenceId]),
      ),
    )
  );
}
export async function audioEvidence(root: string, snapshot: Snapshot, sequenceId: string) {
  const assets = [
      ...new Map(audioClips(snapshot, sequenceId).map((c) => [c.asset.id, c.asset])).values(),
    ],
    files = new Map<string, string>(),
    resources = [];
  for (const asset of assets) {
    if (asset.soundSource) {
      const sound = soundResource(snapshot, asset),
        dependencies = await soundDependencies(root, snapshot, asset);
      resources.push({
        assetId: asset.id,
        source: sound.source,
        hash: sound.hash,
        pluginChecks: dependencies.pluginChecks,
        audioHost: dependencies.pluginChecks.length ? audioHostBinary() : undefined,
      });
      for (const check of dependencies.checks) {
        const source = snapshot.project.assets.find((a) => a.id === check.assetId)!;
        files.set(path.resolve(root, source.path), check.fingerprint);
      }
    } else {
      const file = path.resolve(root, asset.path);
      files.set(file, await fingerprint(file));
    }
  }
  return {
    files: [...files].map(([file, fingerprint]) => ({ path: file, fingerprint })),
    resources,
  };
}
function audioVersion(snapshot: Snapshot, sequenceId: string) {
  const seen = new Set<string>(),
    sequences: unknown[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const sequence = snapshot.sequences.find((s) => s.id === id)!;
    sequences.push({
      id: sequence.id,
      duration: sequence.duration,
      mix: sequence.mix,
      tracks: sequence.tracks.map((t) => ({
        id: t.id,
        type: t.type,
        muted: t.muted,
        clips: t.clips.map(({ name, linkedGroup, ...clip }) => clip),
      })),
    });
    for (const track of sequence.tracks)
      for (const clip of track.clips) if (clip.sequenceId) visit(clip.sequenceId);
  };
  visit(sequenceId);
  return { fps: snapshot.project.fps, sampleRate: snapshot.project.sampleRate, sequences };
}
function waveHeader(samples: number) {
  const bytes = samples * 8;
  if (bytes > 0xffffffff - 36)
    throw new VmotionError('AUDIO_MIX_BUDGET', 'Float mix exceeds RIFF WAV size limit');
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF');
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(384000, 28);
  buffer.writeUInt16LE(8, 32);
  buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(bytes, 40);
  return buffer;
}
export async function prepareSequenceMix(
  root: string,
  snapshot: Snapshot,
  sequenceId: string,
  signal?: AbortSignal,
  ancestors: string[] = [],
  rawChild = false,
): Promise<string> {
  if (signal?.aborted) throw new VmotionError('CANCELLED', 'Sequence mix cancelled');
  if (ancestors.includes(sequenceId) || ancestors.length > 32)
    throw new VmotionError(
      'NESTING_DEPTH',
      'Sequence mix nesting exceeds its bounded acyclic depth',
    );
  const sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Sequence mix not found');
  const compiled = compileAudioMix(sequence, snapshot.project.fps),
    evidence = await audioEvidence(root, snapshot, sequenceId),
    count = sampleAtFrame(sequence.duration, snapshot.project.fps),
    legacyProtection = !rawChild && !hasAudioMix(snapshot, sequenceId),
    key = hash(
      json({
        engine: 'sequence-mix-1',
        legacyProtection,
        audio: audioVersion(snapshot, sequenceId),
        sequenceId,
        evidence,
      }),
    ),
    directory = safePath(root, `.vmotion/audio-mix/${key}`),
    output = path.join(directory, 'mix.wav'),
    report = path.join(directory, 'report.json');
  const verify = async () => {
    for (const source of evidence.files)
      if ((await fingerprint(source.path)) !== source.fingerprint)
        throw new VmotionError('ASSET_CHANGED', 'Source changed during sequence mixing', source);
  };
  try {
    const info = await stat(output),
      metadata = JSON.parse(await readFile(report, 'utf8'));
    if (info.size === metadata.outputBytes && metadata.sampleCount === count) {
      await verify();
      return output;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let entry = pending.get(output);
  if (entry?.controller.signal.aborted) {
    await entry.promise.catch(() => {});
    entry = pending.get(output);
  }
  if (!entry) {
    const controller = new AbortController(),
      token = randomUUID(),
      scratch = path.join(directory, `scratch-${token}`);
    const promise = (async () => {
      await mkdir(scratch, { recursive: true });
      const files: string[] = [],
        handles: Array<Awaited<ReturnType<typeof open>>> = [];
      try {
        const candidate = structuredClone(snapshot),
          candidateSequence = candidate.sequences.find((s) => s.id === sequenceId)!;
        for (const track of candidateSequence.tracks.filter(
          (t) => !compiled.nodes.get(`track:${t.id}`)!.muted,
        ))
          for (const clip of track.clips)
            if (clip.sequenceId && clip.audioEnabled !== false) {
              const child = clip.sequenceId,
                source = await prepareSequenceMix(
                  root,
                  snapshot,
                  child,
                  controller.signal,
                  [...ancestors, sequenceId],
                  true,
                ),
                id = `__sequence_mix_${randomUUID()}`;
              if (!candidate.project.assets.some((a) => a.id === id))
                candidate.project.assets.push(
                  assetSchema.parse({
                    id,
                    type: 'audio',
                    name: child,
                    path: source,
                    metadata: {
                      duration:
                        (snapshot.sequences.find((s) => s.id === child)!.duration *
                          snapshot.project.fps.den) /
                        snapshot.project.fps.num,
                      sampleRate: 48000,
                      channels: 2,
                      hasAudio: true,
                    },
                  }),
                );
              clip.assetId = id;
              delete clip.sequenceId;
            }
        const tracks = candidateSequence.tracks.filter(
            (t) => !compiled.nodes.get(`track:${t.id}`)!.muted,
          ),
          estimatedScratch = count * 8 * (tracks.length + 2);
        if (estimatedScratch > compiled.mix.scratchBudgetMb * 1024 * 1024)
          throw new VmotionError(
            'AUDIO_MIX_BUDGET',
            'Sequence mix scratch exceeds explicit disk budget',
            { estimatedBytes: estimatedScratch, budgetMb: compiled.mix.scratchBudgetMb },
          );
        const sources = new Map<string, Awaited<ReturnType<typeof open>>>();
        for (const track of tracks) {
          if (controller.signal.aborted)
            throw new VmotionError('CANCELLED', 'Sequence mix cancelled');
          const plan = await audioMixPlan(
              root,
              candidate,
              0,
              count,
              sequenceId,
              undefined,
              controller.signal,
              { trackId: track.id, unclamped: true, bypassRouting: true },
            ),
            file = path.join(scratch, `${files.length}.pcm`),
            filter = file + '.filter.txt';
          files.push(file, filter);
          await writeFile(filter, plan.filters);
          await runProcess(
            ffmpegBinary(),
            [
              '-y',
              ...plan.args,
              '-filter_complex_script',
              filter,
              '-map',
              '[mix]',
              '-c:a',
              'pcm_f32le',
              '-f',
              'f32le',
              file,
            ],
            controller.signal,
          );
          if ((await stat(file)).size !== count * 8)
            throw new VmotionError('AUDIO_SAMPLE_COUNT', 'Dry stem has incorrect length', {
              trackId: track.id,
            });
          const handle = await open(file, 'r');
          handles.push(handle);
          sources.set(track.id, handle);
        }
        const raw = path.join(scratch, 'master.wav');
        files.push(raw);
        const outputHandle = await open(raw, 'w');
        handles.push(outputHandle);
        await outputHandle.write(waveHeader(count));
        const renderer = new SequenceMixRenderer(sequence, snapshot.project.fps);
        let peak = 0,
          sum = 0,
          clipped = 0;
        while (renderer.position < count) {
          if (controller.signal.aborted)
            throw new VmotionError('CANCELLED', 'Sequence mix cancelled');
          const start = renderer.position,
            length = Math.min(4096, count - start),
            inputs = new Map();
          for (const [id, handle] of sources) {
            const bytes = Buffer.allocUnsafe(length * 8),
              result = await handle.read(bytes, 0, bytes.length, start * 8);
            if (result.bytesRead !== bytes.length)
              throw new VmotionError('AUDIO_SAMPLE_COUNT', 'Stem ended before the expected sample');
            const left = new Float64Array(length),
              right = new Float64Array(length);
            for (let i = 0; i < length; i++) {
              left[i] = bytes.readFloatLE(i * 8);
              right[i] = bytes.readFloatLE(i * 8 + 4);
            }
            inputs.set(id, { left, right });
          }
          const block = renderer.process(inputs, length).master,
            bytes = Buffer.allocUnsafe(length * 8);
          for (let i = 0; i < length; i++) {
            const l = legacyProtection
                ? Math.max(-0.95, Math.min(0.95, block.left[i]))
                : block.left[i],
              r = legacyProtection
                ? Math.max(-0.95, Math.min(0.95, block.right[i]))
                : block.right[i];
            peak = Math.max(peak, Math.abs(l), Math.abs(r));
            sum += (l * l + r * r) / 2;
            if (Math.max(Math.abs(l), Math.abs(r)) >= 1) clipped++;
            bytes.writeFloatLE(l, i * 8);
            bytes.writeFloatLE(r, i * 8 + 4);
          }
          await outputHandle.write(bytes);
          await yieldTask();
        }
        await outputHandle.close();
        handles.splice(handles.indexOf(outputHandle), 1);
        const normalization = compiled.mix.master.normalization,
          final = normalization ? path.join(scratch, 'normalized.wav') : raw;
        if (normalization) files.push(final);
        const normalized = normalization
          ? await normalizeAudio(raw, final, count, normalization, controller.signal)
          : undefined;
        await verify();
        await rename(final, output);
        await atomicWrite(
          report,
          json({
            revision: snapshot.revision,
            sequenceId,
            sampleCount: count,
            outputBytes: (await stat(output)).size,
            sampleRate: 48000,
            channels: 2,
            evidence,
            graphOrder: compiled.order,
            legacyProtection,
            preNormalization: {
              peak,
              rms: Math.sqrt(sum / count),
              clippedSampleRatio: clipped / count,
            },
            ...(normalized ? { normalization: normalized } : {}),
            scratchEstimate: estimatedScratch,
          }),
        );
        return output;
      } finally {
        for (const handle of handles) await handle.close().catch(() => {});
        for (const file of files) await unlink(file).catch(() => {});
        const { rmdir } = await import('node:fs/promises');
        await rmdir(scratch).catch(() => {});
      }
    })();
    entry = { controller, users: 0, promise };
    pending.set(output, entry);
    void promise
      .finally(() => {
        if (pending.get(output)?.promise === promise) pending.delete(output);
      })
      .catch(() => {});
  }
  const active = entry;
  active.users++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(new VmotionError('CANCELLED', 'Sequence mix request cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      active.promise.then(
        (file) => {
          signal?.removeEventListener('abort', cancel);
          resolve(file);
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
export async function sequenceMixReport(file: string) {
  return JSON.parse(await readFile(path.join(path.dirname(file), 'report.json'), 'utf8'));
}
