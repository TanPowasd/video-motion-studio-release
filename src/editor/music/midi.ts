export type MidiMessage = { status: number; a: number; b: number; timestamp: number };
type ActiveNote = {
  id: string;
  note: number;
  velocity: number;
  at: number;
  channel: number;
  held: boolean;
};
export class MidiRecorder {
  private active = new Map<string, ActiveNote[]>();
  private sustain = new Set<number>();
  readonly notes: Array<{
    id: string;
    at: number;
    duration: number;
    note: number;
    velocity: number;
    pan: number;
  }> = [];
  constructor(
    readonly toTime: (milliseconds: number) => number,
    readonly limit: number,
    readonly quantize: number,
    readonly id: () => string = () => crypto.randomUUID(),
  ) {}
  private finish(voice: ActiveNote, now: number) {
    if (this.notes.length >= 20000) throw new Error('MIDI recording exceeds 20000 notes');
    const at = this.quantize ? Math.round(voice.at / this.quantize) * this.quantize : voice.at;
    const end = Math.min(this.limit, this.toTime(now));
    if (at >= this.limit || end <= at) return;
    this.notes.push({
      id: voice.id,
      at: Math.max(0, at),
      duration: Math.max(
        0.001,
        Math.min(
          this.limit - at,
          this.quantize
            ? Math.max(this.quantize, Math.round((end - at) / this.quantize) * this.quantize)
            : end - at,
        ),
      ),
      note: voice.note,
      velocity: voice.velocity,
      pan: 0,
    });
  }
  feed(message: MidiMessage) {
    const channel = message.status & 15,
      kind = message.status & 240,
      key = channel + ':' + message.a;
    if (kind === 144 && message.b) {
      if ([...this.active.values()].reduce((sum, voices) => sum + voices.length, 0) >= 256)
        throw new Error('MIDI recording exceeds 256 held voices');
      const voices = this.active.get(key) ?? [];
      voices.push({
        id: this.id(),
        note: message.a,
        velocity: message.b / 127,
        at: this.toTime(message.timestamp),
        channel,
        held: false,
      });
      this.active.set(key, voices);
    } else if (kind === 128 || (kind === 144 && !message.b)) {
      const voices = this.active.get(key) ?? [],
        i = voices.findIndex((v) => !v.held);
      if (i >= 0) {
        if (this.sustain.has(channel)) voices[i].held = true;
        else this.finish(voices.splice(i, 1)[0], message.timestamp);
      }
    } else if (kind === 176 && message.a === 64) {
      if (message.b >= 64) this.sustain.add(channel);
      else {
        this.sustain.delete(channel);
        for (const voices of this.active.values())
          for (let i = voices.length - 1; i >= 0; i--)
            if (voices[i].channel === channel && voices[i].held)
              this.finish(voices.splice(i, 1)[0], message.timestamp);
      }
    } else if (kind === 176 && (message.a === 120 || message.a === 123))
      this.stop(message.timestamp);
    if (this.notes.length > 20000) throw new Error('MIDI recording exceeds 20000 notes');
  }
  stop(now: number) {
    for (const voices of this.active.values()) for (const voice of voices) this.finish(voice, now);
    this.active.clear();
    this.sustain.clear();
    return this.notes;
  }
}
export function parseMidi(data: ArrayLike<number>, timestamp: number): MidiMessage | undefined {
  if (data.length < 2 || data[0] < 128 || data[0] >= 240) return;
  const kind = data[0] & 240;
  if (![128, 144, 160, 176, 192, 208, 224].includes(kind)) return;
  if (![192, 208].includes(kind) && data.length < 3) return;
  if (data[1] > 127 || data[1] < 0 || (data[2] ?? 0) > 127) return;
  return { status: data[0], a: data[1], b: data[2] ?? 0, timestamp };
}
