import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFakeFfmpeg } from './fake-ffmpeg.js';
import {
  encoderArguments,
  parseEncoderList,
  probeVideoEncoders,
  resetEncoderProbeCache,
  resolveVideoEncoder,
  summarizeStderr,
} from '../src/media/video-encoder.js';
import { projectSchema } from '../src/core/model.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoEncodeFields } from '../src/editor/VideoEncodeFields.js';

const posix = process.platform !== 'win32';
let dir: string, fake: string, log: string;
const saved = { ...process.env };
const setFake = (encoders: string[], fail: string[] = []) => {
  process.env.FAKE_FFMPEG_ENCODERS = encoders.join(',');
  process.env.FAKE_FFMPEG_FAIL = fail.join(',');
};
const invocations = async () =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
const probeCalls = async () => (await invocations()).filter((a) => a.includes('null'));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vmotion-hwenc-'));
  fake = await writeFakeFfmpeg(dir);
  log = path.join(dir, 'log.jsonl');
});
beforeEach(async () => {
  resetEncoderProbeCache();
  await writeFile(log, '');
  process.env.FAKE_FFMPEG_LOG = log;
  delete process.env.VMOTION_ENCODER;
  delete process.env.FAKE_FFMPEG_FAIL_SEGMENT;
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

describe('encoder argument mapping', () => {
  it('keeps the historical software arguments byte-for-byte', () => {
    expect(encoderArguments('libx264', 'h264').output).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(encoderArguments('libopenh264', 'h264').output).toEqual([
      '-c:v',
      'libopenh264',
      '-b:v',
      '20M',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(encoderArguments('mpeg4', 'h264').output).toEqual([
      '-c:v',
      'mpeg4',
      '-b:v',
      '20M',
      '-pix_fmt',
      'yuv420p',
    ]);
    // crf 18 alone reproduces the legacy x264 flags.
    expect(encoderArguments('libx264', 'h264', { crf: 18 }).output).toEqual(
      encoderArguments('libx264', 'h264').output,
    );
    expect(encoderArguments('libx264', 'h264').input).toEqual([]);
  });
  it('maps crf/bitrate/preset/keyframes/bit depth to each hardware encoder', () => {
    const q = { crf: 23, preset: 'quality' as const, keyframeInterval: 60 };
    const nv = encoderArguments('hevc_nvenc', 'hevc', { ...q, bitDepth: 10 }).output;
    expect(nv).toEqual(
      expect.arrayContaining(['-c:v', 'hevc_nvenc', '-preset', 'p6', '-cq', '23', '-g', '60']),
    );
    expect(nv.join(' ')).toContain('-profile:v main10');
    expect(nv.slice(-2)).toEqual(['-pix_fmt', 'p010le']);
    const qsv = encoderArguments('h264_qsv', 'h264', q).output.join(' ');
    expect(qsv).toContain('-preset veryslow');
    expect(qsv).toContain('-global_quality 23');
    expect(qsv).toContain('-pix_fmt nv12');
    const amf = encoderArguments('h264_amf', 'h264', q).output.join(' ');
    expect(amf).toContain('-quality quality');
    expect(amf).toContain('-rc cqp -qp_i 23 -qp_p 23 -qp_b 23');
    expect(encoderArguments('av1_amf', 'av1', { crf: 30 }).output.join(' ')).toContain('-qp_i 120');
    const mf = encoderArguments('h264_mf', 'h264', { crf: 0 }).output.join(' ');
    expect(mf).toContain('-hw_encoding 1 -rate_control quality -quality 100');
    const vt = encoderArguments('hevc_videotoolbox', 'hevc').output.join(' ');
    expect(vt).toContain('-allow_sw 0');
    expect(vt).toContain('-b:v 20M');
    expect(vt).toContain('-tag:v hvc1');
    const va = encoderArguments(
      'h264_vaapi',
      'h264',
      { crf: 20 },
      { vaapiDevice: '/dev/dri/renderD129' },
    );
    expect(va.input).toEqual(['-vaapi_device', '/dev/dri/renderD129']);
    expect(va.output.join(' ')).toContain(
      '-vf format=nv12,hwupload -c:v h264_vaapi -rc_mode CQP -qp 20',
    );
    expect(va.output).not.toContain('-pix_fmt');
    const rate = encoderArguments('h264_nvenc', 'h264', { crf: 10, bitrateKbps: 8000 }).output.join(
      ' ',
    );
    expect(rate).toContain('-b:v 8000k -maxrate 12000k');
    expect(rate).not.toContain('-cq');
    expect(encoderArguments('libx265', 'hevc', { bitDepth: 10 }).output.join(' ')).toContain(
      '-profile:v main10 -x265-params log-level=error -tag:v hvc1 -pix_fmt yuv420p10le',
    );
    expect(encoderArguments('libopenh264', 'h264', { crf: 20 }).notes[0]).toContain('crf ignored');
  });
  it('rejects unsupported bit depth and quality combinations', () => {
    expect(() => encoderArguments('h264_nvenc', 'h264', { bitDepth: 10 })).toThrow('HEVC or AV1');
    expect(() => encoderArguments('hevc_mf', 'hevc', { bitDepth: 10 })).toThrow('10-bit');
    expect(() => encoderArguments('libx264', 'h264', { crf: 60 })).toThrow('exceeds 51');
    expect(projectSchema.innerType().shape.videoExport.safeParse({ encoder: 'cuda' }).success).toBe(
      false,
    );
    expect(
      projectSchema
        .innerType()
        .shape.videoExport.safeParse({
          encoder: 'nvenc',
          codec: 'hevc',
          quality: { crf: 20, bitDepth: 10 },
        }).success,
    ).toBe(true);
  });
  it('parses encoder lists and keeps the root-cause stderr line', () => {
    const names = parseEncoderList(
      'Encoders:\n V..... = Video\n ------\n V....D libx264   x\n V....D h264_nvenc  NVIDIA\n A....D aac  AAC\n',
    );
    expect([...names]).toEqual(['libx264', 'h264_nvenc']);
    expect(
      summarizeStderr(
        '[h264_nvenc @ 0xabc] Cannot load libcuda.so.1\n[vost#0:0 @ 0x1] Error while opening\nTerminating\n',
      ),
    ).toBe('Cannot load libcuda.so.1 | Error while opening');
  });
});

describe.skipIf(!posix)('probe and resolution with a fake FFmpeg', () => {
  const windowsSet = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'hevc_nvenc'];
  it('auto follows Windows priority and skips a listed encoder whose probe fails', async () => {
    setFake(windowsSet, ['h264_nvenc']);
    const r = await resolveVideoEncoder({ encoder: 'auto' }, { binary: fake, platform: 'win32' });
    expect(r).toMatchObject({ used: 'h264_qsv', hardware: true, mode: 'auto', codec: 'h264' });
    expect(r.probe.map((p) => [p.encoder, p.ok])).toEqual([
      ['h264_nvenc', false],
      ['h264_qsv', true],
    ]);
    expect(r.probe[0].error).toContain('No capable devices found');
    expect(r.identity.driver).toBeTruthy();
    // The probe is a real tiny encode through the export pixel path.
    const [first] = await probeCalls();
    expect(first.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 256x256');
    expect(first.join(' ')).toContain('-frames:v 64 -f null -');
  });
  it('caches probes per ffmpeg binary for the process', async () => {
    setFake(windowsSet);
    await resolveVideoEncoder({ encoder: 'auto' }, { binary: fake, platform: 'win32' });
    await resolveVideoEncoder({ encoder: 'nvenc' }, { binary: fake, platform: 'win32' });
    await resolveVideoEncoder(
      { encoder: 'auto', codec: 'h264' },
      { binary: fake, platform: 'win32' },
    );
    expect(await probeCalls()).toHaveLength(1);
    expect((await invocations()).filter((a) => a.includes('-encoders'))).toHaveLength(1);
    // A different bit depth is a different surface format and is probed separately.
    await resolveVideoEncoder(
      { encoder: 'nvenc', codec: 'hevc', quality: { bitDepth: 10 } },
      { binary: fake, platform: 'win32' },
    );
    expect(await probeCalls()).toHaveLength(2);
  });
  it('auto falls back to software deterministically with a reason', async () => {
    setFake(windowsSet, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']);
    const r = await resolveVideoEncoder({}, { binary: fake, platform: 'win32' });
    expect(r).toMatchObject({ used: 'libx264', hardware: false, mode: 'auto' });
    expect(r.fallbackReason).toMatch(/h264_nvenc probe failed.*h264_qsv.*h264_amf.*h264_mf/);
    expect(r.args.output).toEqual(encoderArguments('libx264', 'h264').output);
    expect(r.identity.driver).toBeUndefined();
    setFake(['libx264']);
    resetEncoderProbeCache();
    const none = await resolveVideoEncoder({}, { binary: fake, platform: 'linux' });
    expect(none.fallbackReason).toContain('h264_nvenc not in FFmpeg');
    expect(await probeCalls()).toHaveLength(4);
  });
  it('explicit hardware errors clearly instead of falling back', async () => {
    setFake(['libx264', 'h264_amf'], ['h264_amf']);
    await expect(
      resolveVideoEncoder({ encoder: 'nvenc' }, { binary: fake, platform: 'win32' }),
    ).rejects.toThrow(/h264_nvenc is not built into this FFmpeg/);
    await expect(
      resolveVideoEncoder({ encoder: 'amf' }, { binary: fake, platform: 'win32' }),
    ).rejects.toThrow(/h264_amf failed its probe encode: No capable devices found/);
    await expect(
      resolveVideoEncoder(
        { encoder: 'mediafoundation', codec: 'av1' },
        { binary: fake, platform: 'win32' },
      ),
    ).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED' });
  });
  it('software chains keep openh264 first, report mpeg4 and missing codecs', async () => {
    setFake(['libopenh264', 'libx264', 'h264_nvenc']);
    expect((await resolveVideoEncoder({ encoder: 'software' }, { binary: fake })).used).toBe(
      'libopenh264',
    );
    expect(await probeCalls()).toHaveLength(0);
    resetEncoderProbeCache();
    setFake(['mpeg4', 'h264_mf']);
    const legacy = await resolveVideoEncoder({ encoder: 'software' }, { binary: fake });
    expect(legacy.used).toBe('mpeg4');
    expect(legacy.fallbackReason).toContain('MPEG-4 Part 2');
    await expect(
      resolveVideoEncoder({ encoder: 'software', codec: 'hevc' }, { binary: fake }),
    ).rejects.toThrow(/No software HEVC encoder \(libx265\)/);
  });
  it('honours raw FFmpeg names, VMOTION_ENCODER and platform priorities', async () => {
    setFake(['libx264', 'h264_videotoolbox', 'hevc_videotoolbox', 'h264_nvenc']);
    await expect(
      resolveVideoEncoder({ encoder: 'vmotion-no-such' }, { binary: fake }),
    ).rejects.toThrow('Requested encoder is unavailable in this media runtime: vmotion-no-such');
    const raw = await resolveVideoEncoder({ encoder: 'libx264' }, { binary: fake });
    expect(raw).toMatchObject({ mode: 'custom', used: 'libx264', hardware: false });
    const mac = await resolveVideoEncoder({ codec: 'hevc' }, { binary: fake, platform: 'darwin' });
    expect(mac).toMatchObject({ used: 'hevc_videotoolbox', hardware: true });
    process.env.VMOTION_ENCODER = 'software';
    expect((await resolveVideoEncoder({}, { binary: fake, platform: 'darwin' })).used).toBe(
      'libx264',
    );
    expect(
      (await resolveVideoEncoder({ encoder: 'auto' }, { binary: fake, platform: 'darwin' })).used,
    ).toBe('h264_videotoolbox');
  });
  it('produces a probe table for every codec', async () => {
    setFake(
      ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv'],
      ['av1_nvenc'],
    );
    const table = await probeVideoEncoders({ binary: fake, platform: 'win32' });
    expect(table.software).toEqual({ h264: 'libx264', hevc: 'libx265', av1: null });
    const row = (encoder: string) => table.rows.find((r) => r.encoder === encoder);
    expect(row('h264_nvenc')).toMatchObject({ listed: true, ok: true });
    expect(row('av1_nvenc')).toMatchObject({ listed: true, ok: false });
    expect(row('hevc_amf')).toMatchObject({ listed: false });
    expect(table.rows.some((r) => r.encoder === 'av1_mf')).toBe(false);
  });
});

it('export dialog encoder fields render Chinese labels and project defaults', () => {
  const html = renderToStaticMarkup(
    React.createElement(VideoEncodeFields, {
      value: { encoder: 'nvenc', codec: 'hevc', quality: { crf: 22, bitDepth: 10 } },
      saved: { encoder: 'nvenc', codec: 'hevc', quality: { crf: 22, bitDepth: 10 } },
      onChange: () => {},
      run: async () => undefined,
      transact: async () => undefined,
    }),
  );
  expect(html).toContain('视频编码器');
  expect(html).toContain('检测硬件编码');
  expect(html).toContain('10-bit 输出');
  expect(html).toMatch(/<option value="nvenc" selected="">NVIDIA NVENC<\/option>/);
  expect(html).toMatch(/value="22"/);
  // Unchanged settings cannot be re-saved; H.264 hides the 10-bit option.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>设为工程默认/);
  const h264 = renderToStaticMarkup(
    React.createElement(VideoEncodeFields, {
      value: {},
      onChange: () => {},
      run: async () => undefined,
      transact: async () => undefined,
    }),
  );
  expect(h264).not.toContain('10-bit 输出');
});
