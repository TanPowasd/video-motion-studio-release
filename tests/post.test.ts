import { it, expect } from 'vitest';
import { applyPixelEffect, samplePremultiplied, lumaMatte } from '../src/core/pixels.js';
import {
  chromaKey,
  levels,
  curves,
  parseCube,
  displacement,
  pixelate,
  grain,
  vignette,
} from '../src/sdk/post.js';
const rgba = (...values: number[]) => new Uint8ClampedArray(values),
  options = { frame: 10, fps: 30 };
it('removes green, preserves subject colors and creates soft matte edges', () => {
  const source = rgba(0, 255, 0, 255, 255, 0, 0, 255, 60, 180, 70, 255),
    result = applyPixelEffect(
      source,
      3,
      1,
      chromaKey('#00ff00', { tolerance: 0.1, softness: 0.4 }),
      options,
    );
  expect(result[3]).toBe(0);
  expect(result[7]).toBe(255);
  expect(result[11]).toBeGreaterThan(0);
  expect(result[11]).toBeLessThan(255);
  expect(result[9]).toBeLessThan(source[9]);
});
it('preserves alpha while applying levels and channel curves', () => {
  const source = rgba(64, 128, 192, 77),
    level = applyPixelEffect(source, 1, 1, levels({ inputBlack: 0.25, inputWhite: 0.75 }), options);
  expect(level[0]).toBeLessThan(2);
  expect(level[2]).toBe(255);
  expect(level[3]).toBe(77);
  const curve = applyPixelEffect(
    source,
    1,
    1,
    curves({
      red: [
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ],
    }),
    options,
  );
  expect(curve[0]).toBe(191);
  expect(curve[1]).toBe(128);
  expect(curve[3]).toBe(77);
});
it('loads .cube LUT ordering and interpolates all eight neighbors', () => {
  let cube = 'TITLE "Invert"\nLUT_3D_SIZE 2\n';
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube += `${1 - r} ${1 - g} ${1 - b}\n`;
  const result = applyPixelEffect(rgba(64, 128, 192, 255), 1, 1, parseCube(cube), options);
  expect([...result]).toEqual([191, 127, 63, 255]);
  expect(() => parseCube('LUT_3D_SIZE 3\n0 0 0')).toThrow('mismatch');
});
it('resamples transparent edges with premultiplied alpha', () => {
  const output = new Uint8ClampedArray(4);
  samplePremultiplied(rgba(255, 0, 0, 255, 0, 0, 255, 0), 2, 1, 0.5, 0, output, 0);
  expect(output[0]).toBe(255);
  expect(output[2]).toBe(0);
  expect(output[3]).toBe(128);
});
it('keeps zero displacement identical and deterministic evolving distortion independent of order', () => {
  const source = rgba(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255);
  expect(applyPixelEffect(source, 2, 2, displacement({ amountX: 0, amountY: 0 }), options)).toEqual(
    source,
  );
  const effect = displacement({
      amountX: 2,
      amountY: 2,
      scale: 8,
      evolution: 0.4,
      seed: 7,
      edge: 'wrap',
    }),
    a = applyPixelEffect(source, 2, 2, effect, options);
  applyPixelEffect(source, 2, 2, displacement({ evolution: 9 }), options);
  expect(applyPixelEffect(source, 2, 2, effect, options)).toEqual(a);
});
it('averages pixel blocks without leaking colors from transparent samples', () => {
  const output = applyPixelEffect(rgba(255, 0, 0, 255, 0, 0, 255, 0), 2, 1, pixelate(2), options);
  expect([...output]).toEqual([255, 0, 0, 128, 255, 0, 0, 128]);
});
it('grain changes with time while static grain remains stable', () => {
  const source = new Uint8ClampedArray(64).fill(128);
  const a = applyPixelEffect(source, 4, 4, grain(0.4, 5), options),
    b = applyPixelEffect(source, 4, 4, grain(0.4, 5), { frame: 11, fps: 30 });
  expect(a).not.toEqual(b);
  expect(applyPixelEffect(source, 4, 4, grain(0.4, 5, false), options)).toEqual(
    applyPixelEffect(source, 4, 4, grain(0.4, 5, false), { frame: 11, fps: 30 }),
  );
});
it('vignette darkens corners in linear light and keeps center and alpha', () => {
  const source = new Uint8ClampedArray(10 * 10 * 4).fill(255),
    result = applyPixelEffect(source, 10, 10, vignette(0.8, 0.5, 0.5), options);
  expect(result[0]).toBeLessThan(200);
  expect(result[(5 * 10 + 5) * 4]).toBe(255);
  expect(result[3]).toBe(255);
  expect(lumaMatte(rgba(0, 0, 0, 255, 255, 255, 255, 128))[7]).toBe(128);
});
