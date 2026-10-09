import { newNode, type Node, type Keyframe, type NodeInput } from '../core/model.js';
import { ease, interpolate, random } from '../core/time.js';
export { newNode as node, ease, interpolate, random };
export * from './render-programs.js';
export { pixelEvidence, comparePixels } from '../core/pixel-evidence.js';
export type { PixelRegion, PixelEvidenceOptions } from '../core/pixel-evidence.js';
export type { GpuMode } from '../core/gpu-points.js';
export * from './plugins.js';
export type { PluginManifest, PluginTool, PluginRegistration } from '../core/plugin-schema.js';
export type NodeProps = Omit<NodeInput, 'id' | 'type'>;
export { evaluateDrivers } from '../core/drivers.js';
export { prepareCurvePath, sampleCurvePath } from '../core/curve-path.js';
export type { DriverContext, DriverReport } from '../core/drivers.js';
export type { Layout, LayoutInput, MotionPath, MotionPathInput } from '../core/driver-schema.js';
export { axes, diagram, stack, cubicBezier, bubbleSortSteps } from './science.js';
export * from './motion.js';
export { storyboardSchema, storyboardBoundary } from '../core/storyboard.js';
export type { Storyboard, StoryboardInput } from '../core/storyboard.js';
export {
  sequenceSourcesAt,
  sequenceSampleCandidates,
  stratifiedFrames,
} from '../core/sequence-inspection.js';
export { compileAudioMix, SequenceMixRenderer } from '../core/audio-mix.js';
export type {
  AudioMix,
  AudioMixInput,
  AudioDucking,
  AudioNormalization,
} from '../core/audio-mix-schema.js';
export { sceneTransition, transitionStyles } from './transitions.js';
export type { TransitionStyle } from './transitions.js';
export { applyMotionCues, parseMotionTemplate, builtinMotions } from '../core/motion-template.js';
export type {
  MotionTemplate,
  MotionTemplateInput,
  MotionCue,
  MotionOptions,
  BuiltinMotion,
} from '../core/motion-template.js';
export * from './effects.js';
export {
  particleField,
  particleState,
  particleFieldParameters,
  particleFieldSchema,
} from '../core/particle-field.js';
export type {
  ParticleFieldInput,
  ParticleFieldConfig,
  ParticleRecord,
  ParticleCallbacks,
} from '../core/particle-field.js';
export * from './post.js';
export { prepareTexture, textureSettingsSchema } from '../core/visual-fields.js';
export type { TextureSettings } from '../core/visual-fields.js';
export { visualPreset, visualPresetNames } from '../core/visual-presets.js';
export type { VisualPreset } from '../core/visual-presets.js';
export { editEffectGraph } from '../core/effect-graph-edit.js';
export { editAnimationLayers } from '../core/animation-layers.js';
export { applyMotionLayers } from '../core/motion-template.js';
export { prepareKeyframes, sampleKeyframes } from '../core/time.js';
export type { PreparedKeyframes } from '../core/time.js';
export type {
  AnimationLayer,
  AnimationLayerInput,
  AnimationChannel,
} from '../core/animation-schema.js';
export type { EffectGraphAction } from '../core/effect-graph-edit.js';
export { defineEffectGraph, compileEffectGraph } from '../core/effect-graph.js';
export type {
  EffectGraphInput,
  EffectGraph,
  EffectGraphNode,
} from '../core/effect-graph-schema.js';
export * from './repeater.js';
export * from './linear-algebra.js';
export * from './matrix3d.js';
export * from './meshes.js';
export * from './materials3d.js';
export * from './normals3d.js';
export { editEffectStack } from '../core/effect-stack.js';
export type { EffectAction } from '../core/effect-stack.js';
export { parseOBJ } from './obj.js';
export type { MeshDocument } from '../core/mesh-document.js';
export { editSequence, sequenceActionSchema } from '../core/editing.js';
export type { SequenceAction } from '../core/editing.js';
export { parseCaptions, captionsSchema } from '../core/captions.js';
export type { CaptionDocument } from '../core/captions.js';
export { measureTextBlock } from '../core/text-layout.js';
export { bindTheme, ThemeResolver } from '../core/theme.js';
export type { ThemeDocument, ThemeToken, ThemeBinding } from '../core/theme-schema.js';
export type { TemplateDocument, TemplateAuthor } from '../core/template-schema.js';
export {
  prepareTracking,
  sampleTrackedPoint,
  trackingMotion,
  fitTrackingMotion,
  trackingGaps,
  blendTrackingMotion,
  smoothTrackingMotion,
} from '../core/tracking.js';
export type { PreparedTracking, TrackingPair, TrackingModel } from '../core/tracking.js';
export type {
  TrackingDocument,
  TrackingSample,
  TrackingSettings,
} from '../core/tracking-schema.js';
export { layoutAnimatedText, textSelectorWeight } from '../core/typography.js';
export type { TextRun } from '../core/typography.js';
export type { PathTextInput, TextAnimatorInput, TextSelector } from '../core/typography-schema.js';
export { applyShapeOperators } from '../core/vector.js';
export type { ShapeOperator, ShapeOperatorInput } from '../core/shape-operator-schema.js';
export { editGraphicsStack } from '../core/graphics-stack.js';
export type { GraphicsAction, GraphicsStack } from '../core/graphics-stack.js';
export { mapContentTime, contentTiming, contentTimeSchema } from '../core/content-time.js';
export type { ContentTime, ContentTiming } from '../core/content-time.js';
export {
  booleanPath,
  trimPath,
  outlinePath,
  simplifyPath,
  roundPath,
  pathGeometry,
} from '../core/vector.js';
export type {
  PathTrim,
  PathOperation,
  OutlineOptions,
  PathGeometryRequest,
} from '../core/vector-schema.js';
export { editKeyframes, sampleAnimation } from '../core/keyframes.js';
export type { KeyframeAction } from '../core/keyframes.js';
export {
  auditFrame,
  auditMotion,
  auditGeometry,
  visualOptionsSchema,
} from '../core/visual-audit.js';
export type { VisualOptions, VisualFinding } from '../core/visual-audit.js';
export type { Node, Keyframe, Gradient, Effect } from '../core/model.js';
export type {
  DrawingDocument,
  DrawingLayer,
  DrawingStroke,
  DrawingOperation,
} from '../core/drawing-model.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  type ParameterDefinitions,
  type ParameterValues,
} from '../core/parameters.js';
export { resolveParameters, parameterDefault, parameterJsonSchema } from '../core/parameters.js';
export type {
  Parameter,
  ParameterDefinitions,
  ParameterValues,
  ParameterValue,
} from '../core/parameters.js';
export interface ComponentContext {
  frame: number;
  seconds: number;
  fps: number;
  width: number;
  height: number;
  seed: number;
  audio?: {
    rms: number;
    peak: number;
    bass: number;
    mid: number;
    treble: number;
    onset: number;
    beat: number;
    bpm: number;
  };
}
export interface Component<P extends ParameterDefinitions = ParameterDefinitions> {
  name: string;
  parameters: P;
  render: (
    context: ComponentContext,
    params: ParameterValues<P>,
  ) => Array<Partial<Node> & Pick<Node, 'id' | 'type'>>;
}
export function defineComponent<const P extends ParameterDefinitions>(
  component: Component<P>,
): Component<P> {
  validateParameterDefinitions(component.parameters);
  return {
    ...component,
    render: (ctx, params) => component.render(ctx, resolveParameters(component.parameters, params)),
  };
}
export const rect = (id: string, props: NodeProps = {}) => newNode({ id, type: 'rect', ...props });
export const text = (id: string, value: string, props: NodeProps = {}) =>
  newNode({ id, type: 'text', text: value, ...props });
