import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packageRoot = path.resolve('release/Vmotion'),
  root = path.resolve(process.argv[2]),
  client = new Client({ name: 'vmotion-packaged-mcp-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: path.join(packageRoot, 'Vmotion.exe'),
    args: [
      path.join(packageRoot, 'resources/app/dist/cli/index.mjs'),
      'mcp',
      '--project',
      root,
      '--tools',
      'all',
    ],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
      ELECTRON_RUN_AS_NODE: '1',
      ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
    },
    stderr: 'pipe',
  });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (
    ![
      'agent_guide',
      'media_inspect',
      'media_sample',
      'sequence_plan',
      'linear_algebra',
      'matrix3d',
    ].every((name) => tools.tools.some((t) => t.name === name))
  )
    throw new Error('Packaged agent tools missing');
  const matrix = await client.callTool({
    name: 'matrix3d',
    arguments: { request: { operation: 'compose', transform: { position: { x: 1, y: 2, z: 3 } } } },
  });
  if (matrix.isError || JSON.parse(matrix.content[0].text).result.matrix[3] !== 1)
    throw new Error('Packaged 3D matrices failed');
  if (!['time_inspect', 'time_edit'].every((name) => tools.tools.some((t) => t.name === name)))
    throw new Error('Packaged time tools missing');
  if (
    !['sequence_edit', 'captions_import', 'captions_inspect'].every((name) =>
      tools.tools.some((t) => t.name === name),
    )
  )
    throw new Error('Packaged editing tools missing');
  if (
    !['scene_precompose', 'scene_place', 'scene_references'].every((name) =>
      tools.tools.some((t) => t.name === name),
    )
  )
    throw new Error('Packaged shared scene tools missing');
  const pattern = await client.callTool({
    name: 'repeat_describe',
    arguments: {
      parameters: { count: 3, position: { x: 40, y: 0 } },
      sourceBounds: { x: 0, y: 0, width: 20, height: 20 },
    },
  });
  if (pattern.isError || JSON.parse(pattern.content[0].text).bounds.width !== 100)
    throw new Error('Packaged repeat transforms failed');
  const geometry = await client.callTool({
    name: 'path_geometry',
    arguments: {
      operation: 'difference',
      paths: [{ path: 'M0 0H100V100H0Z' }, { path: 'M25 25H75V75H25Z' }],
    },
  });
  if (geometry.isError || JSON.parse(geometry.content[0].text).bounds.width !== 100)
    throw new Error('Packaged native vector geometry failed');
  const listed = await client.callTool({ name: 'drawing_list', arguments: {} }),
    docs = JSON.parse(listed.content[0].text);
  let drawingImage = false;
  if (docs.length) {
    const image = await client.callTool({
      name: 'drawing_frame',
      arguments: { id: docs[0].id, width: 320, height: 180 },
    });
    if (image.isError || !image.content.some((block) => block.type === 'image'))
      throw new Error('Packaged MCP did not return a drawing image');
    drawingImage = true;
  }
  const contextResult = await client.callTool({ name: 'project_context', arguments: { limit: 5 } }),
    context = JSON.parse(contextResult.content[0].text);
  const refs = await client.callTool({
    name: 'scene_references',
    arguments: { sourceId: context.scenes[0].id },
  });
  if (refs.isError || JSON.parse(refs.content[0].text).revision !== context.revision)
    throw new Error('Packaged scene references failed');
  const preflightResult = await client.callTool({
      name: 'project_preflight',
      arguments: {
        revision: context.revision,
        samples: [
          { sceneId: context.scenes[0].id, frame: 0 },
          { sceneId: context.scenes[0].id, frame: 30 },
        ],
        width: 240,
        determinism: true,
      },
    }),
    report = JSON.parse(preflightResult.content[0].text);
  if (
    preflightResult.isError ||
    !report.valid ||
    !preflightResult.content.some((block) => block.type === 'image')
  )
    throw new Error('Packaged preflight did not return valid frame images');
  const schemaResult = await client.callTool({
    name: 'project_schema',
    arguments: { name: 'fileEdit' },
  });
  if (schemaResult.isError) throw new Error('Packaged schema query failed');
  const visual = await client.callTool({
    name: 'visual_audit',
    arguments: { sceneId: context.scenes[0].id, frames: [0, 30], width: 240, maxImages: 2 },
  });
  if (
    visual.isError ||
    !visual.content.some((block) => block.type === 'image') ||
    JSON.parse(visual.content[0].text).frames.length !== 2
  )
    throw new Error('Packaged visual audit failed');
  const audio = await client.callTool({
    name: 'audio_preview',
    arguments: { sequenceId: context.project.activeSequence, startSample: 0, sampleCount: 24000 },
  });
  if (audio.isError || !audio.content.some((block) => block.type === 'audio'))
    throw new Error('Packaged audio preview failed');
  const stateful = await client.callTool({
      name: 'project_context',
      arguments: { sceneId: context.scenes[0].id, limit: 100 },
    }),
    details = JSON.parse(stateful.content[0].text),
    component = details.scene.nodes.find((n) => n.type === 'component');
  let structuredParameters = false;
  if (component) {
    const parameters = await client.callTool({
      name: 'component_parameters',
      arguments: { sceneId: context.scenes[0].id, nodeId: component.id, frame: 0 },
    });
    if (parameters.isError) throw new Error('Packaged parameter query failed');
    const info = JSON.parse(parameters.content[0].text);
    structuredParameters = !!info.jsonSchema && Array.isArray(info.channels);
    const animation = await client.callTool({
      name: 'animation_inspect',
      arguments: {
        sceneId: context.scenes[0].id,
        nodeId: component.id,
        frames: [0, 30],
        limit: 20,
      },
    });
    if (animation.isError || JSON.parse(animation.content[0].text).samples.length !== 2)
      throw new Error('Packaged animation query failed');
  }
  console.log(
    JSON.stringify({
      connected: true,
      drawingDocuments: docs.length,
      tools: tools.tools.length,
      drawingImage,
      preflightImages: true,
      audioPreview: true,
      visualAudit: true,
      vectorGeometry: true,
      repeatPattern: true,
      sceneReferences: true,
      preflightSamples: report.samples.length,
      candidateRevision: report.candidateRevision,
      structuredParameters,
    }),
  );
} finally {
  await client.close();
  await transport.close();
}
