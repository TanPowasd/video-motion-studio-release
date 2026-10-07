import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
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
    ...process.env,
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/agent-history-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  encoding: 'utf8',
  windowsHide: true,
});
const client = new Client({ name: 'history-stress', version: '1.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
const logs = [];
let step = '',
  iteration = 0;
async function call(name, args = {}, full = false, expectedError) {
  step = name;
  const result = await client.callTool({
      name: 'tool_call',
      arguments: { name, arguments: args, response: full ? 'full' : 'compact' },
    }),
    value = JSON.parse(result.content.find((c) => c.type === 'text').text);
  if (expectedError) {
    if (!result.isError || value.code !== expectedError)
      throw new Error(JSON.stringify({ expectedError, result: value }));
    return value;
  }
  if (result.isError) throw new Error(JSON.stringify(value));
  return value;
}
try {
  await client.connect(transport);
  for (iteration = 0; iteration < 50; iteration++) {
    const before = (await call('project_context')).revision,
      operations = [
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: 'title',
          patch: { text: `History pass ${iteration}` },
        },
      ],
      edit = await call('project_transact', { revision: before, operations });
    await call('project_inspect', {}, true);
    await call(
      'project_transact',
      { revision: edit.revision, operations, typo: true },
      false,
      'TOOL_ARGUMENTS',
    );
    await call(
      'project_preflight',
      {
        operations: [
          { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { width: -1 } },
        ],
      },
      false,
      'TOOL_ARGUMENTS',
    );
    await call('project_transact', { revision: before, operations }, false, 'REVISION_CONFLICT');
    const undo = await call('project_undo');
    if (undo.revision !== before) throw new Error('Undo revision mismatch');
    await readFile(path.join(root, 'project.vmotion.json'), 'utf8');
    const redo = await call('project_redo', {}, true);
    if (redo.snapshot.revision !== edit.revision) throw new Error('Redo revision mismatch');
    await call('project_undo');
    logs.push({ iteration, passed: true });
  }
  console.log(JSON.stringify({ root, packaged, iterations: logs.length, passed: true }));
} catch (e) {
  const failedStep = step;
  let context;
  try {
    context = await call('project_context');
  } catch {}
  const report = { root, iteration, step: failedStep, error: e.message, context, logs };
  await writeFile(path.join(root, 'failure.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
