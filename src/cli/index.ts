#!/usr/bin/env node
import { Command, Option } from 'commander';
import path from 'node:path';
import { Application } from '../service/application.js';
import { initProject } from '../service/template.js';
import { existingService, rpc, servePipe } from '../service/ipc.js';
import { serveHttp } from '../service/http.js';
import { startMcp } from '../mcp/server.js';
import { VmotionError } from '../core/model.js';
import { animationReference } from '../sdk/reference.js';
import { pathGeometry } from '../core/vector.js';
import { describeRepeater } from '../sdk/repeater.js';
import { linearAlgebra } from '../service/linear-algebra.js';
import { matrix3d } from '../service/matrix3d.js';
import { toolDefinitions } from '../mcp/catalog.js';
import { projectPluginTools } from '../mcp/plugin-tools.js';
import { searchTools, toolSchema, toolSchemaRequestSchema, findTool } from '../mcp/discovery.js';

const program = new Command()
  .name('vmotion')
  .description('Local programmable video workstation — external agents welcome')
  .version('0.1.0');
program
  .command('matrix3d')
  .description(
    'Evaluate 4x4 transforms, cameras, projected vertices and shaded mesh geometry (no project required)',
  )
  .requiredOption('--request <file>', 'Matrix 3D JSON request')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(matrix3d(JSON.parse(await readFile(o.request, 'utf8'))));
  });
const output = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
const fail = (e: unknown) => {
  process.stderr.write(
    JSON.stringify(
      {
        error: {
          code: e instanceof VmotionError ? e.code : 'ERROR',
          message: (e as Error).message,
          details: e instanceof VmotionError ? e.details : undefined,
        },
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = 1;
};
function projectCommand(name: string, description: string) {
  return program
    .command(name)
    .description(description)
    .option('-p, --project <directory>', 'Project directory', '.')
    .option('--json', 'Structured JSON output (also the default)');
}
program
  .command('linear-algebra')
  .description(
    'Run bounded matrix, fitting, point-transform or quadratic-optimization calculations (no project required)',
  )
  .requiredOption('--request <file>', 'Numerical JSON request')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(linearAlgebra(JSON.parse(await readFile(o.request, 'utf8'))));
  });
projectCommand('agent-guide', 'Read concise external-agent workflow routing')
  .option(
    '--topic <topic>',
    'overview, animation, effects, editing, 3d, math or recovery',
    'overview',
  )
  .action(async (o) => output(await withProject(o.project, 'agentGuide', { topic: o.topic })));
async function withProject(root: string, method: string, params: unknown = {}) {
  root = path.resolve(root);
  if (await existingService(root)) return rpc(root, method, params);
  const app = await new Application(root).open(false);
  try {
    return await app.dispatch(method, params);
  } finally {
    await app.close();
  }
}
projectCommand(
  'tracking-analyze',
  'Analyze motion with a background service, or wait in a headless standalone CLI',
)
  .requiredOption('--request <file>', 'JSON action/request/id')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises'),
      request = JSON.parse(await readFile(o.request, 'utf8'));
    if (!(await existingService(o.project))) {
      request.wait = true;
    }
    const result = await withProject(o.project, 'trackingAnalyze', request);
    if (result.status === 'failed' || result.status === 'cancelled')
      throw new VmotionError(
        result.error?.code ?? 'TRACKING_ANALYSIS',
        result.error?.message ?? 'Tracking failed',
      );
    output(result);
  });
program
  .command('path')
  .description('Compute native SVG geometry from a JSON request (no project required)')
  .requiredOption('--request <file>', 'Path geometry JSON file')
  .option('--json', 'Structured JSON output (default)')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(pathGeometry(JSON.parse(await readFile(o.request, 'utf8'))));
  });
projectCommand('vector-bake', 'Create an editable static path snapshot and preserve source layers')
  .requiredOption('--request <file>', 'JSON scene/path/nodeIds/operation request')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(
      await withProject(o.project, 'vectorBake', JSON.parse(await readFile(o.request, 'utf8'))),
    );
  });
projectCommand('repeat-create', 'Create a programmable repeater from selected sibling layers')
  .requiredOption('--request <file>', 'JSON scene/path/nodeIds/parameters request')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(
      await withProject(o.project, 'repeatCreate', JSON.parse(await readFile(o.request, 'utf8'))),
    );
  });
