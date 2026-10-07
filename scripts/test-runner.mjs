import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, readdir, createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
const read = promisify(readFile),
  list = promisify(readdir);
const group = process.argv[2] ?? 'all';
const groups = JSON.parse(await read('tests/test-groups.json', 'utf8'));
const all = (await list('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`)
  .sort();
const assigned = [...groups.fast.files, ...groups.integration.files];
if (
  new Set(assigned).size !== assigned.length ||
  assigned.length !== all.length ||
  all.some((file) => !assigned.includes(file))
)
  throw Error('Test groups must assign every test file exactly once');
if (group !== 'all' && !groups[group]) throw Error(`Unknown test group: ${group}`);
const configuredTimeout =
  process.env.VMOTION_TEST_TIMEOUT_MS === undefined
    ? undefined
    : Number(process.env.VMOTION_TEST_TIMEOUT_MS);
if (
  configuredTimeout !== undefined &&
  (!Number.isSafeInteger(configuredTimeout) ||
    configuredTimeout < 20 ||
    configuredTimeout > 3600000)
)
  throw Error('Invalid VMOTION_TEST_TIMEOUT_MS');
const timeoutMs = configuredTimeout ?? (group === 'all' ? 1800000 : groups[group].timeoutMs);
const files = group === 'all' ? all : groups[group].files;
const commands =
  group === 'acceptance'
    ? groups.acceptance.scripts
        .filter((script) => script.requires !== 'gpu' || process.env.VMOTION_TEST_GPU === '1')
        .map((script) => [script.file, ...script.args])
    : [
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          'vitest.config.ts',
          '--reporter=verbose',
          '--reporter=./scripts/test-progress-reporter.mjs',
          ...(process.argv.includes('--coverage') ? ['--coverage'] : []),
          ...files,
        ],
      ];
await promisify(mkdir)('artifacts/tests', { recursive: true });
const runId = `${group}-${Date.now()}`;
const activityFile = path.resolve(`artifacts/tests/${runId}-activity.json`);
const log = createWriteStream(`artifacts/tests/${runId}.log`);
console.log(
  `[tests] group=${group} files=${files?.length ?? 0} scripts=${commands.length} timeout=${timeoutMs}ms log=${log.path}`,
);
if (group === 'acceptance' && process.env.VMOTION_TEST_GPU !== '1')
  console.log(
    '[tests] GPU hardware checks omitted explicitly; set VMOTION_TEST_GPU=1 on the reference machine.',
  );
let exitCode = 0;
for (const args of commands) {
  const started = Date.now();
  let lastActivity = started,
    timedOut = false;
  const child = spawn(process.execPath, args, {
    env: { ...process.env, VMOTION_TEST_ACTIVITY: activityFile },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      lastActivity = Date.now();
      log.write(data);
      (stream === child.stdout ? process.stdout : process.stderr).write(data);
    });
  const heartbeat = setInterval(async () => {
    let active = '';
    try {
      active = await read(activityFile, 'utf8');
    } catch {}
    console.log(
      `[tests] group=${group} elapsed=${Math.round((Date.now() - started) / 1000)}s pid=${child.pid} lastOutput=${Math.round((Date.now() - lastActivity) / 1000)}s active=${active}`,
    );
  }, 30000);
  const stop = () => {
    if (process.platform === 'win32')
      execFile(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {},
      );
    else child.kill('SIGTERM');
  };
  const timeout = setTimeout(async () => {
    timedOut = true;
    console.error(
      `[tests] TIMEOUT group=${group} pid=${child.pid} lastActivity=${new Date(lastActivity).toISOString()} command=${process.execPath} ${args.join(' ')}`,
    );
    if (process.platform === 'win32') {
      const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
      await new Promise((resolve) =>
        execFile(
          'powershell',
          ['-NoProfile', '-Command', cmd],
          { windowsHide: true, timeout: 10000 },
          (_error, stdout) => {
            console.error(stdout);
            resolve();
          },
        ),
      );
    }
    stop();
  }, timeoutMs);
  const interrupt = () => stop();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
  clearInterval(heartbeat);
  clearTimeout(timeout);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  exitCode = timedOut ? 124 : code;
  if (exitCode !== 0) break;
}
await new Promise((resolve) => log.end(resolve));
process.exitCode = exitCode;
