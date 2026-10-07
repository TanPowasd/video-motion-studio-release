import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, ffmpegBinary, VideoDecoder } from '../src/media/ffmpeg.js';
it('preserves the absolute resampling grid when randomly seeking fractional-FPS and last frames', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-video-clock-'));
  try {
    for (const sourceRate of [24, 30, 60]) {
      const file = path.join(root, `source-${sourceRate}.mkv`);
      await runProcess(ffmpegBinary(), [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=64x36:rate=${sourceRate}:duration=1`,
        '-c:v',
        'ffv1',
        ...(sourceRate === 60 ? ['-output_ts_offset', '5'] : []),
        file,
      ]);
      const sequence = new VideoDecoder(file, 64, 36, { num: 30000, den: 1001 }),
        seek = new VideoDecoder(file, 64, 36, { num: 30000, den: 1001 });
      try {
        const expected: Buffer[] = [];
        for (let i = 0; i < 30; i++) expected.push(await sequence.frame(i));
        for (const frame of [29, 0, 17, 28, 3, 27, 1, 12, 29])
          expect(
            (await seek.frame(frame)).equals(expected[frame]),
            `source ${sourceRate} frame ${frame}`,
          ).toBe(true);
        await expect(seek.frame(100)).rejects.toMatchObject({ code: 'VIDEO_DECODE' });
      } finally {
        await sequence.close();
        await seek.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
