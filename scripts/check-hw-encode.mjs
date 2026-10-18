// Real-machine hardware video encode verification (intended for the Windows reference box).
//
//   npm run build
//   node scripts/check-hw-encode.mjs                 # dist CLI + dist/runtime or PATH FFmpeg
//   node scripts/check-hw-encode.mjs --packaged      # release/Vmotion (bundled LGPL FFmpeg)
//   options: --width 1920 --height 1080 --frames 300 --export-frames 90 --codecs h264,hevc,av1
//            --strict (exit 1 when no hardware encoder passes the probe)
//
// 1. Prints the probe table (FFmpeg encoder list + real 64-frame test encode per backend, 8-bit
//    and 10-bit).
// 2. For software and every hardware encoder that passed: render_profile encode timing of
//    `--frames` frames (rendered once, cycled, null muxer) -> fps and speed vs software H.264.
// 3. Exports `--export-frames` through the real `vmotion render --encoder <mode> --codec <c>`
//    pipeline, then validates with ffprobe (codec, pix_fmt, profile, counted frames) and a full
//    decode pass.
// 4. Checks that `--encoder auto` picks the first passing backend in platform priority.
// Report: artifacts/hw-encode/report-<timestamp>.json. Exit 1 on any failed export/validation.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2),
  flag = (name) => argv.includes(name),
  option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  },
  packaged = flag('--packaged'),
  strict = flag('--strict'),
  width = Number(option('--width', '1920')),
  height = Number(option('--height', '1080')),
  benchFrames = Number(option('--frames', '300')),
  exportFrames = Number(option('--export-frames', '90')),
  codecs = option('--codecs', 'h264,hevc,av1').split(','),
  packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'),
  exe = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve(option('--cli', 'dist/cli/index.mjs')),
  env = {
    ...process.env,
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  },
  exeSuffix = process.platform === 'win32' ? '.exe' : '',
  ffprobe =
    process.env.VMOTION_FFPROBE ??
    [
      path.join(packageRoot, `resources/runtime/media/bin/ffprobe${exeSuffix}`),
      path.resolve(`dist/runtime/media/bin/ffprobe${exeSuffix}`),
    ].find((f) => (packaged || !f.startsWith(packageRoot)) && existsSync(f)) ??
    'ffprobe',
  ffmpeg =
    process.env.VMOTION_FFMPEG ??
    (/[\\/]/.test(ffprobe) ? path.join(path.dirname(ffprobe), `ffmpeg${exeSuffix}`) : 'ffmpeg');
if (!existsSync(cli)) throw new Error(`CLI not found: ${cli} (run npm run build first)`);

