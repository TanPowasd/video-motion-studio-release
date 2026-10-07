import { VmotionError, type Sequence, type Snapshot } from './model.js';
import {
  audioMixSchema,
  audioTrackMixSchema,
  type AudioMix,
  type AudioDucking,
} from './audio-mix-schema.js';
import { SOUND_RATE, dbGain, soundEffects, panBlock, type StereoBlock } from './sound-effects.js';
export type MixNode = {
  key: string;
  id: string;
  type: 'track' | 'bus' | 'master';
  config: AudioMix['master'] | AudioMix['tracks'][string];
  muted: boolean;
  dependencies: string[];
  routes: { to: string; gain: number }[];
};
export function compileAudioMix(sequence: Sequence, fps: Snapshot['project']['fps']) {
  const mix = audioMixSchema.parse(sequence.mix ?? {}),
    duration = (sequence.duration * fps.den) / fps.num;
  if (duration > 7200)
    throw new VmotionError('AUDIO_MIX_BUDGET', 'A mixed sequence is limited to two hours');
  if (sequence.tracks.length > 64)
    throw new VmotionError('AUDIO_MIX_BUDGET', 'A sequence mix is limited to 64 tracks');
  if (Object.keys(mix.tracks).some((id) => !sequence.tracks.some((t) => t.id === id)))
    throw new VmotionError(
      'AUDIO_MIX_TRACK',
      'Mix configuration references a missing timeline track',
    );
  const buses = new Set(mix.buses.map((b) => b.id));
  if (buses.size !== mix.buses.length || buses.has('master'))
    throw new VmotionError('AUDIO_MIX_ID', 'Bus IDs must be unique; master is reserved');
  const solo = sequence.tracks.some((t) => !t.muted && mix.tracks[t.id]?.solo),
    nodes = new Map<string, MixNode>();
  for (const track of sequence.tracks) {
    const config = Object.hasOwn(mix.tracks, track.id)
      ? mix.tracks[track.id]
      : audioTrackMixSchema.parse({});
    nodes.set(`track:${track.id}`, {
      key: `track:${track.id}`,
      id: track.id,
      type: 'track',
      config,
      muted: track.muted || (solo && !config.solo),
      dependencies: [],
      routes: [],
    });
  }
  for (const bus of mix.buses)
    nodes.set(`bus:${bus.id}`, {
      key: `bus:${bus.id}`,
      id: bus.id,
      type: 'bus',
      config: bus,
      muted: false,
      dependencies: [],
      routes: [],
    });
  nodes.set('master', {
    key: 'master',
    id: 'master',
    type: 'master',
    config: mix.master,
    muted: false,
    dependencies: [],
    routes: [],
  });
  let stateBytes = 0;
  for (const node of nodes.values()) {
    const config = node.config;
    for (const e of config.effects)
      stateBytes +=
        e.type === 'delay'
          ? (e.seconds + (e.rightSeconds ?? e.seconds)) * SOUND_RATE * 8
          : e.type === 'chorus'
            ? (e.delay + e.depth) * SOUND_RATE * 16
            : e.type === 'reverb'
              ? 140000
              : 64;
    if ('automation' in config) {
      if (new Set(config.automation.map((a) => a.property)).size !== config.automation.length)
        throw new VmotionError('AUDIO_MIX_AUTOMATION', 'One channel per gain/pan property', {
          nodeId: node.key,
        });
      for (const channel of config.automation)
        if (
          channel.keys.some(
            (k, i) =>
              k.at > duration ||
              (i > 0 && k.at <= channel.keys[i - 1].at) ||
              k.value < (channel.property === 'pan' ? -1 : -80) ||
              k.value > (channel.property === 'pan' ? 1 : 24),
          )
        )
          throw new VmotionError(
            'AUDIO_MIX_AUTOMATION',
            'Automation uses increasing seconds and bounded gain/pan values',
            { nodeId: node.key },
          );
    }
    if ('busId' in config) {
      const target = (id: string) => {
        if (id === 'master') return 'master';
        if (!buses.has(id))
          throw new VmotionError('AUDIO_MIX_BUS', 'Missing destination bus', {
            nodeId: node.key,
            busId: id,
          });
        return `bus:${id}`;
      };
      if (new Set(config.sends.map((s) => s.busId)).size !== config.sends.length)
        throw new VmotionError('AUDIO_MIX_BUS', 'Duplicate send destinations', {
          nodeId: node.key,
        });
      node.routes = [
        { to: target(config.busId), gain: 1 },
        ...config.sends.map((s) => ({ to: target(s.busId), gain: dbGain(s.db) })),
      ];
      for (const route of node.routes) nodes.get(route.to)!.dependencies.push(node.key);
    }
    if (config.ducking) {
      const key = `${config.ducking.source.type}:${config.ducking.source.id}`;
      if (!nodes.has(key))
        throw new VmotionError('AUDIO_MIX_SIDECHAIN', 'Missing sidechain source', {
          nodeId: node.key,
          source: key,
        });
      node.dependencies.push(key);
    }
  }
  if (stateBytes > 64 * 1024 * 1024)
    throw new VmotionError('AUDIO_MIX_BUDGET', 'Mix processor state exceeds 64 MB', { stateBytes });
  const order: string[] = [],
    done = new Set<string>(),
    visiting: string[] = [];
  const visit = (key: string) => {
    if (done.has(key)) return;
    const index = visiting.indexOf(key);
    if (index >= 0)
      throw new VmotionError('AUDIO_MIX_CYCLE', 'Audio routing or sidechain creates a cycle', {
        path: [...visiting.slice(index), key],
      });
    visiting.push(key);
    for (const dependency of new Set(nodes.get(key)!.dependencies)) visit(dependency);
    visiting.pop();
    done.add(key);
    order.push(key);
  };
  for (const key of nodes.keys()) visit(key);
  return { mix, nodes, order, duration, stateBytes };
}
function ducking(config: AudioDucking) {
  const attack = Math.exp(-1 / (config.attack * SOUND_RATE)),
    release = Math.exp(-1 / (config.release * SOUND_RATE));
  let reduction = 0;
  return (block: StereoBlock, source: StereoBlock) => {
    for (let i = 0; i < block.left.length; i++) {
      const peak = Math.max(Math.abs(source.left[i]), Math.abs(source.right[i]), 1e-12),
        over = 20 * Math.log10(peak) - config.thresholdDb,
        k = config.kneeDb,
        compression =
          over < -k / 2
            ? 0
            : over > k / 2
              ? (1 - 1 / config.ratio) * over
              : ((1 - 1 / config.ratio) * (over + k / 2) ** 2) / (2 * Math.max(k, 1e-12)),
        target = Math.min(config.maxReductionDb, compression),
        coefficient = target > reduction ? attack : release;
      reduction = target + (reduction - target) * coefficient;
      const gain = dbGain(-reduction);
      block.left[i] *= gain;
      block.right[i] *= gain;
    }
  };
}
export class SequenceMixRenderer {
  readonly compiled: ReturnType<typeof compileAudioMix>;
  position = 0;
  private processors = new Map<
    string,
    { effects: ReturnType<typeof soundEffects>; duck?: ReturnType<typeof ducking> }
  >();
  constructor(sequence: Sequence, fps: Snapshot['project']['fps']) {
    this.compiled = compileAudioMix(sequence, fps);
    for (const node of this.compiled.nodes.values())
      this.processors.set(node.key, {
        effects: soundEffects(node.config.effects),
        ...(node.config.ducking ? { duck: ducking(node.config.ducking) } : {}),
      });
  }
  process(inputs: Map<string, StereoBlock>, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 16384)
      throw new VmotionError('AUDIO_MIX_RANGE', 'Process a bounded sequential mix block');
    const empty = (): StereoBlock => ({
        left: new Float64Array(count),
        right: new Float64Array(count),
      }),
      output = new Map<string, StereoBlock>(),
      incoming = new Map<string, StereoBlock>(),
      start = this.position;
    for (const key of this.compiled.order) {
      const node = this.compiled.nodes.get(key)!,
        config = node.config,
        provided = node.type === 'track' ? inputs.get(node.id) : incoming.get(key),
        block = provided ? { left: provided.left.slice(), right: provided.right.slice() } : empty();
      if (block.left.length !== count || block.right.length !== count)
        throw new VmotionError('AUDIO_MIX_RANGE', 'Input stem size does not match mix block');
      const processor = this.processors.get(key)!;
      if (node.muted) {
        block.left.fill(0);
        block.right.fill(0);
      } else {
        processor.effects(block, start);
        if (processor.duck) {
          const source = config.ducking!.source;
          processor.duck(block, output.get(`${source.type}:${source.id}`)!);
        }
        if ('automation' in config && config.automation.length) {
          const sample = (property: string, time: number, base: number) => {
            const keys = config.automation.find((a) => a.property === property)?.keys;
            if (!keys) return base;
            let lo = 0,
              hi = keys.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (keys[mid].at <= time) lo = mid + 1;
              else hi = mid;
            }
            const index = lo - 1;
            if (index < 0) return keys[0].value;
            const a = keys[index],
              b = keys[index + 1];
            if (!b || a.easing === 'hold') return a.value;
            return a.value + ((b.value - a.value) * (time - a.at)) / (b.at - a.at);
          };
          for (let i = 0; i < count; i++) {
            const t = (start + i) / SOUND_RATE,
              pan = sample('pan', t, config.pan),
              gain = dbGain(sample('gainDb', t, config.gainDb));
            block.left[i] *= gain * (pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1);
            block.right[i] *= gain * (pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1);
          }
        } else panBlock(block, dbGain(config.gainDb), config.pan);
      }
      for (const values of [block.left, block.right])
        for (const value of values)
          if (!Number.isFinite(value))
            throw new VmotionError(
              'AUDIO_MIX_NONFINITE',
              'Mix processor produced nonfinite audio',
              { nodeId: key },
            );
      output.set(key, block);
      for (const route of node.routes) {
        const target = incoming.get(route.to) ?? empty();
        for (let i = 0; i < count; i++) {
          target.left[i] += block.left[i] * route.gain;
          target.right[i] += block.right[i] * route.gain;
        }
        incoming.set(route.to, target);
      }
    }
    this.position += count;
    return { master: output.get('master')!, nodes: output };
  }
}
