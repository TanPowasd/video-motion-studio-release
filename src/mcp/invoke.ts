import { z } from 'zod';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from './catalog.js';
import { VmotionError } from '../core/model.js';
export const toolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    response: z.enum(['compact', 'full']).default('compact'),
    fields: z
      .array(
        z
          .string()
          .min(1)
          .max(160)
          .regex(
            /^(?!.*(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$))[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u,
          ),
      )
      .min(1)
      .max(32)
      .optional(),
    media: z.boolean().default(true),
  })
  .strict();
export type BackendCall = (method: string, params: unknown) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;
type JsonContainer = JsonRecord | unknown[];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProperty(value: unknown, key: string): unknown {
  if (isRecord(value)) return value[key];
  if (Array.isArray(value) && /^\d+$/.test(key)) return value[Number(key)];
  return undefined;
}

function hasProperty(value: unknown, key: string): boolean {
  if (isRecord(value)) return Object.hasOwn(value, key);
  if (Array.isArray(value) && /^\d+$/.test(key)) return Object.hasOwn(value, Number(key));
  return false;
}

function writeProperty(container: JsonContainer, key: string, value: unknown) {
  if (Array.isArray(container) && /^\d+$/.test(key)) container[Number(key)] = value;
  else if (isRecord(container)) container[key] = value;
}

