import { it, expect } from 'vitest';
import { sequenceSchema } from '../src/core/model.js';
import { compileAudioMix, SequenceMixRenderer } from '../src/core/audio-mix.js';
const fps = { num: 30, den: 1 };
const seq = (mix: unknown = {}) =>
  sequenceSchema.parse({
    id: 'main',
    name: 'mix',
    duration: 120,
    tracks: [
      { id: 'background', name: 'BG', type: 'audio', clips: [] },
      { id: 'voice', name: 'Voice', type: 'audio', clips: [] },
    ],
    mix,
  });
it('solves sidechain dependencies before routing and ducks only the target signal with bounded attack/release', () => {
  const s = seq({
      tracks: {
        background: {
          ducking: {
            source: { type: 'track', id: 'voice' },
            thresholdDb: -20,
            ratio: 4,
            kneeDb: 0,
            attack: 0.001,
            release: 0.02,
            maxReductionDb: 24,
          },
        },
      },
    }),
    r = new SequenceMixRenderer(s, fps);
  expect(r.compiled.order.indexOf('track:voice')).toBeLessThan(
    r.compiled.order.indexOf('track:background'),
  );
  const render = (voice: number) =>
    r.process(
      new Map([
        [
          'background',
          { left: new Float64Array(4800).fill(1), right: new Float64Array(4800).fill(0.5) },
        ],
        [
          'voice',
          { left: new Float64Array(4800).fill(voice), right: new Float64Array(4800).fill(voice) },
        ],
      ]),
      4800,
    );
  const on = render(1),
    off = render(0),
    bg = on.nodes.get('track:background')!;
  expect(bg.left[4799]).toBeCloseTo(10 ** (-15 / 20));
  expect(bg.right[4799] / bg.left[4799]).toBe(0.5);
  expect(off.nodes.get('track:background')!.left[4799]).toBeGreaterThan(0.98);
  expect(on.nodes.get('track:voice')!.left[4799]).toBe(1);
});
it('mixes post-fader sends and held/linear automation in seconds without multiplying root opacity equivalents', () => {
  const s = seq({
      tracks: {
        background: {
          gainDb: -6,
          busId: 'music',
          sends: [{ busId: 'room', db: -6 }],
          automation: [
            {
              property: 'gainDb',
              keys: [
                { at: 0, value: -6 },
                { at: 0.1, value: 0, easing: 'hold' },
              ],
            },
          ],
        },
      },
      buses: [{ id: 'music' }, { id: 'room', gainDb: -6 }],
    }),
    r = new SequenceMixRenderer(s, fps),
    out = r.process(
      new Map([
        [
          'background',
          { left: new Float64Array(4800).fill(0.1), right: new Float64Array(4800).fill(0.1) },
        ],
      ]),
      4800,
    );
  const first = 0.1 * 10 ** (-6 / 20),
    send = first * 10 ** (-12 / 20);
  expect(out.master.left[0]).toBeCloseTo(first + send);
  expect(out.master.left[4799]).toBeGreaterThan(out.master.left[0]);
});
it('rejects sidechain feedback cycles, missing targets and invalid automation before processing', () => {
  expect(() =>
    compileAudioMix(
      seq({
        tracks: {
          background: { busId: 'music', ducking: { source: { type: 'bus', id: 'music' } } },
        },
        buses: [{ id: 'music' }],
      }),
      fps,
    ),
  ).toThrow('cycle');
  expect(() =>
    compileAudioMix(
      seq({ tracks: { background: { ducking: { source: { type: 'track', id: 'absent' } } } } }),
      fps,
    ),
  ).toThrow('Missing');
  expect(() => compileAudioMix(seq({ tracks: { absent: { gainDb: 0 } } }), fps)).toThrow('missing');
  expect(() =>
    compileAudioMix(
      seq({
        tracks: {
          voice: {
            automation: [
              {
                property: 'pan',
                keys: [
                  { at: 0, value: 0 },
                  { at: 1, value: 2 },
                ],
              },
            ],
          },
        },
      }),
      fps,
    ),
  ).toThrow('bounded');
});
it('retains effect/ducking state for arbitrary sequential partitions and supports reserved-looking track IDs safely', () => {
  const s = seq({
    tracks: {
      background: {
        effects: [{ type: 'delay', seconds: 0.01, mix: 0.3, feedback: 0.3 }],
        ducking: {
          source: { type: 'track', id: 'voice' },
          thresholdDb: -18,
          ratio: 3,
          attack: 0.02,
          release: 0.08,
        },
      },
    },
  });
  const render = (size: number) => {
    const r = new SequenceMixRenderer(s, fps),
      values = new Float64Array(12000);
    while (r.position < values.length) {
      const start = r.position,
        count = Math.min(size, values.length - start),
        left = Float64Array.from({ length: count }, (_, i) => Math.sin((start + i) / 100)),
        voice = Float64Array.from({ length: count }, (_, i) => (start + i < 6000 ? 0.8 : 0)),
        out = r.process(
          new Map([
            ['background', { left, right: left }],
            ['voice', { left: voice, right: voice }],
          ]),
          count,
        );
      values.set(out.master.left, start);
    }
    return values;
  };
  expect(render(4096)).toEqual(render(997));
  const special = sequenceSchema.parse({
    id: 'main',
    name: 'mix',
    duration: 30,
    tracks: [{ id: 'constructor', name: 'test', type: 'audio', clips: [] }],
    mix: {},
  });
  expect(compileAudioMix(special, fps).nodes.get('track:constructor')!.config.gainDb).toBe(0);
});
