import { z } from 'zod';
import type { ParameterDefinitions } from './parameters.js';
const finite = z.number().finite();
const vec2 = z.object({ x: finite, y: finite }).strict();
export const matrixSchema = z.tuple([finite, finite, finite, finite, finite, finite]);
export const repeaterOptionsSchema = z
  .object({
    mode: z.enum(['linear', 'grid', 'radial']).default('linear'),
    count: finite.min(0).max(512).default(6),
    offset: finite.min(-512).max(512).default(0),
    position: vec2.default({ x: 80, y: 0 }),
    rotation: finite.min(-1e6).max(1e6).default(0),
    scale: z
      .object({ x: finite.min(-100).max(100), y: finite.min(-100).max(100) })
      .strict()
      .default({ x: 1, y: 1 }),
    pivot: vec2.default({ x: 0, y: 0 }),
    skew: finite.min(-85).max(85).default(0),
    columns: z.number().int().min(1).max(512).default(3),
    gap: vec2.default({ x: 100, y: 100 }),
    radius: finite.min(0).max(1e6).default(150),
    angleStart: finite.min(-1e6).max(1e6).default(0),
    angleStep: finite.min(-1e6).max(1e6).default(30),
    orientation: z.enum(['fixed', 'radial', 'tangent']).default('fixed'),
    startOpacity: finite.min(0).max(1).default(1),
    endOpacity: finite.min(0).max(1).default(1),
    reverse: z.boolean().default(false),
  })
  .strict();
export type RepeaterOptions = z.input<typeof repeaterOptionsSchema>;
export const repeatDescribeSchema = z
  .object({
    parameters: repeaterOptionsSchema.default({}),
    indices: z.array(z.number().int().min(0).max(511)).max(128).optional(),
    sourceBounds: z
      .object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export const repeaterParameters = {
  mode: {
    type: 'enum',
    options: ['linear', 'grid', 'radial'],
    default: 'linear',
    label: '排列方式',
  },
  count: {
    type: 'number',
    default: 6,
    min: 0,
    max: 512,
    step: 0.1,
    label: '副本数量',
    description: '小数部分控制最后一个副本的透明度。',
  },
  offset: { type: 'number', default: 0, min: -512, max: 512, step: 0.1, label: '序号偏移' },
  position: { type: 'vec2', default: { x: 80, y: 0 }, label: '每步位移' },
  rotation: { type: 'number', default: 0, min: -1e6, max: 1e6, label: '每步旋转 (°)' },
  scale: { type: 'vec2', default: { x: 1, y: 1 }, min: -100, max: 100, label: '每步缩放' },
  pivot: { type: 'vec2', default: { x: 0, y: 0 }, label: '变换中心' },
  skew: {
    type: 'number',
    default: 0,
    min: -85,
    max: 85,
    label: '每步斜切 (°)',
    description: '累积斜切限制在 ±85°，避免跨越奇异矩阵。',
  },
  columns: { type: 'number', default: 3, min: 1, max: 512, integer: true, label: '网格列数' },
  gap: { type: 'vec2', default: { x: 100, y: 100 }, label: '网格间距' },
  radius: { type: 'number', default: 150, min: 0, max: 1e6, label: '放射半径' },
  angleStart: { type: 'number', default: 0, min: -1e6, max: 1e6, label: '起始角度 (°)' },
  angleStep: { type: 'number', default: 30, min: -1e6, max: 1e6, label: '角度间隔 (°)' },
  orientation: {
    type: 'enum',
    options: ['fixed', 'radial', 'tangent'],
    default: 'fixed',
    label: '放射朝向',
  },
  startOpacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: '首个透明度' },
  endOpacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: '末个透明度' },
  reverse: { type: 'boolean', default: false, label: '反向叠放' },
} as const satisfies ParameterDefinitions;