const vm = (args, { allowFail = false } = {}) => {
  const result = spawnSync(exe, [cli, ...args], {
    env,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !(allowFail && result.status === 3))
    throw new Error(
      `vmotion ${args[0]} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  return JSON.parse(result.stdout);
};
const ffmpegLike = (bin, args) =>
  spawnSync(bin === 'ffmpeg' ? ffmpeg : ffprobe, args, {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

await mkdir('artifacts/hw-encode', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/hw-encode/project-')),
  out = `${root}-exports`;
await mkdir(out, { recursive: true });
execFileSync(
  exe,
  [
    cli,
    'init',
    '--project',
    root,
    '--template',
    'science',
    '--width',
    String(width),
    '--height',
    String(height),
    '--duration',
    String(Math.ceil(exportFrames / 30) + 1),
  ],
  { env, windowsHide: true },
);

// 1. probe table
const probe8 = vm(['encoders', '--project', root, '--codec', ...codecs]),
  probe10 = vm([
    'encoders',
    '--project',
    root,
    '--codec',
    ...codecs.filter((c) => c !== 'h264'),
    '--bit-depth',
    '10',
  ]);
console.log(
  `platform=${probe8.platform} priority=${probe8.priority.join('>')} ffmpeg=${probe8.ffmpeg.binary} (${probe8.ffmpeg.hash}) driver=${probe8.driver}`,
);
console.log('software:', probe8.software);
const tableRows = [
  ...probe8.rows.map((r) => ({ ...r, bitDepth: 8 })),
  ...probe10.rows.map((r) => ({ ...r, bitDepth: 10 })),
];
console.table(
  tableRows.map((r) => ({
    codec: r.codec,
    bits: r.bitDepth,
    encoder: r.encoder,
    listed: r.listed,
    ok: r.ok ?? '',
    probeMs: r.ms ?? '',
    error: (r.error ?? '').slice(0, 90),
  })),
);

// 2 + 3. benchmark and export each candidate
const candidates = [];
for (const codec of codecs) {
  if (probe8.software[codec]) candidates.push({ codec, mode: 'software', bitDepth: 8 });
  for (const row of probe8.rows.filter((r) => r.codec === codec && r.ok))
    candidates.push({ codec, mode: row.mode, bitDepth: 8 });
  for (const row of probe10.rows.filter((r) => r.codec === codec && r.ok))
    candidates.push({ codec, mode: row.mode, bitDepth: 10 });
}
const results = [],
  failures = [];
for (const c of candidates) {
  const label = `${c.codec}/${c.mode}${c.bitDepth === 10 ? '/10bit' : ''}`,
    row = { label, ...c };
  try {
    if (c.bitDepth === 8) {
      const requestFile = path.join(root, `profile-${c.codec}-${c.mode}.json`);
      await writeFile(
        requestFile,
        JSON.stringify({
          frames: [0, 15, 30, 45],
          repeat: 1,
          width: Math.min(width, 3840),
          height: Math.min(height, 2160),
          encoder: c.mode,
          codec: c.codec,
          encodeFrames: benchFrames,
        }),
      );
      const profile = vm(['render-profile', '--project', root, '--request', requestFile]);
      Object.assign(row, {
        used: profile.videoEncode.used,
        encodeFps: profile.videoEncode.framesPerSecond,
        encodeWallMs: profile.videoEncode.wallMs,
      });
    }
    const file = path.join(out, `${c.codec}-${c.mode}-${c.bitDepth}.mp4`),
      started = Date.now(),
      job = vm(
        [
          'render',
          '--project',
          root,
          '-o',
          file,
          '--encoder',
          c.mode,
          '--codec',
          c.codec,
          '--end',
          String(exportFrames),
          '--no-resume',
          ...(c.bitDepth === 10 ? ['--bit-depth', '10'] : []),
        ],
        { allowFail: true },
      );
    row.exportWallMs = Date.now() - started;
    if (job.status !== 'completed') throw new Error(`export ${job.status}: ${job.error}`);
    Object.assign(row, {
      used: job.encoder.used,
      segmentWallMs: job.encoder.segmentWallMs,
      encoderWaitMs: job.encoder.encoderWaitMs,
    });
    const info = JSON.parse(
        ffmpegLike('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_streams',
          '-of',
          'json',
          file,
        ]).stdout,
      ),
      video = info.streams[0],
      decode = ffmpegLike('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-']);
    Object.assign(row, {
      codecName: video.codec_name,
      profile: video.profile,
      pixFmt: video.pix_fmt,
      frames: Number(video.nb_read_frames),
      decodeErrors: decode.stderr.trim().split('\n').filter(Boolean).length,
    });
    const expectCodec = { h264: 'h264', hevc: 'hevc', av1: 'av1' }[c.codec];
    if (video.codec_name !== expectCodec)
      throw new Error(`codec ${video.codec_name} != ${expectCodec}`);
    if (row.frames !== exportFrames) throw new Error(`frames ${row.frames} != ${exportFrames}`);
    if (row.decodeErrors) throw new Error(`decode errors: ${decode.stderr.slice(0, 300)}`);
    if (c.bitDepth === 10 && !/10/.test(video.pix_fmt))
      throw new Error(`pix_fmt ${video.pix_fmt} is not 10-bit`);
    row.valid = true;
  } catch (e) {
    row.valid = false;
    row.error = e.message.slice(0, 400);
    failures.push(label);
  }
  results.push(row);
}
const softwareH264 = results.find((r) => r.codec === 'h264' && r.mode === 'software')?.encodeFps;
for (const r of results)
  if (r.encodeFps && softwareH264)
    r.speedVsSoftwareH264 = Math.round((r.encodeFps / softwareH264) * 100) / 100;
console.table(
  results.map((r) => ({
    case: r.label,
    used: r.used,
    encodeFps: r.encodeFps,
    'x vs sw h264': r.speedVsSoftwareH264,
    exportMs: r.exportWallMs,
    pix: r.pixFmt,
    profile: r.profile,
    frames: r.frames,
    valid: r.valid,
    error: r.error?.slice(0, 80),
  })),
);

// 4. auto picks the first passing backend in priority order
const expectedAuto = probe8.priority
    .map((mode) => probe8.rows.find((r) => r.codec === 'h264' && r.mode === mode && r.ok))
    .find(Boolean)?.encoder,
  autoJob = vm(
    [
      'render',
      '--project',
      root,
      '-o',
      path.join(out, 'auto.mp4'),
      '--encoder',
      'auto',
      '--end',
      String(Math.min(exportFrames, 30)),
      '--no-resume',
    ],
    { allowFail: true },
  ),
  auto = {
    status: autoJob.status,
    used: autoJob.encoder?.used,
    expected: expectedAuto ?? probe8.software.h264,
    fallbackReason: autoJob.encoder?.fallbackReason,
  };
console.log('auto:', auto);
if (auto.status !== 'completed' || auto.used !== auto.expected) failures.push('auto');
const hardwareOk = tableRows.some((r) => r.ok);
if (strict && !hardwareOk) failures.push('no hardware encoder passed the probe');

const report = path.resolve(`artifacts/hw-encode/report-${Date.now()}.json`);
await writeFile(
  report,
  JSON.stringify(
    {
      root,
      packaged,
      width,
      height,
      benchFrames,
      exportFrames,
      probe: { eightBit: probe8, tenBit: probe10 },
      results,
      auto,
      failures,
    },
    null,
    2,
  ),
);
console.log(`report: ${report}`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else console.log(`OK: ${results.length} encodes valid; hardware available=${hardwareOk}`);
