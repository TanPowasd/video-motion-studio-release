import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { h, toNodes, LocalTime, Stage, measureTextBlock, type ComponentContext } from '../src/sdk/index.js';
import { computeLayout, layoutEngineInfo } from '../src/core/layout/taffy.js';
import { measureTextNode } from '../src/core/text-layout.js';
import { fitBox } from '../src/core/rendering/node-image-video.js';
import { newNode, type Node } from '../src/core/model.js';

const ctx = (frame = 0): ComponentContext => ({
  frame,
  seconds: frame / 30,
  fps: 30,
  width: 1280,
  height: 720,
  seed: 1,
});
const boxes = (tree: unknown, frame = 0) =>
  Object.fromEntries(
    toNodes(tree as never, ctx(frame)).map((n) => [
      n.id,
      [n.x, n.y, n.width, n.height].map((v) => Math.round(v * 100) / 100),
    ]),
  );
const byId = (tree: unknown, frame = 0) =>
  Object.fromEntries(toNodes(tree as never, ctx(frame)).map((n) => [n.id, n])) as Record<string, Node>;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('flexbox layout (taffy wasm)', () => {
  it('row: padding, gap, grow, justify/align and percent sizes', () => {
    const b = boxes(
      h(
        'group',
        { id: 'row', style: { display: 'flex', width: 600, height: 200, padding: 10, gap: 20, alignItems: 'center' } },
        h('rect', { id: 'a', style: { width: 100, height: 50 } }),
        h('rect', { id: 'b', style: { flexGrow: 1, height: '50%' } }),
        h('rect', { id: 'c', style: { flexGrow: 2, height: 20 } }),
      ),
    );
    expect(b['row']).toEqual([0, 0, 600, 200]);
    expect(b['row/a']).toEqual([10, 75, 100, 50]);
    // free = 580 - 100 - 40 = 440 → b 1/3, c 2/3
    expect(b['row/b']).toEqual([130, 55, 146.67, 90]);
    expect(b['row/c']).toEqual([296.67, 90, 293.33, 20]);
  });
  it('column with stretch, space-between, auto margins and absolute children', () => {
    const b = boxes(
      h(
        'group',
        { id: 'col', style: { display: 'flex', flexDirection: 'column', left: 40, top: 30, width: 300, height: 400, padding: 20, gap: 10 } },
        h('rect', { id: 'bg', style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' } }),
        h('rect', { id: 'a', style: { height: 50 } }),
        h('rect', { id: 'b', style: { height: 50, marginTop: 'auto' } }),
        h('rect', { id: 'corner', style: { position: 'absolute', right: 8, bottom: 8, width: 20, height: 20 } }),
      ),
    );
    expect(b['col']).toEqual([40, 30, 300, 400]);
    expect(b['col/bg']).toEqual([0, 0, 300, 400]);
    expect(b['col/a']).toEqual([20, 20, 260, 50]);
    // auto margin keeps the gap (patched taffy): 400 - 20 - 50 = 330
    expect(b['col/b']).toEqual([20, 330, 260, 50]);
    expect(b['col/corner']).toEqual([272, 372, 20, 20]);
  });
  it('wrap, row-reverse, justifyContent and nested containers', () => {
    const b = boxes(
      h(
        'group',
        { id: 'w', style: { display: 'flex', flexWrap: 'wrap', width: 250, gap: '10px 5px', justifyContent: 'center' } },
        ...[0, 1, 2, 3].map((i) => h('rect', { key: `i${i}`, style: { width: 80, height: 30 } })),
      ),
    );
    // 3 per line (80*3 + 2*5 = 250), the 4th centred on line two
    expect(b['w']).toEqual([0, 0, 250, 70]);
    expect(b['w/i2']).toEqual([170, 0, 80, 30]);
    expect(b['w/i3']).toEqual([85, 40, 80, 30]);
    const r = boxes(
      h(
        'group',
        { id: 'r', style: { display: 'flex', flexDirection: 'row-reverse', width: 200, height: 40 } },
        h('rect', { id: 'x', style: { width: 50 } }),
        h('group', { id: 'n', style: { display: 'flex', width: 100, justifyContent: 'flex-end' } }, h('rect', { id: 'dot', style: { width: 10, height: 10 } })),
      ),
    );
    expect(r['r/x']).toEqual([150, 0, 50, 40]);
    expect(r['r/n']).toEqual([50, 0, 100, 40]);
    expect(r['r/n/dot']).toEqual([90, 0, 10, 10]);
  });
  it('min/max sizes, flexBasis, flex shorthand and aspectRatio', () => {
    const b = boxes(
      h(
        'group',
        { id: 'f', style: { display: 'flex', width: 500, height: 100, alignItems: 'flex-start' } },
        h('rect', { id: 'a', style: { flex: 1, maxWidth: 120, height: 10 } }),
        h('rect', { id: 'b', style: { flex: '1 1 0', minWidth: 300, height: 10 } }),
        h('rect', { id: 'c', style: { width: 50, flexShrink: 0, aspectRatio: '2 / 1' } }),
      ),
    );
    expect(b['f/a']).toEqual([0, 0, 120, 10]);
    expect(b['f/b']).toEqual([120, 0, 330, 10]);
    expect(b['f/c']).toEqual([450, 0, 50, 25]);
  });
});

describe('grid layout', () => {
  it('repeat/fr tracks, gaps, spans and auto rows', () => {
    const b = boxes(
      h(
        'group',
        { id: 'g', style: { display: 'grid', width: 400, gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, gridAutoRows: 40 } },
        h('rect', { id: 'wide', style: { gridColumn: '1 / span 2' } }),
        ...[0, 1, 2, 3, 4].map((i) => h('rect', { key: `c${i}` })),
      ),
    );
    expect(b['g']).toEqual([0, 0, 400, 140]);
    expect(b['g/wide']).toEqual([0, 0, 263.33, 40]);
    expect(b['g/c0']).toEqual([273.33, 0, 126.67, 40]);
    expect(b['g/c3']).toEqual([273.33, 50, 126.67, 40]);
    expect(b['g/c4']).toEqual([0, 100, 126.67, 40]);
  });
  it('px/auto/minmax tracks, explicit placement and template from a number or array', () => {
    const b = boxes(
      h(
        'group',
        { id: 'g', style: { display: 'grid', width: 500, height: 300, gridTemplateColumns: [100, 'minmax(50px, 1fr)', 'auto'], gridTemplateRows: '1fr 2fr' } },
        h('rect', { id: 'side', style: { gridColumn: 1, gridRow: '1 / 3' } }),
        h('rect', { id: 'tag', style: { gridColumn: 3, width: 60, height: 20 } }),
        h('rect', { id: 'main', style: { gridColumnStart: 2, gridRowStart: 2 } }),
      ),
    );
    expect(b['g/side']).toEqual([0, 0, 100, 300]);
    expect(b['g/tag']).toEqual([440, 0, 60, 20]);
    expect(b['g/main']).toEqual([100, 100, 340, 200]);
    const n = boxes(
      h('group', { id: 'n', style: { display: 'grid', width: 300, gridTemplateColumns: 3 } }, h('rect', { id: 'a', style: { height: 10 } })),
    );
    expect(n['n/a']).toEqual([0, 0, 100, 10]);
    expect(codeOf(() => toNodes(h('group', { style: { display: 'grid', gridTemplateColumns: '[a] 1fr' } }), ctx()))).toBe('JSX_STYLE_UNSUPPORTED');
    expect(codeOf(() => toNodes(h('group', { style: { display: 'grid', gridTemplateColumns: 'repeat(x, 1fr)' } }), ctx()))).toBe('JSX_STYLE_VALUE');
  });
  it('groups without display act as content-sized boxes; their x/y children resolve % against them', () => {
    const b = boxes(
      h(
        'group',
        { id: 'g', style: { display: 'grid', width: 300, gridTemplateColumns: '1fr 1fr', columnGap: 20 } },
        h(
          'group',
          { id: 'card' },
          h('rect', { id: 'bg', style: { width: '100%', height: '100%' } }),
          h('rect', { id: 'chip', x: 10, y: 15, width: 30, height: 30 }),
        ),
        h('group', { id: 'fixed', width: 50, height: 70 }, h('rect', { id: 'r', width: 30 })),
      ),
    );
    // content size is 45 high; the grid row (70, from the fixed group) stretches it
    expect(b['g/card']).toEqual([0, 0, 140, 70]);
    expect(b['g/card/bg']).toEqual([0, 0, 140, 70]);
    expect(b['g/card/chip']).toEqual([10, 15, 30, 30]);
    // fixed-size group stays a leaf; its children keep batch-1 absolute semantics
    expect(b['g/fixed']).toEqual([160, 0, 50, 70]);
  });
});

describe('text measurement (renderer font metrics)', () => {
  it('auto-sized text measures like measureTextBlock and wraps CJK in narrow boxes', () => {
    const label = '弹性布局 Flex layout 测量';
    const block = measureTextBlock(label, { fontSize: 32, width: 1e9 });
    const b = byId(
      h(
        'group',
        { id: 'r', style: { display: 'flex', width: 800, alignItems: 'flex-start' } },
        h('text', { id: 't', fontSize: 32 }, label),
      ),
    );
    expect(b['r/t'].width).toBeCloseTo(block.width, 2);
    expect(b['r/t'].height).toBeCloseTo(32 * 1.3, 3);
    const narrow = byId(
      h(
        'group',
        { id: 'r', style: { display: 'flex', flexDirection: 'column', width: 120 } },
        h('text', { id: 't', fontSize: 32 }, '中文按字断行的段落'),
      ),
    );
    const wrapped = measureTextNode(narrow['r/t'], 120);
    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(narrow['r/t'].height).toBeCloseTo(wrapped.lines.length * 32 * 1.3, 3);
    // the laid-out width is what the renderer wraps at: identical lines
    expect(measureTextNode(narrow['r/t'], narrow['r/t'].width).lines).toEqual(wrapped.lines);
  });
  it('min-content uses the longest word; glyph-set text uses the composed advances', () => {
    const b = byId(
      h(
        'group',
        { id: 'g', style: { display: 'grid', width: 10, gridTemplateColumns: 'min-content' } },
        h('text', { id: 't', fontSize: 20 }, 'aa longestword b'),
      ),
    );
    const longest = measureTextNode(newNode({ id: 'x', type: 'text', fontSize: 20, text: 'longestword' }), Infinity);
    expect(b['g/t'].width).toBeCloseTo(longest.width, 1);
    const glyph = byId(
      h(
        'group',
        { id: 'r', style: { display: 'flex', width: 900, alignItems: 'flex-start' } },
        h('text', { id: 't', fontSize: 40, glyphSet: 'builtin:demo' }, '江河湖 ok'),
      ),
    );
    const direct = measureTextBlock('江河湖 ok', { fontSize: 40, width: 1e9, glyphSet: 'builtin:demo' });
    expect(glyph['r/t'].width).toBeCloseTo(direct.width, 2);
  });
  it('letterSpacing tracks text, widens the measured box and keeps center alignment', () => {
    const plain = byId(h('group', { id: 'r', style: { display: 'flex', width: 900, alignItems: 'flex-start' } }, h('text', { id: 't', fontSize: 30 }, 'ABCD')));
    const tracked = byId(
      h('group', { id: 'r', style: { display: 'flex', width: 900, alignItems: 'flex-start' } }, h('text', { id: 't', fontSize: 30, style: { letterSpacing: 10 } }, 'ABCD')),
    );
    expect(tracked['r/t'].width - plain['r/t'].width).toBeCloseTo(30, 2);
    expect(tracked['r/t'].textAnimators[0]).toMatchObject({ id: 'css-letter-spacing', values: { tracking: 10 } });
    const centred = byId(h('text', { id: 't', width: 400, fontSize: 30, style: { letterSpacing: '0.5em', textAlign: 'center' } }, 'ABCD'))['t'];
    expect(centred.textAnimators.map((a) => [a.id, a.values.x, a.values.tracking])).toEqual([
      ['css-letter-spacing', 0, 15],
      ['css-letter-spacing-line-0', -22.5, 0],
    ]);
  });
  it('textTransform rewrites the string before measuring', () => {
    const n = byId(
      h(
        'group',
        { id: 'g' },
        h('text', { id: 'u', style: { textTransform: 'uppercase' } }, 'vmotion jsx'),
        h('text', { id: 'c', style: { textTransform: 'capitalize' } }, 'hello wide world'),
      ),
    );
    expect(n['g/u'].text).toBe('VMOTION JSX');
    expect(n['g/c'].text).toBe('Hello Wide World');
  });
});

describe('layout semantics', () => {
  it('is animatable per frame and deterministic across runs', () => {
    const tree = (frame: number) =>
      h(
        'group',
        { id: 'row', style: { display: 'flex', width: 200 + frame * 10, gap: frame } },
        h('rect', { id: 'a', style: { flexGrow: 1, height: 10 } }),
        h('text', { id: 't', fontSize: 24 }, '节拍 beat'),
      );
    const a = boxes(tree(0)),
      b = boxes(tree(12));
    expect(a['row/a'][2]).not.toEqual(b['row/a'][2]);
    expect(JSON.stringify(toNodes(tree(7), ctx()))).toBe(JSON.stringify(toNodes(tree(7), ctx())));
    // independent engine invocation from a child process: byte-identical boxes
    const script = `import { h, toNodes } from './src/sdk/index.ts';
      const t = h('group', { id: 'row', style: { display: 'flex', width: 270, gap: 7 } }, h('rect', { id: 'a', style: { flexGrow: 1, height: 10 } }), h('text', { id: 't', fontSize: 24 }, '节拍 beat'));
      process.stdout.write(JSON.stringify(toNodes(t, { frame: 0, seconds: 0, fps: 30, width: 1280, height: 720, seed: 1 }).map((n) => [n.id, n.x, n.y, n.width, n.height])));`;
    const child = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child).toBe(JSON.stringify(toNodes(tree(7), ctx()).map((n) => [n.id, n.x, n.y, n.width, n.height])));
  });
  it('LocalTime children join the flow only while visible (reflow over time)', () => {
    const tree = h(
      'group',
      { id: 'row', style: { display: 'flex', width: 300, gap: 10 } },
      h('rect', { id: 'a', style: { width: 50, height: 10 } }),
      h(LocalTime, { key: 'late', start: 10 }, h('rect', { id: 'b', style: { width: 50, height: 10 } })),
      h('rect', { id: 'c', style: { width: 50, height: 10 } }),
    );
    expect(boxes(tree, 0)['row/c']).toEqual([60, 0, 50, 10]);
    expect(boxes(tree, 12)['row/c']).toEqual([120, 0, 50, 10]);
  });
  it('size-dependent style is lowered after layout: center transforms, gradients, radius %, clip', () => {
    const n = byId(
      h(
        'group',
        { id: 'row', style: { display: 'flex', width: 400, height: 100, overflow: 'hidden' } },
        h('rect', {
          id: 'a',
          style: { flexGrow: 1, transform: 'translate(10%, 0) rotate(10deg)', background: 'linear-gradient(90deg, #000, #fff)', borderRadius: '50%' },
        }),
      ),
    );
    expect(n['row'].clip).toEqual({ x: 0, y: 0, width: 400, height: 100 });
    expect(n['row/a']).toMatchObject({ x: 40, width: 400, height: 100, originX: 200, originY: 50, rotation: 10, radius: 50 });
    expect(n['row/a'].gradient).toMatchObject({ from: { x: 0, y: 50 }, to: { x: 400, y: 50 } });
    expect(byId(h('group', { id: 'g', width: 50, height: 40, style: { overflowY: 'clip' } }))['g'].clip).toMatchObject({ y: 0, height: 40 });
  });
  it('Stage can be a flex container and its background follows the layout box', () => {
    const n = byId(
      h(Stage, { id: 'stage', background: '#000', style: { display: 'flex', justifyContent: 'center', alignItems: 'center' } }, h('rect', { id: 'dot', style: { width: 20, height: 20 } })),
    );
    expect(n['stage/background']).toMatchObject({ width: 1280, height: 720 });
    expect([n['stage/dot'].x, n['stage/dot'].y]).toEqual([630, 350]);
  });
  it('explicit x/y on flow items are relative offsets; explicit props win over style', () => {
    const b = byId(
      h(
        'group',
        { id: 'row', style: { display: 'flex', width: 300 } },
        h('rect', { id: 'a', x: 5, y: 3, style: { width: 50, height: 10 } }),
        h('rect', { id: 'b', width: 70, fill: '#f00', style: { height: 10, background: '#00f' } }),
      ),
    );
    expect([b['row/a'].x, b['row/a'].y]).toEqual([5, 3]);
    expect([b['row/b'].x, b['row/b'].width, b['row/b'].fill]).toEqual([50, 70, '#f00']);
  });
  it('diagnoses layout keys outside a layout context', () => {
    expect(codeOf(() => toNodes(h('group', { style: { flexGrow: 1 } }), ctx()))).toBe('JSX_LAYOUT_CONTEXT');
    expect(codeOf(() => toNodes(h('text', { style: { display: 'flex' } }), ctx()))).toBe('JSX_LAYOUT_CONTEXT');
    expect(codeOf(() => toNodes(h('group', { style: { justifyContent: 'center' } }), ctx()))).toBe('JSX_LAYOUT_CONTEXT');
    expect(codeOf(() => toNodes(h('group', { style: { display: 'flex', alignItems: 'middle' } }), ctx()))).toBe('JSX_STYLE_VALUE');
  });
});

describe('engine and fit', () => {
  it('raw engine: definite/min/max available space and the embedded wasm matches its crate', () => {
    expect(layoutEngineInfo().engine).toMatch(/taffy/);
    expect(computeLayout([], 0, { width: 100, height: 100 })).toEqual([]);
    expect(() => computeLayout([5], 1, { width: 1, height: 1 })).toThrow(/rejected/);
    expect(execFileSync(process.execPath, ['scripts/build-layout-wasm.mjs', '--check'], { encoding: 'utf8' })).toMatch(/up to date/);
  });
  it('objectFit contain/cover boxes', () => {
    expect(fitBox({ width: 200, height: 100, fit: 'contain' }, 100, 100)).toEqual({ x: 50, y: 0, width: 100, height: 100, clip: false });
    expect(fitBox({ width: 200, height: 100, fit: 'cover' }, 100, 100)).toEqual({ x: 0, y: -50, width: 200, height: 200, clip: true });
    expect(fitBox({ width: 200, height: 100 }, 100, 100)).toMatchObject({ width: 200, height: 100 });
    expect(byId(h('image', { id: 'i', src: 'a.png', style: { objectFit: 'cover' } }))['i'].fit).toBe('cover');
  });
});
