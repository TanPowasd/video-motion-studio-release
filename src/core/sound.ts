import {
  createSoundChain,
  applySoundChain,
  type PluginAudioRequest,
  type PluginAudioProcessor,
} from './sound-plugin-pipeline.js';
import { VmotionError } from './model.js';
import { expandSoundTracks } from './sound-patterns.js';
import {
  soundDocumentSchema,
  type SoundDocument,
  type SoundInput,
  type SoundInstrument,
  type SoundEffect,
} from './sound-schema.js';
import { SOUND_RATE, dbGain, soundEffects, panBlock, type StereoBlock } from './sound-effects.js';
export { SOUND_RATE } from './sound-effects.js';
export { soundDocumentSchema } from './sound-schema.js';
export type { SoundDocument, SoundInput, SoundInstrument, SoundEffect } from './sound-schema.js';
export function noteNumber(note: number | string): number {
  if (typeof note === 'number') {
    if (!Number.isFinite(note) || note < 0 || note > 127)
      throw new VmotionError('SOUND_NOTE', 'Use finite MIDI 0–127', { note });
    return note;
  }
  const m = /^([A-Ga-g])(#|b)?(-?\d{1,2})$/.exec(note);
  if (!m)
    throw new VmotionError('SOUND_NOTE', 'Use MIDI 0–127 or a note such as C4, F#3, Bb2', { note });
  const value =
    (Number(m[3]) + 1) * 12 +
    ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] ?? 0) +
    (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  if (value < 0 || value > 127)
    throw new VmotionError('SOUND_NOTE', 'Note lies outside MIDI 0–127', { note });
  return value;
}
export const noteFrequency = (note: number | string) => 440 * 2 ** ((noteNumber(note) - 69) / 12);
function preceding<T>(list: T[], value: number, time: (v: T) => number) {
  let low = 0,
    high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (time(list[mid]) <= value) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
export function tempoClock(raw: SoundDocument['tempo']) {
  if (
    !raw.length ||
    raw[0].beat !== 0 ||
    raw.some(
      (t, i) =>
        !Number.isFinite(t.beat) ||
        t.bpm < 20 ||
        t.bpm > 400 ||
        (i > 0 && t.beat <= raw[i - 1].beat),
    )
  )
    throw new VmotionError('SOUND_TEMPO', 'Tempo starts at beat zero and must increase strictly');
  const segments = raw.map((t, i) => ({ ...t, seconds: 0 }));
  for (let i = 1; i < segments.length; i++)
    segments[i].seconds =
      segments[i - 1].seconds +
      ((segments[i].beat - segments[i - 1].beat) * 60) / segments[i - 1].bpm;
  return {
    beatSeconds(beat: number) {
      const t =
        segments[
          Math.max(
            0,
            preceding(segments, beat, (t) => t.beat),
          )
        ];
      return t.seconds + ((beat - t.beat) * 60) / t.bpm;
    },
    secondsBeat(seconds: number) {
      const t =
        segments[
          Math.max(
            0,
            preceding(segments, seconds, (t) => t.seconds),
          )
        ];
      return t.beat + ((seconds - t.seconds) * t.bpm) / 60;
    },
    segments,
  };
}
export const soundPresets: Record<string, SoundInstrument> = {
  sine: {
    type: 'synth',
    wave: 'sine',
    gain: 0.3,
    attack: 0.008,
    decay: 0.15,
    sustain: 0.6,
    release: 0.2,
    fmRatio: 0,
    fmIndex: 0,
    detune: 0,
  },
  pad: {
    type: 'synth',
    wave: 'triangle',
    gain: 0.25,
    attack: 0.3,
    decay: 0.3,
    sustain: 0.7,
    release: 1,
    fmRatio: 2,
    fmIndex: 0.4,
    detune: 0,
  },
  bass: {
    type: 'synth',
    wave: 'saw',
    gain: 0.22,
    attack: 0.006,
    decay: 0.13,
    sustain: 0.45,
    release: 0.08,
    fmRatio: 0,
    fmIndex: 0,
    detune: 0,
  },
  bell: {
    type: 'synth',
    wave: 'sine',
    gain: 0.3,
    attack: 0.003,
    decay: 0.8,
    sustain: 0.05,
    release: 0.7,
    fmRatio: 2.76,
    fmIndex: 2.2,
    detune: 0,
  },
  pluck: {
    type: 'synth',
    wave: 'triangle',
    gain: 0.35,
    attack: 0.002,
    decay: 0.2,
    sustain: 0.08,
    release: 0.15,
    fmRatio: 2,
    fmIndex: 0.6,
    detune: 0,
  },
  noise: {
    type: 'synth',
    wave: 'noise',
    gain: 0.3,
    attack: 0.1,
    decay: 0.2,
    sustain: 0.8,
    release: 0.15,
    fmRatio: 0,
    fmIndex: 0,
    detune: 0,
  },
  kick: { type: 'drum', voice: 'kick', gain: 0.65, release: 0.35 },
  snare: { type: 'drum', voice: 'snare', gain: 0.35, release: 0.18 },
  hat: { type: 'drum', voice: 'hat', gain: 0.18, release: 0.05 },
  tom: { type: 'drum', voice: 'tom', gain: 0.45, release: 0.3 },
  clap: { type: 'drum', voice: 'clap', gain: 0.3, release: 0.18 },
};
export function soundPreset(name: string, patch: Partial<SoundInstrument> = {}): SoundInstrument {
  if (!Object.hasOwn(soundPresets, name))
    throw new VmotionError('SOUND_PRESET', 'Unknown sound preset', {
      name,
      available: Object.keys(soundPresets),
    });
  return { ...soundPresets[name], ...patch } as SoundInstrument;
}
export function compileSound(raw: SoundInput | unknown) {
  const document = soundDocumentSchema.parse(raw),
    clock = tempoClock(document.tempo),
    toSeconds = (at: number) => (document.unit === 'beats' ? clock.beatSeconds(at) : at),
    duration = toSeconds(document.duration) + document.tail,
    sampleCount = Math.ceil(duration * SOUND_RATE),
    busIds = new Set(document.buses.map((b) => b.id)),
    ids = [...document.tracks.map((t) => t.id), ...busIds];
  const external = [
    ...document.tracks.flatMap((t) => [
      ...(t.instrument.type === 'plugin' ? [t.instrument] : []),
      ...t.effects.filter((e) => e.type === 'plugin'),
    ]),
    ...document.buses.flatMap((b) => b.effects.filter((e) => e.type === 'plugin')),
    ...document.master.effects.filter((e) => e.type === 'plugin'),
  ];
  if (
    external.length > 32 ||
    external.reduce(
      (size, p) => size + (p.state?.length ?? 0) + (p.controllerState?.length ?? 0),
      0,
    ) >
      4 * 1024 * 1024
  )
    throw new VmotionError(
      'AUDIO_PLUGIN_BUDGET',
      'A score supports at most 32 external instances and 4 MiB of encoded state',
    );
  for (const pattern of document.patterns ?? [])
    for (const channel of pattern.channels)
      for (const event of channel.events) {
        noteNumber(event.note);
        if (event.endNote !== undefined) noteNumber(event.endNote);
      }
  if (duration > 1800)
    throw new VmotionError(
      'SOUND_BUDGET',
      'A sound document is limited to 30 minutes; use multiple timeline assets for longer films',
    );
  if (new Set(ids).size !== ids.length || document.buses.some((b) => b.id === 'master'))
    throw new VmotionError('SOUND_ID', 'Track and bus IDs must be unique; master is reserved');
  if (busIds.size !== document.buses.length)
    throw new VmotionError('SOUND_ID', 'Duplicate bus IDs');
  const targets = (v: { busId: string; sends: { busId: string }[] }) => [
    v.busId,
    ...v.sends.map((s) => s.busId),
  ];
  for (const v of [...document.tracks, ...document.buses]) {
    for (const id of targets(v))
      if (id !== 'master' && !busIds.has(id))
        throw new VmotionError('SOUND_BUS', 'Missing destination bus', {
          ownerId: v.id,
          busId: id,
        });
    if (new Set(v.sends.map((s) => s.busId)).size !== v.sends.length)
      throw new VmotionError('SOUND_BUS', 'Duplicate sends', { ownerId: v.id });
  }
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    order: string[] = [];
  function visit(id: string) {
    if (id === 'master' || visited.has(id)) return;
    if (visiting.has(id))
      throw new VmotionError('SOUND_BUS_CYCLE', 'Audio bus cycle', { busId: id });
    visiting.add(id);
    const b = document.buses.find((b) => b.id === id)!;
    for (const t of targets(b)) visit(t);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const b of document.buses) visit(b.id);
  order.reverse();
  const solo = document.tracks.some((t) => t.solo && !t.muted);
  const effects = [
    ...document.tracks.flatMap((t) => t.effects),
    ...document.buses.flatMap((b) => b.effects),
    ...document.master.effects,
  ];
  const effectBytes = effects.reduce(
    (sum, e) =>
      sum +
      (e.type === 'delay'
        ? (e.seconds + (e.rightSeconds ?? e.seconds)) * SOUND_RATE * 8
        : e.type === 'chorus'
          ? (e.delay + e.depth) * SOUND_RATE * 16
          : e.type === 'reverb'
            ? 140000
            : 64),
    0,
  );
  if (effectBytes > 64 * 1024 * 1024)
    throw new VmotionError('SOUND_BUDGET', 'Audio effect state exceeds 64 MB', { effectBytes });
  let work =
      sampleCount *
      (document.tracks.length +
        document.buses.length +
        1 +
        effects.reduce(
          (sum, e) => sum + (e.type === 'reverb' ? 12 : e.type === 'chorus' ? 4 : 1),
          0,
        )),
    eventCount = 0;
  const tracks = expandSoundTracks(document).map((track) => {
    if (new Set(track.events.map((e) => e.id)).size !== track.events.length)
      throw new VmotionError('SOUND_ID', 'Duplicate event IDs', { trackId: track.id });
    if (new Set(track.automation.map((a) => a.property)).size !== track.automation.length)
      throw new VmotionError('SOUND_AUTOMATION', 'Duplicate automation channels', {
        trackId: track.id,
      });
    const automation = track.automation.map((a) => {
      if (
        a.keys.some(
          (k, i) =>
            k.at > document.duration ||
            (i > 0 && k.at <= a.keys[i - 1].at) ||
            k.value < (a.property === 'pan' ? -1 : -80) ||
            k.value > (a.property === 'pan' ? 1 : 24),
        )
      )
        throw new VmotionError(
          'SOUND_AUTOMATION',
          'Automation times must increase, remain in the score and use valid gain/pan values',
          { trackId: track.id, property: a.property },
        );
      return { ...a, keys: a.keys.map((k) => ({ ...k, seconds: toSeconds(k.at) })) };
    });
    const events = track.events
      .map((event) => {
        if (event.at + event.duration > document.duration + 1e-8)
          throw new VmotionError('SOUND_RANGE', 'Event extends beyond the declared score', {
            trackId: track.id,
            eventId: event.id,
          });
        const start = Math.round(toSeconds(event.at) * SOUND_RATE),
          gate = toSeconds(event.at + event.duration) - toSeconds(event.at),
          release = track.instrument.release,
          end = Math.min(
            sampleCount,
            Math.ceil((start / SOUND_RATE + gate + release) * SOUND_RATE),
          ),
          note = noteNumber(event.note),
          endNote = event.endNote === undefined ? note : noteNumber(event.endNote);
        if (
          track.instrument.type === 'plugin' &&
          (note !== Math.round(note) || endNote !== note || event.pan !== 0)
        )
          throw new VmotionError(
            'AUDIO_PLUGIN_NOTE',
            'External instruments use integer MIDI notes; sweeps and per-note pan need plugin/MIDI expression support',
          );
        let sampleWork = 1;
        if (track.instrument.type === 'sample') {
          const root = noteNumber(track.instrument.rootNote),
            ratio = 2 ** ((Math.max(note, endNote) - root) / 12),
            minimum = 2 ** ((Math.min(note, endNote) - root) / 12);
          if (ratio > 16 || minimum < 1 / 16)
            throw new VmotionError(
              'SOUND_SAMPLE_PITCH',
              'Sample pitch must stay within four octaves of rootNote',
              { trackId: track.id, eventId: event.id },
            );
          sampleWork = Math.ceil((16 * Math.max(1, ratio)) / 0.95);
        }
        work += (end - start) * sampleWork;
        eventCount++;
        return {
          ...event,
          start,
          end,
          gate,
          note,
          endNote,
          seed: stringSeed(`${document.seed}:${track.id}:${event.id}`),
        };
      })
      .sort((a, b) => a.start - b.start);
    const ends: number[] = [];
    let maxVoices = 0;
    for (const e of events) {
      for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= e.start) ends.splice(i, 1);
      ends.push(e.end);
      maxVoices = Math.max(maxVoices, ends.length);
    }
    if (maxVoices > 256)
      throw new VmotionError('SOUND_POLYPHONY', 'A track exceeds 256 simultaneous voices', {
        trackId: track.id,
        maxVoices,
      });
    return { track, events, automation, enabled: !track.muted && (!solo || track.solo), maxVoices };
  });
  if (eventCount > 20000 || work > 2_000_000_000)
    throw new VmotionError('SOUND_BUDGET', 'Sound work exceeds the explicit event/sample budget', {
      eventCount,
      estimatedWork: work,
    });
  return {
    document,
    clock,
    toSeconds,
    duration,
    sampleCount,
    tracks,
    busOrder: order,
    eventCount,
    estimatedWork: work,
  };
}
export function stringSeed(value: string) {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i++) seed = Math.imul(seed ^ value.charCodeAt(i), 16777619);
  return seed >>> 0;
}
function noise(seed: number, index: number) {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 2147483648 - 1;
}
function blep(t: number, dt: number) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}
function oscillator(wave: string, cycles: number, frequency: number, seed: number, index: number) {
  const phase = ((cycles % 1) + 1) % 1,
    dt = Math.min(0.49, frequency / SOUND_RATE);
  if (wave === 'noise') return noise(seed, index);
  if (wave === 'saw') return 2 * phase - 1 - blep(phase, dt);
  if (wave === 'square')
    return (phase < 0.5 ? 1 : -1) + blep(phase, dt) - blep((phase + 0.5) % 1, dt);
  if (wave === 'triangle') return 1 - 4 * Math.abs(phase - 0.5);
  return Math.sin(2 * Math.PI * cycles);
}
function envelope(
  t: number,
  gate: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
) {
  const on = (at: number) =>
    at < attack
      ? at / Math.max(attack, 1 / SOUND_RATE)
      : at < attack + decay
        ? 1 - ((1 - sustain) * (at - attack)) / Math.max(decay, 1 / SOUND_RATE)
        : sustain;
  return t < gate ? on(t) : release ? on(gate) * Math.max(0, 1 - (t - gate) / release) : 0;
}
export type SoundSample =
  | { left: Float32Array; right: Float32Array }
  | { length: number; read: (index: number, channel: 0 | 1) => number };
