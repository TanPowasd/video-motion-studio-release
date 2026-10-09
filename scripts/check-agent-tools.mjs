import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/agent-tools-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  encoding: 'utf8',
  windowsHide: true,
});
const source = path.join(root, 'source.mp4');
execFileSync(
  process.env.VMOTION_FFMPEG ?? 'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'mpeg4',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ],
  { windowsHide: true },
);
const client = new Client({ name: 'agent-tools-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
let directNames = new Set(['tools_search', 'tool_schema', 'tool_call', 'tools_load']);
async function call(name, args = {}) {
  const result = await client.callTool(
    directNames.has(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  const text = result.content.find((c) => c.type === 'text');
  return { value: JSON.parse(text.text), content: result.content };
}
try {
  await client.connect(transport);
  const catalog = await client.listTools(),
    guide = await call('agent_guide', { topic: '3d' });
  const nativeModules = {};
  for (const [id, count, runtime] of [
    ['vmotion.3d', 5, 'module'],
    ['vmotion.vector', 8, 'module'],
    ['vmotion.animation', 14, 'module'],
    ['vmotion.core', 15, 'module'],
    ['vmotion.recovery', 3, 'module'],
    ['vmotion.cache', 3, 'module'],
    ['vmotion.review', 7, 'module'],
    ['vmotion.organization', 4, 'module'],
  ]) {
    const module = (await call('plugins_inspect', { id })).value.items[0];
    if (module.moduleTools !== count || module.runtime !== runtime)
      throw new Error('Module registration mismatch: ' + id);
    nativeModules[id] = { moduleTools: module.moduleTools, hostTools: module.hostTools };
  }
  directNames = new Set(catalog.tools.map((t) => t.name));
  const initialCatalogBytes = Buffer.byteLength(JSON.stringify(catalog)),
    discovery = await call('tools_search', { limit: 50, detail: true });
  await call('tools_load', {
    categories: discovery.value.categories.map((entry) => entry.category),
  });
  const fullCatalog = await client.listTools(),
    fullCatalogBytes = Buffer.byteLength(JSON.stringify(fullCatalog));
  if (fullCatalog.tools.length !== discovery.value.total + 4)
    throw new Error('Full discovery omitted capabilities or duplicated entries');
  await call('tools_load', { mode: 'replace' });
  if (initialCatalogBytes >= fullCatalogBytes * 0.3)
    throw new Error('Compact catalog does not materially reduce discovery payload');
  if (!guide.value.workflow.tools.includes('matrix3d')) throw new Error('3D routing missing');
  const fxBefore = (await call('project_context')).value.revision,
    fxPlan = await call('effects_plan', {
      sceneId: 'intro',
      frame: 90,
      targets: [
        {
          nodeId: 'title',
          actions: [
            {
              type: 'append',
              effect: { type: 'rgbSplit', amountX: 3, amountY: 0, id: 'agent-rgb' },
            },
          ],
        },
        {
          nodeId: 'subtitle',
          actions: [
            {
              type: 'append',
              effect: {
                type: 'waveWarp',
                amountX: 6,
                wavelength: 120,
                phase: 0.3,
                id: 'agent-wave',
              },
            },
          ],
        },
      ],
    });
  const fxCheck = await call('project_preflight', fxPlan.value.candidate);
  if (!fxCheck.value.valid || !fxCheck.content.some((c) => c.type === 'image'))
    throw new Error('Effect plan failed visual preflight');
  await call('project_apply', fxPlan.value.apply);
  const fxInfo = await call('effects_inspect', {
    sceneId: 'intro',
    nodeIds: ['title', 'subtitle'],
    frame: 90,
  });
  if (fxInfo.value.layers[0].effects[0].id !== 'agent-rgb')
    throw new Error('Stable effect ID missing');
  await call('project_undo');
  if ((await call('project_context')).value.revision !== fxBefore)
    throw new Error('Multi-layer effect undo failed');
  const meshBefore = (await call('project_context')).value.revision,
    meshPlan = await call('mesh_generate', {
      primitive: { kind: 'sphere', widthSegments: 8, heightSegments: 4 },
      place: { sceneId: 'intro', nodeId: 'agent-sphere' },
    });
  if (!meshPlan.value.candidate.planId || meshPlan.value.candidate.operations)
    throw new Error('Mesh planning did not stay compact');
  const meshCheck = await call('project_preflight', meshPlan.value.candidate);
  if (!meshCheck.value.valid || !meshCheck.content.some((c) => c.type === 'image'))
    throw new Error('Stored mesh plan preflight failed');
  await call('project_apply', meshPlan.value.apply);
  const meshInfo = await call('mesh_inspect', { source: { file: meshPlan.value.file }, limit: 2 }),
    meshImage = await call('scene3d_render', {
      source: { sceneId: 'intro', nodeId: 'agent-sphere' },
      width: 240,
    });
  if (
    !meshInfo.value.summary.topology.closed ||
    meshImage.value.backend !== 'rust' ||
    meshImage.value.visiblePixels < 100
  )
    throw new Error('Placed mesh did not render');
  const materialPlan = await call('scene3d_materials', {
      sceneId: 'intro',
      nodeId: 'agent-sphere',
      updates: [
        { instanceId: 'model', patch: { metallic: 0.6, roughness: 0.25, color: '#e3aa56' } },
      ],
      options: {
        ambient: 0.1,
        lights: [{ type: 'directional', direction: { x: 0, y: 0, z: 1 }, intensity: 3 }],
      },
    }),
    materialCheck = await call('project_preflight', materialPlan.value.candidate);
  if (!materialCheck.value.valid) throw new Error('Material plan did not preflight');
  await call('project_apply', materialPlan.value.apply);
  const materialImage = await call('scene3d_render', {
    source: { sceneId: 'intro', nodeId: 'agent-sphere' },
    width: 240,
  });
  if (
    materialImage.value.backend !== 'rust' ||
    materialImage.value.materials[0].material.metallic !== 0.6
  )
    throw new Error('Native material was not applied');
  await call('project_undo');
  if ((await call('project_context')).value.revision !== meshPlan.value.candidateRevision)
    throw new Error('Material-only undo failed');
  await call('project_undo');
  if ((await call('project_context')).value.revision !== meshBefore)
    throw new Error('Mesh/resource undo failed');
  const obj = await call('mesh_import', {
      text: 'v -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nf 1 2 3 4',
      place: { sceneId: 'intro', nodeId: 'agent-obj' },
    }),
    objCheck = await call('project_preflight', obj.value.candidate);
  if (!objCheck.value.valid || !obj.value.sourceHash) throw new Error('OBJ plan did not validate');
  await call('project_apply', obj.value.apply);
  const objInfo = await call('mesh_inspect', { source: { file: obj.value.file } });
  if (objInfo.value.summary.faces !== 2) throw new Error('OBJ polygon import failed');
  await call('project_undo');
  if ((await call('project_context')).value.revision !== meshBefore)
    throw new Error('OBJ undo failed');
  const projection = await call('matrix3d', {
    request: {
      operation: 'project',
      camera: {
        position: { x: 0, y: 0, z: 5 },
        target: { x: 0, y: 0, z: 0 },
        width: 160,
        height: 90,
      },
      points: [{ x: 0, y: 0, z: 0 }],
    },
  });
  if (projection.value.result.points[0].x !== 80) throw new Error('Matrix projection failed');
  const plane = {
    vertices: [
      { x: -1, y: -1, z: 0 },
      { x: 1, y: -1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: -1, y: 1, z: 0 },
    ],
    faces: [[0, 1, 2, 3]],
  };
  const depthScene = await call('scene3d_render', {
    source: {
      scene: {
        camera: {
          position: { x: 0, y: 0, z: 5 },
          target: { x: 0, y: 0, z: 0 },
          width: 128,
          height: 64,
          projection: 'orthographic',
          orthographicHeight: 4,
        },
        instances: [
          {
            id: 'red',
            mesh: plane,
            color: '#ff0000',
            transform: { rotation: { x: 0, y: 45, z: 0 } },
          },
          {
            id: 'blue',
            mesh: plane,
            color: '#0000ff',
            transform: { rotation: { x: 0, y: -45, z: 0 } },
          },
        ],
        options: { ambient: 1 },
        samples: 4,
      },
    },
    width: 128,
    picks: [
      { x: 58, y: 32 },
      { x: 70, y: 32 },
    ],
  });
  if (
    depthScene.value.backend !== 'rust' ||
    depthScene.content.filter((c) => c.type === 'image').length !== 3 ||
    depthScene.value.picks[0].face.instanceId !== 'red' ||
    depthScene.value.picks[1].face.instanceId !== 'blue'
  )
    throw new Error('Native depth scene evidence failed');
  const imported = await call('asset_import', { path: source, type: 'video', copy: false }),
    assetId = imported.value.importedAsset.id,
    sampled = await call('media_sample', { assetId, frames: [0, 15, 29], width: 160 });
  if (!sampled.content.some((c) => c.type === 'image') || sampled.value.samples.length !== 3)
    throw new Error('Source evidence missing');
  const context = await call('project_context'),
    baseRevision = context.value.revision,
    planned = await call('sequence_plan', {
      revision: baseRevision,
      assetChecks: [sampled.value.assetCheck],
      items: [
        {
          source: { type: 'asset', id: assetId },
          trackId: 'visual',
          mode: 'overwrite',
          at: 0,
          sourceIn: 0,
          sourceOut: 15,
        },
      ],
    }),
    checked = await call('project_preflight', planned.value.candidate);
  if (
    !checked.value.valid ||
    checked.value.candidateRevision !== planned.value.candidateRevision ||
    !checked.content.some((c) => c.type === 'image')
  )
    throw new Error('Plan preflight failed');
  const applied = await call('project_apply', planned.value.apply);
  if (applied.value.revision !== planned.value.candidateRevision)
    throw new Error('Exact plan was not committed');
  const output = path.join(root, 'exports/agent-assembly.mp4'),
    render = await call('render_start', {
      output,
      format: 'mp4',
      start: 0,
      end: 15,
      width: 320,
      height: 180,
    });
  let job;
  for (let i = 0; i < 120; i++) {
    job = (await call('render_status', { id: render.value.id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (job.status !== 'completed') throw new Error(`Render ${job.status}: ${job.error}`);
  const info = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  if (
    !info.streams.some((s) => s.codec_type === 'audio') ||
    !info.streams.some((s) => s.codec_type === 'video')
  )
    throw new Error('Assembly media streams missing');
  await call('project_undo');
  const undone = await call('project_context');
  if (undone.value.revision !== baseRevision) throw new Error('Assembly undo failed');
  const result = {
    root,
    packaged,
    nativeModules,
    tools: fullCatalog.tools.length,
    initialTools: catalog.tools.length,
    availableCapabilities: discovery.value.total,
    initialCatalogBytes,
    fullCatalogBytes,
    sourceEvidence: true,
    matrixProjection: true,
    nativeDepthImages: true,
    storedMeshPlan: true,
    storedOBJPlan: true,
    materialPlan: true,
    planarEffectsPlan: true,
    exactCandidateCommit: true,
    undo: true,
    videoAudioExport: true,
    output,
    duration: Number(info.format.duration),
  };
  await writeFile(path.join(root, 'agent-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await client.close();
  await transport.close();
}
