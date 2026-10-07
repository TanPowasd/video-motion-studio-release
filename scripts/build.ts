import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import ts from 'typescript';
import './schema.js';
await build({
  entryPoints: ['src/core/tracking-engine.ts'],
  outfile: 'dist/tracking/engine.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
});
await mkdir('dist/sdk', { recursive: true });
await build({
  entryPoints: ['src/sdk/index.ts'],
  outfile: 'dist/sdk/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
const declarations = ts.createProgram(['src/sdk/index.ts'], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true,
  emitDeclarationOnly: true,
  skipLibCheck: true,
  strict: true,
  outDir: 'dist/types',
  rootDir: 'src',
});
const declarationResult = declarations.emit();
if (declarationResult.emitSkipped) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(declarationResult.diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }),
  );
  throw new Error('SDK declaration generation failed');
}
await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['src/desktop/main.ts'],
  outfile: 'dist/desktop/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  define: { 'import.meta.url': '__filename' },
});
await build({
  entryPoints: ['src/desktop/preload.ts'],
  outfile: 'dist/desktop/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
});
