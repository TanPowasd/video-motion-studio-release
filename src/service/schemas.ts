import { glyphSetSchema } from '../core/glyphs/glyph-schema.js';
import { stillSchema } from '../core/still-schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { renderProgramSchema } from '../core/programs/render-program-schema.js';
import {
  pluginBundleManifestSchema,
  pluginManifestSchema,
  pluginRegistrationSchema,
} from '../core/plugin-schema.js';
import { storyboardSchema } from '../core/storyboard.js';
import { textureSettingsSchema } from '../core/texture-schema.js';
import { pathTextSchema, textAnimatorSchema } from '../core/typography-schema.js';
import { shapeOperatorSchema } from '../core/shape-operator-schema.js';
import { trackingDocumentSchema, trackingSettingsSchema } from '../core/tracking-schema.js';
import { themeDocumentSchema, themeBindingSchema } from '../core/theme-schema.js';
import { templateDocumentSchema, templateAuthorSchema } from '../core/template-schema.js';
import { audioMixSchema, audioNormalizationSchema } from '../core/audio-mix-schema.js';
import type { ZodTypeAny } from 'zod';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  nodeSchema,
  operationSchema,
  effectSchema,
  VmotionError,
  FORMAT_VERSION,
} from '../core/model.js';
import { drawingDocumentSchema, drawingOperationSchema } from '../core/drawing-model.js';
import { fileEditSchema } from '../core/file-edits.js';
import { scene3dSchema } from '../core/scene3d-schema.js';
import { meshDocumentSchema } from '../core/mesh-document.js';
import { material3dSchema } from '../core/material3d-schema.js';
import { motionTemplateSchema } from '../core/motion-template.js';
import { effectGraphSchema } from '../core/effect-graph-schema.js';
import { expressionsSchema, layoutSchema, motionPathSchema } from '../core/driver-schema.js';
import { animationLayerSchema, animationLayersSchema } from '../core/animation-schema.js';
import {
  soundDocumentSchema,
  soundInstrumentSchema,
  soundEffectSchema,
} from '../core/sound-schema.js';
const schemas = {
  renderProgram: renderProgramSchema,
  animationLayer: animationLayerSchema,
  animationLayers: animationLayersSchema,
  plugin: pluginManifestSchema,
  pluginRegistration: pluginRegistrationSchema,
  pluginBundle: pluginBundleManifestSchema,
  still: stillSchema,
  glyphSet: glyphSetSchema,
  theme: themeDocumentSchema,
  themeBinding: themeBindingSchema,
  sceneTemplate: templateDocumentSchema,
  templateAuthor: templateAuthorSchema,
  tracking: trackingDocumentSchema,
  trackingSettings: trackingSettingsSchema,
  pathText: pathTextSchema,
  textAnimator: textAnimatorSchema,
  shapeOperator: shapeOperatorSchema,
  storyboard: storyboardSchema,
  textureSettings: textureSettingsSchema,
  audioMix: audioMixSchema,
  audioNormalization: audioNormalizationSchema,
  project: projectSchema,
  scene: sceneSchema,
  sequence: sequenceSchema,
  node: nodeSchema,
  operation: operationSchema,
  drawing: drawingDocumentSchema,
  drawingOperation: drawingOperationSchema,
  fileEdit: fileEditSchema,
  scene3d: scene3dSchema,
  mesh: meshDocumentSchema,
  material3d: material3dSchema,
  effect: effectSchema,
  motionTemplate: motionTemplateSchema,
  effectGraph: effectGraphSchema,
  expressions: expressionsSchema,
  layout: layoutSchema,
  motionPath: motionPathSchema,
  sound: soundDocumentSchema,
  soundInstrument: soundInstrumentSchema,
  soundEffect: soundEffectSchema,
};
export function projectSchemaInfo(name: string, operationType?: string) {
  if (!Object.hasOwn(schemas, name))
    throw new VmotionError(
      'SCHEMA_NAME',
      'Read project_schema for one registered resource type; unknown/future kinds are not rewritten',
      { available: Object.keys(schemas) },
    );
  let schema: ZodTypeAny = schemas[name as keyof typeof schemas];
  if (operationType) {
    if (name !== 'operation')
      throw new VmotionError(
        'SCHEMA_OPERATION',
        'operationType is only supported for the operation schema',
      );
    const selected = operationSchema.options.find(
      (option) => option.shape.type.value === operationType,
    );
    if (!selected) throw new VmotionError('SCHEMA_OPERATION', 'Unknown operation type');
    schema = selected;
  }
  return {
    name,
    operationType,
    formatVersion: FORMAT_VERSION,
    schema: zodToJsonSchema(schema, name),
  };
}
export const projectSchemaNames = Object.keys(schemas) as [
  keyof typeof schemas,
  ...Array<keyof typeof schemas>,
];