for (const [name, method, description] of [
  ['precompose', 'scenePrecompose', 'Create a reusable shared scene from selected layers'],
  ['scene-place', 'scenePlace', 'Place a reusable scene reference in a composition'],
  [
    'scene-reset',
    'sceneReset',
    'Reset internal instance overrides while preserving shared sources',
  ],
] as const)
  projectCommand(name, description)
    .requiredOption('--request <file>', 'JSON scene/path/node request')
    .action(async (o) => {
      const { readFile } = await import('node:fs/promises');
      output(await withProject(o.project, method, JSON.parse(await readFile(o.request, 'utf8'))));
    });
projectCommand('scene-refs', 'Inspect shared scene dependencies and incoming references')
  .requiredOption('--source <id>')
  .action(async (o) =>
    output(await withProject(o.project, 'sceneReferences', { sourceId: o.source })),
  );
for (const [name, method] of [
  ['project-diagnostics', 'projectDiagnostics'],
  ['project-references', 'projectReferences'],
  ['reference-plan', 'referencePlan'],
  ['reference-sample', 'referenceSample'],
  ['color-scopes', 'colorScopes'],
  ['frame-compare', 'frameCompare'],
  ['layer-impact', 'layerImpact'],
  ['sequence-query', 'sequenceQuery'],
  ['time-inspect', 'timeInspect'],
  ['time-edit', 'timeEdit'],
  ['sequence-edit', 'sequenceEdit'],
  ['captions-import', 'captionsImport'],
  ['media-inspect', 'mediaInspect'],
  ['media-sample', 'mediaSample'],
  ['sequence-plan', 'sequencePlan'],
  ['scene3d-render', 'scene3dRender'],
  ['mesh-generate', 'meshGenerate'],
  ['mesh-import', 'meshImport'],
  ['mesh-inspect', 'meshInspect'],
  ['scene3d-materials', 'scene3dMaterials'],
  ['effects-guide', 'effectsGuide'],
  ['drivers-inspect', 'driversInspect'],
  ['drivers-plan', 'driversPlan'],
  ['curve-path', 'curvePath'],
  ['sound-library', 'soundLibrary'],
  ['sound-inspect', 'soundInspect'],
  ['sound-plan', 'soundPlan'],
  ['sound-preview', 'soundPreview'],
  ['sound-export', 'soundExport'],
  ['sound-midi', 'soundMidi'],
  ['render-profile', 'renderProfile'],
  ['render-compare', 'renderCompare'],
  ['animation-layers-inspect', 'animationLayersInspect'],
  ['animation-layers-plan', 'animationLayersPlan'],
  ['media-status', 'mediaStatus'],
  ['media-relink-plan', 'mediaRelinkPlan'],
  ['media-proxy', 'mediaProxy'],
  ['cache-inspect', 'cacheInspect'],
  ['cache-plan', 'cachePlan'],
  ['cache-apply', 'cacheApply'],
  ['visual-templates', 'visualTemplates'],
  ['visual-plan', 'visualPlan'],
  ['storyboard-plan', 'storyboardPlan'],
  ['storyboard-inspect', 'storyboardInspect'],
  ['sequence-audit', 'sequenceAudit'],
  ['transition-plan', 'transitionPlan'],
  ['audio-mix-inspect', 'audioMixInspect'],
  ['audio-mix-plan', 'audioMixPlan'],
  ['audio-audit', 'audioAudit'],
  ['effect-graph-inspect', 'effectGraphInspect'],
  ['effect-graph-query', 'effectGraphQuery'],
  ['effect-graph-plan', 'effectGraphPlan'],
  ['particles-inspect', 'particlesInspect'],
  ['particles-plan', 'particlesPlan'],
  ['motion-templates', 'motionTemplates'],
  ['motion-plan', 'motionPlan'],
  ['visual-repair-plan', 'visualRepairPlan'],
  ['effects-inspect', 'effectsInspect'],
  ['effects-plan', 'effectsPlan'],
  ['graphics-inspect', 'graphicsInspect'],
  ['graphics-plan', 'graphicsPlan'],
  ['tracking-inspect', 'trackingInspect'],
  ['tracking-plan', 'trackingPlan'],
  ['tracking-evidence', 'trackingEvidence'],
  ['theme-inspect', 'themeInspect'],
  ['theme-plan', 'themePlan'],
  ['template-inspect', 'templateInspect'],
  ['template-plan', 'templatePlan'],
  ['plugins-inspect', 'pluginsInspect'],
  ['plugins-plan', 'pluginsPlan'],
  ['plugins-package', 'pluginsPackage'],
] as const)
  projectCommand(name, 'Inspect or edit visual content time mapping')
    .requiredOption('--request <file>', 'JSON scene/node/path/frame/clock request')
    .action(async (o) => {
      const { readFile } = await import('node:fs/promises');
      output(await withProject(o.project, method, JSON.parse(await readFile(o.request, 'utf8'))));
    });
