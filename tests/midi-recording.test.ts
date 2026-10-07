import { it, expect } from 'vitest';
import { MidiRecorder, parseMidi } from '../src/editor/music/midi.js';
it('records velocity, overlapping notes and sustain using supplied clock, quantization and score bounds', () => {
  let id = 0;
  const recorder = new MidiRecorder(
    (ms) => ms / 500,
    4,
    0.25,
    () => String(++id),
  );
  recorder.feed({ status: 144, a: 60, b: 100, timestamp: 40 });
  recorder.feed({ status: 144, a: 60, b: 80, timestamp: 140 });
  recorder.feed({ status: 176, a: 64, b: 127, timestamp: 180 });
  recorder.feed({ status: 128, a: 60, b: 0, timestamp: 200 });
  recorder.feed({ status: 128, a: 60, b: 0, timestamp: 250 });
  expect(recorder.notes).toHaveLength(0);
  recorder.feed({ status: 176, a: 64, b: 0, timestamp: 500 });
  expect(recorder.notes).toHaveLength(2);
  expect(recorder.notes.map((n) => n.at).sort()).toEqual([0, 0.25]);
  expect(recorder.notes.find((n) => n.id === '1')!.velocity).toBe(100 / 127);
  recorder.feed({ status: 144, a: 72, b: 90, timestamp: 1800 });
  recorder.stop(2500);
  expect(recorder.notes.at(-1)!.at + recorder.notes.at(-1)!.duration).toBeLessThanOrEqual(4);
});
it('accepts zero-velocity note off and panic, filters invalid/system MIDI and preserves deterministic timestamps', () => {
  const recorder = new MidiRecorder(
    (ms) => ms / 1000,
    2,
    0,
    () => 'note',
  );
  recorder.feed(parseMidi([144, 69, 100], 100)!);
  recorder.feed(parseMidi([144, 69, 0], 600)!);
  expect(recorder.notes[0].duration).toBe(0.5);
  expect(parseMidi([240, 1, 2], 10)).toBeUndefined();
  expect(parseMidi([144, 200, 1], 10)).toBeUndefined();
  recorder.feed(parseMidi([144, 70, 90], 1000)!);
  recorder.feed(parseMidi([176, 123, 0], 1300)!);
  expect(recorder.notes).toHaveLength(2);
});
