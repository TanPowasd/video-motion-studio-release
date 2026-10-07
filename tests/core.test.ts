import { describe, it, expect } from 'vitest';
import { mergeJson, mergeText } from '../src/core/merge.js';
import { frameSample, interpolate } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
import { newNode } from '../src/core/model.js';
describe('concurrent edits', () => {
  it('merges independent object fields and additions', () => {
    const base = { nodes: [{ id: 'a', x: 0, y: 0 }] };
    const ours = {
      nodes: [
        { id: 'a', x: 40, y: 0 },
        { id: 'b', x: 5 },
      ],
    };
    const theirs = {
      nodes: [
        { id: 'a', x: 0, y: 70 },
        { id: 'c', x: 9 },
      ],
    };
    const result = mergeJson(base, ours, theirs, 'scene.json');
    expect(result.conflicts).toEqual([]);
    expect(result.value).toEqual({
      nodes: [
        { id: 'a', x: 40, y: 70 },
        { id: 'b', x: 5 },
        { id: 'c', x: 9 },
      ],
    });
  });
  it('retains both values of a same-property conflict', () => {
    const result = mergeJson({ x: 0 }, { x: 40 }, { x: 70 }, 'scene.json');
    expect(result.conflicts[0]).toMatchObject({ path: '/x', base: 0, ours: 40, theirs: 70 });
    expect(result.value).toEqual({ x: 40 });
  });
  it('adopts a remote layer reorder', () => {
    const b = [
      { id: 'a', x: 0 },
      { id: 'b', x: 0 },
    ];
    const result = mergeJson(
      b,
      [
        { id: 'a', x: 2 },
        { id: 'b', x: 0 },
      ],
      [b[1], b[0]],
      'scene',
    );
    expect(result.value).toEqual([
      { id: 'b', x: 0 },
      { id: 'a', x: 2 },
    ]);
  });
  it('merges adjacent source-line edits and rejects overlapping ones', () => {
    expect(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n', 'c.ts')).toEqual({
      value: 'A\nB\nc\n',
      conflicts: [],
    });
    expect(mergeText('a\n', 'b\n', 'c\n', 'c.ts').conflicts).toHaveLength(1);
  });
});
describe('frame evaluation', () => {
  it('maps fractional frame rates without accumulating drift', () => {
    expect(frameSample(215784, { num: 30000, den: 1001 })).toBe(345599654);
  });
  it('evaluates frames in arbitrary order with native/SDK parity', async () => {
    const native = new NativeEvaluator();
    try {
      for (const easing of [
        'linear',
        'easeIn',
        'easeOut',
        'easeInOut',
        'hold',
        'spring',
      ] as const) {
        const keys = [
          { frame: 0, value: 5, easing },
          { frame: 60, value: 105, easing: 'linear' as const },
        ];
        const n = newNode({ id: 'animated', type: 'rect', animations: [{ property: 'x', keys }] });
        for (const frame of [59, 0, 30, 60, 12]) {
          const result = await native.evaluate([n], frame);
          expect(result[0].x).toBeCloseTo(interpolate(keys, frame), 8);
        }
      }
    } finally {
      native.close();
    }
  });
});
