import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@vmotion/sdk': path.resolve('src/sdk/index.ts') } },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    testTimeout: 30000,
    // Integration beforeEach hooks open a full Application (component compile + first render),
    // 5-9 s on a 2-core host; the 10 s default flakes under load, so match the test budget.
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'artifacts/coverage',
      reporter: ['text', 'json-summary'],
      include: [
        'src/core/**/*.ts',
        'src/service/**/*.ts',
        'src/mcp/**/*.ts',
        'src/plugins/**/*.ts',
        'src/editor/state/**/*.ts',
        'src/platform/**/*.ts',
      ],
    },
  },
});