program
  .command('repeat-describe')
  .description('Compute a repeat pattern without opening a project')
  .requiredOption('--request <file>', 'JSON parameters/indices/sourceBounds request')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(describeRepeater(JSON.parse(await readFile(o.request, 'utf8'))));
  });
projectCommand('init', 'Create a local blank or science project')
  .option('--name <name>', 'Project name', '未命名项目')
  .option('--template <blank|science>', 'Project template', 'blank')
  .option('--width <pixels>', 'Canvas width', '1920')
  .option('--height <pixels>', 'Canvas height', '1080')
  .option('--fps <number>', 'Integer frame rate', '30')
  .option('--duration <seconds>', 'Initial duration', '10')
  .action(async (options) =>
    output({
      project: await initProject(path.resolve(options.project), options.name, {
        template: options.template,
        width: Number(options.width),
        height: Number(options.height),
        fps: { num: Number(options.fps), den: 1 },
        durationSeconds: Number(options.duration),
      }),
      path: path.resolve(options.project),
    }),
  );
projectCommand('inspect', 'Inspect source, nodes, tracks and diagnostics').action(async (options) =>
  output(await withProject(options.project, 'state')),
);
projectCommand('context', 'Read concise project IDs, source hashes, diagnostics and selection')
  .option('--scene <id>')
  .option('--sequence <id>')
  .option('--offset <number>', 'Page offset', '0')
  .option('--limit <number>', 'Page length', '100')
  .action(async (o) =>
    output(
      await withProject(o.project, 'projectContext', {
        sceneId: o.scene,
        sequenceId: o.sequence,
        offset: Number(o.offset),
        limit: Number(o.limit),
      }),
    ),
  );
projectCommand('audit', 'Inspect visual layout and sampled motion with annotated frame evidence')
  .requiredOption('--scene <id>')
  .option('--path <json>', 'Composition path', '[]')
  .option('--frames <list>', 'Comma-separated frames; omitted samples the scene')
  .option('--options-file <path>', 'JSON thresholds and node filters')
  .option('--width <pixels>', 'Evidence tile width', '480')
  .option('--max-images <number>', 'Evidence frame limit', '8')
  .option('--no-images')
  .option('--revision <hash>')
  .option('-o, --output <path>')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises'),
      report = await withProject(o.project, 'visualAudit', {
        sceneId: o.scene,
        path: JSON.parse(o.path),
        frames: o.frames ? o.frames.split(',').map(Number) : undefined,
        options: o.optionsFile ? JSON.parse(await readFile(o.optionsFile, 'utf8')) : {},
        width: Number(o.width),
        maxImages: Number(o.maxImages),
        images: o.images,
        revision: o.revision,
        output: o.output,
      });
    output(report);
    if (report.summary.status === 'failed') process.exitCode = 2;
  });
projectCommand('component-params', 'Inspect typed parameters of a programmable component')
  .requiredOption('--scene <id>')
  .requiredOption('--node <id>')
  .option('--path <json>', 'Composition path', '[]')
  .option('--frame <number>', 'Evaluation frame', '0')
  .action(async (o) =>
    output(
      await withProject(o.project, 'componentParameters', {
        sceneId: o.scene,
        nodeId: o.node,
        path: JSON.parse(o.path),
        frame: Number(o.frame),
      }),
    ),
  );
