import { it, expect } from 'vitest';
import { pixelEvidence, comparePixels } from '../src/sdk/index.js';
const options = { analysis: 'full' as const, alpha: 'weighted' as const };
const rgba = (...values: number[]) => new Uint8ClampedArray(values);
it('measures encoded SDR colors, endpoint clipping and bounded distributions against known pixels', () => {
  const result = pixelEvidence(
    rgba(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255),
    4,
    1,
    { ...options, bins: 8, columns: 4, vectorSize: 8, distributions: true },
  );
  expect(result.coverage).toMatchObject({
    visited: 4,
    weight: 4,
    meanAlpha: 1,
    fullPixelCoverage: true,
  });
  for (const channel of result.summary.channels) expect(channel.mean).toBeCloseTo(0.25);
  expect(result.summary.channels[0]).toMatchObject({ lowRatio: 0.75, highRatio: 0.25 });
  expect(result.summary.channels[0].percentiles[2]).toBe(0.0625);
  expect(result.summary.lumaVariance).toBeCloseTo(
    (0.2126 ** 2 + 0.7152 ** 2 + 0.0722 ** 2) / 4 - 0.25 ** 2,
  );
  expect(result.histogram!.channels[0].counts).toEqual([3, 0, 0, 0, 0, 0, 0, 1]);
  expect(result.waveform!.channels[0].counts[7]).toBe(1);
  expect(result.waveform!.channels[0].counts[8]).toBe(1);
  expect(result.vectorscope!.counts.reduce((a, b) => a + b, 0)).toBe(4);
});
it('distinguishes visible, alpha weighted and black-composited colors without using hidden RGB', () => {
  const pixels = rgba(255, 0, 0, 255, 0, 0, 255, 128, 0, 255, 0, 0);
  const weighted = pixelEvidence(pixels, 3, 1, options);
  expect(weighted.summary.channels[0].mean).toBeCloseTo(255 / 383);
  expect(weighted.summary.channels[2].mean).toBeCloseTo(128 / 383);
  expect(weighted.summary.channels[1].mean).toBe(0);
  const visible = pixelEvidence(pixels, 3, 1, { ...options, alpha: 'visible' });
  expect(visible.summary.channels[0].mean).toBe(0.5);
  const black = pixelEvidence(pixels, 3, 1, { ...options, alpha: 'black' });
  expect(black.summary.channels[0].mean).toBeCloseTo(1 / 3);
  expect(black.summary.channels[2].mean).toBeCloseTo(128 / 765);
  expect(black.coverage.visibleSamples).toBe(2);
});
it('reports exact ROI coverage and deterministic raster-stride sampling explicitly', () => {
  const pixels = new Uint8ClampedArray(10 * 4 * 4).fill(255);
  const region = { x: 2, y: 1, width: 5, height: 2 };
  const full = pixelEvidence(pixels, 10, 4, { ...options, region });
  expect(full.coverage).toMatchObject({ regionPixels: 10, visited: 10, stride: 1 });
  const sampled = pixelEvidence(pixels, 10, 4, {
    ...options,
    region,
    analysis: 'sampled',
    maxSamples: 3,
  });
  expect(sampled.coverage).toMatchObject({
    regionPixels: 10,
    visited: 3,
    stride: 4,
    fullPixelCoverage: false,
  });
  expect(sampled.histogram).toBeUndefined();
  expect(sampled).toEqual(
    pixelEvidence(pixels, 10, 4, { ...options, region, analysis: 'sampled', maxSamples: 3 }),
  );
});
it('uses null summaries for zero visible weight and validates direct SDK buffers and budgets', () => {
  const result = pixelEvidence(rgba(255, 0, 0, 0), 1, 1, options);
  expect(result.summary.channels[0].mean).toBeNull();
  expect(result.summary.channels[0].percentiles).toEqual([null, null, null, null, null]);
  expect(() => pixelEvidence(rgba(0), 1, 1, options)).toThrow(/RGBA/);
  for (const patch of [
    { maxSamples: 0 },
    { maxSamples: Infinity },
    { bins: 400 },
    { analysis: 'invalid' },
    { alpha: 'invalid' },
    { region: { x: 1, y: 0, width: 1, height: 1 } },
  ])
    expect(() => pixelEvidence(rgba(0, 0, 0, 0), 1, 1, { ...options, ...patch } as any)).toThrow();
});
it('compares premultiplied channels and independent alpha, ignoring fully transparent RGB', () => {
  const a = rgba(255, 0, 0, 0, 255, 0, 0, 128),
    b = rgba(0, 255, 0, 0, 128, 0, 0, 255);
  const result = comparePixels(a, b, 2, 1, { diff: true });
  expect(result).toMatchObject({
    comparedPixels: 2,
    changedPixels: 1,
    exactChangedPixels: 1,
    changedRatio: 0.5,
    maximum8bit: 127,
    changedBounds: { x: 1, y: 0, width: 1, height: 1 },
  });
  expect(result.meanAbsolute8bit).toBe(127 / 8);
  expect(result.rms8bit).toBeCloseTo(127 / Math.sqrt(8));
  expect([...result.diff!.slice(0, 4)]).toEqual([0, 0, 0, 255]);
});
it('separates tolerance bounds from exact differences, supports ROI and rejects incompatible dimensions', () => {
  const a = new Uint8ClampedArray(3 * 2 * 4).fill(255),
    b = a.slice();
  b[0] = 250;
  b[(1 * 3 + 2) * 4] = 155;
  const result = comparePixels(a, b, 3, 2, { tolerance: 5 });
  expect(result.changedPixels).toBe(1);
  expect(result.exactChangedPixels).toBe(2);
  expect(result.changedBounds).toEqual({ x: 2, y: 1, width: 1, height: 1 });
  expect(
    comparePixels(a, b, 3, 2, { region: { x: 0, y: 0, width: 1, height: 1 }, tolerance: 5 })
      .changedBounds,
  ).toBeNull();
  expect(() => comparePixels(a, b, 2, 2)).toThrow();
  expect(() => comparePixels(a, b, 3, 2, { tolerance: 0.5 })).toThrow();
  expect(() =>
    comparePixels(a, b, 3, 2, { region: { x: 2, y: 0, width: 2, height: 1 } }),
  ).toThrow();
});
