import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { programLayer, programEffect } from '../src/sdk/render-programs.js';
import { renderProgramSchema } from '../src/core/programs/render-program-schema.js';
let root: string, app: Application;
const manifest = 'components/renderers/test.json',
  entry = 'components/renderers/test.py';
const python = `from helper import color\ndef render(ctx,p,input_rgba):\n print('logs use stderr')\n rgba=bytes([color(ctx['frame']),int(p.get('green',20)),0,255])\n return rgba*(ctx['width']*ctx['height'])\n`;
const shader = `@group(0) @binding(0) var<storage,read> input:array<u32>;\n@group(0) @binding(1) var<storage,read_write> output:array<u32>;\n@group(0) @binding(2) var<storage,read> clock:array<vec4<f32>>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p:vec3<u32>){let w=u32(clock[0].x);let h=u32(clock[0].y);if(p.x>=w||p.y>=h){return;}let i=p.y*w+p.x;output[i]=input[i]^0x000000ffu;}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-program-'));
  await initProject(root, 'Programs', {
    template: 'blank',
    width: 64,
    height: 64,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(backend: 'python' | 'wgsl' = 'python', code = python) {
  const file = backend === 'python' ? entry : entry.replace('.py', '.wgsl');
  await app.service.transact([
    { type: 'writeSource', path: file, content: code },
    {
      type: 'writeSource',
      path: 'components/renderers/helper.py',
      content: 'def color(frame):\n return int(frame)%256\n',
    },
    {
      type: 'writeSource',
      path: manifest,
      content: JSON.stringify({
        kind: 'render-program',
        version: 1,
        name: 'Test',
        backend,
        entry: file,
        files: backend === 'python' ? ['components/renderers/helper.py'] : [],
      }),
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: programLayer('program', manifest, { width: 64, height: 64, params: { green: 42 } }),
    },
  ]);
}
it('renders arbitrary Python with pinned dependencies, seeded random seeks and bounded worker reuse', async () => {
  await setup();
  const revision = app.service.snapshot.revision,
    source = await readFile(path.join(root, entry), 'utf8');
  const hashes = [];
  for (const frame of [30, 0, 30]) {
    const canvas = await app.renderer.render(app.service.snapshot, frame, { sceneId: 'intro' });
    try {
      const data = canvas.getContext('2d').getImageData(0, 0, 64, 64).data;
      expect([...data.slice(0, 4)]).toEqual([frame, 42, 0, 255]);
      hashes.push(data.toString());
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
  expect(hashes[0]).toBe(hashes[2]);
  expect(app.renderer.programs.report().workerStarts).toBe(1);
  expect(app.renderer.programs.report().sourceHits).toBeGreaterThan(0);
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/renderers/helper.py',
      content: 'def color(frame):\n return 99\n',
    },
  ]);
  const image = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' });
  expect(image.getContext('2d').getImageData(0, 0, 1, 1).data[0]).toBe(99);
  image.width = 1;
  image.height = 1;
  expect(app.renderer.programs.report().workerStarts).toBe(2);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
  expect(await readFile(path.join(root, entry), 'utf8')).toBe(source);
});
it('uses custom Python as an ordered effect and a graph pass with exact candidate/undo', async () => {
  await setup();
  const revision = app.service.snapshot.revision;
  const code = `def render(ctx,p,input_rgba):\n pixels=bytearray(input_rgba)\n for i in range(0,len(pixels),4):\n  pixels[i]=int(p.get('red',7))\n  pixels[i+3]=255\n return pixels\n`;
  const candidate = {
    revision,
    files: [
      { type: 'replace' as const, path: entry, expectedHash: '' as string | null, content: code },
    ],
    samples: [{ sceneId: 'intro', frame: 0 }],
    width: 160,
    determinism: true,
  };
  // A replacement is guarded by the actual source hash.
  const { hash } = await import('../src/platform/project-files.js');
  candidate.files[0].expectedHash = hash(python);
  const checked = await app.dispatch('projectPreflight', candidate);
  expect(checked.valid).toBe(true);
  await app.dispatch('projectApply', {
    ...candidate,
    expectedCandidateRevision: checked.candidateRevision,
  });
  await app.service.transact([
    {
      type: 'updateNode',
      sceneId: 'intro',
      nodeId: 'program',
      patch: { effects: [programEffect(manifest, { red: 77 })] },
    },
  ]);
  const canvas = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' });
  expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0]).toBe(77);
  canvas.width = 1;
  canvas.height = 1;
  await app.service.transact([
    {
      type: 'updateNode',
      sceneId: 'intro',
      nodeId: 'program',
      patch: {
        effects: [
          {
            type: 'effectGraph',
            params: {},
            bindings: {},
            graph: {
              kind: 'effect-graph',
              version: 1,
              name: 'Program pass',
              nodes: [
                { id: 'in', type: 'input', slot: 'source' },
                {
                  id: 'out',
                  type: 'pass',
                  input: 'in',
                  effect: programEffect(manifest, { red: 88 }),
                },
              ],
              output: 'out',
              parameters: {},
              links: [],
              outputs: {},
            },
          },
        ],
      },
    },
  ]);
  const graph = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' });
  expect(graph.getContext('2d').getImageData(0, 0, 1, 1).data[0]).toBe(88);
  graph.width = 1;
  graph.height = 1;
});
it('reports source/size/runtime errors, preserves last preview and terminates stalled Python', async () => {
  await setup();
  await app.frame({ frame: 0 });
  await app.service.transact([
    {
      type: 'writeSource',
      path: entry,
      content: 'def render(ctx,p,input_rgba):\n return b"short"\n',
    },
  ]);
  const stale = await app.frame({ frame: 0, fallback: true });
  expect(stale.stale).toBe(true);
  expect(stale.error).toContain('RGBA size differs');
  await app.service.transact([
    {
      type: 'writeSource',
      path: entry,
      content: 'def render(ctx,p,input_rgba):\n while True: pass\n',
    },
    {
      type: 'writeSource',
      path: manifest,
      content: JSON.stringify({
        kind: 'render-program',
        version: 1,
        name: 'Stalled',
        backend: 'python',
        entry,
        timeoutMs: 200,
      }),
    },
  ]);
  await expect(
    app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' }),
  ).rejects.toMatchObject({ code: 'PROGRAM_TIMEOUT', details: { file: entry } });
  const before = app.service.snapshot.revision;
  await expect(
    app.service.transact([
      {
        type: 'writeSource',
        path: manifest,
        content: JSON.stringify({
          kind: 'render-program',
          version: 1,
          name: 'Missing',
          backend: 'python',
          entry: 'components/renderers/missing.py',
        }),
      },
    ]),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(app.service.snapshot.revision).toBe(before);
  expect(() =>
    renderProgramSchema.parse({
      kind: 'render-program',
      version: 1,
      name: 'Bad',
      backend: 'python',
      entry: '../outside.py',
    }),
  ).toThrow();
});
it('runs a user-authored WGSL effect with cached pipeline and rejects bad code without project changes', async (context) => {
  if (process.env.VMOTION_GPU === 'cpu') {
    context.skip();
    return;
  }
  if (!(await app.renderer.gpu.initialize())) {
    context.skip();
    return;
  }
  await setup('wgsl', shader);
  const before = app.service.snapshot.revision;
  const canvas = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' });
  expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0]).toBe(16);
  canvas.width = 1;
  canvas.height = 1;
  const image = await app.renderer.programs.render(
    app.service.snapshot,
    manifest,
    2,
    64,
    64,
    {},
    new Uint8ClampedArray(64 * 64 * 4).fill(255),
  );
  expect([...image.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([0, 255, 255, 255]);
  image.width = 1;
  image.height = 1;
  const generator={...app.service.snapshot,files:{...app.service.snapshot.files,[entry.replace('.py','.wgsl')]:`@group(0) @binding(1) var<storage,read_write> output:array<u32>; @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p:vec3<u32>){if(p.x<64u&&p.y<64u){output[p.y*64u+p.x]=0xffffffffu;}}`}};
  const generated=await app.renderer.programs.render(generator,manifest,0,64,64,{});
  expect([...generated.getContext('2d').getImageData(0,0,1,1).data]).toEqual([255,255,255,255]);generated.width=1;generated.height=1;
  const bad = {
    ...app.service.snapshot,
    files: { ...app.service.snapshot.files, [entry.replace('.py', '.wgsl')]: 'broken wgsl' },
  };
  await expect(app.renderer.programs.render(bad, manifest, 0, 64, 64, {})).rejects.toMatchObject({
    code: 'PROGRAM_SHADER',
  });
  expect(app.service.snapshot.revision).toBe(before);
});
