import type { AudioPluginConfig, SoundEffect } from './sound-schema.js';
import { soundEffects, type StereoBlock } from './sound-effects.js';
export type PluginAudioRequest = {
  key: string;
  config: AudioPluginConfig;
  kind: 'instrument' | 'effect';
  block: StereoBlock;
  startSample: number;
};
export type PluginAudioProcessor = (request: PluginAudioRequest) => Promise<StereoBlock>;
type EffectStep =
  { plugin: AudioPluginConfig; key: string } | { process: ReturnType<typeof soundEffects> };
export function createSoundChain(effects: SoundEffect[], owner: string): EffectStep[] {
  const steps: EffectStep[] = [];
  let pure: SoundEffect[] = [];
  const flush = () => {
    if (pure.length) {
      steps.push({ process: soundEffects(pure) });
      pure = [];
    }
  };
  effects.forEach((effect, index) => {
    if (effect.type === 'plugin') {
      flush();
      steps.push({ plugin: effect, key: `${owner}:effect:${index}` });
    } else pure.push(effect);
  });
  flush();
  return steps;
}
export function* applySoundChain(
  steps: EffectStep[],
  block: StereoBlock,
  startSample: number,
): Generator<PluginAudioRequest, StereoBlock, StereoBlock> {
  for (const step of steps) {
    if ('process' in step) step.process(block, startSample);
    else block = yield { key: step.key, config: step.plugin, kind: 'effect', block, startSample };
  }
  return block;
}
