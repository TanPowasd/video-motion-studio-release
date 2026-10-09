import { glyphSetSchema } from '../src/core/glyphs/glyph-schema.js';
import { stillSchema } from '../src/core/still-schema.js';
import { mkdir, writeFile } from 'node:fs/promises';
import {renderProgramSchema} from '../src/core/programs/render-program-schema.js';
import {
  pluginBundleManifestSchema,
  pluginManifestSchema,
  pluginRegistrationSchema,
} from '../src/core/plugin-schema.js';
import { storyboardSchema } from '../src/core/storyboard.js';
import { textureSettingsSchema } from '../src/core/texture-schema.js';
import { pathTextSchema, textAnimatorSchema } from '../src/core/typography-schema.js';
import { shapeOperatorSchema } from '../src/core/shape-operator-schema.js';
import { trackingDocumentSchema, trackingSettingsSchema } from '../src/core/tracking-schema.js';
import { themeDocumentSchema, themeBindingSchema } from '../src/core/theme-schema.js';
import { templateDocumentSchema, templateAuthorSchema } from '../src/core/template-schema.js';
import { audioMixSchema, audioNormalizationSchema } from '../src/core/audio-mix-schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  nodeSchema,
  operationSchema,
  effectSchema,
} from '../src/core/model.js';
import { drawingDocumentSchema, drawingOperationSchema } from '../src/core/drawing-model.js';
import { fileEditSchema } from '../src/core/file-edits.js';
import { scene3dSchema } from '../src/core/scene3d-schema.js';
import { meshDocumentSchema } from '../src/core/mesh-document.js';
import { material3dSchema } from '../src/core/material3d-schema.js';
import { motionTemplateSchema } from '../src/core/motion-template.js';
import { effectGraphSchema } from '../src/core/effect-graph-schema.js';
import { expressionsSchema, layoutSchema, motionPathSchema } from '../src/core/driver-schema.js';
import { animationLayerSchema, animationLayersSchema } from '../src/core/animation-schema.js';
import {
  soundDocumentSchema,
  soundInstrumentSchema,
  soundEffectSchema,
} from '../src/core/sound-schema.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  renderProgram:renderProgramSchema,
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
}))
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(zodToJsonSchema(schema, name), null, 2) + '\n',
  );