function sampleKernel(ratio: number) {
  const cutoff = 0.95 * Math.min(1, 1 / ratio),
    half = Math.ceil(8 / cutoff),
    taps = half * 2,
    phases = 256,
    weights = new Float64Array(taps * phases);
  for (let p = 0; p < phases; p++) {
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - p / phases,
        u = x * cutoff,
        w =
          Math.abs(x) < half
            ? (Math.abs(u) < 1e-12 ? cutoff : Math.sin(Math.PI * u) / (Math.PI * x)) *
              (0.5 + 0.5 * Math.cos((Math.PI * x) / half))
            : 0;
      weights[p * taps + k] = w;
      sum += w;
    }
    for (let k = 0; k < taps; k++) weights[p * taps + k] /= sum;
  }
  return { half, taps, weights };
}
export class SoundRenderer {
  readonly compiled: ReturnType<typeof compileSound>;
  position = 0;
  private tracks: Array<{
    compiled: ReturnType<typeof compileSound>['tracks'][number];
    effects: ReturnType<typeof createSoundChain>;
    cursor: number;
    active: ReturnType<typeof compileSound>['tracks'][number]['events'];
  }>;
  private buses: Map<
    string,
    { bus: SoundDocument['buses'][number]; effects: ReturnType<typeof createSoundChain> }
  >;
  private master: ReturnType<typeof createSoundChain>;
  private kernels = new Map<string, ReturnType<typeof sampleKernel>>();
  constructor(
    raw: SoundInput | unknown,
    private samples: Map<string, SoundSample> = new Map(),
  ) {
    this.compiled = compileSound(raw);
    this.tracks = this.compiled.tracks.map((compiled) => ({
      compiled,
      effects: createSoundChain(compiled.track.effects, `track:${compiled.track.id}`),
      cursor: 0,
      active: [],
    }));
    this.buses = new Map(
      this.compiled.document.buses.map((bus) => [
        bus.id,
        { bus, effects: createSoundChain(bus.effects, `bus:${bus.id}`) },
      ]),
    );
    this.master = createSoundChain(this.compiled.document.master.effects, 'master');
    for (const { track, enabled } of this.compiled.tracks)
      if (enabled && track.instrument.type === 'sample' && !samples.has(track.id))
        throw new VmotionError('SOUND_SAMPLE', 'Decoded sample is missing', {
          trackId: track.id,
          assetId: track.instrument.assetId,
        });
  }
  process(count: number): StereoBlock {
    const iterator = this.generate(count);
    let step = iterator.next();
    if (!step.done)
      throw new VmotionError('AUDIO_PLUGIN_HOST', 'External audio plugins require processAsync');
    return step.value;
  }
  async processAsync(count: number, process: PluginAudioProcessor): Promise<StereoBlock> {
    const iterator = this.generate(count);
    let step = iterator.next();
    while (!step.done) step = iterator.next(await process(step.value));
    return step.value;
  }
  private *generate(count: number): Generator<PluginAudioRequest, StereoBlock, StereoBlock> {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 16384 ||
      this.position + count > this.compiled.sampleCount
    )
      throw new VmotionError(
        'SOUND_RANGE',
        'Process a bounded sequential sound block within its duration',
      );
    const empty = (): StereoBlock => ({
        left: new Float64Array(count),
        right: new Float64Array(count),
      }),
      buffers = new Map<string, StereoBlock>([
        ['master', empty()],
        ...this.compiled.busOrder.map((id) => [id, empty()] as [string, StereoBlock]),
      ]),
      start = this.position,
      end = start + count;
    const add = (source: StereoBlock, id: string, gain = 1) => {
      const to = buffers.get(id)!;
      for (let i = 0; i < count; i++) {
        to.left[i] += source.left[i] * gain;
        to.right[i] += source.right[i] * gain;
      }
    };
    const route = (
      block: StereoBlock,
      v: { busId: string; sends: { busId: string; db: number }[] },
    ) => {
      add(block, v.busId);
      for (const send of v.sends) add(block, send.busId, dbGain(send.db));
    };
    for (const state of this.tracks) {
      const { track, events, enabled, automation } = state.compiled;
      if (!enabled) continue;
      state.active = state.active.filter((e) => e.end > start);
      while (state.cursor < events.length && events[state.cursor].start < end)
        state.active.push(events[state.cursor++]);
      let block = empty();
      const instrument = track.instrument;
      if (instrument.type === 'plugin')
        block = yield {
          key: `track:${track.id}:instrument`,
          config: instrument,
          kind: 'instrument',
          block,
          startSample: start,
        };
      else {
        for (const event of state.active) {
          const begin = Math.max(start, event.start),
            finish = Math.min(end, event.end),
            f0 =
              noteFrequency(event.note) *
              (instrument.type === 'synth' ? 2 ** (instrument.detune / 1200) : 1),
            f1 =
              noteFrequency(event.endNote) *
              (instrument.type === 'synth' ? 2 ** (instrument.detune / 1200) : 1),
            slope = (f1 - f0) / event.gate,
            lpan = Math.cos(((event.pan + 1) * Math.PI) / 4),
            rpan = Math.sin(((event.pan + 1) * Math.PI) / 4);
          const source = instrument.type === 'sample' ? this.samples.get(track.id)! : undefined,
            sampleLength = source ? ('length' in source ? source.length : source.left.length) : 0,
            ratio =
              instrument.type === 'sample'
                ? Math.max(f0, f1) / noteFrequency(instrument.rootNote)
                : 1,
            kernelKey = String(ratio);
          if (source && !this.kernels.has(kernelKey)) {
            if (this.kernels.size >= 64) this.kernels.delete(this.kernels.keys().next().value!);
            this.kernels.set(kernelKey, sampleKernel(ratio));
          }
          const kernel = source ? this.kernels.get(kernelKey) : undefined,
            read = (index: number, ch: 0 | 1) => {
              if (instrument.type === 'sample' && instrument.loop)
                index = ((index % sampleLength) + sampleLength) % sampleLength;
              if (index < 0 || index >= sampleLength) return 0;
              return source && 'read' in source
                ? source.read(index, ch)
                : source
                  ? ch === 0
                    ? source.left[index]
                    : source.right[index]
                  : 0;
            };
          for (let sample = begin; sample < finish; sample++) {
            const index = sample - event.start,
              t = index / SOUND_RATE,
              glide = Math.min(t, event.gate),
              frequency = Math.min(22000, f0 + slope * glide),
              cycles = f0 * glide + (slope * glide * glide) / 2 + Math.max(0, t - event.gate) * f1,
              at = sample - start;
            let left = 0,
              right = 0;
            if (instrument.type === 'sample') {
              const position = (cycles / noteFrequency(instrument.rootNote)) * SOUND_RATE,
                p = instrument.loop ? position % sampleLength : position;
              if (p < sampleLength) {
                const a = Math.floor(p),
                  phase = Math.floor((p - a) * 256),
                  env =
                    envelope(t, event.gate, instrument.attack, 0, 1, instrument.release) *
                    instrument.gain;
                for (let k = 0; k < kernel!.taps; k++) {
                  const weight = kernel!.weights[phase * kernel!.taps + k],
                    index = a - kernel!.half + 1 + k;
                  left += read(index, 0) * weight;
                  right += read(index, 1) * weight;
                }
                left *= env;
                right *= env;
                left *= event.pan > 0 ? Math.cos((event.pan * Math.PI) / 2) : 1;
                right *= event.pan < 0 ? Math.cos((-event.pan * Math.PI) / 2) : 1;
              }
            } else {
              let value: number;
              if (instrument.type === 'synth') {
                const env = envelope(
                    t,
                    event.gate,
                    instrument.attack,
                    instrument.decay,
                    instrument.sustain,
                    instrument.release,
                  ),
                  phase =
                    cycles +
                    (instrument.fmIndex *
                      Math.exp(-3 * t) *
                      Math.sin(2 * Math.PI * cycles * instrument.fmRatio)) /
                      (2 * Math.PI);
                value =
                  oscillator(instrument.wave, phase, frequency, event.seed, index) *
                  env *
                  instrument.gain;
              } else {
                const life = instrument.release,
                  env = Math.exp((-8 * t) / life) * (t < life ? 1 : 0),
                  n = noise(event.seed, index),
                  hp = (n - noise(event.seed, index - 1)) * 0.5,
                  base = frequency;
                switch (instrument.voice) {
                  case 'kick':
                    value =
                      Math.sin(
                        2 * Math.PI * (base * t + base * 0.9 * 0.035 * (1 - Math.exp(-t / 0.035))),
                      ) * env;
                    break;
                  case 'tom':
                    value =
                      Math.sin(
                        2 * Math.PI * (base * t + base * 0.4 * 0.04 * (1 - Math.exp(-t / 0.04))),
                      ) * env;
                    break;
                  case 'snare':
                    value = (0.75 * n + 0.25 * Math.sin(2 * Math.PI * 180 * t)) * env;
                    break;
                  case 'hat':
                    value = hp * env;
                    break;
                  case 'clap': {
                    const burst =
                      t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) * 25);
                    value = hp * burst * env;
                    break;
                  }
                }
                value *= instrument.gain;
              }
              left = value * lpan;
              right = value * rpan;
            }
            block.left[at] += left * event.velocity;
            block.right[at] += right * event.velocity;
          }
        }
      }
      block = yield* applySoundChain(state.effects, block, start);
      if (automation.length) {
        const value = (property: string, time: number, base: number) => {
          const channel = automation.find((a) => a.property === property);
          if (!channel) return base;
          const keys = channel.keys,
            k = preceding(keys, time, (k) => k.seconds);
          if (k < 0) return keys[0].value;
          if (k === keys.length - 1) return keys[k].value;
          const a = keys[k],
            b = keys[k + 1];
          return a.value + ((b.value - a.value) * (time - a.seconds)) / (b.seconds - a.seconds);
        };
        for (let i = 0; i < count; i++) {
          const time = (start + i) / SOUND_RATE,
            pan = value('pan', time, track.pan),
            gain = dbGain(value('gainDb', time, track.gainDb));
          block.left[i] *= gain * (pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1);
          block.right[i] *= gain * (pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1);
        }
      } else panBlock(block, dbGain(track.gainDb), track.pan);
      route(block, track);
    }
    for (const id of this.compiled.busOrder) {
      let block = buffers.get(id)!;
      const { bus, effects } = this.buses.get(id)!;
      block = yield* applySoundChain(effects, block, start);
      panBlock(block, dbGain(bus.gainDb), bus.pan);
      route(block, bus);
    }
    let master = buffers.get('master')!;
    master = yield* applySoundChain(this.master, master, start);
    panBlock(master, dbGain(this.compiled.document.master.gainDb), 0);
    for (const values of [master.left, master.right])
      for (const v of values)
        if (!Number.isFinite(v))
          throw new VmotionError('SOUND_NONFINITE', 'Audio processing produced nonfinite samples');
    this.position = end;
    return master;
  }
}
