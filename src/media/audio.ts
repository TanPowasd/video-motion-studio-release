import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { VmotionError, type Snapshot, type Asset } from '../core/model.js';
import { frameSample, frameSeconds } from '../core/time.js';
import { ffmpegBinary, runProcess, probe, fingerprint } from './ffmpeg.js';
import { tempoSource } from './audio-tempo.js';
import { clipWindow, clipContentDuration } from '../core/clip-window.js';
import { audioSourceFile } from './sound-source.js';
import { hasAudioMix, prepareSequenceMix } from './audio-mix-cache.js';
export const AUDIO_SAMPLE_RATE = 48000;
export type AudioEnvelope = { start: number; duration: number; fadeIn: number; fadeOut: number };
export type AudioClip = {
  asset: Asset;
  clipId: string;
  sequenceId: string;
  trackId: string;
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  envelopes: AudioEnvelope[];
};
export function audioClips(
  snapshot: Snapshot,
  sequenceId = snapshot.project.activeSequence,
): AudioClip[] {
  const result: AudioClip[] = [],
    assets = new Map(snapshot.project.assets.map((a) => [a.id, a]));
  function visit(
    id: string,
    origin: number,
    speed: number,
    localStart: number,
    localEnd: number,
    volume: number,
    envelopes: AudioEnvelope[],
    ancestors: string[],
  ) {
    if (ancestors.includes(id) || ancestors.length > 32)
      throw new VmotionError(
        'NESTING_DEPTH',
        'Audio sequence nesting is cyclic or exceeds 32 levels',
      );
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(volume))
      throw new VmotionError('AUDIO_SPEED', 'Nested audio speed/volume is not finite');
    const sequence = snapshot.sequences.find((s) => s.id === id);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audio sequence not found');
    for (const track of sequence.tracks.filter((t) => !t.muted))
      for (const clip of track.clips) {
        if (clip.audioEnabled === false) continue;
        const begin = Math.max(localStart, clip.start),
          end = Math.min(localEnd, clip.start + clipContentDuration(clip));
        if (end <= begin || !clip.volume || !volume) continue;
        const start = origin + (begin - localStart) / speed,
          duration = (end - begin) / speed,
          sourceIn = clip.sourceIn + (begin - clip.start) * clip.speed,
          window = clipWindow(clip),
          envelope = {
            start: origin + (clip.start - window.offset - localStart) / speed,
            duration: window.duration / speed,
            fadeIn: clip.fadeIn / speed,
            fadeOut: clip.fadeOut / speed,
          },
          next = [...envelopes, envelope];
        if (clip.sequenceId)
          visit(
            clip.sequenceId,
            start,
            speed * clip.speed,
            sourceIn,
            sourceIn + (end - begin) * clip.speed,
            volume * clip.volume,
            next,
            [...ancestors, id],
          );
        else if (clip.assetId) {
          const asset = assets.get(clip.assetId);
          if (asset && (asset.type === 'audio' || asset.type === 'video'))
            result.push({
              asset,
              clipId: clip.id,
              sequenceId: id,
              trackId: track.id,
              start,
              duration,
              sourceIn,
              speed: speed * clip.speed,
              volume: volume * clip.volume,
              fadeIn: envelope.fadeIn,
              fadeOut: envelope.fadeOut,
              envelopes: next,
            });
        }
      }
  }
  const sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audio sequence not found');
  visit(sequence.id, 0, 1, 0, sequence.duration, 1, [], []);
  return result;
}
export function sampleAtFrame(frame: number, fps: Snapshot['project']['fps']) {
  return Number.isInteger(frame)
    ? frameSample(frame, fps)
    : Math.floor(frameSeconds(frame, fps) * AUDIO_SAMPLE_RATE);
}
export function audioEnvelopeAt(clip: AudioClip, frame: number) {
  return clip.envelopes.reduce(
    (gain, envelope) =>
      gain *
      Math.max(
        0,
        Math.min(
          1,
          envelope.fadeIn ? (frame - envelope.start) / envelope.fadeIn : 1,
          envelope.fadeOut ? (envelope.start + envelope.duration - frame) / envelope.fadeOut : 1,
        ),
      ),
    clip.volume,
  );
}
function tempo(speed: number) {
  if (!Number.isFinite(speed) || speed <= 0)
    throw new VmotionError('AUDIO_SPEED', 'Audio speed must be finite and positive');
  if (speed === 1) return 'anull';
  const stages: number[] = [];
  while (speed > 2) {
    stages.push(2);
    speed /= 2;
  }
  while (speed < 0.5) {
    stages.push(0.5);
    speed *= 2;
  }
  stages.push(speed);
  return stages.map((v) => `atempo=${v}`).join(',');
}
const seconds = (value: number) => value.toFixed(12);
type ProbeCache = Map<string, Awaited<ReturnType<typeof probe>>>;
export async function audioMixPlan(
  root: string,
  snapshot: Snapshot,
  startSample: number,
  sampleCount: number,
  sequenceId = snapshot.project.activeSequence,
  cache?: ProbeCache,
  signal?: AbortSignal,
  options: { trackId?: string; unclamped?: boolean; bypassRouting?: boolean } = {},
) {
  if (
    !Number.isSafeInteger(startSample) ||
    !Number.isSafeInteger(sampleCount) ||
    startSample < 0 ||
    sampleCount <= 0
  )
    throw new VmotionError('AUDIO_RANGE', 'Audio range uses nonnegative integer sample positions');
  if (!options.bypassRouting && hasAudioMix(snapshot, sequenceId)) {
    const file = await prepareSequenceMix(root, snapshot, sequenceId, signal),
      stamp = await fingerprint(file),
      info = {
        format: {
          duration: String(
            (snapshot.sequences.find((s) => s.id === sequenceId)!.duration *
              snapshot.project.fps.den) /
              snapshot.project.fps.num,
          ),
        },
        streams: [{ codec_type: 'audio', sample_rate: '48000', channels: 2 }],
      };
    return {
      args: ['-v', 'error', '-ss', (startSample / 48000).toFixed(12), '-i', file],
      filters: `[0:a]aresample=48000,apad,atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS[mix]`,
      inputs: [{ path: file, fingerprint: stamp, seek: startSample / 48000, info }],
      clips: audioClips(snapshot, sequenceId),
    };
  }
  const fps = snapshot.project.fps,
    endSample = startSample + sampleCount,
    clips = audioClips(snapshot, sequenceId).filter(
      (c) =>
        (!options.trackId || c.trackId === options.trackId) &&
        sampleAtFrame(c.start, fps) < endSample &&
        sampleAtFrame(c.start + c.duration, fps) > startSample,
    ),
    sources = new Map<
      string,
      { path: string; fingerprint: string; seek: number; info: Awaited<ReturnType<typeof probe>> }
    >(),
    usable: Array<{
      clip: AudioClip;
      begin: number;
      end: number;
      warm: number;
      warmEnd: number;
      source: number;
      length: number;
      file: string;
    }> = [];
  for (const clip of clips) {
    let file = await audioSourceFile(root, snapshot, clip.asset, signal),
      stamp = await fingerprint(file);
    const key = file + ':' + stamp;
    let info = cache?.get(key);
    if (!info) {
      info = await probe(file);
      if (cache) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, info);
      }
    }
    if (!info.streams.some((stream) => stream.codec_type === 'audio')) continue;
    let mediaSpeed = clip.speed,
      sourceIn = frameSeconds(clip.sourceIn, fps);
    if (clip.speed !== 1) {
      const original = snapshot.sequences
          .find((s) => s.id === clip.sequenceId)
          ?.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === clip.clipId),
        sourceWindow = original?.sourceWindow,
        anchor = sourceWindow ? Math.min(sourceWindow.sourceIn, clip.sourceIn) : clip.sourceIn,
        span = sourceWindow
          ? Math.max(
              sourceWindow.sourceIn + sourceWindow.duration,
              clip.sourceIn + clip.duration * clip.speed,
            ) - anchor
          : clip.duration * clip.speed,
        outputSamples = sourceWindow
          ? Math.ceil(frameSeconds(span / clip.speed, fps) * AUDIO_SAMPLE_RATE - 1e-8)
          : sampleAtFrame(clip.start + clip.duration, fps) - sampleAtFrame(clip.start, fps),
        channelFilter =
          info.streams.find((stream) => stream.codec_type === 'audio')?.channels === 1
            ? 'pan=stereo|c0=c0|c1=c0'
            : 'aformat=channel_layouts=stereo';
      file = await tempoSource(
        root,
        {
          source: file,
          fingerprint: stamp,
          sourceIn: frameSeconds(anchor, fps),
          sourceDuration: frameSeconds(span, fps),
          outputSamples,
          filter: `${tempo(clip.speed)},aresample=48000,${channelFilter}`,
        },
        signal,
      );
      stamp = await fingerprint(file);
      info = {
        format: { duration: String(outputSamples / AUDIO_SAMPLE_RATE) },
        streams: [{ codec_type: 'audio', sample_rate: '48000', channels: 2 }],
      };
      mediaSpeed = 1;
      sourceIn = frameSeconds((clip.sourceIn - anchor) / clip.speed, fps);
    }
    const begin = Math.max(startSample, sampleAtFrame(clip.start, fps)),
      end = Math.min(endSample, sampleAtFrame(clip.start + clip.duration, fps)),
      warm = Math.max(sampleAtFrame(clip.start, fps), begin - AUDIO_SAMPLE_RATE),
      warmEnd = Math.min(sampleAtFrame(clip.start + clip.duration, fps), end + AUDIO_SAMPLE_RATE),
      source = sourceIn + (warm / AUDIO_SAMPLE_RATE - frameSeconds(clip.start, fps)) * mediaSpeed,
      length = ((warmEnd - warm) / AUDIO_SAMPLE_RATE) * mediaSpeed;
    const current = sources.get(file);
    if (current) current.seek = Math.min(current.seek, Math.max(0, source));
    else sources.set(file, { path: file, fingerprint: stamp, seek: Math.max(0, source), info });
    usable.push({ clip, begin, end, warm, warmEnd, source, length, file });
  }
  const inputs = [...sources.values()],
    args = ['-v', 'error'];
  for (const input of inputs) args.push('-ss', seconds(input.seek), '-i', input.path);
  if (!usable.length) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    return {
      args,
      filters: `[0:a]atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS[mix]`,
      inputs,
      clips: [],
    };
  }
  const filters: string[] = [];
  for (const [index, item] of usable.entries()) {
    const { clip, begin, end, warm, source, length } = item,
      input = inputs.findIndex((v) => v.path === item.file),
      offset = begin - warm;
    const channelFilter =
      inputs[input].info.streams.find((stream) => stream.codec_type === 'audio')?.channels === 1
        ? 'pan=stereo|c0=c0|c1=c0'
        : 'aformat=channel_layouts=stereo';
    const gain = [
      String(clip.volume),
      ...clip.envelopes.map((envelope) => {
        const at = seconds(begin / AUDIO_SAMPLE_RATE - frameSeconds(envelope.start, fps)),
          endAt = seconds(
            frameSeconds(envelope.start + envelope.duration, fps) - begin / AUDIO_SAMPLE_RATE,
          ),
          inGain = envelope.fadeIn
            ? `(t+${at})/${seconds(frameSeconds(envelope.fadeIn, fps))}`
            : '1',
          outGain = envelope.fadeOut
            ? `(${endAt}-t)/${seconds(frameSeconds(envelope.fadeOut, fps))}`
            : '1';
        return `max(0,min(1,min(${inGain},${outGain})))`;
      }),
    ].join('*');
    filters.push(
      `[${input}:a]atrim=start=${seconds(Math.max(0, source - inputs[input].seek))}:duration=${seconds(length)},asetpts=PTS-STARTPTS,aresample=48000,${channelFilter},apad,atrim=start_sample=${offset}:end_sample=${offset + end - begin},asetpts=PTS-STARTPTS,aeval='val(0)*(${gain})|val(1)*(${gain})',adelay=${begin - startSample}S:all=1[a${index}]`,
    );
  }
  filters.push(
    usable.map((_, i) => `[a${i}]`).join('') +
      `amix=inputs=${usable.length}:normalize=0,${options.unclamped ? '' : "aeval='clip(val(0),-0.95,0.95)|clip(val(1),-0.95,0.95)',"}apad,atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS[mix]`,
  );
  return { args, filters: filters.join(';\n'), inputs, clips: usable.map((v) => v.clip) };
}
export async function renderAudio(
  root: string,
  snapshot: Snapshot,
  file: string,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  const first = sampleAtFrame(start, snapshot.project.fps),
    count = sampleAtFrame(end, snapshot.project.fps) - first,
    plan = await audioMixPlan(
      root,
      snapshot,
      first,
      count,
      snapshot.project.activeSequence,
      undefined,
      signal,
    ),
    filterFile = file + '.filter.txt';
  await writeFile(filterFile, plan.filters);
  await runProcess(
    ffmpegBinary(),
    [
      '-y',
      ...plan.args,
      '-filter_complex_script',
      filterFile,
      '-map',
      '[mix]',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      file,
    ],
    signal,
  );
}
export async function mixAudioSamples(
  root: string,
  snapshot: Snapshot,
  startSample: number,
  sampleCount: number,
  sequenceId = snapshot.project.activeSequence,
  signal?: AbortSignal,
  cache?: ProbeCache,
) {
  const plan = await audioMixPlan(
      root,
      snapshot,
      startSample,
      sampleCount,
      sequenceId,
      cache,
      signal,
    ),
    bytes = await runProcess(
      ffmpegBinary(),
      [
        ...plan.args,
        '-filter_complex',
        plan.filters,
        '-map',
        '[mix]',
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        'pipe:1',
      ],
      signal,
    );
  const expected = sampleCount * 8;
  if (bytes.length !== expected)
    throw new VmotionError(
      'AUDIO_SAMPLE_COUNT',
      'Mixed audio length did not match the requested sample range',
      { expected, actual: bytes.length },
    );
  return {
    buffer: bytes,
    inputs: plan.inputs.map((input) => ({ path: input.path, fingerprint: input.fingerprint })),
    clipCount: plan.clips.length,
  };
}
export function pcmWave(samples: Buffer) {
  const length = samples.length / 2,
    buffer = Buffer.alloc(44 + length);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length, 40);
  for (let index = 0; index < samples.length / 4; index++) {
    const value = Math.max(-1, Math.min(1, samples.readFloatLE(index * 4)));
    buffer.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return buffer;
}