projectCommand('animation', 'Inspect layer keyframes and sampled values/velocities')
  .requiredOption('--scene <id>')
  .requiredOption('--node <id>')
  .option('--path <json>', 'Composition path', '[]')
  .option('--frame <number>', 'Inspection frame', '0')
  .option('--frames <list>', 'Comma-separated sample frames')
  .option('--offset <number>', 'Keyframe page offset', '0')
  .option('--limit <number>', 'Keys per channel', '200')
  .action(async (o) =>
    output(
      await withProject(o.project, 'animationInspect', {
        sceneId: o.scene,
        nodeId: o.node,
        path: JSON.parse(o.path),
        frame: Number(o.frame),
        frames: o.frames ? o.frames.split(',').map(Number) : [],
        offset: Number(o.offset),
        limit: Number(o.limit),
      }),
    ),
  );
projectCommand('audio-timeline', 'Inspect audible clip sample positions and nested mix envelopes')
  .option('--sequence <id>')
  .action(async (o) =>
    output(await withProject(o.project, 'audioTimeline', { sequenceId: o.sequence })),
  );
projectCommand('audio-preview', 'Render a short actual sequence mix and report sound levels')
  .option('--sequence <id>')
  .option('--start-sample <number>', 'Start sample at 48 kHz', '0')
  .option('--samples <number>', 'Sample count, max 480000', '192000')
  .option('--revision <hash>')
  .option('-o, --output <path>')
  .action(async (o) =>
    output(
      await withProject(o.project, 'audioPreview', {
        sequenceId: o.sequence,
        startSample: Number(o.startSample),
        sampleCount: Number(o.samples),
        revision: o.revision,
        output: o.output,
      }),
    ),
  );
projectCommand('animate', 'Apply an atomic keyframe request from JSON')
  .requiredOption('--request-file <path>')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises'),
      result = await withProject(
        o.project,
        'animationEdit',
        JSON.parse(await readFile(o.requestFile, 'utf8')),
      );
    output({
      revision: result.snapshot.revision,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    });
  });
projectCommand(
  'component-edit',
  'Edit component parameters and numeric keyframes using a JSON request',
)
  .requiredOption('--request-file <path>')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    const result = await withProject(
      o.project,
      'componentParametersEdit',
      JSON.parse(await readFile(o.requestFile, 'utf8')),
    );
    output({
      revision: result.snapshot.revision,
      values: result.parameterValues,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    });
  });
projectCommand('schema', 'Read one authoritative project or operation schema')
  .requiredOption('--name <name>')
  .option('--operation <type>')
  .action(async (o) =>
    output(
      await withProject(o.project, 'projectSchema', { name: o.name, operationType: o.operation }),
    ),
  );
projectCommand('read', 'Read a project source file range with its content hash')
  .requiredOption('--file <path>')
  .option('--start-line <number>', 'First line', '1')
  .option('--line-count <number>', 'Maximum lines', '200')
  .option('--pending', 'Read pending external edits')
  .action(async (o) =>
    output(
      await withProject(o.project, 'projectFileRead', {
        path: o.file,
        startLine: Number(o.startLine),
        lineCount: Number(o.lineCount),
        version: o.pending ? 'pending' : 'active',
      }),
    ),
  );
for (const method of ['preflight', 'apply'])
  projectCommand(
    method,
    method === 'preflight'
      ? 'Validate candidate edits and sample frames without saving project changes'
      : 'Validate and commit an inspected candidate atomically',
  )
    .requiredOption(
      '--request-file <path>',
      'JSON request containing operations/files/samples and revision checks',
    )
    .action(async (o) => {
      const { readFile } = await import('node:fs/promises'),
        request = JSON.parse(await readFile(o.requestFile, 'utf8')),
        result = await withProject(
          o.project,
          method === 'preflight' ? 'projectPreflight' : 'projectApply',
          request,
        );
      output(result);
      if (!result.valid) process.exitCode = 2;
    });
program
  .command('guide')
  .description('Read the animation/effects API and agent workflow')
  .action(() => output(animationReference));
