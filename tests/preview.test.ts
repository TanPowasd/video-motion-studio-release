import { it, expect } from 'vitest';
import { canPresentPreview } from '../src/editor/preview.js';
const req = { key: 'scene/rev/clock-1', frame: 30, playing: true, signature: '30' };
it('keeps advancing playback frames while rejecting stale versions, scopes, clocks and mismatched replies', () => {
  const current = { ...req, frame: 34, signature: '34' },
    reply = { revision: 'rev', frame: 30 };
  expect(canPresentPreview(req, current, reply, 'rev')).toBe(true);
  expect(canPresentPreview(req, { ...current, key: 'scene/rev/clock-2' }, reply, 'rev')).toBe(
    false,
  );
  expect(canPresentPreview(req, current, { ...reply, revision: 'old' }, 'rev')).toBe(false);
  expect(canPresentPreview(req, current, { ...reply, frame: 29 }, 'rev')).toBe(false);
});
it('rejects backward or excessively late frames during playback but accepts an explicit paused seek', () => {
  expect(
    canPresentPreview(
      req,
      { ...req, frame: 40, signature: '40' },
      { revision: 'rev', frame: 30 },
      'rev',
      { key: req.key, frame: 31 },
    ),
  ).toBe(false);
  expect(
    canPresentPreview(
      req,
      { ...req, frame: 100, signature: '100' },
      { revision: 'rev', frame: 30 },
      'rev',
    ),
  ).toBe(false);
  const seek = { ...req, playing: false };
  expect(
    canPresentPreview(seek, seek, { revision: 'rev', frame: 30 }, 'rev', {
      key: req.key,
      frame: 90,
    }),
  ).toBe(true);
});
