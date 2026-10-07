import { z } from 'zod';
import { drawingDocumentSchema, type DrawingDocument } from './drawing-model.js';
import { pluginRegistrationSchema } from './plugin-registration.js';
import { fileEditSchema, type FileEdit } from './file-edits.js';
import { vectorFields } from './vector-schema.js';
import { matrixSchema } from './repeater-schema.js';
import { contentTimeSchema } from './content-time-schema.js';
import { scene3dSchema } from './scene3d-schema.js';
import { rasterEffectSchema } from './raster-effect-schema.js';
import { graphEffectDefinition } from './effect-graph-schema.js';
import { temporalEffectSchema } from './temporal-effect.js';
import { pinGrid } from './warp-grid.js';
import { numericPropertyPattern } from './numeric-properties.js';
import { expressionsSchema, layoutSchema, motionPathSchema } from './driver-schema.js';
import { audioMixSchema } from './audio-mix-schema.js';
import { pathTextSchema, textAnimatorsSchema } from './typography-schema.js';
import { shapeOperatorsSchema } from './shape-operator-schema.js';
import { themeBindingSchema } from './theme-schema.js';
import { templateInstanceSchema } from './template-instance-schema.js';
import { keyframeSchema, animationSchema, animationLayersSchema } from './animation-schema.js';
import { renderProgramPathSchema } from './programs/render-program-schema.js';
export { keyframeSchema, animationSchema } from './animation-schema.js';

export const FORMAT_VERSION = 1;
const finite = z.number().finite();
const id = z.string().min(1).max(200);
const color = z.string().min(1);
const pointSchema = z.object({ x: finite, y: finite });
export const gradientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('linear'),
    from: pointSchema,
    to: pointSchema,
    stops: z
      .array(z.object({ offset: finite.min(0).max(1), color }))
      .min(2)
      .max(32),
  }),
  z.object({
    type: z.literal('radial'),
    center: pointSchema,
    radius: finite.positive(),
    stops: z
      .array(z.object({ offset: finite.min(0).max(1), color }))
      .min(2)
      .max(32),
  }),
]);
const baseEffectSchema = z.discriminatedUnion('type', [
  ...rasterEffectSchema.options,
  ...temporalEffectSchema.options,
  graphEffectDefinition,
]);
export const effectDefinitions = baseEffectSchema.options.map((option) =>
  option.extend({ id: z.string().min(1).max(200).optional(), enabled: z.boolean().optional() }),
);
type EffectMetadata = { id?: string; enabled?: boolean };
export const effectSchema = z
  .discriminatedUnion(
    'type',
    effectDefinitions as [
      (typeof effectDefinitions)[number],
      ...Array<(typeof effectDefinitions)[number]>,
    ],
  )
  .superRefine((effect, ctx) => {
    if (effect.type === 'effectGraph' && !!effect.source === !!effect.graph)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose exactly one graph or source file',
        path: ['source'],
      });
    if (
      effect.type === 'meshWarp' &&
      effect.points.length !== (effect.columns + 1) * (effect.rows + 1)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Grid point count must be (columns+1)*(rows+1)',
        path: ['points'],
      });
    if (effect.type === 'cornerPin') {
      try {
        pinGrid(effect.corners);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['corners'] });
      }
    }
  }) as unknown as z.ZodType<
  z.output<typeof baseEffectSchema> & EffectMetadata,
  z.ZodTypeDef,
  z.input<typeof baseEffectSchema> & EffectMetadata
