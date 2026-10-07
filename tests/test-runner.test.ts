import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
it('bounds a stalled group and reports its command and PID while preserving diagnostics', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/test-runner.mjs', 'fast'], {
    env: { ...process.env, VMOTION_TEST_TIMEOUT_MS: '20' },
    windowsHide: true,
    timeout: 20000,
  }).catch((error) => error as { code: number; stdout: string; stderr: string });
  expect(result).toMatchObject({ code: 124 });
  expect(result.stderr).toContain('TIMEOUT group=fast');
  expect(result.stderr).toContain('pid=');
  expect(result.stderr).toContain('command=');
});
