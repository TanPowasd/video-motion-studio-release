// Hardware/software video encoder selection for MP4 export.
//
// Selection is two-stage: the FFmpeg encoder list says what the binary was built with, and a real
// tiny encode (64 frames, 256×256, RGBA through the same pipe/pixel-format path as export) proves
// the device/driver actually works. Results are cached per process, keyed by the FFmpeg binary
// content hash and a driver fingerprint. `software` reproduces the pre-hardware argument list
// exactly, so its output is byte-identical to earlier releases.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmotionError } from '../core/model.js';
import {
  encoderModes,
  hardwareEncoderModes,
  type EncoderMode,
  type HardwareEncoderMode,
  type VideoCodec,
  type VideoQuality,
} from '../core/video-export-schema.js';
import { ffmpegBinary } from './ffmpeg.js';

export const hardwareEncoderNames: Record<
  HardwareEncoderMode,
  Partial<Record<VideoCodec, string>>
> = {
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
  amf: { h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
  mediafoundation: { h264: 'h264_mf', hevc: 'hevc_mf' },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
};
/** Software chains. H.264 keeps the historical order (libopenh264 before libx264, mpeg4 last). */
export const softwareEncoderChains: Record<VideoCodec, string[]> = {
  h264: ['libopenh264', 'libx264', 'mpeg4'],
  hevc: ['libx265'],
  av1: ['libsvtav1', 'libaom-av1'],
};
export const platformPriority: Record<string, HardwareEncoderMode[]> = {
  win32: ['nvenc', 'qsv', 'amf', 'mediafoundation'],
  darwin: ['videotoolbox'],
  linux: ['nvenc', 'vaapi', 'qsv'],
};
const tenBitUnsupported = new Set(['h264_mf', 'hevc_mf']);
const codecLabel: Record<VideoCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

export interface EncoderArgs {
  /** Arguments placed before `-f rawvideo … -i pipe:0` (device selection). */
  input: string[];
  /** Arguments placed after `-an`: codec, rate control, pixel format/upload filter. */
  output: string[];
  notes: string[];
}
export interface ProbeRow {
  mode: HardwareEncoderMode;
  encoder: string;
  listed: boolean;
  ok?: boolean;
  ms?: number;
  error?: string;
}
export interface EncoderResolution {
  requested: string;
  mode: EncoderMode | 'custom';
  codec: VideoCodec;
  used: string;
  hardware: boolean;
  bitDepth: 8 | 10;
  fallbackReason?: string;
  args: EncoderArgs;
  probe: ProbeRow[];
  /** Stable identity pinned into the render resume fingerprint. */
  identity: {
    used: string;
    mode: string;
    args: string[];
    ffmpeg: string;
    driver?: string;
  };
}

const isMode = (value: string): value is EncoderMode =>
  (encoderModes as readonly string[]).includes(value);
const isLegacyQuality = (q: VideoQuality) =>
  q.crf === undefined &&
  q.bitrateKbps === undefined &&
  q.preset === undefined &&
  q.keyframeInterval === undefined &&
  (q.bitDepth ?? 8) === 8;
const pick = <T>(preset: VideoQuality['preset'], speed: T, balanced: T, quality: T) =>
  preset === 'speed' ? speed : preset === 'quality' ? quality : balanced;
const defaultCrf = (codec: VideoCodec) => (codec === 'h264' ? 18 : codec === 'hevc' ? 20 : 30);
const k = (kbps: number) => `${kbps}k`;
const crfToPercent = (crf: number, max = 51) =>
  String(Math.max(1, Math.min(100, Math.round((100 * (max - Math.min(crf, max))) / max))));

/** FFmpeg arguments for one encoder; `software` legacy quality keeps the historical flags. */
export function encoderArguments(
  encoder: string,
  codec: VideoCodec,
  quality: VideoQuality = {},
  context: { vaapiDevice?: string } = {},
): EncoderArgs {
  const q = quality,
    tenBit = q.bitDepth === 10,
    notes: string[] = [],
    gop = q.keyframeInterval ? ['-g', String(q.keyframeInterval)] : [],
    crf = q.crf ?? defaultCrf(codec),
    bitrate = q.bitrateKbps,
    hevcTag = codec === 'hevc' ? ['-tag:v', 'hvc1'] : [],
    profile =
      codec === 'h264'
        ? ['-profile:v', 'high']
        : codec === 'hevc'
          ? ['-profile:v', tenBit ? 'main10' : 'main']
          : [];
  if (tenBit && codec === 'h264')
    throw new VmotionError('ENCODER_BIT_DEPTH', '10-bit output requires HEVC or AV1');
  if (tenBit && tenBitUnsupported.has(encoder))
    throw new VmotionError('ENCODER_BIT_DEPTH', `${encoder} does not support 10-bit output`);
  if (crf > 51 && codec !== 'av1')
    throw new VmotionError('ENCODER_QUALITY', `crf ${crf} exceeds 51 for ${codecLabel[codec]}`);
  const swPix = ['-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p'],
    nvPix = ['-pix_fmt', tenBit ? 'p010le' : 'nv12'];
  const out = (rest: string[], pix: string[] = swPix): EncoderArgs => ({
    input: [],
    output: ['-c:v', encoder, ...rest, ...pix],
    notes,
  });
  switch (encoder) {
    case 'libx264':
      if (isLegacyQuality(q)) return out(['-preset', 'veryfast', '-crf', '18']);
      return out([
        '-preset',
        pick(q.preset, 'superfast', 'veryfast', 'slow'),
        ...(bitrate
          ? ['-b:v', k(bitrate), '-maxrate', k(bitrate), '-bufsize', k(bitrate * 2)]
          : ['-crf', String(crf)]),
        ...gop,
      ]);
    case 'libopenh264':
    case 'mpeg4':
      if (q.crf !== undefined && !bitrate)
        notes.push(`${encoder} has no constant-quality mode; crf ignored, bitrate 20M used`);
      return out([...(bitrate ? ['-b:v', k(bitrate)] : ['-b:v', '20M']), ...gop]);
    case 'libx265':
      return out([
        '-preset',
        pick(q.preset, 'superfast', 'veryfast', 'slow'),
        ...(bitrate ? ['-b:v', k(bitrate)] : ['-crf', String(crf)]),
        ...(tenBit ? ['-profile:v', 'main10'] : []),
        '-x265-params',
        'log-level=error',
        ...hevcTag,
        ...gop,
      ]);
    case 'libsvtav1':
      return out([
        '-preset',
        pick(q.preset, '10', '8', '5'),
        ...(bitrate ? ['-b:v', k(bitrate)] : ['-crf', String(crf)]),
        ...gop,
      ]);
    case 'libaom-av1':
      return out([
        '-cpu-used',
        pick(q.preset, '8', '6', '4'),
        '-row-mt',
        '1',
        ...(bitrate ? ['-b:v', k(bitrate)] : ['-crf', String(crf), '-b:v', '0']),
        ...gop,
      ]);
  }
  const hw = encoder.replace(/^(h264|hevc|av1)_/, '');
  switch (hw) {
    case 'nvenc':
      return out(
        [
          '-preset',
          pick(q.preset, 'p2', 'p4', 'p6'),
          '-tune',
          'hq',
          '-rc',
          'vbr',
          ...(bitrate
            ? ['-b:v', k(bitrate), '-maxrate', k(Math.round(bitrate * 1.5))]
            : ['-cq', String(crf), '-b:v', '0']),
          ...profile,
          ...gop,
        ],
        ['-pix_fmt', tenBit ? 'p010le' : 'yuv420p'],
      );
    case 'qsv':
      return out(
        [
          '-preset',
          pick(q.preset, 'veryfast', 'medium', 'veryslow'),
          ...(bitrate
            ? ['-b:v', k(bitrate), '-maxrate', k(bitrate)]
            : ['-global_quality', String(crf)]),
          ...profile,
          ...gop,
        ],
        nvPix,
      );
    case 'amf': {
      // av1_amf quantisers span 0–255; h264/hevc 0–51.
      const qp = String(codec === 'av1' ? Math.min(255, crf * 4) : crf);
      return out(
        [
          '-usage',
          'transcoding',
          '-quality',
          pick(q.preset, 'speed', 'balanced', 'quality'),
          ...(bitrate
            ? ['-rc', 'vbr_peak', '-b:v', k(bitrate), '-maxrate', k(Math.round(bitrate * 1.5))]
            : ['-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(codec === 'h264' ? ['-qp_b', qp] : [])]),
          ...profile,
          ...gop,
        ],
        nvPix,
      );
    }
    case 'mf':
      return out(
        [
          '-hw_encoding',
          '1',
          ...(bitrate
            ? ['-rate_control', 'cbr', '-b:v', k(bitrate)]
            : ['-rate_control', 'quality', '-quality', crfToPercent(crf)]),
          ...gop,
        ],
        ['-pix_fmt', 'nv12'],
      );
    case 'videotoolbox':
      // Constant quality (-q:v) is Apple-silicon only, so it is used only when crf is explicit.
      return out(
        [
          '-allow_sw',
          '0',
          '-realtime',
          '0',
          ...(bitrate
            ? ['-b:v', k(bitrate)]
            : q.crf !== undefined
              ? ['-q:v', crfToPercent(q.crf)]
              : ['-b:v', '20M']),
          ...profile,
          ...hevcTag,
          ...gop,
        ],
        nvPix,
      );
    case 'vaapi': {
      const qp = String(codec === 'av1' ? Math.min(255, crf * 4) : crf);
      return {
        input: ['-vaapi_device', context.vaapiDevice ?? '/dev/dri/renderD128'],
        output: [
          '-vf',
          `format=${tenBit ? 'p010' : 'nv12'},hwupload`,
          '-c:v',
          encoder,
          ...(bitrate
            ? ['-rc_mode', 'VBR', '-b:v', k(bitrate), '-maxrate', k(bitrate)]
            : ['-rc_mode', 'CQP', '-qp', qp]),
          ...profile,
          ...gop,
        ],
        notes,
      };
    }
  }
  // Unknown/custom FFmpeg encoder: historical generic arguments.
  return out(['-b:v', '20M']);
}

// ---- process-level probe cache ------------------------------------------------------------
interface ProbeCache {
  key: string;
  ffmpeg: string;
  driver: string;
  encoders: Set<string>;
  tests: Map<string, Promise<{ ok: boolean; ms: number; error?: string }>>;
  rows: Map<string, ProbeRow>;
}
const caches = new Map<string, Promise<ProbeCache>>();
let lastCache: ProbeCache | undefined;
export function resetEncoderProbeCache() {
  caches.clear();
  lastCache = undefined;
}
function resolveExecutable(binary: string) {
  if (binary.includes('/') || binary.includes('\\')) return existsSync(binary) ? binary : undefined;
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
}
async function fileHash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }))
    digest.update(chunk);
  return digest.digest('hex');
}
/** Cheap fingerprint of the GPU driver/runtime state that decides hardware encode availability. */
export function driverFingerprint(platform = process.platform) {
  const parts: string[] = [platform, os.release()];
  const stamp = (file: string) => {
    try {
      const s = statSync(file);
      parts.push(`${path.basename(file)}:${s.size}:${Math.round(s.mtimeMs)}`);
    } catch {}
  };
  if (platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    for (const dll of [
      'nvEncodeAPI64.dll',
      'nvcuda.dll',
      'amfrt64.dll',
      'libmfxhw64.dll',
      'libvpl.dll',
      'mfplat.dll',
    ])
      stamp(path.join(system, dll));
  } else if (platform === 'linux') {
    try {
      parts.push(readFileSync('/proc/driver/nvidia/version', 'utf8').split('\n')[0]);
    } catch {}
    try {
      parts.push('dri:' + readdirSync('/dev/dri').sort().join(','));
    } catch {}
  }
  if (process.env.VMOTION_VAAPI_DEVICE) parts.push('vaapi:' + process.env.VMOTION_VAAPI_DEVICE);
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
export function parseEncoderList(text: string) {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
    if (match && match[1] !== '=') names.add(match[1]);
  }
  return names;
}
function run(binary: string, args: string[], input?: Buffer, timeoutMs = 30000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>(
    (resolve) => {
      const started = performance.now();
      let stdout = '',
        stderr = '',
        settled = false;
      const child = spawn(binary, args, { windowsHide: true });
      const finish = (code: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr: (stderr + extra).slice(-4000),
          ms: performance.now() - started,
        });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(null, `\ntimed out after ${timeoutMs}ms`);
      }, timeoutMs);
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr = (stderr + c.toString()).slice(-8000)));
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code) => finish(code));
      child.stdin.on('error', () => {});
      if (input) child.stdin.end(input);
      else child.stdin.end();
    },
  );
}
async function cacheFor(binary = ffmpegBinary(), platform = process.platform): Promise<ProbeCache> {
  const executable = resolveExecutable(binary),
    stat = executable ? statSync(executable) : undefined,
    cacheKey = `${executable ?? binary}|${stat?.size}|${stat?.mtimeMs}|${platform}`;
  let pending = caches.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const ffmpeg = executable ? await fileHash(executable) : `unresolved:${binary}`,
        driver = driverFingerprint(platform),
        listed = await run(binary, ['-hide_banner', '-encoders']);
      if (listed.code !== 0 && !listed.stdout)
        throw new VmotionError(
          'MEDIA_RUNTIME',
          `Cannot list FFmpeg encoders (${binary}): ${listed.stderr.trim().split('\n').pop() ?? ''}`,
        );
      return {
        key: `${ffmpeg}|${driver}`,
        ffmpeg,
        driver,
        encoders: parseEncoderList(listed.stdout),
        tests: new Map(),
        rows: new Map(),
      };
    })();
    caches.set(cacheKey, pending);
    pending.catch(() => caches.delete(cacheKey));
  }
  const cache = await pending;
  lastCache = cache;
  return cache;
}
const probeFrames = 64,
  probeSide = 256;