>;
const effectArraySchema = z
  .array(effectSchema)
  .max(16)
  .superRefine((effects, ctx) => {
    const ids = effects.flatMap((e) => (e.id ? [e.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Effect IDs must be unique within a layer' });
  });
export const overrideSchema = z
  .object({
    theme: themeBindingSchema.nullable().optional(),
    templateInstance: templateInstanceSchema.nullable().optional(),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    assetId: id.optional(),
    audioAssetId: id.optional(),
    component: z.string().optional(),
    programSource: renderProgramPathSchema.optional(),
    source: z.string().optional(),
    isolation: z.boolean().optional(),
    x: finite.optional(),
    y: finite.optional(),
    width: finite.nonnegative().optional(),
    height: finite.nonnegative().optional(),
    rotation: finite.optional(),
    scaleX: finite.optional(),
    scaleY: finite.optional(),
    originX: finite.optional(),
    originY: finite.optional(),
    matrix: matrixSchema.optional(),
    timeMapping: contentTimeSchema.optional(),
    opacity: finite.min(0).max(1).optional(),
    fill: color.optional(),
    stroke: z.string().optional(),
    strokeWidth: finite.nonnegative().optional(),
    strokeDash: vectorFields.strokeDash.optional(),
    strokeDashOffset: vectorFields.strokeDashOffset.optional(),
    strokeCap: vectorFields.strokeCap.optional(),
    strokeJoin: vectorFields.strokeJoin.optional(),
    strokeMiterLimit: vectorFields.strokeMiterLimit.optional(),
    fillRule: vectorFields.fillRule.optional(),
    pathTrim: vectorFields.pathTrim.optional(),
    shapeOperators: shapeOperatorsSchema.optional(),
    path: z.string().optional(),
    radius: finite.nonnegative().optional(),
    text: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: finite.positive().optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: finite.positive().optional(),
    pathText: pathTextSchema.nullable().optional(),
    textAnimators: textAnimatorsSchema.optional(),
    reveal: finite.min(0).max(1).optional(),
    effects: effectArraySchema.optional(),
    gradient: gradientSchema.optional(),
    animations: z.array(animationSchema).optional(),
    animationLayers: animationLayersSchema.optional(),
    expressions: expressionsSchema.optional(),
    layout: layoutSchema.nullable().optional(),
    motionPath: motionPathSchema.nullable().optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
    maskFeather: finite.min(0).max(300).optional(),
    maskMode: z.enum(['alpha', 'alphaInverted', 'luma', 'lumaInverted']).optional(),
    params: z.record(z.unknown()).optional(),
    sceneId: id.optional(),
    scene3d: scene3dSchema.optional(),
  })
  .strict();
export const nodeBaseSchema = z
  .object({
    theme: themeBindingSchema.nullable().optional(),
    templateInstance: templateInstanceSchema.nullable().optional(),
    id,
    type: z.enum([
      'group',
      'text',
      'rect',
      'ellipse',
      'path',
      'image',
      'video',
      'formula',
      'chart',
      'component',
      'drawing',
      'scene',
      'scene3d',
      'program',
    ]),
    programSource: renderProgramPathSchema.optional(),
    name: z.string().default('Layer'),
    parentId: id.optional(),
    visible: z.boolean().default(true),
    isolation: z.boolean().optional(),
    sceneDependencies: z.array(id).max(64).optional(),
    x: finite.default(0),
    y: finite.default(0),
    width: finite.nonnegative().default(200),
    height: finite.nonnegative().default(100),
    rotation: finite.default(0),
    scaleX: finite.default(1),
    scaleY: finite.default(1),
    originX: finite.default(0),
    originY: finite.default(0),
    matrix: matrixSchema.default([1, 0, 0, 1, 0, 0]),
    timeMapping: contentTimeSchema.default({}),
    opacity: finite.min(0).max(1).default(1),
    fill: color.default('#7c8cff'),
    gradient: gradientSchema.optional(),
    effects: effectArraySchema.default([]),
    stroke: z.string().default(''),
    strokeWidth: finite.nonnegative().default(0),
    ...vectorFields,
    shapeOperators: shapeOperatorsSchema.default([]),
    radius: finite.nonnegative().default(0),
    text: z.string().default(''),
    fontFamily: z.string().default('Microsoft YaHei'),
    fontSize: finite.positive().default(48),
    fontWeight: z.number().int().min(100).max(900).default(400),
    align: z.enum(['left', 'center', 'right']).default('left'),
    lineHeight: finite.positive().default(1.3),
    pathText: pathTextSchema.nullable().optional(),
    textAnimators: textAnimatorsSchema.default([]),
    reveal: finite.min(0).max(1).default(1),
    textMotion: z
      .object({
        unit: z.enum(['grapheme', 'word']).default('grapheme'),
        start: z.number().int().nonnegative().default(0),
        duration: z.number().int().positive().default(18),
        stagger: z.number().int().nonnegative().default(2),
        offsetX: finite.default(0),
        offsetY: finite.default(24),
        rotation: finite.default(0),
        scale: finite.min(0.01).max(10).default(0.85),
      })
      .optional(),
    assetId: id.optional(),
    source: z.string().optional(),
    sceneId: id.optional(),
    component: z.string().optional(),
    scene3d: scene3dSchema.optional(),
    audioAssetId: id.optional(),
    audioOffset: finite.default(0),
    params: z.record(z.unknown()).default({}),
    overrides: z.record(overrideSchema).default({}),
    path: z.string().default(''),
    blend: z
      .enum([
        'source-over',
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'difference',
        'destination-in',
        'lighter',
      ])
      .default('source-over'),
    blur: finite.nonnegative().default(0),
    shadow: z.object({ color, blur: finite.nonnegative(), x: finite, y: finite }).optional(),
    clip: z
      .object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() })
      .optional(),
    maskId: id.optional(),
    maskMode: z.enum(['alpha', 'alphaInverted', 'luma', 'lumaInverted']).default('alpha'),
    maskFeather: finite.min(0).max(300).default(0),
    brightness: finite.min(0).max(4).default(1),
    saturation: finite.min(0).max(4).default(1),
    start: z.number().int().nonnegative().default(0),
    end: z.number().int().positive().optional(),
    animations: z.array(animationSchema).default([]),
    animationLayers: animationLayersSchema.optional(),
    expressions: expressionsSchema.optional(),
    layout: layoutSchema.nullable().optional(),
    motionPath: motionPathSchema.nullable().optional(),
    points: z
      .array(z.object({ x: finite, y: finite, pressure: finite.min(0).max(1).default(1) }))
      .default([]),
  })
  .strict();
const editSchema = z
  .object({
    added: z.array(nodeBaseSchema).max(4000).default([]),
    removed: z.array(id).max(10000).default([]),
    parents: z.record(id.nullable()).default({}),
    order: z.array(id).max(10000).default([]),
  })
  .strict();
export const structureSchema = editSchema.extend({ nested: z.record(editSchema).default({}) });
type NodeShape = typeof nodeBaseSchema.shape & {
  structure: z.ZodOptional<typeof structureSchema>;
};
export const nodeSchema: z.ZodObject<NodeShape, 'strict'> = nodeBaseSchema.extend({
  structure: structureSchema.optional(),
});
const sceneCameraSchema = z.object({
  x: finite,
  y: finite,
  zoom: finite.positive(),
  rotation: finite,
});
type SceneShape = {
  id: z.ZodString;
  name: z.ZodString;
  duration: z.ZodNumber;
  width: z.ZodOptional<z.ZodNumber>;
  height: z.ZodOptional<z.ZodNumber>;
  background: z.ZodDefault<z.ZodString>;
  nodes: z.ZodArray<typeof nodeSchema>;
  camera: z.ZodOptional<typeof sceneCameraSchema>;
};
export const sceneSchema: z.ZodObject<SceneShape, 'strict'> = z
  .object({
    id,
    name: z.string(),
    duration: z.number().int().positive(),
    width: z.number().int().min(16).max(3840).optional(),
    height: z.number().int().min(16).max(2160).optional(),
    background: color.default('#101525'),
    nodes: z.array(nodeSchema),
    camera: sceneCameraSchema.optional(),
  })
  .strict();
export const clipSchema = z
  .object({
    id,
    sceneId: id.optional(),
    sequenceId: id.optional(),
    assetId: id.optional(),
    start: z.number().int().nonnegative(),
    duration: z.number().int().positive(),
    sourceIn: finite.nonnegative().default(0),
    sourceOut: finite.positive().optional(),
    speed: finite.positive().default(1),
    volume: finite.min(0).max(4).default(1),
    fadeIn: z.number().int().nonnegative().default(0),
    fadeOut: z.number().int().nonnegative().default(0),
    name: z.string().optional(),
    linkedGroup: id.optional(),
    audioEnabled: z.boolean().optional(),
    fadeWindow: z.object({ offset: finite, duration: finite.positive() }).strict().optional(),
    sourceWindow: z
      .object({ sourceIn: finite.nonnegative(), duration: finite.positive() })
      .strict()
      .optional(),
  })
  .strict();
export const trackSchema = z
  .object({
    id,
    name: z.string(),
    type: z.enum(['video', 'audio']),
    muted: z.boolean().default(false),
    locked: z.boolean().optional(),
    clips: z.array(clipSchema),
  })
  .strict();
export const sequenceSchema = z
  .object({
    id,
    name: z.string(),
    duration: z.number().int().positive(),
    tracks: z.array(trackSchema),
    workflow: z.enum(['general', 'remix', 'film']).optional(),
    mix: audioMixSchema.nullable().optional(),
    workArea: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
      .refine((r) => r.end > r.start, 'Out point must follow in point')
      .optional(),
    markers: z
      .array(
        z.object({
          id,
          frame: z.number().int().nonnegative(),
          label: z.string(),
          kind: z.enum(['marker', 'beat', 'chapter']).optional(),
          group: id.optional(),
        }),
      )
      .default([]),
  })
  .strict();
export const assetSchema = z
  .object({
    id,
    name: z.string(),
    path: z.string().min(1),
    soundSource: z.string().min(1).optional(),
    type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
    managed: z.boolean().default(false),
    fingerprint: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
export const projectSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    id,
    name: z.string().min(1),
    width: z.number().int().min(16).max(3840),
    height: z.number().int().min(16).max(2160),
    fps: z.object({
      num: z.number().int().positive().max(60000),
      den: z.number().int().positive().max(1001),
    }),
    colorSpace: z.literal('srgb').default('srgb'),
    sampleRate: z.literal(48000).default(48000),
    activeSequence: id,
    scenes: z.array(z.string()),
    sequences: z.array(z.string()),
    assets: z.array(assetSchema),
    drawings: z
      .array(z.object({ id, name: z.string().min(1), path: z.string().min(1) }).strict())
      .default([]),
    sdkVersion: z.string().default('0.1.0'),
    plugins: z.array(pluginRegistrationSchema).max(128).optional(),
    motionBlur: z
      .object({
        samples: z.number().int().min(2).max(16),
        shutterAngle: finite.min(0).max(360).default(180),
      })
      .optional(),
  })
  .strict()
  .refine((p) => p.fps.num / p.fps.den <= 60, 'Frame rate must not exceed 60fps');

export type Node = z.infer<typeof nodeSchema>;
export type ComponentStructure = z.infer<typeof structureSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Gradient = z.infer<typeof gradientSchema>;
export interface Snapshot {
  project: Project;
  scenes: Scene[];
  sequences: Sequence[];
  revision: string;
  files: Record<string, string>;
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  path?: string;
}
export interface Conflict {
  file: string;
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}
export type Operation =
  | { type: 'editFiles'; edits: FileEdit[] }
  | { type: 'writeDrawing'; document: DrawingDocument }
  | { type: 'removeDrawing'; id: string }
  | { type: 'updateNode'; sceneId: string; nodeId: string; patch: Partial<Node> }
  | { type: 'addNode'; sceneId: string; node: Partial<Node> & Pick<Node, 'id' | 'type'> }
  | { type: 'removeNode'; sceneId: string; nodeId: string }
  | { type: 'updateScene'; sceneId: string; patch: Partial<Scene> }
  | { type: 'addScene'; scene: Scene }
  | { type: 'removeScene'; sceneId: string }
  | { type: 'updateSequence'; sequenceId: string; patch: Partial<Sequence> }
  | { type: 'addTrack'; sequenceId: string; track: Track }
  | { type: 'removeTrack'; sequenceId: string; trackId: string }
  | { type: 'addClip'; sequenceId: string; trackId: string; clip: Clip }
  | {
      type: 'updateClip';
      sequenceId: string;
      trackId: string;
      clipId: string;
      patch: Partial<Clip>;
    }
  | { type: 'removeClip'; sequenceId: string; trackId: string; clipId: string }
  | { type: 'updateProject'; patch: Partial<Project> }
  | { type: 'addAsset'; asset: Asset }
  | { type: 'writeSource'; path: string; content: string };

const nodePatchSchema: z.ZodObject<
  { [K in keyof NodeShape]: z.ZodOptional<NodeShape[K]> },
  'strict'
> = nodeSchema.partial();
const scenePatchSchema: z.ZodObject<
  { [K in keyof SceneShape]: z.ZodOptional<SceneShape[K]> },
  'strict'
> = sceneSchema.partial();
const updateNodeOperation: z.ZodObject<{
  type: z.ZodLiteral<'updateNode'>;
  sceneId: typeof id;
  nodeId: typeof id;
  patch: typeof nodePatchSchema;
}> = z.object({ type: z.literal('updateNode'), sceneId: id, nodeId: id, patch: nodePatchSchema });
const addNodeOperation: z.ZodObject<{
  type: z.ZodLiteral<'addNode'>;
  sceneId: typeof id;
  node: typeof nodeSchema;
}> = z.object({ type: z.literal('addNode'), sceneId: id, node: nodeSchema });
const updateSceneOperation: z.ZodObject<{
  type: z.ZodLiteral<'updateScene'>;
  sceneId: typeof id;
  patch: typeof scenePatchSchema;
}> = z.object({ type: z.literal('updateScene'), sceneId: id, patch: scenePatchSchema });
const addSceneOperation: z.ZodObject<{
  type: z.ZodLiteral<'addScene'>;
  scene: typeof sceneSchema;
}> = z.object({ type: z.literal('addScene'), scene: sceneSchema });
const operationOptions = [
  z.object({ type: z.literal('editFiles'), edits: z.array(fileEditSchema).min(1).max(1000) }),
  z.object({ type: z.literal('writeDrawing'), document: drawingDocumentSchema }),
  z.object({ type: z.literal('removeDrawing'), id }),
  updateNodeOperation,
  addNodeOperation,
  z.object({ type: z.literal('removeNode'), sceneId: id, nodeId: id }),
  updateSceneOperation,
  addSceneOperation,
  z.object({ type: z.literal('removeScene'), sceneId: id }),
  z.object({ type: z.literal('updateSequence'), sequenceId: id, patch: sequenceSchema.partial() }),
  z.object({ type: z.literal('addTrack'), sequenceId: id, track: trackSchema }),
  z.object({ type: z.literal('removeTrack'), sequenceId: id, trackId: id }),
  z.object({ type: z.literal('addClip'), sequenceId: id, trackId: id, clip: clipSchema }),
  z.object({
    type: z.literal('updateClip'),
    sequenceId: id,
    trackId: id,
    clipId: id,
    patch: clipSchema.partial(),
  }),
  z.object({ type: z.literal('removeClip'), sequenceId: id, trackId: id, clipId: id }),
  z.object({ type: z.literal('updateProject'), patch: projectSchema.innerType().partial() }),
  z.object({ type: z.literal('addAsset'), asset: assetSchema }),
  z.object({ type: z.literal('writeSource'), path: z.string(), content: z.string() }),
] as const;
export const operationSchema: z.ZodDiscriminatedUnion<'type', typeof operationOptions> =
  z.discriminatedUnion('type', operationOptions);

export class VmotionError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: unknown = undefined,
  ) {
    super(message);
    this.name = 'VmotionError';
  }
}
export type NodeInput = Omit<
  Partial<Node>,
  | 'layout'
  | 'motionPath'
  | 'pathText'
  | 'textAnimators'
  | 'shapeOperators'
  | 'animations'
  | 'animationLayers'
  | 'timeMapping'
  | 'theme'
  | 'templateInstance'
> &
  Pick<Node, 'id' | 'type'> & {
    layout?: z.input<typeof layoutSchema> | null;
    motionPath?: z.input<typeof motionPathSchema> | null;
    pathText?: z.input<typeof pathTextSchema> | null;
    textAnimators?: z.input<typeof textAnimatorsSchema>;
    shapeOperators?: z.input<typeof shapeOperatorsSchema>;
    animations?: z.input<typeof animationSchema>[];
    animationLayers?: z.input<typeof animationLayersSchema>;
    timeMapping?: z.input<typeof contentTimeSchema>;
    theme?: z.input<typeof themeBindingSchema> | null;
    templateInstance?: z.input<typeof templateInstanceSchema> | null;
  };
export const newNode = (value: NodeInput): Node => nodeSchema.parse(value);
