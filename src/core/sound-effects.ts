import type { SoundEffect } from './sound-schema.js';
import { VmotionError } from './model.js';
export const SOUND_RATE = 48000;
export const dbGain = (db: number) => 10 ** (db / 20);
export type StereoBlock = { left: Float64Array; right: Float64Array };
type Processor = (block: StereoBlock, start: number) => void;
function biquad(e: Extract<SoundEffect, { type: 'filter' }>): Processor {
  const w = (2 * Math.PI * e.frequency) / SOUND_RATE,
    c = Math.cos(w),
    s = Math.sin(w),
    a = s / (2 * e.q),
    A = 10 ** (e.db / 40),
    shelf = 2 * Math.sqrt(A) * a;
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (e.mode === 'lowpass') {
    b0 = (1 - c) / 2;
    b1 = 1 - c;
    b2 = b0;
    a0 = 1 + a;
    a1 = -2 * c;
    a2 = 1 - a;
  } else if (e.mode === 'highpass') {
    b0 = (1 + c) / 2;
    b1 = -(1 + c);
    b2 = b0;
    a0 = 1 + a;
    a1 = -2 * c;
    a2 = 1 - a;
  } else if (e.mode === 'peaking') {
    b0 = 1 + a * A;
    b1 = -2 * c;
    b2 = 1 - a * A;
    a0 = 1 + a / A;
    a1 = -2 * c;
    a2 = 1 - a / A;
  } else if (e.mode === 'lowshelf') {
    b0 = A * (A + 1 - (A - 1) * c + shelf);
    b1 = 2 * A * (A - 1 - (A + 1) * c);
    b2 = A * (A + 1 - (A - 1) * c - shelf);
    a0 = A + 1 + (A - 1) * c + shelf;
    a1 = -2 * (A - 1 + (A + 1) * c);
    a2 = A + 1 + (A - 1) * c - shelf;
  } else {
    b0 = A * (A + 1 + (A - 1) * c + shelf);
    b1 = -2 * A * (A - 1 + (A + 1) * c);
    b2 = A * (A + 1 + (A - 1) * c - shelf);
    a0 = A + 1 - (A - 1) * c + shelf;
    a1 = 2 * (A - 1 - (A + 1) * c);
    a2 = A + 1 - (A - 1) * c - shelf;
  }
  const B0 = b0 / a0,
    B1 = b1 / a0,
    B2 = b2 / a0,
    A1 = a1 / a0,
    A2 = a2 / a0,
    state = [
      [0, 0],
      [0, 0],
    ];
  return (block) => {
    for (const [ch, values] of [block.left, block.right].entries()) {
      let [z1, z2] = state[ch];
      for (let i = 0; i < values.length; i++) {
        const x = values[i],
          y = B0 * x + z1;
        z1 = B1 * x - A1 * y + z2;
        z2 = B2 * x - A2 * y;
        values[i] = y;
      }
      state[ch] = [z1, z2];
    }
  };
}
function delay(e: Extract<SoundEffect, { type: 'delay' }>): Processor {
  const rings = [
      new Float64Array(Math.max(1, Math.round(e.seconds * SOUND_RATE))),
      new Float64Array(Math.max(1, Math.round((e.rightSeconds ?? e.seconds) * SOUND_RATE))),
    ],
    positions = [0, 0];
  return (block) => {
    for (const [ch, values] of [block.left, block.right].entries()) {
      const ring = rings[ch];
      let p = positions[ch];
      for (let i = 0; i < values.length; i++) {
        const x = values[i],
          wet = ring[p];
        ring[p] = x + wet * e.feedback;
        values[i] = x * (1 - e.mix) + wet * e.mix;
        p = (p + 1) % ring.length;
      }
      positions[ch] = p;
    }
  };
}
function chorus(e: Extract<SoundEffect, { type: 'chorus' }>): Processor {
  const size = Math.ceil((e.delay + e.depth) * SOUND_RATE) + 2,
    rings = [new Float64Array(size), new Float64Array(size)];
  let p = 0;
  return (block, start) => {
    for (let i = 0; i < block.left.length; i++) {
      for (const [ch, values] of [block.left, block.right].entries()) {
        const ring = rings[ch],
          x = values[i];
        ring[p] = x;
        const back =
            (e.delay +
              e.depth *
                Math.sin((2 * Math.PI * e.rate * (start + i)) / SOUND_RATE + (ch * Math.PI) / 2)) *
            SOUND_RATE,
          at = (p - back + size * 2) % size,
          a = Math.floor(at),
          t = at - a,
          wet = ring[a] * (1 - t) + ring[(a + 1) % size] * t;
        values[i] = x * (1 - e.mix) + wet * e.mix;
      }
      p = (p + 1) % size;
    }
  };
}
function reverb(e: Extract<SoundEffect, { type: 'reverb' }>): Processor {
  // Parallel damped combs followed by two allpasses, decorrelated per channel.
  const channels = Array.from({ length: 2 }, (_, ch) => ({
    combs: [1493, 1601, 1747, 1867].map((length) => ({
      ring: new Float64Array(length + ch * 23),
      p: 0,
      low: 0,
      feedback: 10 ** ((-3 * (length + ch * 23)) / (SOUND_RATE * e.seconds)),
    })),
    passes: [211, 443].map((length) => ({ ring: new Float64Array(length + ch * 13), p: 0 })),
  }));
  return (block) => {
    for (const [ch, values] of [block.left, block.right].entries()) {
      const state = channels[ch];
      for (let i = 0; i < values.length; i++) {
        const x = values[i];
        let wet = 0;
        for (const comb of state.combs) {
          const y = comb.ring[comb.p];
          comb.low = y * (1 - e.damping) + comb.low * e.damping;
          comb.ring[comb.p] = x + comb.low * comb.feedback;
          comb.p = (comb.p + 1) % comb.ring.length;
          wet += y * 0.25;
        }
        for (const pass of state.passes) {
          const y = pass.ring[pass.p],
            out = y - wet * 0.5;
          pass.ring[pass.p] = wet + out * 0.5;
          pass.p = (pass.p + 1) % pass.ring.length;
          wet = out;
        }
        values[i] = x * (1 - e.mix) + wet * e.mix;
      }
    }
  };
}
function compressor(e: Extract<SoundEffect, { type: 'compressor' }>): Processor {
  const attack = Math.exp(-1 / (e.attack * SOUND_RATE)),
    release = Math.exp(-1 / (e.release * SOUND_RATE)),
    makeup = dbGain(e.makeupDb);
  let reduction = 0;
  return (block) => {
    for (let i = 0; i < block.left.length; i++) {
      const peak = Math.max(Math.abs(block.left[i]), Math.abs(block.right[i]), 1e-12),
        over = 20 * Math.log10(peak) - e.thresholdDb,
        k = e.kneeDb,
        target =
          over < -k / 2
            ? 0
            : over > k / 2
              ? (1 - 1 / e.ratio) * over
              : ((1 - 1 / e.ratio) * (over + k / 2) ** 2) / (2 * Math.max(k, 1e-12)),
        coeff = target > reduction ? attack : release;
      reduction = target + (reduction - target) * coeff;
      const gain = dbGain(-reduction) * makeup;
      block.left[i] *= gain;
      block.right[i] *= gain;
    }
  };
}
function limiter(e: Extract<SoundEffect, { type: 'limiter' }>): Processor {
  const ceiling = dbGain(e.ceilingDb),
    release = Math.exp(-1 / (e.release * SOUND_RATE));
  let gain = 1;
  return (block) => {
    for (let i = 0; i < block.left.length; i++) {
      const peak = Math.max(Math.abs(block.left[i]), Math.abs(block.right[i])),
        target = peak > ceiling ? ceiling / peak : 1;
      gain = target < gain ? target : target + (gain - target) * release;
      block.left[i] *= gain;
      block.right[i] *= gain;
    }
  };
}
export function soundEffects(effects: SoundEffect[]): Processor {
  const list = effects.map((e): Processor => {
    switch (e.type) {
      case 'plugin':
        throw new VmotionError(
          'AUDIO_PLUGIN_HOST',
          'External effects require the asynchronous audio plugin host',
        );
      case 'gain': {
        const gain = dbGain(e.db);
        return (block) => {
          for (const values of [block.left, block.right])
            for (let i = 0; i < values.length; i++) values[i] *= gain;
        };
      }
      case 'filter':
        return biquad(e);
      case 'delay':
        return delay(e);
      case 'chorus':
        return chorus(e);
      case 'reverb':
        return reverb(e);
      case 'compressor':
        return compressor(e);
      case 'limiter':
        return limiter(e);
      case 'distortion': {
        const norm = Math.tanh(e.drive);
        return (block) => {
          for (const values of [block.left, block.right])
            for (let i = 0; i < values.length; i++)
              values[i] = values[i] * (1 - e.mix) + (Math.tanh(values[i] * e.drive) / norm) * e.mix;
        };
      }
    }
  });
  return (block, start) => {
    for (const process of list) process(block, start);
  };
}
export function panBlock(block: StereoBlock, gain: number, pan: number) {
  // Stereo balance: preserve centre level; attenuate the opposite side.
  const l = gain * (pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1),
    r = gain * (pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1);
  for (let i = 0; i < block.left.length; i++) {
    block.left[i] *= l;
    block.right[i] *= r;
  }
}
