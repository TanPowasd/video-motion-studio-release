import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
import { surfaceMesh } from '../src/sdk/meshes.js';
import { meshDocumentSchema } from '../src/core/mesh-document.js';
import { hash } from '../src/service/project.js';
const root = path.resolve('examples/mesh-gallery'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root))
  throw new Error('Close this project service before rebuilding/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '三维网格 · 资源与 OBJ');
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    for (const [id, primitive] of Object.entries({
      sphere: { kind: 'sphere', widthSegments: 20, heightSegments: 10 },
      torus: { kind: 'torus', radialSegments: 24, tubularSegments: 10 },
      cylinder: { kind: 'cylinder', radialSegments: 24 },
      cone: { kind: 'cone', radialSegments: 24 },
    })) {
      const file = `components/meshes/${id}.json`,
        old = app.service.snapshot.files[file],
        plan = await app.dispatch('meshGenerate', {
          primitive,
          file,
          expectedHash: old ? hash(old) : null,
          normalizeSize: 2,
        });
      const checked = await app.dispatch('projectPreflight', plan.candidate);
      if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
      await app.dispatch('projectApply', plan.apply);
    }
    const source =
      'o arch\ng silhouette\nusemtl rose\nv -1.5 -1.5 0\nv 1.5 -1.5 0\nv 1.5 1.5 0\nv .5 1.5 0\nv .5 -.5 0\nv -.5 -.5 0\nv -.5 1.5 0\nv -1.5 1.5 0\nf 1 2 3 4 5 6 7 8\n';
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets/arch.obj'), source);
    const file = 'components/meshes/arch.json',
      old = app.service.snapshot.files[file],
      imported = await app.dispatch('meshImport', {
        path: path.join(root, 'assets/arch.obj'),
        file,
        expectedHash: old ? hash(old) : null,
        normalizeSize: 2,
        materials: { rose: '#f49aba' },
      });
    await app.dispatch('projectApply', imported.apply);
    const surface = meshDocumentSchema.parse({
      version: 1,
      kind: 'mesh3d',
      name: 'Function surface',
      mesh: surfaceMesh((x, z) => 0.35 * Math.sin(2 * x) * Math.cos(2 * z), {
        width: 2.6,
        depth: 2.6,
        widthSegments: 16,
        depthSegments: 16,
      }),
      source: { format: 'primitive', name: 'SDK surfaceMesh' },
      groups: [],
      warnings: [],
    });
    await app.service.transact([
      {
        type: 'editFiles',
        edits: [
          {
            type: 'replace',
            path: 'components/meshes/surface.json',
            expectedHash: app.service.snapshot.files['components/meshes/surface.json']
              ? hash(app.service.snapshot.files['components/meshes/surface.json'])
              : null,
            content: JSON.stringify(surface, null, 2) + '\n',
          },
        ],
      },
      {
        type: 'writeSource',
        path: 'components/mesh-gallery.ts',
        content: await readFile('scripts/mesh-gallery-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '可复用网格',
          duration: 240,
          nodes: [
            newNode({
              id: 'gallery',
              type: 'component',
              component: 'components/mesh-gallery.ts',
              width: 1280,
              height: 720,
              params: { spin: 28 },
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 240,
          tracks: [
            {
              id: 'visual',
              name: '3D meshes',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'gallery',
                  sceneId: 'intro',
                  start: 0,
                  duration: 240,
                  sourceIn: 0,
                  speed: 1,
                  volume: 1,
                  fadeIn: 0,
                  fadeOut: 0,
                },
              ],
            },
          ],
        },
      },
    ]);
  }
  await mkdir(path.join(root, 'exports'), { recursive: true });
  const frames = [0, 45, 90, 150, 239];
  for (const frame of frames)
    await writeFile(
      path.join(root, `exports/mesh-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const checked = await app.dispatch('projectPreflight', {
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    width: 480,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const evidence = await app.dispatch('scene3dRender', {
    source: { sceneId: 'intro', path: ['gallery'], nodeId: 'gallery/mesh-arch', frame: 90 },
    width: 480,
    output: path.join(root, 'exports/obj-evidence'),
  });
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      preflight: { valid: checked.valid, diagnostics: checked.diagnostics },
      OBJ: { backend: evidence.backend, visiblePixels: evidence.visiblePixels },
    }),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/mesh-gallery.mp4'),
        format: 'mp4',
        encoder: 'libx264',
      }),
      done = await app.renders.wait(job.id);
    console.log(JSON.stringify(done));
    if (done.status !== 'completed') process.exitCode = 1;
  }
} finally {
  await app.close();
}
