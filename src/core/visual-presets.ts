import { defineEffectGraph } from './effect-graph.js';
import type { EffectGraphInput } from './effect-graph-schema.js';
const number = (value: number, min: number, max: number) => ({
  type: 'number',
  default: value,
  min,
  max,
});
const color = (value: string) => ({ type: 'color', default: value });
const preset = (
  name: string,
  parameters: Record<string, unknown>,
  nodes: EffectGraphInput['nodes'],
  output: string,
  links: EffectGraphInput['links'] = [],
) =>
  defineEffectGraph({ kind: 'effect-graph', version: 1, name, parameters, nodes, output, links });
export const visualPresetNames = [
  'texture',
  'marble',
  'cellular',
  'textureDisplace',
  'layerDisplace',
  'inkReveal',
  'neonBloom',
  'radialRays',
  'duotone',
] as const;
export type VisualPreset = (typeof visualPresetNames)[number];
export function visualPreset(name: VisualPreset) {
  switch (name) {
    case 'texture':
    case 'marble':
    case 'cellular':
      return preset(
        name,
        {
          scale: number(70, 1, 4000),
          evolution: number(0, -100000, 100000),
          warp: number(name === 'marble' ? 1 : 0, 0, 8),
          contrast: number(1, 0.01, 10),
          low: color('#10263d'),
          high: color('#9bdbd6'),
        },
        [
          {
            id: 'field',
            type: 'texture',
            settings: {
              pattern: name === 'texture' ? 'fbm' : name,
              scale: 70,
              warp: 0,
              stops: [
                { offset: 0, color: '#10263d' },
                { offset: 1, color: '#9bdbd6' },
              ],
            },
          },
        ],
        'field',
        [
          { nodeId: 'field', property: 'settings.scale', parameter: 'scale' },
          { nodeId: 'field', property: 'settings.evolution', parameter: 'evolution' },
          { nodeId: 'field', property: 'settings.warp', parameter: 'warp' },
          { nodeId: 'field', property: 'settings.contrast', parameter: 'contrast' },
          { nodeId: 'field', property: 'settings.stops.0.color', parameter: 'low' },
          { nodeId: 'field', property: 'settings.stops.1.color', parameter: 'high' },
        ],
      );
    case 'textureDisplace':
      return preset(
        name,
        {
          amountX: number(25, -1000, 1000),
          amountY: number(8, -1000, 1000),
          evolution: number(0, -100000, 100000),
          scale: number(70, 1, 4000),
        },
        [
          { id: 'source', type: 'input' },
          {
            id: 'field',
            type: 'texture',
            settings: {
              pattern: 'turbulence',
              scale: 70,
              stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
              ],
            },
          },
          {
            id: 'warp',
            type: 'displace',
            input: 'source',
            map: 'field',
            amountX: 25,
            amountY: 8,
            channelX: 'luma',
            channelY: 'luma',
            midpointX: 0.5,
            midpointY: 0.5,
          },
        ],
        'warp',
        [
          { nodeId: 'field', property: 'settings.scale', parameter: 'scale' },
          { nodeId: 'field', property: 'settings.evolution', parameter: 'evolution' },
          { nodeId: 'warp', property: 'amountX', parameter: 'amountX' },
          { nodeId: 'warp', property: 'amountY', parameter: 'amountY' },
        ],
      );
    case 'layerDisplace':
      return preset(
        name,
        {
          amountX: number(20, -1000, 1000),
          amountY: number(20, -1000, 1000),
          midpointX: number(0.5, 0, 1),
          midpointY: number(0.5, 0, 1),
        },
        [
          { id: 'source', type: 'input' },
          { id: 'field', type: 'input', slot: 'map' },
          { id: 'warp', type: 'displace', input: 'source', map: 'field', amountX: 20, amountY: 20 },
        ],
        'warp',
        [
          { nodeId: 'warp', property: 'amountX', parameter: 'amountX' },
          { nodeId: 'warp', property: 'amountY', parameter: 'amountY' },
          { nodeId: 'warp', property: 'midpointX', parameter: 'midpointX' },
          { nodeId: 'warp', property: 'midpointY', parameter: 'midpointY' },
        ],
      );
    case 'inkReveal':
      return preset(
        name,
        {
          progress: number(0, 0, 1),
          scale: number(60, 1, 4000),
          evolution: number(0, -100000, 100000),
        },
        [
          { id: 'source', type: 'input' },
          {
            id: 'field',
            type: 'texture',
            settings: {
              pattern: 'ridged',
              scale: 60,
              contrast: 2,
              stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
              ],
            },
          },
          {
            id: 'reveal',
            type: 'pass',
            input: 'brighten',
            effect: { type: 'linearWipe', progress: 0, feather: 60 },
          },
          {
            id: 'brighten',
            type: 'pass',
            input: 'field',
            effect: { type: 'levels', outputBlack: 0, outputWhite: 1 },
          },
          { id: 'masked', type: 'mask', input: 'source', matte: 'reveal', mode: 'luma' },
        ],
        'masked',
        [
          { nodeId: 'field', property: 'settings.scale', parameter: 'scale' },
          { nodeId: 'field', property: 'settings.evolution', parameter: 'evolution' },
          { nodeId: 'reveal', property: 'effect.progress', parameter: 'progress' },
          { nodeId: 'brighten', property: 'effect.outputBlack', parameter: 'progress' },
        ],
      );
    case 'neonBloom':
      return preset(
        name,
        {
          radius: number(24, 0, 300),
          intensity: number(1.5, 0, 8),
          threshold: number(0.4, 0, 1),
          color: color('#a5cfff'),
        },
        [
          { id: 'source', type: 'input' },
          {
            id: 'bloom',
            type: 'pass',
            input: 'source',
            effect: {
              type: 'bloom',
              radius: 24,
              intensity: 1.5,
              threshold: 0.4,
              levels: 4,
              color: '#a5cfff',
            },
          },
        ],
        'bloom',
        [
          { nodeId: 'bloom', property: 'effect.radius', parameter: 'radius' },
          { nodeId: 'bloom', property: 'effect.intensity', parameter: 'intensity' },
          { nodeId: 'bloom', property: 'effect.threshold', parameter: 'threshold' },
          { nodeId: 'bloom', property: 'effect.color', parameter: 'color' },
        ],
      );
    case 'radialRays':
      return preset(
        name,
        {
          center: { type: 'vec2', default: { x: 0.5, y: 0.5 }, min: -2, max: 3 },
          length: number(0.7, 0, 4),
          intensity: number(1.5, 0, 8),
          threshold: number(0.35, 0, 1),
          color: color('#deecff'),
        },
        [
          { id: 'source', type: 'input' },
          {
            id: 'rays',
            type: 'pass',
            input: 'source',
            effect: {
              type: 'radialRays',
              samples: 16,
              length: 0.7,
              intensity: 1.5,
              threshold: 0.35,
            },
          },
        ],
        'rays',
        [
          { nodeId: 'rays', property: 'effect.center', parameter: 'center' },
          { nodeId: 'rays', property: 'effect.length', parameter: 'length' },
          { nodeId: 'rays', property: 'effect.intensity', parameter: 'intensity' },
          { nodeId: 'rays', property: 'effect.threshold', parameter: 'threshold' },
          { nodeId: 'rays', property: 'effect.color', parameter: 'color' },
        ],
      );
    case 'duotone':
      return preset(
        name,
        { low: color('#112c4d'), high: color('#91ebce'), intensity: number(1, 0, 1) },
        [
          { id: 'source', type: 'input' },
          {
            id: 'map',
            type: 'pass',
            input: 'source',
            effect: {
              type: 'gradientMap',
              stops: [
                { offset: 0, color: '#112c4d' },
                { offset: 1, color: '#91ebce' },
              ],
              intensity: 1,
            },
          },
        ],
        'map',
        [
          { nodeId: 'map', property: 'effect.stops.0.color', parameter: 'low' },
          { nodeId: 'map', property: 'effect.stops.1.color', parameter: 'high' },
          { nodeId: 'map', property: 'effect.intensity', parameter: 'intensity' },
        ],
      );
  }
}
