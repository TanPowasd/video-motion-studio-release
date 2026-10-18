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
import { z, type ZodTypeAny } from 'zod';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  nodeSchema,
  operationSchema,
  effectSchema,
  keyframeSchema,
  animationSchema,
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
  // Native keyframe channel formats (node.animations[] and its keys[]), as animation_edit accepts.
  animation: animationSchema,
  keyframe: keyframeSchema,
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
function unwrapField(schema: ZodTypeAny): {
  schema: ZodTypeAny;
  optional: boolean;
  fallback?: unknown;
} {
  let current = schema,
    optional = false,
    fallback: unknown;
  for (let i = 0; i < 12; i++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodDefault) {
      optional = true;
      fallback = current._def.defaultValue();
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) current = current._def.schema;
    else if (current instanceof z.ZodLazy) current = current._def.getter();
    else break;
  }
  return { schema: current, optional, fallback };
}
const fieldNotes: Record<string, string> = {
  animations:
    'array<{property, keys:[{frame, value, easing?, bezier?}], before?, after?}>; project_schema name=animation|keyframe; edit with animation_edit',
  animationLayers: 'array<animationLayer>; project_schema name=animationLayer',
  start: 'integer frame where the layer starts (default 0)',
  end: 'integer exclusive end frame (optional)',
};
/** One-line type for a property index; keeps full enum values (the reason agents ask). */
function shortType(schema: ZodTypeAny, depth = 0): string {
  const { schema: s } = unwrapField(schema);
  if (s instanceof z.ZodNumber) return s.isInt ? 'integer' : 'number';
  if (s instanceof z.ZodString) return 'string';
  if (s instanceof z.ZodBoolean) return 'boolean';
  if (s instanceof z.ZodEnum) return 'enum ' + (s.options as string[]).join('|');
  if (s instanceof z.ZodLiteral) return JSON.stringify(s.value);
  if (s instanceof z.ZodArray)
    return depth > 1 ? 'array' : `array<${shortType(s.element, depth + 1)}>`;
  if (s instanceof z.ZodTuple) return `tuple(${s.items.length})`;
  if (s instanceof z.ZodRecord) return 'record';
  if (s instanceof z.ZodObject)
    return depth > 0
      ? `{${Object.keys(s.shape).slice(0, 8).join(',')}${Object.keys(s.shape).length > 8 ? ',…' : ''}}`
      : 'object';
  if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion)
    return (s.options as ZodTypeAny[])
      .slice(0, 4)
      .map((o) => shortType(o, depth + 1))
      .join(' | ');
  return 'value';
}
function objectShape(schema: ZodTypeAny) {
  const { schema: s } = unwrapField(schema);
  return s instanceof z.ZodObject ? (s.shape as Record<string, ZodTypeAny>) : undefined;
}
/** Leading property index so truncated clients still see every field name/type first. */
function propertyIndex(schema: ZodTypeAny) {
  const shape = objectShape(schema);
  if (!shape) return undefined;
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      const { optional, fallback } = unwrapField(field),
        primitive = ['number', 'string', 'boolean'].includes(typeof fallback);
      return [
        key,
        (fieldNotes[key] ?? shortType(field)) +
          (optional ? '?' : '') +
          (primitive ? ` = ${JSON.stringify(fallback)}` : ''),
      ];
    }),
  );
}
export function projectSchemaInfo(name: string, operationType?: string, properties?: string[]) {
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
    if (!selected)
      throw new VmotionError('SCHEMA_OPERATION', 'Unknown operation type', {
        allowed: operationSchema.options.map((option) => option.shape.type.value),
      });
    schema = selected;
  }
  const index = propertyIndex(schema);
  if (properties?.length) {
    const shape = objectShape(schema);
    if (!shape)
      throw new VmotionError('SCHEMA_PROPERTIES', 'properties selects fields of an object schema', {
        name,
      });
    const missing = properties.filter((p) => !Object.hasOwn(shape, p));
    if (missing.length)
      throw new VmotionError('SCHEMA_PROPERTIES', 'Unknown schema properties', {
        missing,
        allowed: Object.keys(shape),
      });
    const picked = z.object(Object.fromEntries(properties.map((p) => [p, shape[p]]))).strict();
    return {
      name,
      operationType,
      formatVersion: FORMAT_VERSION,
      properties: Object.fromEntries(properties.map((p) => [p, index![p]])),
      projection: { properties, partial: true as const },
      schema: zodToJsonSchema(picked, name),
    };
  }
  return {
    name,
    operationType,
    formatVersion: FORMAT_VERSION,
    // Index first: clients that truncate large tool results still see every field.
    ...(index ? { properties: index } : {}),
    ...(index && Object.keys(index).length > 24
      ? { hint: 'Pass properties:["animations","start"] to read only selected property schemas.' }
      : {}),
    schema: zodToJsonSchema(schema, name),
  };
}
export const projectSchemaNames = Object.keys(schemas) as [
  keyof typeof schemas,
  ...Array<keyof typeof schemas>,
];