projectCommand('sample', 'Render 1–12 frames into an animation contact sheet')
  .requiredOption('--frames <list>', 'Comma-separated frame numbers')
  .option('--scene <id>')
  .option('--width <pixels>', 'Each tile width', '640')
  .option('-o, --output <file>')
  .action(async (o) =>
    output(
      await withProject(o.project, 'sample', {
        frames: o.frames.split(',').map(Number),
        sceneId: o.scene,
        width: Number(o.width),
        output: o.output,
      }),
    ),
  );
projectCommand('validate', 'Validate project and component compilation').action(async (options) => {
  const result = await withProject(options.project, 'validate');
  output(result);
  if (!result.valid) process.exitCode = 2;
});
projectCommand('audio-analyze', 'Analyze an audio asset range for reactive animation')
  .requiredOption('--asset <id>')
  .option('--start <seconds>', 'Start time', '0')
  .option('--duration <seconds>', 'Range duration, maximum 600s', '60')
  .option('--rate <number>', 'Feature samples per second', '30')
  .action(async (o) =>
    output(
      await withProject(o.project, 'audioAnalyze', {
        assetId: o.asset,
        start: Number(o.start),
        duration: Number(o.duration),
        rate: Number(o.rate),
      }),
    ),
  );
projectCommand('lut', 'Import .cube LUT into a layer effect stack')
  .requiredOption('--file <path>')
  .requiredOption('--scene <id>')
  .requiredOption('--node <id>')
  .option('--intensity <number>', 'Mix amount', '1')
  .action(async (o) =>
    output(
      await withProject(o.project, 'importLut', {
        path: o.file,
        sceneId: o.scene,
        nodeId: o.node,
        intensity: Number(o.intensity),
      }),
    ),
  );
projectCommand('frame', 'Render one frame with the native Skia core')
  .option('--frame <number>', 'Frame number', '0')
  .option('-o, --output <file>', 'Output PNG')
  .option('--width <pixels>')
  .option('--height <pixels>')
  .option('--scene <id>')
  .option('--path <json>', 'Isolated composition path', '[]')
  .option('--context <json>', 'Pinned ancestor content frames', '[]')
  .action(async (o) =>
    output(
      await withProject(o.project, 'frame', {
        frame: Number(o.frame),
        output: o.output,
        width: o.width ? Number(o.width) : undefined,
        height: o.height ? Number(o.height) : undefined,
        sceneId: o.scene,
        path: JSON.parse(o.path),
        contextFrames: JSON.parse(o.context),
      }),
    ),
  );
projectCommand('render', 'Export video, PNG sequence or WAV audio')
  .requiredOption('-o, --output <path>')
  .option('--format <format>', 'mp4, png or wav', 'mp4')
  .option('--start <frame>')
  .option('--end <frame>')
  .option('--width <pixels>')
  .option('--height <pixels>')
  .option('--encoder <name>', 'FFmpeg encoder override')
  .option('--gpu <mode>', 'Point-effect backend: cpu, auto or gpu')
  .option('--no-resume', 'Ignore completed checkpoints')
  .option('--revision <hash>', 'Require the accepted project revision')
  .action(async (o) => {
    if (!['mp4', 'png', 'wav'].includes(o.format))
      throw new VmotionError('FORMAT', 'Expected mp4, png or wav');
    const root = path.resolve(o.project),
      remote = await existingService(root),
      app = remote ? undefined : await new Application(root).open(false);
    const call = (method: string, params: unknown) =>
      app ? app.dispatch(method, params) : rpc(root, method, params);
    try {
      const job = await call('render', {
        output: o.output,
        format: o.format,
        start: o.start ? Number(o.start) : undefined,
        end: o.end ? Number(o.end) : undefined,
        width: o.width ? Number(o.width) : undefined,
        height: o.height ? Number(o.height) : undefined,
        encoder: o.encoder,
        gpu: o.gpu,
        resume: o.resume,
        revision: o.revision,
      });
      let final = job;
      if (app) final = await app.renders.wait(job.id);
      else {
        while (['queued', 'running'].includes(final.status)) {
          await new Promise((r) => setTimeout(r, 250));
          final = await call('job', { id: job.id });
        }
      }
      output(final);
      if (final.status !== 'completed') process.exitCode = 3;
    } finally {
      await app?.close();
    }
  });
