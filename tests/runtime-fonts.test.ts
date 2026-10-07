import { it, expect, vi } from 'vitest';
it('loads runtime fonts once and returns explicit fallback status on missing faces', async () => {
  vi.resetModules();
  let loads = 0;
  const add = vi.fn();
  class Face {
    constructor(
      public family: string,
      public source: string,
      public options: unknown,
    ) {}
    async load() {
      loads++;
      if (this.source.includes('bold')) throw Error('missing font');
      return this;
    }
  }
  vi.stubGlobal('FontFace', Face);
  vi.stubGlobal('document', { fonts: { add } });
  try {
    const { loadRuntimeFonts } = await import('../src/editor/runtime-fonts.js');
    const [a, b] = await Promise.all([loadRuntimeFonts(), loadRuntimeFonts()]);
    expect(a).toEqual({ family: 'Vmotion UI Sans', loaded: 1, failed: 1 });
    expect(a).toBe(b);
    expect(loads).toBe(2);
    expect(add).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