function cloneContainer(value: unknown): JsonContainer {
  return Array.isArray(value) ? [...value] : isRecord(value) ? { ...value } : {};
}
const imageMethods = new Set([
  'colorScopes',
  'frameCompare',
  'layerImpact',
  'trackingEvidence',
  'sequenceAudit',
  'frame',
  'sample',
  'drawingFrame',
  'assetThumbnail',
  'projectPreflight',
  'visualAudit',
  'mediaSample',
]);
const retry: Record<string, string> = {
  PARAMETER_PATH:
    'Read component_query or component_parameters for declared relative parameter paths and current array lengths. Correct missing indices/unsafe paths before querying or editing; source files remain unchanged.',
  COMPONENT_TIMEOUT:
    'The worker was retired after 5 seconds. Correct the loop/input or choose a different bounded request, then retry; the next call loads a fresh module. Query failures preserve the project revision.',
  PLUGIN_DEPENDENCY:
    'Inspect plugins_inspect versions/enabled state and register compatible dependencies in the same candidate. Do not delete existing author sources.',
  PLUGIN_CHANGED:
    'Refresh tools_search/tool_schema and the expectedPluginHash. Rebuild the candidate against the current revision; schema/default changes must be explicit.',
  PLUGIN_PARAMETERS:
    'Keep manifest tool parameter definitions and definePluginTool exports identical, then preflight again.',
  PLUGIN_CONTEXT:
    'Read the plugin tool schema and declare/select only the required scene IDs, sequence IDs or files in _context.',
  PLUGIN_MODE:
    'A query tool returned candidate fields. Declare mode=plan in the manifest for operations/files, then rediscover the updated namespaced schema.',
  PLUGIN_NONDETERMINISTIC:
    'Derive IDs and values from arguments/supplied context. Remove wall-clock/random/state-dependent candidate generation; repeat fixed-input evidence before applying.',
  TOOL_SCHEMA_PATH:
    'Read the parent schema branch first and choose an existing object property path; full invocation validation remains active.',
  THEME_TOKEN:
    'Read theme_inspect for inherited/aliased token IDs and layer links. Restore the token or explicitly remove/reset its bindings in the same reviewed candidate.',
  TEMPLATE_CONFLICT:
    'Read template_inspect and keep the old instance while defining parameter/layer migrations or deliberate parameterPolicy/default resets. Preflight the unchanged candidate after resolving the conflict.',
  TEMPLATE_VERSION_CHANGED:
    'Edit the author source and publish a new template version. Linked releases are pinned; use template_plan detach for a private editable copy.',
  TEMPLATE_SHARED_CODE:
    'Inspect the reported dynamic/shared project references. Rewrite author references when pinning is required, or explicitly acknowledge allowSharedCode and review sampled output.',
  TRACKING_LOST:
    'Read tracking_inspect gap ranges and tracking_evidence. Add explicit manual seeds and reanalyze, or deliberately choose loss=hold; no invisible interpolation crosses loss.',
  TRACKING_CONFIDENCE:
    'Inspect photometric/forward-backward evidence; improve seeds/analysis size before lowering minConfidence explicitly.',
  TRACKING_CHANNEL_EXISTS:
    'Inspect existing matrix keys. Set replaceChannels=true only to bake/combine current matrix motion; other animated properties remain editable.',
  TRACKING_SOURCE_EFFECT:
    'Analyze original/unwarped footage or render the effected source and track that new registered asset.',
  TRACKING_TIMEBASE:
    'Regenerate tracking at the current rational project FPS or convert the editable source-frame data explicitly.',
  TEXT_BUDGET:
    'Split long text into separate stable-ID layers; advanced typography supports 4096 graphemes per layer. No text is silently dropped.',
  VECTOR_OFFSET_OPEN:
    'Close every contour or add outline before offset. Use amount=0 to disable expansion without removing indexed channels.',
  GRAPHICS_EXPRESSION_REFERENCE:
    'Rewrite explicit graphics stack index references in expressions before changing topology. Expression targets and keyframe channels follow stable IDs automatically.',
  GRAPHICS_CHANNEL:
    'Remove the reported pathText channels/expressions explicitly before disabling the path configuration.',
  CACHE_BUSY:
    'Wait for active render/proxy/audio tasks to finish or cancel the intended task explicitly, then regenerate/inspect the cache plan. Cleanup does not interrupt creators or delete their sources/checkpoints.',
  MEDIA_RELINK_COMPATIBILITY:
    'Inspect old/new stream metadata. Choose a compatible source or use policy=replace explicitly and review the fixed candidate frames.',
  MEDIA_RELINK_RANGE:
    'Choose a replacement long enough for every existing source range, or edit clip ranges in a separate reviewed candidate first.',
  PROXY_BUSY:
    'Inspect media_proxy status and avoid duplicate asset tasks; start a bounded batch after existing jobs complete.',
  FIELD_BUDGET:
    'Inspect render_profile fieldPixels and use bounded texture regions or fewer radial-ray samples. Change quality explicitly; export dimensions are not lowered automatically.',
  LIGHTING_BUDGET:
    'Reduce explicit ray samples/length, or put the light in a smaller precomposition. The runtime refuses more than 256M scalar samples.',
  VISUAL_TEMPLATE_SELECTION:
    'Request one visual_templates preset before includeGraph=true. Default results summarize all templates without full graphs.',
  SOUND_BUS_CYCLE:
    'Inspect sound_inspect busOrder and break the output/send feedback cycle. Use bounded delay/reverb processors inside an acyclic route.',
  SOUND_SAMPLE:
    'Import an audio/video sample asset and use its stable ID. Nested sound-resource sampling is rejected; export a WAV first when intentional.',
  SOUND_RANGE:
    'Inspect score duration and unit. Extend the score/sequence explicitly or shorten the affected event/placement.',
  SOUND_BUDGET:
    'Split a long score into timeline assets, reduce polyphony/effect work or sample-bank size explicitly. Rendering does not silently lower sound quality.',
  DRIVER_CYCLE:
    'Read drivers_inspect at the common owner scope and break the reported property dependency cycle. Use base/value for the original animated property instead of self-referencing the final property.',
  DRIVER_REFERENCE:
    'Inspect stable IDs in the current scene/component/group and correct the referenced layer ID. External group dependencies are evaluated in their parent scope.',
  DRIVER_CONFLICT:
    'Choose one positional driver: layout or motion path. Explicit property expressions override driver outputs; remove conflicting layout anchors/insets.',
  LAYOUT_CONFLICT:
    'Choose an anchor/size or insets for the same axis; do not use both. Preserve unconstrained size for an aspect ratio.',
  EXPRESSION_SYNTAX:
    'Use the documented numeric expression subset and literal stable layer IDs. General code belongs in TypeScript components.',
  EXPRESSION_VALUE:
    'Inspect the evaluated property and its dependencies; avoid division by zero or nonfinite/domain-invalid functions.',
  MOTION_PATH_SOURCE:
    'Inspect curve_path for an actual vector contour. Provide exactly one SVG path or shape-layer ID.',
  EFFECT_GRAPH_SOURCE:
    'Read effect_graph_inspect/project_file_read and restore the missing resource in the candidate. Graphs resolve from the fixed project snapshot.',
  EFFECT_GRAPH_BINDING:
    'Use effect_graph_inspect to read named input slots, then bind existing sibling layers in the owner scope. The source slot is the incoming stack image.',
  EFFECT_GRAPH_LAYER:
    'Inspect composition IDs at the requested frame/path and update the named input binding; generated sources need stable IDs.',
  EFFECT_GRAPH_SPACE:
    'Precompose the source or bind a sibling group so graph input pixels share the owner parent coordinate space.',
  EFFECT_GRAPH_CYCLE:
    'Inspect topology and subgraph resources; break the reported dependency cycle before preflight. Layer inputs must not recurse into their owner output.',
  EFFECT_GRAPH_PARAMETER:
    'Read graph parameter schemas and reset obsolete params/keys explicitly when upgrading the resource.',
  EFFECT_GRAPH_LINK:
    'Read the targeted graph node and parameter descriptors. Link one numeric leaf field once; initialize valid fields and preserve stable IDs.',
  EFFECT_GRAPH_BUDGET:
    'Reduce reachable branches or source captures explicitly, or choose a smaller preview. The runtime does not change export resolution.',
  MOTION_CHANNEL_EXISTS:
    'Inspect animation_inspect; choose replaceChannels deliberately to replace controlled channels, or merge to keep existing keys and reject time collisions.',
  MOTION_OVERLAP:
    'Sequence cues on a shared property or split them into separate layer groups. Motion plans do not implicitly add overlapping tracks.',
  MOTION_TIME_COLLISION:
    'Increase duration or simplify normalized keys; distinct key times must map to distinct video frames.',
  MOTION_RANGE:
    'Inspect the local composition duration and adjust cue start/duration/target offset or extend that composition explicitly.',
  MOTION_BINDING:
    'Read motion_templates for parameter schemas and cue IDs, then correct bindings. Nested objects preserve siblings; arrays replace as a whole.',
  VISUAL_REPAIR_FIT:
    'Inspect requiredHeight/bounds and explicitly choose text width/font size or a larger canvas. Repairs do not silently scale or shorten content.',
  VISUAL_REPAIR_TRANSFORM:
    'Inspect the owner transform; a zero parent scale cannot convert canvas displacement. Edit owner parameters or source first.',
  VISUAL_REPAIR_TARGET: 'Use one ordered action list per expanded stable layer ID.',
  REVISION_CONFLICT:
    'Read project_context again, rebuild the candidate against the current revision, and preflight.',
  FILE_HASH_CONFLICT: 'Read project_file_read again and use its current hash.',
  CANDIDATE_REVISION: 'Use exactly the operations/files from the inspected preflight.',
  ASSET_CHANGED:
    'Inspect and sample the media again, then rebuild the plan with fresh assetChecks.',
  INVALID_ON_DISK: 'Read pending files and repair using version=pending.',
  UNRESOLVED_CONFLICTS: 'Inspect project_context conflicts and resolve explicitly before editing.',
  VALIDATION_FAILED: 'Fix reported diagnostics, preflight the corrected candidate, then apply.',
  TRACK_LOCKED: 'Inspect the affected track; unlock it explicitly before editing.',
  TOOL_NOT_FOUND: 'Use tools_search to select a real tool name.',
  FILE_WRITE:
    'Inspect the reported file/systemCode, release a persistent file lock or fix storage access, then re-read context before retrying.',
  AGENT_PLAN_MISSING: 'Generate/import the candidate again and use its new planId.',
  AGENT_PLAN_CHANGED: 'Regenerate the candidate; never modify a stored plan file in place.',
  AGENT_PLAN_OVERRIDE:
    'Create a new candidate when operations, files, revision or asset checks must change. Only sampling/output options may override a stored plan.',
  TOOL_ARGUMENTS: 'Read tool_schema for this tool and correct the reported argument paths.',
};
export function toolError(error: unknown): CallToolResult {
  const code =
      error instanceof VmotionError
        ? error.code
        : error instanceof z.ZodError
          ? 'TOOL_ARGUMENTS'
          : 'INTERNAL_ERROR',
    details =
      error instanceof VmotionError
        ? error.details
        : error instanceof z.ZodError
          ? error.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message }))
          : undefined,
    value = {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(details === undefined ? {} : { details }),
      ...(retry[code] ? { recovery: retry[code] } : {}),
    };
  return {
    isError: true,
    structuredContent: { error: value },
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}
export function compactResult(method: string, result: unknown) {
  if (!isRecord(result) || !isRecord(result.snapshot) || method === 'state') return result;
  const { snapshot, pendingFiles, document, ...rest } = result;
  const compactDocument = isRecord(document)
    ? {
        id: document.id,
        name: document.name,
        width: document.width,
        height: document.height,
        layers: Array.isArray(document.layers)
          ? document.layers.filter(isRecord).map((layer) => ({
              id: layer.id,
              name: layer.name,
              visible: layer.visible,
              strokes: Array.isArray(layer.strokes) ? layer.strokes.length : 0,
            }))
          : undefined,
      }
    : undefined;
  return {
    ...rest,
    revision: snapshot.revision,
    pendingFiles: !!pendingFiles,
    ...(compactDocument ? { document: compactDocument } : {}),
  };
}
export async function invokeTool(
  tool: ToolDefinition,
  raw: unknown,
  call: BackendCall,
  options: {
    response?: 'compact' | 'full';
    inline?: boolean;
    fields?: string[];
    media?: boolean;
  } = {},
) {
  if (options.fields) toolCallSchema.shape.fields.parse(options.fields);
  let params: Record<string, unknown>;
  try {
    params = z.object(tool.schema).strict().parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new VmotionError(
        'TOOL_ARGUMENTS',
        `Invalid arguments for ${tool.name}`,
        e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
      );
    throw e;
  }
  const inline = options.media === false ? false : (options.inline ?? true),
    payload =
      imageMethods.has(tool.method) ||
      ['audioPreview', 'soundPreview', 'scene3dRender'].includes(tool.method)
        ? { ...params, inline }
        : ['linearAlgebra', 'matrix3d'].includes(tool.method)
          ? params.request
          : params;
  let rawResult: unknown;
  try {
    rawResult = await call(tool.method, payload);
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new VmotionError(
        'TOOL_ARGUMENTS',
        `Invalid arguments for ${tool.name}`,
        e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
      );
    throw e;
  }
  if (
    rawResult === undefined ||
    typeof rawResult === 'function' ||
    typeof rawResult === 'symbol' ||
    typeof rawResult === 'bigint'
  )
    throw new VmotionError('TOOL_RESULT', 'Backend returned an unsupported result');
  const result = options.response === 'full' ? rawResult : compactResult(tool.method, rawResult);
  const media: ContentBlock[] = [];
  let value: unknown = result;
  if (
    tool.method === 'scene3dRender' &&
    (!isRecord(result) ||
      !Array.isArray(result.images) ||
      result.images.some(
        (image) => !isRecord(image) || (image.data !== undefined && typeof image.data !== 'string'),
      ))
  )
    throw new VmotionError('TOOL_RESULT', '3D frame evidence must contain image records');
  if (
    isRecord(result) &&
    imageMethods.has(tool.method) &&
    result.data !== undefined &&
    typeof result.data !== 'string'
  )
    throw new VmotionError('TOOL_RESULT', 'Inline image evidence must be a string');
  if (tool.method === 'scene3dRender' && isRecord(result) && Array.isArray(result.images)) {
    const { images, ...info } = result;
    const records = images.filter(isRecord);
    value = { ...info, images: records.map(({ data: _data, ...image }) => image) };
    for (const image of records)
      if (typeof image.data === 'string')
        media.push({ type: 'image', data: image.data, mimeType: 'image/png' });
  } else if (
    isRecord(result) &&
    typeof result.data === 'string' &&
    (imageMethods.has(tool.method) || ['audioPreview', 'soundPreview'].includes(tool.method))
  ) {
    const { data, ...info } = result;
    value = info;
    media.push(
      ['audioPreview', 'soundPreview'].includes(tool.method)
        ? { type: 'audio', data: data as string, mimeType: 'audio/wav' }
        : { type: 'image', data: data as string, mimeType: 'image/png' },
    );
  }
  // A few legacy mutations already exposed compact fields; full mode preserves their legacy shape.
  if (options.response === 'full' && tool.method === 'animationEdit' && isRecord(result))
    value = {
      revision: isRecord(result.snapshot) ? result.snapshot.revision : undefined,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    };
  if (options.response === 'full' && tool.method === 'componentParametersEdit' && isRecord(result))
    value = {
      revision: isRecord(result.snapshot) ? result.snapshot.revision : undefined,
      values: result.parameterValues,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    };
  const structuredContent: JsonRecord = isRecord(value) ? value : { result: value };
  const projected = options.fields
    ? projectToolResult(structuredContent, options.fields)
    : structuredContent;
  return {
    value: options.fields ? projected : value,
    result: {
      structuredContent: projected,
      content: [
        { type: 'text' as const, text: JSON.stringify(options.fields ? projected : value) },
        ...(options.media === false ? [] : media),
      ],
    } satisfies CallToolResult,
  };
}
export function projectToolResult(value: Record<string, unknown>, fields: string[]) {
  const valid = toolCallSchema.shape.fields.parse(fields)!,
    result: JsonRecord = {},
    missing: string[] = [];
  for (const path of [...new Set(valid)]) {
    const parts = path.split('.');
    let source: unknown = value,
      target: JsonContainer = result;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!hasProperty(source, part)) {
        missing.push(path);
        break;
      }
      const next = readProperty(source, part);
      source = next;
      if (index === parts.length - 1) writeProperty(target, part, source);
      else {
        const current = readProperty(target, part);
        const child = cloneContainer(current);
        writeProperty(target, part, child);
        target = child;
      }
    }
  }
  for (const key of ['revision', 'baseRevision', 'candidateRevision', 'applied', 'valid'])
    if (Object.hasOwn(value, key)) result[key] = value[key];
  return { ...result, resultProjection: { fields: [...new Set(valid)], missing, partial: true } };
}
