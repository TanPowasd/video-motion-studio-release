import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  exe = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...process.env,
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/animation-layers-'));
execFileSync(
  exe,
  [
    cli,
    'init',
    '--project',
    root,
    '--template',
    'blank',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'animation-layers-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] },
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function call(name, args = {}, error) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = parse(result);
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(value.code, error);
  } else assert.notEqual(result.isError, true, JSON.stringify(value));
  return { value, result };
}
const source =
    "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Actor',parameters:{},render(){return[node({id:'box',type:'rect',x:80,y:80,width:80,height:70,fill:'#6699ff'})]}});",
  loop = {
    id: 'float',
    name: '循环浮动',
    blend: 'add',
    channels: [
      {
        property: 'y',
        keys: [
          { frame: 0, value: 0, easing: 'easeInOut' },
          { frame: 10, value: -20, easing: 'easeInOut' },
          { frame: 20, value: 0, easing: 'linear' },
        ],
        after: 'cycle',
      },
    ],
  };
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const before = (await call('project_context')).value.revision,
    candidate = {
      revision: before,
      files: [
        { type: 'replace', path: 'components/actor.ts', expectedHash: null, content: source },
      ],
      operations: [
        {
          type: 'updateScene',
          sceneId: 'intro',
          patch: {
            nodes: [
              {
                id: 'native',
                type: 'rect',
                x: 280,
                y: 80,
                width: 80,
                height: 70,
                fill: '#bd93ff',
                animations: [
                  {
                    property: 'x',
                    keys: [
                      { frame: 0, value: 280 },
                      { frame: 59, value: 350 },
                    ],
                  },
                ],
              },
              {
                id: 'actor',
                type: 'component',
                component: 'components/actor.ts',
                width: 640,
                height: 360,
              },
            ],
          },
        },
      ],
    },
    check = (await call('project_preflight', candidate)).value;
  assert.equal(check.valid, true, JSON.stringify(check.diagnostics));
  await call('project_apply', { ...candidate, expectedCandidateRevision: check.candidateRevision });
  const base = (await call('project_context')).value.revision,
    plan = (
      await call('animation_layers_plan', {
        revision: base,
        targets: [
          { sceneId: 'intro', nodeId: 'native', actions: [{ type: 'append', layer: loop }] },
          {
            sceneId: 'intro',
            path: ['actor'],
            nodeId: 'actor/box',
            actions: [{ type: 'append', layer: loop }],
          },
        ],
      })
    ).value;
  const checked = await call('project_preflight', plan.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  assert.ok(checked.result.content.some((c) => c.type === 'image'));
  await call('project_apply', plan.apply);
  const info = (
    await call('animation_layers_inspect', {
      sceneId: 'intro',
      path: ['actor'],
      nodeId: 'actor/box',
      frames: [5, 25],
      includeKeys: true,
      keyLimit: 1,
    })
  ).value;
  assert.deepEqual(
    info.samples.map((s) => s.values.y),
    [70, 70],
  );
  assert.equal(info.layers[0].channels[0].keys.length, 1);
  assert.equal(info.layers[0].channels[0].nextKeyOffset, 1);
  const motion = (
      await call('motion_plan', {
        revision: plan.candidateRevision,
        output: 'layers',
        cues: [
          {
            id: 'scale',
            template: { builtin: 'pop' },
            start: 0,
            duration: 10,
            blend: 'multiply',
            after: 'pingpong',
          },
        ],
        targets: [
          { sceneId: 'intro', nodeId: 'native' },
          { sceneId: 'intro', path: ['actor'], nodeId: 'actor/box' },
        ],
      })
    ).value,
    preflight = (await call('project_preflight', motion.candidate)).value;
  assert.equal(preflight.valid, true, JSON.stringify(preflight.diagnostics));
  await call('project_apply', motion.apply);
  const listed = (
    await call('animation_layers_inspect', { sceneId: 'intro', nodeId: 'native', limit: 1 })
  ).value;
  assert.equal(listed.total, 2);
  assert.equal(listed.nextOffset, 1);
  const control = await call('animation_edit', {
    sceneId: 'intro',
    edits: [
      {
        nodeId: 'native',
        actions: [
          {
            type: 'upsert',
            property: 'animationLayers.0.weight',
            keys: [
              { frame: 0, value: 0 },
              { frame: 59, value: 1 },
            ],
          },
        ],
      },
    ],
  });
  const edit = (
    await call('animation_layers_plan', {
      revision: control.value.revision,
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'native',
          actions: [
            { type: 'move', id: 'float', index: 1 },
            { type: 'duplicate', id: 'float', newId: 'extra', index: 2 },
            { type: 'update', id: 'extra', patch: { weight: 0.3 } },
          ],
        },
      ],
    })
  ).value;
  await call('project_apply', edit.apply);
  const actual = (await call('project_inspect')).value.snapshot.scenes[0].nodes.find(
    (n) => n.id === 'native',
  );
  assert.deepEqual(
    actual.animationLayers.map((l) => l.id),
    ['scale', 'float', 'extra'],
  );
  assert.ok(actual.animations.some((c) => c.property === 'animationLayers.1.weight'));
  assert.ok(actual.animations.some((c) => c.property === 'animationLayers.2.weight'));
  await call(
    'animation_layers_plan',
    {
      revision: edit.candidateRevision,
      targets: [
        { sceneId: 'intro', nodeId: 'native', actions: [{ type: 'remove', id: 'missing' }] },
      ],
    },
    'ANIMATION_LAYER_ID',
  );
  await call(
    'animation_layers_inspect',
    { sceneId: 'intro', nodeId: 'native', revision: 'old' },
    'REVISION_CONFLICT',
  );
  await call(
    'animation_layers_inspect',
    { sceneId: 'intro', nodeId: 'native', limit: 33 },
    'TOOL_ARGUMENTS',
  );
  assert.equal((await call('project_context')).value.revision, edit.candidateRevision);
  const comparison = (
    await call('render_compare', {
      sceneId: 'intro',
      frames: [0, 7, 12, 27, 59],
      repeat: 2,
      width: 640,
      height: 360,
      baseline: { nativeCache: false },
      optimized: { nativeCache: true },
    })
  ).value;
  assert.equal(comparison.equivalence.matched, true);
  assert.equal(comparison.optimized.nativeAnimation.indexedSupported, true);
  assert.ok(
    comparison.optimized.nativeAnimation.definitionBytesSent <
      comparison.baseline.nativeAnimation.definitionBytesSent,
  );
  report.nativeComparison = {
    baseline: comparison.baseline.nativeAnimation,
    optimized: comparison.optimized.nativeAnimation,
    equivalence: comparison.equivalence,
    difference: comparison.difference,
  };
  const largeKeys = Array.from({ length: 2000 }, (_, i) => ({
      frame: i,
      value: Math.sin(i / 30),
      easing: 'linear',
    })),
    largePlan = (
      await call('animation_layers_plan', {
        revision: edit.candidateRevision,
        targets: [
          {
            sceneId: 'intro',
            nodeId: 'native',
            actions: [
              {
                type: 'append',
                layer: {
                  id: 'large',
                  channels: [{ property: 'rotation', keys: largeKeys, after: 'cycle' }],
                },
              },
            ],
          },
        ],
      })
    ).value;
  await call('project_apply', largePlan.apply);
  const short = (
      await call('animation_layers_inspect', {
        sceneId: 'intro',
        nodeId: 'native',
        layerIds: ['large'],
      })
    ).value,
    full = (
      await call('animation_layers_inspect', {
        sceneId: 'intro',
        nodeId: 'native',
        layerIds: ['large'],
        includeKeys: true,
        keyLimit: 1000,
      })
    ).value;
  assert.equal(short.layers[0].channels[0].keyCount, 2000);
  assert.equal(short.layers[0].channels[0].keys, undefined);
  report.shortBytes = Buffer.byteLength(JSON.stringify(short));
  report.keyPageBytes = Buffer.byteLength(JSON.stringify(full));
  assert.ok(report.shortBytes < report.keyPageBytes / 10);
  const indexed = (
    await call('render_compare', {
      sceneId: 'intro',
      frames: [0, 12, 31, 59],
      repeat: 3,
      width: 640,
      height: 360,
      baseline: { nativeCache: false },
      optimized: { nativeCache: true },
    })
  ).value;
  assert.equal(indexed.equivalence.matched, true);
  assert.ok(
    indexed.optimized.nativeAnimation.definitionBytesSent <
      indexed.baseline.nativeAnimation.definitionBytesSent / 5,
  );
  report.largeKeyComparison = {
    keyCount: 2000,
    equivalence: indexed.equivalence,
    difference: indexed.difference,
    baseline: indexed.baseline.nativeAnimation,
    optimized: indexed.optimized.nativeAnimation,
  };
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, edit.candidateRevision);
  const schema = (await call('project_schema', { name: 'animationLayer' })).value;
  assert.ok(schema.schema);
  const request = path.join(root, 'inspect-request.json');
  await writeFile(request, JSON.stringify({ sceneId: 'intro', nodeId: 'native', frames: [12] }));
  const cliValue = JSON.parse(
    execFileSync(exe, [cli, 'animation-layers-inspect', '--project', root, '--request', request], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(cliValue.total, 3);
  await client.callTool({
    name: 'tools_load',
    arguments: { names: ['animation_layers_inspect', 'animation_layers_plan'] },
  });
  const direct = await client.callTool({
    name: 'animation_layers_inspect',
    arguments: { sceneId: 'intro', nodeId: 'native' },
  });
  assert.notEqual(direct.isError, true);
  assert.equal(parse(direct).total, 3);
  const preview = (
    await call('frame_capture', {
      frame: 27,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/preview.png'),
    })
  ).value;
  async function wait(id) {
    for (let i = 0; i < 300; i++) {
      const j = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        assert.equal(j.status, 'completed', JSON.stringify(j.error));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('render timeout');
  }
  const png = (
    await call('render_start', {
      revision: edit.candidateRevision,
      start: 27,
      end: 28,
      format: 'png',
      width: 640,
      height: 360,
      output: path.join(root, 'exports/parity'),
    })
  ).value;
  await wait(png.id);
  assert.equal(
    (await readFile(preview.output)).equals(
      await readFile(path.join(root, 'exports/parity/frame-00000027.png')),
    ),
    true,
  );
  const video = (
    await call('render_start', {
      revision: edit.candidateRevision,
      width: 640,
      height: 360,
      output: path.join(root, 'exports/animation-layers.mp4'),
    })
  ).value;
  await wait(video.id);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        path.join(root, 'exports/animation-layers.mp4'),
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  assert.equal(await readFile(path.join(root, 'components/actor.ts'), 'utf8'), source);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, control.value.revision);
  await call('project_undo');
  await call('project_undo');
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, base);
  report.checks = [
    'compact discovery and authoritative schemas',
    'native/generated layer candidates and exact one-step undo',
    'cycle keys and overlapping reusable multiply motion',
    'stable IDs preserve control channels through reorder/duplicate',
    'invalid/stale requests preserve active revision',
    'large key pages opt in and ordinary keys remain editable',
    'native cached/no-cache pixels and IPC definitions evidence',
    'CLI bridge and directly loaded MCP tools',
    'source kept intact; native PNG export parity and 60-frame MP4',
  ];
  report.output = path.join(root, 'exports/animation-layers.mp4');
  report.passed = true;
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