let probePixels: Buffer | undefined;
function probeInput() {
  if (probePixels) return probePixels;
  const frame = probeSide * probeSide * 4,
    data = Buffer.allocUnsafe(frame * probeFrames);
  for (let f = 0; f < probeFrames; f++)
    for (let y = 0; y < probeSide; y++)
      for (let x = 0; x < probeSide; x++) {
        const o = f * frame + (y * probeSide + x) * 4;
        data[o] = (x + f * 4) & 255;
        data[o + 1] = (y * 2 + f) & 255;
        data[o + 2] = ((x ^ y) + f * 8) & 255;
        data[o + 3] = 255;
      }
  return (probePixels = data);
}
/** One real tiny encode through the export pixel path; output discarded with the null muxer. */
async function testEncode(
  binary: string,
  encoder: string,
  codec: VideoCodec,
  quality: VideoQuality,
) {
  const args = encoderArguments(
      encoder,
      codec,
      { ...quality, bitrateKbps: undefined },
      vaapiContext(),
    ),
    result = await run(
      binary,
      [
        '-hide_banner',
        '-v',
        'error',
        ...args.input,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${probeSide}x${probeSide}`,
        '-r',
        '30',
        '-i',
        'pipe:0',
        '-an',
        ...args.output,
        '-frames:v',
        String(probeFrames),
        '-f',
        'null',
        '-',
      ],
      probeInput(),
      Number(process.env.VMOTION_ENCODER_PROBE_TIMEOUT_MS ?? 30000),
    );
  const error =
    result.code === 0 ? undefined : summarizeStderr(result.stderr) || `exit ${result.code}`;
  return { ok: result.code === 0, ms: Math.round(result.ms), error };
}
/** Root cause first: FFmpeg prints the device/driver error before the generic teardown lines. */
export function summarizeStderr(stderr: string) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]*@ 0x[0-9a-f]+\]\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' | ')
    .slice(0, 300);
}
const vaapiContext = () => ({ vaapiDevice: process.env.VMOTION_VAAPI_DEVICE });

async function probeHardware(
  cache: ProbeCache,
  binary: string,
  mode: HardwareEncoderMode,
  codec: VideoCodec,
  quality: VideoQuality,
): Promise<ProbeRow> {
  const encoder = hardwareEncoderNames[mode][codec]!,
    bitDepth = quality.bitDepth ?? 8,
    rowKey = `${encoder}|${bitDepth}`;
  if (!cache.encoders.has(encoder)) {
    const row = { mode, encoder, listed: false };
    cache.rows.set(rowKey, row);
    return row;
  }
  let test = cache.tests.get(rowKey);
  if (!test) {
    // Bit depth changes the surface format (Main10 support differs per GPU), so it is probed separately.
    test = testEncode(binary, encoder, codec, { bitDepth: quality.bitDepth });
    cache.tests.set(rowKey, test);
  }
  const result = await test,
    row: ProbeRow = { mode, encoder, listed: true, ...result };
  cache.rows.set(rowKey, row);
  return row;
}

export function parseEncoderRequest(value: string | undefined) {
  if (value === undefined || value === '') return undefined;
  return value.trim();
}
export function defaultEncoderRequest() {
  return parseEncoderRequest(process.env.VMOTION_ENCODER) ?? 'auto';
}

export async function resolveVideoEncoder(
  request: { encoder?: string; codec?: VideoCodec; quality?: VideoQuality },
  options: { binary?: string; platform?: NodeJS.Platform } = {},
): Promise<EncoderResolution> {
  const binary = options.binary ?? ffmpegBinary(),
    platform = options.platform ?? process.platform,
    requested = parseEncoderRequest(request.encoder) ?? defaultEncoderRequest(),
    codec = request.codec ?? 'h264',
    quality = request.quality ?? {},
    bitDepth = (quality.bitDepth ?? 8) as 8 | 10,
    cache = await cacheFor(binary, platform),
    probe: ProbeRow[] = [];
  if (bitDepth === 10 && codec === 'h264')
    throw new VmotionError('ENCODER_BIT_DEPTH', '10-bit output requires HEVC or AV1');
  const finish = (
    mode: EncoderResolution['mode'],
    used: string,
    hardware: boolean,
    fallbackReason?: string,
  ): EncoderResolution => {
    const args = encoderArguments(used, codec, quality, vaapiContext());
    return {
      requested,
      mode,
      codec,
      used,
      hardware,
      bitDepth,
      ...(fallbackReason ? { fallbackReason } : {}),
      args,
      probe,
      identity: {
        used,
        mode,
        args: [...args.input, '|', ...args.output],
        ffmpeg: cache.ffmpeg,
        ...(hardware ? { driver: cache.driver } : {}),
      },
    };
  };
  const software = (fallbackReason?: string) => {
    const used = softwareEncoderChains[codec].find((name) => cache.encoders.has(name));
    if (!used)
      throw new VmotionError(
        'NO_ENCODER',
        `No software ${codecLabel[codec]} encoder (${softwareEncoderChains[codec].join(', ')}) is available in this FFmpeg${fallbackReason ? `; ${fallbackReason}` : ''}`,
        { codec, probe },
      );
    if (used === 'mpeg4' && codec === 'h264')
      fallbackReason = [fallbackReason, 'no software H.264 encoder; legacy MPEG-4 Part 2 used']
        .filter(Boolean)
        .join('; ');
    return finish(requested === 'auto' ? 'auto' : 'software', used, false, fallbackReason);
  };
  if (!isMode(requested)) {
    // Raw FFmpeg encoder name: historical behaviour and error text.
    if (!cache.encoders.has(requested))
      throw new VmotionError(
        'NO_ENCODER',
        `Requested encoder is unavailable in this media runtime: ${requested}`,
      );
    const hwMode = hardwareEncoderModes.find((m) =>
      Object.values(hardwareEncoderNames[m]).includes(requested),
    );
    return finish('custom', requested, !!hwMode);
  }
  if (requested === 'software') return software();
  if (requested === 'auto') {
    const candidates = (platformPriority[platform] ?? []).filter(
      (m) => hardwareEncoderNames[m][codec],
    );
    const skipped: string[] = [];
    for (const mode of candidates) {
      const encoder = hardwareEncoderNames[mode][codec]!;
      if (bitDepth === 10 && tenBitUnsupported.has(encoder)) {
        probe.push({
          mode,
          encoder,
          listed: cache.encoders.has(encoder),
          ok: false,
          error: '10-bit unsupported',
        });
        skipped.push(`${encoder}: 10-bit unsupported`);
        continue;
      }
      const row = await probeHardware(cache, binary, mode, codec, quality);
      probe.push(row);
      if (row.ok) return finish('auto', encoder, true);
      skipped.push(
        row.listed ? `${encoder} probe failed (${row.error})` : `${encoder} not in FFmpeg`,
      );
    }
    return software(
      candidates.length
        ? `no working hardware ${codecLabel[codec]} encoder: ${skipped.join('; ')}`
        : `no hardware ${codecLabel[codec]} encoder is defined for ${platform}`,
    );
  }
  const encoder = hardwareEncoderNames[requested][codec];
  if (!encoder)
    throw new VmotionError(
      'ENCODER_UNSUPPORTED',
      `${requested} does not offer ${codecLabel[codec]} encoding`,
      { encoder: requested, codec },
    );
  if (bitDepth === 10 && tenBitUnsupported.has(encoder))
    throw new VmotionError('ENCODER_BIT_DEPTH', `${encoder} does not support 10-bit output`);
  const row = await probeHardware(cache, binary, requested, codec, quality);
  probe.push(row);
  if (!row.listed)
    throw new VmotionError(
      'ENCODER_UNAVAILABLE',
      `Hardware encoder ${encoder} is not built into this FFmpeg (${binary}); use encoder "auto" or "software"`,
      { encoder: requested, codec, probe },
    );
  if (!row.ok)
    throw new VmotionError(
      'ENCODER_UNAVAILABLE',
      `Hardware encoder ${encoder} failed its probe encode: ${row.error}`,
      { encoder: requested, codec, probe },
    );
  return finish(requested, encoder, true);
}

/** Probe every hardware backend for one codec (or all codecs) and return the table. */
export async function probeVideoEncoders(
  options: {
    binary?: string;
    platform?: NodeJS.Platform;
    codecs?: VideoCodec[];
    bitDepth?: 8 | 10;
  } = {},
) {
  const binary = options.binary ?? ffmpegBinary(),
    platform = options.platform ?? process.platform,
    cache = await cacheFor(binary, platform),
    priority = platformPriority[platform] ?? [],
    rows: Array<ProbeRow & { codec: VideoCodec }> = [];
  for (const codec of options.codecs ?? (['h264', 'hevc', 'av1'] as VideoCodec[]))
    for (const mode of priority) {
      const encoder = hardwareEncoderNames[mode][codec];
      if (!encoder) continue;
      if (options.bitDepth === 10 && (codec === 'h264' || tenBitUnsupported.has(encoder))) continue;
      rows.push({
        codec,
        ...(await probeHardware(cache, binary, mode, codec, { bitDepth: options.bitDepth })),
      });
    }
  return {
    platform,
    priority,
    ffmpeg: { binary, hash: cache.ffmpeg.slice(0, 16) },
    driver: cache.driver,
    software: Object.fromEntries(
      (Object.keys(softwareEncoderChains) as VideoCodec[]).map((codec) => [
        codec,
        softwareEncoderChains[codec].find((n) => cache.encoders.has(n)) ?? null,
      ]),
    ),
    rows,
  };
}

/** Synchronous view of what this process has probed so far (capabilities). */
export function encoderCapabilities() {
  return {
    default: defaultEncoderRequest(),
    modes: encoderModes,
    codecs: ['h264', 'hevc', 'av1'],
    priority: platformPriority[process.platform] ?? [],
    probed: lastCache
      ? {
          ffmpeg: lastCache.ffmpeg.slice(0, 16),
          driver: lastCache.driver,
          rows: [...lastCache.rows.values()],
        }
      : null,
  };
}

/** Compact public evidence for render_status/profile. */
export function encoderEvidence(resolution: EncoderResolution) {
  return {
    requested: resolution.requested,
    mode: resolution.mode,
    codec: resolution.codec,
    used: resolution.used,
    hardware: resolution.hardware,
    bitDepth: resolution.bitDepth,
    ...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
    ...(resolution.args.notes.length ? { notes: resolution.args.notes } : {}),
    ...(resolution.probe.length ? { probe: resolution.probe } : {}),
  };
}

/**
 * Encode already-rendered RGBA frames (cycled to `count`) with a resolved encoder to the null
 * muxer and time it. Used by render_profile/render_compare; wall time includes encoder start-up.
 */
export async function measureEncode(
  resolution: EncoderResolution,
  frames: ArrayBufferView[],
  width: number,
  height: number,
  fps: { num: number; den: number },
  count: number,
  binary = ffmpegBinary(),
) {
  const started = performance.now();
  let stderr = '',
    waitMs = 0;
  const child = spawn(
    binary,
    [
      '-hide_banner',
      '-v',
      'error',
      ...resolution.args.input,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      `${fps.num}/${fps.den}`,
      '-i',
      'pipe:0',
      '-an',
      ...resolution.args.output,
      '-f',
      'null',
      '-',
    ],
    { windowsHide: true },
  );
  child.stderr.on('data', (c) => (stderr = (stderr + c.toString()).slice(-8000)));
  child.stdin.on('error', () => {});
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new VmotionError('ENCODE_FAILED', e.message)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new VmotionError(
              'ENCODE_FAILED',
              `${resolution.used} failed: ${summarizeStderr(stderr) || `exit ${code}`}`,
            ),
          ),
    );
  });
  closed.catch(() => {});
  try {
    for (let i = 0; i < count; i++) {
      const f = frames[i % frames.length];
      if (!child.stdin.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength))) {
        const w = performance.now();
        await Promise.race([
          new Promise((r) => child.stdin.once('drain', r)),
          closed.then(() => {
            throw new VmotionError('ENCODE_FAILED', `${resolution.used} exited early`);
          }),
        ]);
        waitMs += performance.now() - w;
      }
    }
    child.stdin.end();
    await closed;
  } catch (e) {
    child.kill();
    throw e;
  }
  const wallMs = performance.now() - started;
  return {
    ...encoderEvidence(resolution),
    frames: count,
    width,
    height,
    wallMs: Math.round(wallMs * 10) / 10,
    framesPerSecond: Math.round((count / (wallMs / 1000)) * 10) / 10,
    backpressureMs: Math.round(waitMs * 10) / 10,
  };
}
