// Fake FFmpeg for hardware-encode tests. Behaviour is driven by environment variables so one
// script serves every case:
//   FAKE_FFMPEG_ENCODERS   comma list printed by `-encoders`
//   FAKE_FFMPEG_FAIL       comma list of encoders whose encode fails at open ("no capable device")
//   FAKE_FFMPEG_FAIL_SEGMENT  output-name fragment (e.g. segment-000001) whose hardware encode
//                          dies after reading some input ("device lost" mid-export)
//   FAKE_FFMPEG_LOG        file receiving one JSON argv line per invocation
//   FAKE_FFMPEG_REAL       real ffmpeg used for file outputs; hardware codec args are swapped for
//                          libx264 ultrafast so the export pipeline still produces a valid MP4
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const script = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2), env = process.env;
if (env.FAKE_FFMPEG_LOG) fs.appendFileSync(env.FAKE_FFMPEG_LOG, JSON.stringify(argv) + '\n');
if (argv.includes('-encoders')) {
  process.stdout.write('Encoders:\n V..... = Video\n ------\n');
  for (const name of (env.FAKE_FFMPEG_ENCODERS || '').split(',').filter(Boolean))
    process.stdout.write(' V....D ' + name.padEnd(20) + ' fake ' + name + '\n');
  process.exit(0);
}
const codecAt = argv.indexOf('-c:v'), codec = codecAt >= 0 ? argv[codecAt + 1] : undefined;
const hardware = codec && /_(nvenc|qsv|amf|mf|vaapi|videotoolbox)$/.test(codec);
const output = argv[argv.length - 1];
const fail = (msg) => { process.stderr.write('[' + codec + ' @ 0x1] ' + msg + '\n'); process.exit(1); };
if (codec && (env.FAKE_FFMPEG_FAIL || '').split(',').includes(codec)) {
  process.stdin.resume();
  fail('No capable devices found');
}
if (hardware && env.FAKE_FFMPEG_FAIL_SEGMENT && output.includes(env.FAKE_FFMPEG_FAIL_SEGMENT)) {
  let seen = 0;
  process.stdin.on('data', (c) => { seen += c.length; if (seen > 100000) fail('device lost (CUDA_ERROR_LAUNCH_FAILED)'); });
  process.stdin.on('end', () => fail('device lost (CUDA_ERROR_LAUNCH_FAILED)'));
  return;
}
if (output === '-') {
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));
  return;
}
let args = argv;
if (hardware) {
  const rawAt = args.indexOf('rawvideo') - 1, anAt = args.indexOf('-an'), fAt = args.lastIndexOf('-f');
  args = [...args.slice(0, 3), ...args.slice(rawAt, anAt + 1), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...args.slice(fAt)];
}
const child = spawn(env.FAKE_FFMPEG_REAL || 'ffmpeg', args, { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 1));
`;

export async function writeFakeFfmpeg(directory: string) {
  const file = path.join(directory, 'fake-ffmpeg');
  await writeFile(file, `#!${process.execPath}\n(() => {${script}})();\n`);
  await chmod(file, 0o755);
  return file;
}
