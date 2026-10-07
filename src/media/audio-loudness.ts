import { spawn } from 'node:child_process';
import { VmotionError } from '../core/model.js';
import type { AudioNormalization } from '../core/audio-mix-schema.js';
import { ffmpegBinary, runProcess } from './ffmpeg.js';
export type LoudnessMeasurement = {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDb: number | null;
  thresholdLufs: number | null;
  offsetDb: number | null;
};
const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
export async function loudnessProcess(args: string[], signal?: AbortSignal) {
  if (signal?.aborted) throw new VmotionError('CANCELLED', 'Loudness processing cancelled');
  const child = spawn(ffmpegBinary(), args, {
    windowsHide: true,
    signal,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-32768);
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', (e) =>
      reject(new VmotionError(signal?.aborted ? 'CANCELLED' : 'AUDIO_LOUDNESS_PROCESS', e.message)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new VmotionError(
              signal?.aborted ? 'CANCELLED' : 'AUDIO_LOUDNESS_PROCESS',
              stderr.slice(-8000),
            ),
          ),
    );
  });
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks?.length)
    throw new VmotionError('AUDIO_LOUDNESS_RESULT', 'FFmpeg did not return loudness JSON');
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, string>;
}
export async function measureLoudness(
  file: string,
  options: {
    startSample?: number;
    sampleCount?: number;
    target?: AudioNormalization;
    signal?: AbortSignal;
  } = {},
) {
  const target = options.target ?? { targetLufs: -16, targetLra: 11, truePeakDb: -1, mode: 'auto' },
    range =
      options.sampleCount !== undefined
        ? `aresample=48000,atrim=start_sample=${options.startSample ?? 0}:end_sample=${(options.startSample ?? 0) + options.sampleCount},asetpts=PTS-STARTPTS,`
        : '',
    info = await loudnessProcess(
      [
        '-hide_banner',
        '-nostats',
        '-v',
        'info',
        '-i',
        file,
        '-vn',
        '-af',
        `${range}loudnorm=I=${target.targetLufs}:LRA=${target.targetLra}:TP=${target.truePeakDb}:print_format=json`,
        '-f',
        'null',
        '-',
      ],
      options.signal,
    );
  const measurement: LoudnessMeasurement = {
    integratedLufs: finite(info.input_i),
    loudnessRangeLu: finite(info.input_lra),
    truePeakDb: finite(info.input_tp),
    thresholdLufs: finite(info.input_thresh),
    offsetDb: finite(info.target_offset),
  };
  return {
    measurement,
    engine: 'FFmpeg loudnorm / EBU R128 / BS.1770',
    silentOrTooShort: measurement.integratedLufs === null,
  };
}
export async function normalizeAudio(
  file: string,
  output: string,
  sampleCount: number,
  target: AudioNormalization,
  signal?: AbortSignal,
) {
  const measured = await measureLoudness(file, { target, signal }),
    m = measured.measurement;
  if (
    m.integratedLufs === null ||
    m.truePeakDb === null ||
    m.thresholdLufs === null ||
    m.loudnessRangeLu === null ||
    m.offsetDb === null
  )
    throw new VmotionError(
      'AUDIO_NORMALIZE_SILENCE',
      'Cannot normalize silence or a range too short for gated loudness',
    );
  const linearFeasible =
    m.truePeakDb + target.targetLufs - m.integratedLufs <= target.truePeakDb &&
    m.loudnessRangeLu <= target.targetLra;
  if (target.mode === 'linear' && !linearFeasible)
    throw new VmotionError(
      'AUDIO_NORMALIZE_PEAK',
      'Linear gain cannot satisfy loudness and peak/range targets together',
      {
        measurement: m,
        target,
        recovery: 'Choose mode=auto/dynamic explicitly or change the target/arrangement.',
      },
    );
  if (linearFeasible && target.mode !== 'dynamic') {
    const gainDb = target.targetLufs - m.integratedLufs;
    await runProcess(
      ffmpegBinary(),
      [
        '-y',
        '-v',
        'error',
        '-i',
        file,
        '-vn',
        '-af',
        `volume=${gainDb}dB,aresample=48000,apad,atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS`,
        '-c:a',
        'pcm_f32le',
        '-rf64',
        'auto',
        '-f',
        'wav',
        output,
      ],
      signal,
    );
    const verified = await measureLoudness(output, { signal });
    return {
      requested: target,
      actualMode: 'linear',
      method: 'measured constant gain',
      input: m,
      output: verified.measurement,
      linearFeasible,
      gainDb,
    };
  }
  const filter = `loudnorm=I=${target.targetLufs}:LRA=${target.targetLra}:TP=${target.truePeakDb}:measured_I=${m.integratedLufs}:measured_LRA=${m.loudnessRangeLu}:measured_TP=${m.truePeakDb}:measured_thresh=${m.thresholdLufs}:offset=${m.offsetDb}:linear=${target.mode === 'dynamic' ? 'false' : 'true'}:print_format=json,aresample=48000,apad,atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS`,
    info = await loudnessProcess(
      [
        '-y',
        '-hide_banner',
        '-nostats',
        '-v',
        'info',
        '-i',
        file,
        '-vn',
        '-af',
        filter,
        '-c:a',
        'pcm_f32le',
        '-rf64',
        'auto',
        '-f',
        'wav',
        output,
      ],
      signal,
    );
  if (target.mode === 'linear' && info.normalization_type !== 'linear')
    throw new VmotionError(
      'AUDIO_NORMALIZE_MODE',
      'Normalizer declined requested linear processing',
    );
  const verified = await measureLoudness(output, { signal });
  return {
    requested: target,
    actualMode: info.normalization_type,
    input: measured.measurement,
    output: verified.measurement,
    linearFeasible,
  };
}
