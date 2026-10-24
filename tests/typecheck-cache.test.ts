import { describe, it, expect } from 'vitest';

describe('preflight typecheck reuse (write-back apply speed)', () => {
  it('shares exact typecheck results between renderer instances for the same sources', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises'),
      os = await import('node:os'),
      path = await import('node:path'),
      { initProject } = await import('../src/service/template.js'),
      { loadProject } = await import('../src/service/project.js'),
      { Renderer } = await import('../src/core/renderer.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-typecheck-'));
    try {
      await initProject(root);
      const snapshot = await loadProject(root);
      snapshot.files['components/probe.tsx'] =
        "/** @jsxImportSource @vmotion/sdk */\nimport { defineComponent } from '@vmotion/sdk';\nexport default defineComponent({ name: 'p', parameters: {}, render() { return <rect id=\"r\" width={10} height={10} />; } });\n";
      const a = new Renderer(root),
        b = new Renderer(root);
      try {
        const first = a.components.typecheck(snapshot);
        const second = b.components.typecheck(snapshot);
        expect(second).toEqual(first);
        expect(b.components.stats.typecheckHits).toBe(1);
        expect(b.components.stats.typechecks).toBe(0);
        // A changed source is checked again (no stale reuse).
        const broken = { ...snapshot, files: { ...snapshot.files, 'components/probe.tsx': snapshot.files['components/probe.tsx'].replace('width={10}', 'width={"x" * 2}') } };
        expect(b.components.typecheck(broken).some((d) => d.severity === 'error')).toBe(true);
        expect(b.components.stats.typechecks).toBe(1);
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
