import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
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
const root = await mkdtemp(path.resolve('artifacts/agent-cli-'));
const blankRoot = await mkdtemp(path.resolve('artifacts/agent-cli-blank-'));
const run = (args) =>
  JSON.parse(
    execFileSync(executable, [cli, ...args], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
run([
  'init',
  '--project',
  blankRoot,
  '--name',
  'CLI 空白工程',
  '--width',
  '1280',
  '--height',
  '720',
  '--fps',
  '60',
  '--duration',
  '12',
]);
const blank = run(['inspect', '--project', blankRoot]).snapshot;
if (
  blank.scenes[0].nodes.length ||
  blank.project.width !== 1280 ||
  blank.project.height !== 720 ||
  blank.sequences[0].duration !== 720
)
  throw new Error('CLI blank creation failed');
run([
  'frame',
  '--project',
  blankRoot,
  '--frame',
  '0',
  '--width',
  '320',
  '--height',
  '180',
  '--output',
  path.join(blankRoot, 'blank.png'),
]);
run(['init', '--project', root, '--template', 'science']);
const search = run(['tools-search', '--query', '深度', '--category', '3d', '--limit', '1']);
if (search.items[0].name !== 'scene3d_render') throw new Error('CLI discovery ranking failed');
const schema = run(['tool-schema', '--name', 'sequence_edit']);
if (!schema.inputSchema.properties.actions) throw new Error('CLI tool schema failed');
const before = run(['context', '--project', root]).revision,
  request = path.join(root, 'edit-request.json');
await writeFile(
  request,
  JSON.stringify({
    revision: before,
    operations: [
      {
        type: 'updateNode',
        sceneId: 'intro',
        nodeId: 'title',
        patch: { text: 'CLI agent edited' },
      },
    ],
  }),
);
const edited = run([
  'tool-call',
  '--project',
  root,
  '--name',
  'project_transact',
  '--request',
  request,
]);
if (edited.snapshot || edited.revision === before) throw new Error('CLI compact mutation failed');
const full = run(['tool-call', '--project', root, '--name', 'project_inspect', '--full']);
if (full.snapshot.scenes[0].nodes.find((n) => n.id === 'title').text !== 'CLI agent edited')
  throw new Error('CLI full read failed');
await writeFile(
  request,
  JSON.stringify({
    operations: [
      {
        type: 'updateNode',
        sceneId: 'intro',
        nodeId: 'title',
        patch: { type: 'component', component: 'components/missing.ts' },
      },
    ],
  }),
);
let validationExit;
try {
  run(['tool-call', '--project', root, '--name', 'project_preflight', '--request', request]);
  throw new Error('Invalid CLI preflight succeeded');
} catch (e) {
  if (e.status !== 2) throw e;
  const report = JSON.parse(e.stdout);
  if (report.valid || !report.diagnostics.length)
    throw new Error('Invalid CLI preflight lacks diagnostics');
  validationExit = e.status;
}
await writeFile(
  request,
  JSON.stringify({
    operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { width: -1 } }],
  }),
);
let argumentErrorCode;
try {
  run(['tool-call', '--project', root, '--name', 'project_preflight', '--request', request]);
  throw new Error('Invalid arguments succeeded');
} catch (e) {
  if (e.status !== 1) throw e;
  const error = JSON.parse(e.stderr).error;
  if (error.code !== 'TOOL_ARGUMENTS' || error.details[0].path !== '/operations/0/patch/width')
    throw new Error('CLI argument diagnostics lack field location');
  argumentErrorCode = error.code;
}
const undo = run(['tool-call', '--project', root, '--name', 'project_undo']);
if (undo.revision !== before) throw new Error('CLI undo failed');
await writeFile(request, JSON.stringify({ frame: 90, width: 160, height: 90 }));
const picture = run([
  'tool-call',
  '--project',
  root,
  '--name',
  'frame_capture',
  '--request',
  request,
  '--inline',
]);
if (
  !picture.media.some(
    (block) =>
      block.type === 'image' &&
      Buffer.from(block.data, 'base64').subarray(1, 4).toString() === 'PNG',
  )
)
  throw new Error('CLI inline frame failed');
const report = {
  packaged,
  root,
  blankRoot,
  blankCreation: true,
  search: true,
  schema: true,
  compactMutation: true,
  fullRead: true,
  undo: true,
  inlineImage: true,
  invalidPreflightExit: validationExit,
  argumentErrorCode,
};
await writeFile(path.join(root, 'cli-check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