projectCommand('pack', 'Collect portable source and assets')
  .requiredOption('-o, --output <directory>')
  .action(async (o) => output(await withProject(o.project, 'pack', { output: o.output })));
projectCommand('transact', 'Apply operations from JSON')
  .requiredOption('--operations <json>')
  .option('--revision <hash>')
  .action(async (o) =>
    output(
      await withProject(o.project, 'transact', {
        operations: JSON.parse(o.operations),
        revision: o.revision,
      }),
    ),
  );
projectCommand('mcp', 'Start stdio MCP; attach to an open editor when available')
  .addOption(
    new Option('--tools <mode>', 'compact discovery or all legacy direct tools')
      .choices(['compact', 'all'])
      .default('compact'),
  )
  .action(async (o) => {
    await startMcp(path.resolve(o.project), { tools: o.tools });
  });
program
  .command('tools-search')
  .description('Search concise agent capability metadata without opening a project')
  .option('--query <text>', 'English/Chinese terms', '')
  .option('--category <name>')
  .option('--plugin <id>', 'Filter by plugin ID')
  .option('--project <directory>', 'Include enabled project plugin tools')
  .option('--offset <number>', 'Result offset', '0')
  .option('--limit <number>', 'Page size', '12')
  .option('--detail', 'Include argument names and full discovery metadata')
  .action(async (o) =>
    output(
      searchTools(
        [
          ...toolDefinitions(),
          ...(o.project
            ? projectPluginTools(await withProject(o.project, 'pluginCatalog', {}))
            : []),
        ],
        {
          query: o.query,
          category: o.category,
          pluginId: o.plugin,
          offset: Number(o.offset),
          limit: Number(o.limit),
          detail: !!o.detail,
        },
      ),
    ),
  );
program
  .command('tool-schema')
  .description('Read one exact agent tool input interface without opening a project')
  .requiredOption('--name <tool>')
  .option('--project <directory>', 'Include enabled project plugin interfaces')
  .option('--expanded', 'Return the legacy inline schema')
  .option('--detail', 'Include full interface description and invocation metadata')
  .option('--if-hash <hash>', 'Return notModified when the cached interface is current')
  .option(
    '--paths <list>',
    'Comma-separated property paths for a partial schema; invocation still validates the full tool',
  )
  .action(async (o) => {
    const request = toolSchemaRequestSchema.parse({
      name: o.name,
      format: o.expanded ? 'expanded' : 'compact',
      detail: !!o.detail,
      ifHash: o.ifHash,
      paths: o.paths?.split(',').filter(Boolean),
    });
    output(
      toolSchema(
        [
          ...toolDefinitions(),
          ...(o.project
            ? projectPluginTools(await withProject(o.project, 'pluginCatalog', {}))
            : []),
        ],
        request.name,
        request,
      ),
    );
  });
projectCommand('tool-call', 'Invoke a capability using the same agent schema with concise results')
  .requiredOption('--name <tool>')
  .option('--request <file>', 'JSON tool arguments')
  .option('--full', 'Return legacy result')
  .option('--fields <list>', 'Comma-separated result paths; revision metadata retained')
  .option('--no-media', 'Do not render inline media blocks')
  .option('--inline', 'Include native media data in JSON')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    const params = o.request ? JSON.parse(await readFile(o.request, 'utf8')) : {};
    const selectedTool = toolDefinitions().find((t) => t.name === o.name);
    const invoked = await withProject(o.project, 'agentToolInvoke', {
      name: o.name,
      arguments: params,
      response: o.full ? 'full' : 'compact',
      fields: o.fields?.split(',').filter(Boolean),
      media: o.media,
      inline: !!o.inline,
    });
    output(
      o.inline
        ? {
            result: invoked.value,
            media: invoked.result.content.filter(
              (block: { type: string }) => block.type !== 'text',
            ),
          }
        : invoked.value,
    );
    if (
      ['projectPreflight', 'validate'].includes(selectedTool?.method ?? '') &&
      invoked.value.valid === false
    )
      process.exitCode = 2;
  });