export const ellipse = (id: string, props: NodeProps = {}) =>
  newNode({ id, type: 'ellipse', ...props });
export const path = (id: string, value: string, props: NodeProps = {}) =>
  newNode({ id, type: 'path', path: value, ...props });
export const formula = (id: string, tex: string, props: NodeProps = {}) =>
  newNode({ id, type: 'formula', text: tex, ...props });
export const sceneRef = (id: string, sceneId: string, props: Partial<Node> = {}) =>
  newNode({ ...props, id, type: 'scene', sceneId });
export const keyframes = (property: Node['animations'][number]['property'], keys: Keyframe[]) => ({
  property,
  keys,
});
export {
  compileSound,
  SoundRenderer,
  tempoClock,
  noteNumber,
  noteFrequency,
  soundPresets,
  soundPreset,
  SOUND_RATE,
} from '../core/sound.js';
export type {
  SoundDocument,
  SoundInput,
  SoundInstrument,
  SoundEffect,
  SoundSample,
} from '../core/sound.js';
export { importSoundMidi, exportSoundMidi } from '../core/sound-midi.js';
export type { SoundPattern, SoundEvent, SoundTrack } from '../core/sound-schema.js';
export type { AudioPluginConfig } from '../core/sound-schema.js';
export { expandSoundTracks } from '../core/sound-patterns.js';
export function plot(
  id: string,
  fn: (x: number) => number,
  range: [number, number],
  props: Partial<Node> = {},
) {
  const w = props.width ?? 600,
    h = props.height ?? 300,
    samples = 300;
  const points = Array.from({ length: samples + 1 }, (_, i) => {
    const x = range[0] + ((range[1] - range[0]) * i) / samples;
    return `${i ? 'L' : 'M'} ${(i * w) / samples} ${h / 2 - (fn(x) * h) / 4}`;
  });
  return path(id, points.join(' '), {
    fill: 'transparent',
    stroke: '#7c8cff',
    strokeWidth: 3,
    ...props,
  });
}
export {
  stillPresets,
  stillTemplates,
  stillGuides,
  stillTemplateNodes,
  alignDeltas,
  snapDelta,
  snapTargets,
  stillSchema,
  stillVariantSchema,
  STILL_MAX_SIDE,
  STILL_MAX_PIXELS,
} from '../core/still.js';
export type {
  StillPreset,
  StillSettings,
  StillVariant,
  StillTemplateId,
  AlignMode,
} from '../core/still.js';
/** Result of image_export / `vmotion image export` (one entry per artboard/variant). */
export interface StillExportImage {
  variant: string;
  path: string;
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
  bytes: number;
  dpi: number | null;
  transparent: boolean;
  pixelHash: string;
}
/* Radical-composed glyph sets (偏旁部件拼字): text without a font file. */
export {
  glyphSetSchema,
  glyphComponentSchema,
  glyphEntrySchema,
  glyphAdjustSchema,
  glyphFallbackSchema,
  idsOperators,
  glyphSetFile,
} from '../core/glyphs/glyph-schema.js';
export type {
  GlyphSetDocument,
  GlyphSetInput,
  GlyphComponent,
  GlyphEntry,
  GlyphAdjust,
  GlyphFallback,
  GlyphStroke,
  GlyphFill,
  IdsOperator,
} from '../core/glyphs/glyph-schema.js';
export { parseIds, formatIds, idsLeaves } from '../core/glyphs/ids.js';
export type { IdsNode } from '../core/glyphs/ids.js';
export { GlyphComposer, isGlyphProblem } from '../core/glyphs/compose.js';
export type { ComposedGlyph, GlyphProblem } from '../core/glyphs/compose.js';
export { builtinGlyphSet, builtinGlyphSetIds } from '../core/glyphs/glyph-resources.js';
export { drawComposedGlyph } from '../core/glyphs/glyph-draw.js';
