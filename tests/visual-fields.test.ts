import { it, expect } from 'vitest';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { prepareTexture, textureSettingsSchema } from '../src/core/visual-fields.js';
import { visualPreset, visualPresetNames } from '../src/core/visual-presets.js';
import { compileEffectGraph, defineEffectGraph } from '../src/core/effect-graph.js';
import { renderEffectGraph } from '../src/core/effect-graph-render.js';
import { rasterPass } from '../src/core/raster-pass.js';
import { applyPixelEffect } from '../src/core/pixels.js';
import { effectSchema } from '../src/core/model.js';
import { radialRaysPixels } from '../src/core/lighting-pixels.js';
import { pixelRegion } from '../src/core/pixel-region.js';
import type { Matrix } from '../src/core/interaction.js';
import type { EffectGraphInput } from '../src/core/effect-graph-schema.js';
const make = (w = 64, h = 48) => {
  const canvas = createCanvas(w, h);
  let released = false;
  return {
    canvas,
    ctx: canvas.getContext('2d'),
    release() {
      if (!released) {
        released = true;
        canvas.width = 1;
        canvas.height = 1;
      }
    },
  };
};
const env = (matrix: Matrix = [1, 0, 0, 1, 0, 0]) => ({
  makeSurface: make,
  scale: 1,
  matrix,
  bounds: { x: 0, y: 0, width: 16, height: 12 },
  canvasMatrix: [1, 0, 0, 1, 0, 0] as Matrix,
  frame: 0,
  fps: 30,
});
it('evaluates all field patterns with deterministic coordinates/palettes and rejects invalid stop ordering', () => {
  for (const pattern of ['fbm', 'turbulence', 'ridged', 'cellular', 'marble', 'waves', 'checker']) {
    const field = prepareTexture({ pattern, seed: 23, warp: 0.7, contrast: 1.8, evolution: 2.3 }),
      a = field.value(-5, 12);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
    expect(prepareTexture(field.settings).value(-5, 12)).toBe(a);
    expect(field.color(a).every((v) => Number.isFinite(v) && v >= 0 && v <= 255)).toBe(true);
  }
  expect(() =>
    textureSettingsSchema.parse({
      stops: [
        { offset: 1, color: '#ffffff' },
        { offset: 0, color: '#000000' },
      ],
    }),
  ).toThrow('increase');
  const field = prepareTexture({
    stops: [
      { offset: 0, color: '#ff0000', alpha: 0 },
      { offset: 1, color: '#0000ff', alpha: 1 },
    ],
  });
  expect(field.color(0.5)).toEqual([0, 0, 255, 127.5]);
});
it('matches bounded texture/noise fields to full-canvas baselines under rotated/skewed/reflected transforms', async () => {
  for (const type of ['texture', 'noise'] as const)
    for (const matrix of [
      [1, 0, 0, 1, 19, 11],
      [0.8, 0.3, -0.5, 1.1, 28, 8],
      [-1, 0, 0.2, 1, 50, 16],
    ] as Matrix[]) {
      const graph = compileEffectGraph(
        defineEffectGraph({
          kind: 'effect-graph',
          version: 1,
          name: 'roi',
          nodes: [
            type === 'texture'
              ? {
                  id: 'field',
                  type,
                  settings: { pattern: 'marble', seed: 4, warp: 0.5 },
                  region: { x: 0, y: 0, width: 16, height: 12 },
                }
              : { id: 'field', type, seed: 4, region: { x: 0, y: 0, width: 16, height: 12 } },
          ],
          output: 'field',
        }),
      );
      let bounded = 0,
        full = 0;
      const render = async (force: boolean) => {
        const out = await renderEffectGraph(graph, {
          ...env(matrix),
          fullFieldScan: force,
          evaluatedPixels: (n) => (force ? (full += n) : (bounded += n)),
          input: async () => make(),
        });
        try {
          return out.ctx.getImageData(0, 0, 64, 48).data;
        } finally {
          out.release();
        }
      };
      expect(await render(false)).toEqual(await render(true));
      expect(bounded).toBeLessThan(full / 3);
    }
  expect(
    pixelRegion([1, 0, 0, 1, 500, 500], { x: 0, y: 0, width: 10, height: 10 }, 64, 48).pixels,
  ).toBe(0);
});
it('uses map channels/midpoints/alpha and coordinate basis with byte-exact bounded/full displacement parity', async () => {
  const source = make(),
    map = make();
  source.ctx.fillStyle = '#ff4400';
  source.ctx.fillRect(18, 8, 14, 20);
  map.ctx.fillStyle = '#ff0000';
  map.ctx.fillRect(10, 10, 24, 20);
  const raw: EffectGraphInput = {
      kind: 'effect-graph',
      version: 1,
      name: 'mapped',
      nodes: [
        { id: 'source', type: 'input', slot: 'source' },
        { id: 'map', type: 'input', slot: 'map' },
        {
          id: 'warp',
          type: 'displace',
          input: 'source',
          map: 'map',
          amountX: 5,
          amountY: 0,
          channelX: 'red',
          space: 'canvas',
          midpointX: 0.5,
        },
      ],
      output: 'warp',
    },
    graph = compileEffectGraph(raw),
    render = async (full: boolean) => {
      const out = await renderEffectGraph(graph, {
        ...env([2, 0, 0, 2, 0, 0]),
        fullFieldScan: full,
        input: async (slot) => {
          const copy = make();
          copy.ctx.drawImage(slot === 'map' ? map.canvas : source.canvas, 0, 0);
          return copy;
        },
      });
      try {
        return out.ctx.getImageData(0, 0, 64, 48).data;
      } finally {
        out.release();
      }
    };
  const pixels = await render(false);
  expect(pixels).toEqual(await render(true));
  expect(pixels[(15 * 64 + 13) * 4 + 3]).toBe(255);
  expect(pixels[(15 * 64 + 18) * 4 + 3]).toBe(255);
  expect(pixels[(15 * 64 + 31) * 4 + 3]).toBe(0);
  source.release();
  map.release();
});
it('maps gradient luminance without changing alpha and keeps disabled intensity exactly identical', () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 100, 255, 255, 255, 200, 128, 128, 128, 255]),
    effect = effectSchema.parse({
      type: 'gradientMap',
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    }),
    mapped = applyPixelEffect(pixels, 3, 1, effect, { frame: 0, fps: 30 });
  expect([...mapped.slice(0, 4)]).toEqual([255, 0, 0, 100]);
  expect([...mapped.slice(4, 8)]).toEqual([0, 0, 255, 200]);
  expect(mapped[11]).toBe(255);
  expect(
    applyPixelEffect(pixels, 3, 1, { ...effect, intensity: 0 } as any, { frame: 0, fps: 30 }),
  ).toEqual(pixels);
});
it('adds visible transparent rays and thresholded multilevel bloom with explicit sample limits', () => {
  const source = make();
  source.ctx.fillStyle = '#ffffff';
  source.ctx.fillRect(30, 20, 3, 3);
  const pixels = source.ctx.getImageData(0, 0, 64, 48).data,
    rays = effectSchema.parse({
      type: 'radialRays',
      center: { x: 0.5, y: 0.5 },
      length: 1,
      threshold: 0,
      intensity: 2,
      samples: 12,
    }) as any,
    out = radialRaysPixels(pixels, 64, 48, rays, { bounds: { x: 0, y: 0, width: 64, height: 48 } });
  expect(out.filter((_, i) => i % 4 === 3 && out[i] > 0).length).toBeGreaterThan(9);
  expect(radialRaysPixels(pixels, 64, 48, { ...rays, intensity: 0 }, {})).toEqual(pixels);
  expect(() =>
    radialRaysPixels(new Uint8ClampedArray(4), 4096, 4096, { ...rays, samples: 64 }, {}),
  ).toThrow('256M');
  const bloom = rasterPass(
      source.canvas,
      effectSchema.parse({
        type: 'bloom',
        radius: 3,
        threshold: 0.5,
        intensity: 1,
        levels: 3,
      }) as any,
      env(),
    ),
    result = bloom.ctx.getImageData(0, 0, 64, 48).data;
  expect(result[(22 * 64 + 28) * 4 + 3]).toBeGreaterThan(0);
  expect(result[(21 * 64 + 31) * 4]).toBe(255);
  bloom.release();
  source.release();
});
it('compiles every reusable visual graph and exposes exact named map slots', () => {
  for (const name of visualPresetNames) {
    const graph = compileEffectGraph(visualPreset(name));
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.output).toBeTruthy();
  }
  expect(compileEffectGraph(visualPreset('layerDisplace')).inputs).toContain('map');
});
it('keeps bounded rays pixel-identical for off-centre transparent emitters and avoids unused canvas samples', () => {
  const source = make();
  source.ctx.fillStyle = '#ffaa77';
  source.ctx.globalAlpha = 0.6;
  source.ctx.fillRect(22, 16, 5, 4);
  const pixels = source.ctx.getImageData(0, 0, 64, 48).data;
  for (const length of [0.1, 0.6, 0.9])
    for (const center of [
      { x: 0.4, y: 0.4 },
      { x: -0.3, y: 0.8 },
      { x: 1.2, y: -0.5 },
    ]) {
      const effect = effectSchema.parse({
        type: 'radialRays',
        length,
        center,
        threshold: 0.3,
        samples: 8,
      }) as any;
      let a = 0,
        b = 0;
      const bounded = radialRaysPixels(pixels, 64, 48, effect, { work: (n) => (a += n) }),
        full = radialRaysPixels(pixels, 64, 48, effect, { fullScan: true, work: (n) => (b += n) });
      expect(bounded).toEqual(full);
      expect(a).toBeLessThanOrEqual(b);
    }
  source.release();
});
it('ink reveal has exact hidden/full endpoints for content inside its declared region', async () => {
  const source = make();
  source.ctx.fillStyle = '#ffffff';
  source.ctx.fillRect(0, 0, 16, 12);
  const pixels = source.ctx.getImageData(0, 0, 64, 48).data;
  for (const progress of [0, 1]) {
    const graph = compileEffectGraph(visualPreset('inkReveal'), { progress }),
      out = await renderEffectGraph(graph, {
        ...env(),
        input: async () => {
          const copy = make();
          copy.ctx.drawImage(source.canvas, 0, 0);
          return copy;
        },
      });
    try {
      const actual = out.ctx.getImageData(0, 0, 64, 48).data;
      if (progress === 0) expect(actual.every((v) => v === 0)).toBe(true);
      else expect(actual).toEqual(pixels);
    } finally {
      out.release();
    }
  }
  source.release();
});