projectCommand('structure', 'Edit scene/group/component structure using a JSON action file')
  .requiredOption('--scene <id>')
  .requiredOption('--action-file <path>')
  .option('--path <json>', 'Composition navigation path', '[]')
  .option('--frame <number>', 'Frame used to inspect generated content', '0')
  .option('--revision <hash>')
  .action(async (o) => {
    const { readFile } = await import('node:fs/promises');
    output(
      await withProject(o.project, 'compositionStructure', {
        sceneId: o.scene,
        path: JSON.parse(o.path),
        frame: Number(o.frame),
        action: JSON.parse(await readFile(o.actionFile, 'utf8')),
        revision: o.revision,
      }),
    );
  });
projectCommand(
  'drawing <action>',
  'Create, inspect, edit, publish or preview independent layered drawings',
)
  .option('--id <id>', 'Drawing document ID')
  .option('--asset <id>', 'Drawing asset to open')
  .option('--name <name>')
  .option('--width <pixels>')
  .option('--height <pixels>')
  .option('--operations-file <path>', 'JSON file containing drawing edit operations')
  .option('--layers <json>', 'Selected layer IDs to publish; omitted publishes the whole drawing')
  .option('-o, --output <path>', 'Output image for frame')
  .option('--revision <hash>')
  .action(async (action, o) => {
    const methods: Record<string, string> = {
        list: 'drawingList',
        create: 'drawingCreate',
        inspect: 'drawingGet',
        edit: 'drawingEdit',
        publish: 'drawingPublish',
        open: 'drawingOpenAsset',
        frame: 'drawingFrame',
      },
      method = methods[action];
    if (!method)
      throw new VmotionError(
        'DRAWING_COMMAND',
        'Use list, create, inspect, edit, publish, open or frame',
      );
    if (['inspect', 'edit', 'publish', 'frame'].includes(action) && !o.id)
      throw new VmotionError('DRAWING_ID', '--id is required');
    if (action === 'open' && !o.asset)
      throw new VmotionError('DRAWING_ASSET', '--asset is required');
    if (action === 'edit' && !o.operationsFile)
      throw new VmotionError('DRAWING_OPERATIONS', '--operations-file is required');
    const { readFile } = await import('node:fs/promises');
    output(
      await withProject(o.project, method, {
        id: o.id,
        assetId: o.asset,
        name: o.name,
        width: o.width ? Number(o.width) : undefined,
        height: o.height ? Number(o.height) : undefined,
        revision: o.revision,
        output: o.output,
        operations: o.operationsFile
          ? JSON.parse(await readFile(o.operationsFile, 'utf8'))
          : undefined,
        layerIds: o.layers ? JSON.parse(o.layers) : undefined,
      }),
    );
  });
projectCommand('asset-place', 'Place an asset in a composition or sequence')
  .requiredOption('--asset <id>')
  .option('--scene <id>')
  .option('--path <json>', 'Composition path', '[]')
  .option('--sequence <id>')
  .option('--track <id>')
  .option('--frame <number>', 'Start frame', '0')
  .option('--duration <frames>')
  .option('--x <number>')
  .option('--y <number>')
  .option('--revision <hash>')
  .action(async (o) =>
    output(
      await withProject(o.project, 'assetPlace', {
        assetId: o.asset,
        sceneId: o.scene,
        path: JSON.parse(o.path),
        sequenceId: o.sequence,
        trackId: o.track,
        frame: Number(o.frame),
        duration: o.duration ? Number(o.duration) : undefined,
        x: o.x === undefined ? undefined : Number(o.x),
        y: o.y === undefined ? undefined : Number(o.y),
        revision: o.revision,
      }),
    ),
  );
projectCommand('serve', 'Run a local editor service')
  .option('--port <number>', 'HTTP port', '4318')
  .action(async (o) => {
    const app = await new Application(path.resolve(o.project)).open(),
      pipe = await servePipe(app),
      http = await serveHttp(app, Number(o.port));
    output({ url: `http://127.0.0.1:${o.port}`, project: app.service.snapshot.project.name });
    const stop = async () => {
      pipe.close();
      http.closeAllConnections();
      http.close();
      await app.close();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  });
// The CLI always runs with Node-style argv, including Electron's ELECTRON_RUN_AS_NODE runtime.
program.parseAsync(process.argv, { from: 'node' }).catch(fail);
