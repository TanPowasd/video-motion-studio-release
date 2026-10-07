import { audioPluginSchema, type SoundInstrument } from '../../core/sound-schema.js';
import type { MidiMessage } from './midi.js';
import { rpcTyped } from '../state/rpc-client.js';
const worklet = `class NativeMonitor extends AudioWorkletProcessor {
 constructor(){super();this.queue=[];this.offset=0;this.samples=0;this.started=false;this.underruns=0;this.report=0;this.port.onmessage=e=>{if(e.data.pcm){const p=new Float32Array(e.data.pcm);if(this.samples+p.length/2>4096){this.queue=[];this.samples=0;this.offset=0;this.started=false;}this.queue.push(p);this.samples+=p.length/2;}if(e.data.stop){this.queue=[];this.samples=0;this.started=false;}};}
 process(inputs,outputs){const out=outputs[0];if(!this.started){if(this.samples<1024)return true;this.started=true;}for(let i=0;i<out[0].length;i++){if(!this.queue.length){this.underruns++;this.started=false;break;}const p=this.queue[0];out[0][i]=p[this.offset++];out[1][i]=p[this.offset++];this.samples--;if(this.offset>=p.length){this.queue.shift();this.offset=0;}}if(++this.report>=8){this.report=0;this.port.postMessage({samples:this.samples,underruns:this.underruns});}return true;}
}registerProcessor('vmotion-native-monitor',NativeMonitor);`;
type Voice = {
  nodes: AudioNode[];
  gain: GainNode;
  released: boolean;
  note: number;
  channel: number;
  started: number;
};
export class LiveAudio {
  context?: AudioContext;
  sessionId?: string;
  private monitor?: AudioWorkletNode;
  private ending = false;
  private buffered = 0;
  private midi: Array<{ status: number; a: number; b: number; offset: number }> = [];
  private run?: Promise<void>;
  private gain?: GainNode;
  private voices = new Map<string, Voice[]>();
  private sustain = new Set<number>();
  private instrument?: SoundInstrument;
  private noiseSeed = 17;
  private lastStatus = 0;
  onStatus?: (status: { peak: number; underruns: number; bufferedMs: number }) => void;
  onError?: (error: Error) => void;
  async start(instrument: SoundInstrument, volume = 1) {
    await this.close();
    this.ending = false;
    this.instrument = instrument;
    this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.context.resume();
    this.gain = this.context.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(this.context.destination);
    if (instrument.type === 'plugin') {
      const result = await rpcTyped('audioLive', {
        action: 'open',
        config: audioPluginSchema.strip().parse(instrument),
        sampleRate: this.context.sampleRate,
        blockSize: 512,
      });
      if (!('sessionId' in result) || !result.sessionId) throw new Error('实时插件未打开');
      this.sessionId = result.sessionId;
      const blob = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
      try {
        await this.context.audioWorklet.addModule(blob);
      } finally {
        URL.revokeObjectURL(blob);
      }
      this.monitor = new AudioWorkletNode(this.context, 'vmotion-native-monitor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.monitor.connect(this.gain);
      this.monitor.port.onmessage = (e) => {
        this.buffered = e.data.samples;
        if (performance.now() - this.lastStatus < 200) return;
        this.lastStatus = performance.now();
        this.onStatus?.({
          peak: 0,
          underruns: e.data.underruns,
          bufferedMs: (this.buffered / this.context!.sampleRate) * 1000,
        });
      };
      this.run = this.stream(result.endpoint!);
    } else if (instrument.type === 'sample')
      throw new Error('采样通道实时监听需要外部采样器插件；本地采样保持离线编曲与导出');
  }
  private async stream(endpoint: string) {
    try {
      while (!this.ending) {
        if (this.buffered > 2048) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        const midi = this.midi.splice(0, 1024);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frames: 512, midi }),
        });
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message ?? '插件音频流中断');
        }
        const pcm = await response.arrayBuffer();
        if (this.ending) break;
        if (pcm.byteLength !== 4096) throw new Error('PCM 帧数错误');
        this.buffered += 512;
        this.monitor!.port.postMessage({ pcm }, [pcm]);
      }
    } catch (error) {
      if (!this.ending) {
        this.onError?.(error as Error);
        void this.close();
      }
    }
  }
  send(message: MidiMessage) {
    if (!this.context || this.ending) return;
    if (this.sessionId) {
      if (this.midi.length >= 1024) {
        this.midi = [];
        this.midi.push({ status: 176, a: 123, b: 0, offset: 0 });
      }
      this.midi.push({ status: message.status, a: message.a, b: message.b, offset: 0 });
      return;
    }
    const kind = message.status & 240,
      channel = message.status & 15,
      key = channel + ':' + message.a;
    if (kind === 144 && message.b) {
      for (const [id, voices] of this.voices) {
        const alive = voices.filter((v) => v.nodes.length);
        if (alive.length) this.voices.set(id, alive);
        else this.voices.delete(id);
      }
      if ([...this.voices.values()].reduce((sum, list) => sum + list.length, 0) >= 64) this.panic();
      const voice = this.noteOn(message.a, message.b / 127, channel);
      if (voice) this.voices.set(key, [...(this.voices.get(key) ?? []), voice]);
    } else if (kind === 128 || (kind === 144 && !message.b)) {
      const voice = this.voices.get(key)?.find((v) => !v.released);
      if (voice) {
        voice.released = true;
        if (!this.sustain.has(channel)) this.release(voice);
      }
    } else if (kind === 176 && message.a === 64) {
      if (message.b >= 64) this.sustain.add(channel);
      else {
        this.sustain.delete(channel);
        for (const list of this.voices.values())
          for (const voice of list)
            if (voice.channel === channel && voice.released) this.release(voice);
      }
    } else if (kind === 176 && (message.a === 120 || message.a === 123)) this.panic();
  }
  private noteOn(note: number, velocity: number, channel: number): Voice | undefined {
    const ins = this.instrument,
      ctx = this.context!;
    if (!ins || (ins.type !== 'synth' && ins.type !== 'drum')) return;
    const gain = ctx.createGain(),
      now = ctx.currentTime,
      nodes: AudioNode[] = [];
    gain.connect(this.gain!);
    const frequency = 440 * 2 ** ((note - 69) / 12);
    if (ins.type === 'synth' && ins.wave !== 'noise') {
      const osc = ctx.createOscillator();
      osc.type = {
        sine: 'sine',
        triangle: 'triangle',
        saw: 'sawtooth',
        square: 'square',
        noise: 'sine',
      }[ins.wave] as OscillatorType;
      osc.frequency.value = frequency;
      osc.detune.value = ins.detune;
      osc.connect(gain);
      osc.start();
      nodes.push(osc);
      if (ins.fmRatio && ins.fmIndex) {
        const fm = ctx.createOscillator(),
          amount = ctx.createGain();
        fm.frequency.value = frequency * ins.fmRatio;
        amount.gain.setValueAtTime(frequency * ins.fmIndex, now);
        amount.gain.setTargetAtTime(0.001, now, 0.333);
        fm.connect(amount);
        amount.connect(osc.frequency);
        fm.start();
        nodes.push(fm, amount);
      }
    } else if (ins.type === 'drum' && ['kick', 'tom'].includes(ins.voice)) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(ins.voice === 'kick' ? 160 : 220, now);
      osc.frequency.exponentialRampToValueAtTime(ins.voice === 'kick' ? 45 : 90, now + ins.release);
      osc.connect(gain);
      osc.start();
      nodes.push(osc);
    } else {
      const length = Math.max(
          1,
          Math.round(ctx.sampleRate * (ins.type === 'drum' ? ins.release : 2)),
        ),
        buffer = ctx.createBuffer(1, length, ctx.sampleRate),
        data = buffer.getChannelData(0);
      let seed = this.noiseSeed++;
      for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = seed / 2147483648 - 1;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = ins.type === 'synth';
      source.connect(gain);
      source.start();
      nodes.push(source);
    }
    const volume = velocity * ins.gain * 0.35;
    if (ins.type === 'synth') {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + ins.attack);
      gain.gain.linearRampToValueAtTime(volume * ins.sustain, now + ins.attack + ins.decay);
    } else {
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + ins.release);
    }
    const voice = { nodes, gain, released: false, note, channel, started: now };
    if (ins.type === 'drum') setTimeout(() => this.release(voice), ins.release * 1000);
    return voice;
  }
  private release(voice: Voice) {
    if (!voice.nodes.length || !this.context) return;
    const now = this.context.currentTime,
      duration = this.instrument?.release ?? 0.1;
    voice.gain.gain.cancelAndHoldAtTime(now);
    voice.gain.gain.linearRampToValueAtTime(0, now + duration);
    for (const node of voice.nodes)
      if ('stop' in node)
        try {
          (node as OscillatorNode).stop(now + duration + 0.01);
        } catch {}
    const nodes = voice.nodes;
    voice.nodes = [];
    setTimeout(
      () => {
        nodes.forEach((n) => n.disconnect());
        voice.gain.disconnect();
      },
      (duration + 0.03) * 1000,
    );
  }
  panic() {
    this.sustain.clear();
    if (this.sessionId) {
      this.midi = [];
      for (let channel = 0; channel < 16; channel++)
        this.midi.push({ status: 176 + channel, a: 123, b: 0, offset: 0 });
    }
    for (const list of this.voices.values()) for (const voice of list) this.release(voice);
    this.voices.clear();
  }
  async state() {
    if (!this.sessionId) throw new Error('没有活动插件');
    const result = await rpcTyped('audioLive', { action: 'state', sessionId: this.sessionId });
    if (!('state' in result)) throw new Error('插件状态未返回');
    return result;
  }
  async editor() {
    if (this.sessionId)
      await rpcTyped('audioLive', { action: 'editor', sessionId: this.sessionId, show: true });
  }
  async parameters(values: Record<string, number>) {
    if (this.sessionId)
      await rpcTyped('audioLive', { action: 'parameters', sessionId: this.sessionId, values });
  }
  async close() {
    this.ending = true;
    this.panic();
    this.monitor?.port.postMessage({ stop: true });
    if (this.monitor) {
      this.monitor.port.onmessage = null;
      this.monitor.port.close();
    }
    this.monitor?.disconnect();
    this.monitor = undefined;
    const id = this.sessionId;
    this.sessionId = undefined;
    if (id) await rpcTyped('audioLive', { action: 'close', sessionId: id }).catch(() => {});
    await this.run?.catch(() => {});
    this.run = undefined;
    await this.context?.close().catch(() => {});
    this.context = undefined;
    this.buffered = 0;
  }
}
