import { VmotionError } from './model.js';
import {
  compileSound,
  soundPreset,
  noteNumber,
  type SoundInput,
  type SoundDocument,
} from './sound.js';
type Message = {
  tick: number;
  track: number;
  order: number;
  type: string;
  channel?: number;
  a?: number;
  b?: number;
  data?: Uint8Array;
};
function vlq(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff)
    throw new VmotionError('MIDI_RANGE', 'MIDI delta time exceeds the four-byte range');
  const result = [value & 127];
  while ((value >>>= 7)) result.unshift((value & 127) | 128);
  return result;
}
function chunk(name: string, data: number[]) {
  const length = data.length;
  return [
    ...Array.from(name, (c) => c.charCodeAt(0)),
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    ...data,
  ];
}
export function exportSoundMidi(raw: SoundInput | unknown) {
  const compiled = compileSound(raw),
    doc = compiled.document,
    ppq = 960,
    warnings: string[] = [];
  if (doc.tracks.length > 15)
    throw new VmotionError('MIDI_CHANNELS', 'MIDI export supports at most 15 score tracks');
  const endTick = Math.round(
    (doc.unit === 'beats' ? doc.duration : compiled.clock.secondsBeat(doc.duration)) * ppq,
  );
  const encode = (messages: { tick: number; priority: number; data: number[] }[]) => {
      let previous = 0;
      const data: number[] = [];
      for (const m of messages.sort((a, b) => a.tick - b.tick || a.priority - b.priority)) {
        data.push(...vlq(m.tick - previous), ...m.data);
        previous = m.tick;
      }
      data.push(...vlq(Math.max(previous, endTick) - previous), 255, 47, 0);
      return chunk('MTrk', data);
    },
    tempo = doc.tempo.map((t) => {
      const v = Math.round(60_000_000 / t.bpm);
      return {
        tick: Math.round(t.beat * ppq),
        priority: 0,
        data: [255, 81, 3, (v >>> 16) & 255, (v >>> 8) & 255, v & 255],
      };
    });
  tempo.push({
    tick: 0,
    priority: 1,
    data: [255, 88, 4, doc.timeSignature[0], Math.log2(doc.timeSignature[1]), 24, 8],
  });
  const tracks = [encode(tempo)];
  let channel = 0;
  for (const { track } of compiled.tracks) {
    const instrument = track.instrument,
      ch = instrument.type === 'drum' ? 9 : channel++;
    if (channel === 9) channel++;
    const messages: { tick: number; priority: number; data: number[] }[] = [];
    const name = Array.from(new TextEncoder().encode(track.name));
    messages.push({ tick: 0, priority: 0, data: [255, 3, ...vlq(name.length), ...name] });
    const program =
      instrument.type === 'synth'
        ? instrument.wave === 'saw'
          ? 80
          : instrument.fmIndex > 1
            ? 10
            : instrument.wave === 'triangle'
              ? 11
              : 0
        : 0;
    if (instrument.type !== 'drum')
      messages.push({ tick: 0, priority: 1, data: [192 | ch, program] });
    if (
      track.effects.length ||
      track.sends.length ||
      track.automation.length ||
      track.busId !== 'master' ||
      track.gainDb !== 0 ||
      track.pan !== 0 ||
      track.muted ||
      track.solo
    )
      warnings.push(
        `${track.id}: mix/effect/automation/solo state stays in the sound document; MIDI contains notes only`,
      );
    if (instrument.type === 'sample')
      warnings.push(`${track.id}: sample identity is not represented in standard MIDI`);
    if (instrument.type === 'plugin') warnings.push(`${track.id}: VST3/AU sound and state stay in the project; MIDI contains notes only`);
    for (const event of track.events) {
      if (event.velocity === 0) continue;
      if (event.endNote !== undefined)
        warnings.push(`${track.id}/${event.id}: note sweep is not represented in MIDI`);
      const note =
          instrument.type === 'drum'
            ? { kick: 36, snare: 38, hat: 42, tom: 45, clap: 39 }[instrument.voice]
            : noteNumber(event.note),
        beat = doc.unit === 'beats' ? event.at : compiled.clock.secondsBeat(event.at),
        end =
          doc.unit === 'beats'
            ? event.at + event.duration
            : compiled.clock.secondsBeat(event.at + event.duration);
      if (Math.round(end * ppq) <= Math.round(beat * ppq))
        throw new VmotionError('MIDI_RESOLUTION', 'Note is shorter than the exported MIDI tick', {
          eventId: event.id,
        });
      messages.push(
        {
          tick: Math.round(beat * ppq),
          priority: 3,
          data: [144 | ch, note, Math.max(1, Math.round(event.velocity * 127))],
        },
        { tick: Math.round(end * ppq), priority: 2, data: [128 | ch, note, 0] },
      );
    }
    tracks.push(encode(messages));
  }
  if (doc.buses.length || doc.master.effects.length || doc.master.gainDb !== 0)
    warnings.push('Bus/master processing remains in the sound document');
  return {
    data: new Uint8Array([
      ...chunk('MThd', [0, 1, 0, tracks.length, (ppq >>> 8) & 255, ppq & 255]),
      ...tracks.flat(),
    ]),
    warnings: [...new Set(warnings)],
    ppq,
  };
}
export function importSoundMidi(data: Uint8Array, options: { id: string; name: string }) {
  if (data.length > 4 * 1024 * 1024)
    throw new VmotionError('MIDI_BUDGET', 'MIDI input exceeds 4 MB');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0,
    work = 0;
  const need = (size: number) => {
      if (at + size > data.length)
        throw new VmotionError('MIDI_FORMAT', 'Truncated MIDI file', { offset: at });
    },
    read = (size: number) => {
      need(size);
      const result = data.slice(at, at + size);
      at += size;
      return result;
    },
    u16 = () => {
      need(2);
      const v = view.getUint16(at);
      at += 2;
      return v;
    },
    u32 = () => {
      need(4);
      const v = view.getUint32(at);
      at += 4;
      return v;
    },
    name = () => String.fromCharCode(...read(4));
  if (name() !== 'MThd') throw new VmotionError('MIDI_FORMAT', 'Expected standard MIDI header');
  const header = u32(),
    format = u16(),
    trackCount = u16(),
    division = u16();
  if (
    header < 6 ||
    header > 1024 ||
    format > 1 ||
    !division ||
    division & 0x8000 ||
    !trackCount ||
    trackCount > 128
  )
    throw new VmotionError(
      'MIDI_FORMAT',
      'Only format 0/1 MIDI with PPQ timebase and up to 128 tracks is supported',
    );
  read(header - 6);
  const messages: Message[] = [],
    warnings = new Set<string>(),
    names = new Map<number, string>();
  let lastTick = 0;
  for (let track = 0; track < trackCount; track++) {
    if (name() !== 'MTrk') throw new VmotionError('MIDI_FORMAT', 'Expected track chunk');
    const length = u32();
    need(length);
    const end = at + length;
    let tick = 0,
      running = 0;
    const byte = () => {
        if (at >= end) throw new VmotionError('MIDI_FORMAT', 'Truncated track event');
        return data[at++];
      },
      variable = () => {
        let value = 0;
        for (let i = 0; i < 4; i++) {
          const b = byte();
          value = value * 128 + (b & 127);
          if (!(b & 128)) return value;
        }
        throw new VmotionError('MIDI_FORMAT', 'Invalid variable-length MIDI value');
      };
    while (at < end) {
      if (++work > 200000) throw new VmotionError('MIDI_BUDGET', 'MIDI message budget exceeded');
      tick += variable();
      lastTick = Math.max(lastTick, tick);
      let status = byte();
      if (status < 128) {
        if (!running)
          throw new VmotionError('MIDI_FORMAT', 'Running status without channel message');
        at--;
        status = running;
      }
      if (status === 255) {
        const type = byte(),
          size = variable();
        if (at + size > end) throw new VmotionError('MIDI_FORMAT', 'Truncated MIDI meta message');
        const bytes = read(size);
        if (type === 81) {
          if (size !== 3) throw new VmotionError('MIDI_FORMAT', 'Invalid tempo message');
          messages.push({
            tick,
            track,
            order: work,
            type: 'tempo',
            a: (bytes[0] << 16) | (bytes[1] << 8) | bytes[2],
          });
        } else if (type === 88 && size >= 2)
          messages.push({
            tick,
            track,
            order: work,
            type: 'signature',
            a: bytes[0],
            b: 2 ** bytes[1],
          });
        else if (type === 3) names.set(track, new TextDecoder().decode(bytes));
        else if (![47, 1, 2, 4, 5, 6, 7, 32, 33, 84, 89].includes(type))
          warnings.add(`Unsupported meta message 0x${type.toString(16)}`);
        running = 0;
        continue;
      }
      if (status === 240 || status === 247) {
        const size = variable();
        if (at + size > end)
          throw new VmotionError('MIDI_FORMAT', 'Truncated system-exclusive message');
        read(size);
        warnings.add('System-exclusive instrument settings are not imported');
        running = 0;
        continue;
      }
      if (status >= 240) throw new VmotionError('MIDI_FORMAT', 'Unsupported MIDI system message');
      running = status;
      const kind = status >> 4,
        channel = status & 15,
        a = byte(),
        b = [12, 13].includes(kind) ? undefined : byte();
      if (a > 127 || (b !== undefined && b > 127))
        throw new VmotionError('MIDI_FORMAT', 'Invalid channel data');
      messages.push({
        tick,
        track,
        order: work,
        type:
          kind === 9
            ? b
              ? 'on'
              : 'off'
            : kind === 8
              ? 'off'
              : kind === 11
                ? 'control'
                : kind === 12
                  ? 'program'
                  : 'unsupported',
        channel,
        a,
        b,
      });
      if ([10, 13, 14].includes(kind)) warnings.add('Pitch bends and pressure are not imported');
    }
  }
  if (at !== data.length) warnings.add('Trailing data after MIDI tracks');
  messages.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const tempo = new Map<number, number>([[0, 120]]),
    programs = new Map<number, number>(),
    pedals = new Map<number, boolean>(),
    active = new Map<string, { message: Message; program: number; released: boolean }[]>(),
    notes: { on: Message; end: number; program: number }[] = [],
    signature: [number, number] = [4, 4];
  const finish = (voice: { message: Message; program: number }, tick: number) => {
    if (tick > voice.message.tick)
      notes.push({ on: voice.message, end: tick, program: voice.program });
  };
  for (const m of messages) {
    if (m.type === 'tempo') {
      const bpm = 60_000_000 / m.a!;
      if (bpm < 20 || bpm > 400)
        throw new VmotionError('SOUND_TEMPO', 'MIDI tempo lies outside 20–400 BPM');
      tempo.set(m.tick / division, bpm);
    } else if (m.type === 'signature') {
      if (m.tick === 0 && m.a! <= 32 && [2, 4, 8, 16].includes(m.b!)) {
        signature[0] = m.a!;
        signature[1] = m.b!;
      } else warnings.add('Time signature changes remain outside the imported score');
    } else if (m.type === 'program') programs.set(m.channel!, m.a!);
    else if (m.type === 'on') {
      const key = `${m.channel}:${m.a}`,
        voices = active.get(key) ?? [];
      voices.push({ message: m, program: programs.get(m.channel!) ?? 0, released: false });
      active.set(key, voices);
    } else if (m.type === 'off') {
      const key = `${m.channel}:${m.a}`,
        voices = active.get(key) ?? [],
        i = voices.findIndex((v) => !v.released);
      if (i >= 0) {
        if (pedals.get(m.channel!)) voices[i].released = true;
        else finish(voices.splice(i, 1)[0], m.tick);
      }
    } else if (m.type === 'control') {
      if (m.a === 64) {
        const down = m.b! >= 64;
        pedals.set(m.channel!, down);
        if (!down)
          for (const [key, voices] of active)
            if (key.startsWith(`${m.channel}:`))
              active.set(
                key,
                voices.filter((v) => {
                  if (!v.released) return true;
                  finish(v, m.tick);
                  return false;
                }),
              );
      } else if (m.a === 123 || m.a === 120) {
        for (const [key, voices] of active)
          if (key.startsWith(`${m.channel}:`)) {
            for (const v of voices) finish(v, m.tick);
            active.delete(key);
          }
      } else
        warnings.add(`Controller ${m.a} is not imported (sustain/all-notes-off are supported)`);
    }
  }
  for (const voices of active.values())
    for (const voice of voices) {
      finish(voice, lastTick);
      warnings.add('Unterminated notes were ended at the final MIDI tick');
    }
  const tracks = new Map<string, SoundDocument['tracks'][number]>();
  let index = 0;
  for (const { on, end, program } of notes) {
    const drum =
        on.channel === 9
          ? on.a === 35 || on.a === 36
            ? 'kick'
            : on.a === 38 || on.a === 40
              ? 'snare'
              : on.a === 39
                ? 'clap'
                : [42, 44, 46].includes(on.a!)
                  ? 'hat'
                  : 'tom'
          : undefined,
      key = `${on.track}-${on.channel}-${drum ?? program}`,
      name =
        drum ??
        (program >= 32 && program <= 39
          ? 'bass'
          : program >= 8 && program <= 15
            ? 'bell'
            : program >= 88 && program <= 95
              ? 'pad'
              : 'sine');
    if (!tracks.has(key))
      tracks.set(key, {
        id: `midi-${key}`,
        name: `${names.get(on.track) ?? `MIDI ${on.track + 1}`} · ${name}`,
        instrument: soundPreset(name),
        events: [],
        muted: false,
        solo: false,
        gainDb: 0,
        pan: 0,
        busId: 'master',
        sends: [],
        effects: [],
        automation: [],
      });
    tracks.get(key)!.events.push({
      id: `note-${index++}`,
      at: on.tick / division,
      duration: (end - on.tick) / division,
      note: on.a!,
      velocity: on.b! / 127,
      pan: 0,
    });
  }
  warnings.add(
    'General MIDI instruments map to local synthesis presets; original plugin timbre is not reproduced',
  );
  const document = compileSound({
    kind: 'sound',
    version: 1,
    ...options,
    unit: 'beats',
    duration: Math.max(1, lastTick / division),
    tail: 1,
    tempo: [...tempo].sort((a, b) => a[0] - b[0]).map(([beat, bpm]) => ({ beat, bpm })),
    timeSignature: signature,
    tracks: [...tracks.values()],
    master: { effects: [{ type: 'limiter', ceilingDb: -1, release: 0.1 }] },
  }).document;
  return { document, warnings: [...warnings], format, ppq: division, notes: notes.length };
}
