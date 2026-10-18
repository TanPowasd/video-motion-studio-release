import { describe, it, expect } from 'vitest';
import {
  jsx,
  jsxs,
  h,
  Fragment,
  Stage,
  LocalTime,
  Steps,
  Step,
  useClock,
  toNodes,
  defineComponent,
  remap,
  springTo,
  springSettle,
  spring,
  beatClock,
  mixColor,
  cycle,
  rect,
  group,
  text,
  parseTransform,
  parseGradient,
  type ComponentContext,
} from '../src/sdk/index.js';
import { lintJsxSource } from '../src/core/jsx-lint.js';
import { writeBackJsxProps } from '../src/core/jsx-writeback.js';

const ctx = (frame = 0): ComponentContext => ({
  frame,
  seconds: frame / 30,
  fps: 30,
  width: 640,
  height: 360,
  seed: 1,
});
const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('JSX lowering: ids, nesting, fragments', () => {
  it('lowers intrinsics to nodes and scopes group children like the group() builder', () => {
    const tree = h(
      'group',
      { id: 'card', x: 10, y: 20, width: 300, height: 200 },
      h('rect', { id: 'bg', width: 300, height: 200, radius: 12, fill: '#123456' }),
      h('text', { id: 'title', fontSize: 24 }, 'Hello ', 42),
    );
    const nodes = toNodes(tree, ctx());
    expect(ids(nodes)).toEqual(['card', 'card/bg', 'card/title']);
    expect(nodes[1].parentId).toBe('card');
    expect(nodes[2].text).toBe('Hello 42');
    const builder = group(
      'card',
      [
        rect('bg', { width: 300, height: 200, radius: 12, fill: '#123456' }),
        text('title', 'Hello 42', { fontSize: 24 }),
      ],
      { x: 10, y: 20, width: 300, height: 200 },
    );
    expect(nodes).toEqual(builder);
  });
  it('flattens fragments, arrays and conditionals; keys become ids; auto ids are positional', () => {
    const show = false;
    const tree = jsxs(Fragment, {
      children: [
        jsx('rect', {}),
        show && jsx('rect', { id: 'hidden' }),
        null,
        [1, 2].map((i) => jsx('ellipse', { width: i }, `dot${i}`)),
        jsx('rect', {}),
      ],
    });
    expect(ids(toNodes(tree, ctx()))).toEqual(['rect-0', 'dot1', 'dot2', 'rect-1']);
  });
  it('keys on function components scope their ids; duplicates fail with a clear error', () => {
    const Badge = ({ label }: { label: string }) => h('text', { id: 'label' }, label);
    const ok = toNodes([jsx(Badge, { label: 'a' }, 'a'), jsx(Badge, { label: 'b' }, 'b')], ctx());
    expect(ids(ok)).toEqual(['a/label', 'b/label']);
    expect(
      codeOf(() => toNodes([jsx(Badge, { label: 'a' }), jsx(Badge, { label: 'b' })], ctx())),
    ).toBe('JSX_DUPLICATE_ID');
  });
  it('accepts builder node arrays as children (prefixed under the parent group)', () => {
    const nodes = toNodes(h('group', { id: 'fx' }, [rect('a'), rect('b')]), ctx());
    expect(ids(nodes)).toEqual(['fx', 'fx/a', 'fx/b']);
    expect(nodes[2].parentId).toBe('fx');
  });
  it('Stage is a full-frame group with an optional background rect', () => {
    const nodes = toNodes(
      h(Stage, { id: 'stage', background: '#000' }, h('rect', { id: 'r' })),
      ctx(),
    );
    expect(ids(nodes)).toEqual(['stage', 'stage/background', 'stage/r']);
    expect([nodes[0].width, nodes[0].height]).toEqual([640, 360]);
  });
  it('zIndex reorders siblings stably', () => {
    const nodes = toNodes(
      [
        h('rect', { id: 'a', zIndex: 2 }),
        h('rect', { id: 'b' }),
        h('rect', { id: 'c', style: { zIndex: -1 } }),
      ],
      ctx(),
    );
    expect(ids(nodes)).toEqual(['c', 'b', 'a']);
  });
  it('lowered output is deterministic for the same frame', () => {
    const Scene = () => {
      const { frame } = useClock();
      return h('rect', { id: 'r', x: frame * 2 });
    };
    expect(toNodes(h(Scene, null), ctx(7))).toEqual(toNodes(h(Scene, null), ctx(7)));
  });
});

describe('JSX time containers', () => {
  const Probe = ({ id }: { id: string }) => {
    const c = useClock();
    return h('rect', { id, x: c.frame, y: c.start, width: c.duration ?? 0 });
  };
  it('LocalTime shifts the clock and hides children outside the window', () => {
    const tree = h(LocalTime, { start: 10, duration: 20 }, h(Probe, { id: 'p' }));
    expect(toNodes(tree, ctx(5))).toEqual([]);
    const at = toNodes(tree, ctx(15));
    expect([at[0].x, at[0].y, at[0].width]).toEqual([5, 10, 20]);
    expect(toNodes(tree, ctx(30))).toEqual([]);
  });
  it('nested LocalTime accumulates start offsets', () => {
    const tree = h(LocalTime, { start: 10 }, h(LocalTime, { start: 5 }, h(Probe, { id: 'p' })));
    const [n] = toNodes(tree, ctx(20));
    expect([n.x, n.y]).toEqual([5, 15]);
  });
  it('Steps play children back to back, with overlap offsets', () => {
    const tree = h(
      Steps,
      null,
      h(Step, { duration: 10 }, h(Probe, { id: 'a' })),
      h(Step, { duration: 10, offset: -2 }, h(Probe, { id: 'b' })),
      h(Step, null, h(Probe, { id: 'c' })),
    );
    expect(ids(toNodes(tree, ctx(3)))).toEqual(['a']);
    expect(ids(toNodes(tree, ctx(9)))).toEqual(['a', 'b']);
    expect(toNodes(tree, ctx(9))[1].x).toBe(1);
    expect(ids(toNodes(tree, ctx(18)))).toEqual(['c']);
    expect(ids(toNodes(tree, ctx(500)))).toEqual(['c']);
  });
  it('rejects malformed Steps and Step outside Steps', () => {
    expect(codeOf(() => toNodes(h(Steps, null, h('rect', {})), ctx()))).toBe('JSX_STEPS_CHILD');
    expect(
      codeOf(() => toNodes(h(Steps, null, h(Step, null), h(Step, { duration: 3 })), ctx())),
    ).toBe('JSX_STEP_DURATION');
    expect(codeOf(() => toNodes(h(Step, { duration: 3 }), ctx()))).toBe('JSX_STEP_OUTSIDE');
  });
  it('video inside LocalTime anchors its source time to the local start', () => {
    const [v] = toNodes(
      h(LocalTime, { start: 30 }, h('video', { id: 'v', src: 'assets/a.mp4', trimStart: 12 })),
      ctx(40),
    );
    expect(v.timeMapping.anchor).toBe(30);
    expect(v.timeMapping.offset).toBe(12);
    expect(v.source).toBe('assets/a.mp4');
  });
  it('useClock outside rendering fails clearly', () => {
    expect(codeOf(() => useClock())).toBe('JSX_CLOCK');
  });
  it('defineComponent lowers JSX renders and leaves node-array renders untouched', () => {
    const jsxComponent = defineComponent({
      name: 'j',
      parameters: { size: { type: 'number', default: 10 } },
      render: (_c, p) => h('rect', { id: 'r', width: p.size, x: useClock().frame }),
    });
    const tsComponent = defineComponent({
      name: 't',
      parameters: { size: { type: 'number', default: 10 } },
      render: (c, p) => [rect('r', { width: p.size, x: c.frame })],
    });
    expect(jsxComponent.render(ctx(4), { size: 10 } as never)).toEqual(
      tsComponent.render(ctx(4), { size: 10 } as never),
    );
  });
});

describe('value mapping, springs and beats', () => {
  it('remap clamps by default, extrapolates on request and supports multi-stop easing', () => {
    expect(remap(-5, [0, 10], [0, 100])).toBe(0);
    expect(remap(15, [0, 10], [0, 100])).toBe(100);
    expect(remap(15, [0, 10], [0, 100], { clamp: false })).toBe(150);
    expect(remap(15, [0, 10], [0, 100], { clamp: 'start' })).toBe(150);
    expect(remap(5, [0, 10, 20], [0, 100, 0])).toBe(50);
    expect(remap(15, [0, 10, 20], [0, 100, 0])).toBe(50);
    expect(remap(5, [0, 10], [0, 1], { easing: 'outCubic' })).toBeCloseTo(0.875);
    expect(() => remap(1, [0, 0], [0, 1])).toThrow(/strictly increase/);
  });
  it('springTo maps the closed-form spring and settles', () => {
    const c = { frame: 12, fps: 30 };
    expect(springTo(c, { from: 100, to: 200 })).toBeCloseTo(100 + 100 * spring(c));
    expect(springTo({ frame: 0, fps: 30 }, { from: 5, to: 9 })).toBe(5);
    const settle = springSettle(30);
    expect(settle).toBeGreaterThan(5);
    expect(Math.abs(1 - spring({ frame: settle, fps: 30 }))).toBeLessThanOrEqual(0.001);
    expect(springSettle(30, { stiffness: 400, damping: 40 })).toBeLessThan(settle);
  });
  it('beatClock does 128 BPM frame math', () => {
    const b = beatClock({ frame: 60, fps: 30 }, 128);
    expect(b.framesPerBeat).toBeCloseTo(14.0625);
    expect(b.index).toBe(4);
    expect(b.phase).toBeCloseTo(60 / 14.0625 - 4);
    expect(b.bar).toBe(1);
    expect(b.beatInBar).toBe(0);
    expect(b.frameOfBeat(8)).toBeCloseTo(112.5);
    expect(beatClock({ frame: 0, fps: 30 }, 128).pulse).toBe(1);
  });
  it('mixColor and cycle', () => {
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080ff');
    expect(mixColor('#f00', '#00f', 2)).toBe('#0000ffff');
    expect(cycle(['a', 'b', 'c'], -1)).toBe('c');
  });
});

describe('style subset', () => {
  it('maps position, size, colors, radius, border, shadow, filters, blend and fonts', () => {
    const [r] = toNodes(
      h('rect', {
        id: 'r',
        style: {
          left: '25%',
          top: 10,
          width: 100,
          height: '50%',
          background: '#ff0000',
          borderRadius: 8,
          border: '2px solid #fff',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          filter: 'blur(3px) brightness(1.2)',
          mixBlendMode: 'screen',
          opacity: 0.5,
        },
      }),
      ctx(),
    );
    expect([r.x, r.y, r.width, r.height]).toEqual([160, 10, 100, 180]);
    expect([
      r.fill,
      r.radius,
      r.stroke,
      r.strokeWidth,
      r.blur,
      r.brightness,
      r.blend,
      r.opacity,
    ]).toEqual(['#ff0000', 8, '#fff', 2, 3, 1.2, 'screen', 0.5]);
    expect(r.shadow).toEqual({ x: 0, y: 4, blur: 12, color: 'rgba(0,0,0,0.4)' });
    const [t] = toNodes(
      h(
        'text',
        {
          id: 't',
          style: {
            fontSize: 32,
            fontWeight: 'bold',
            textAlign: 'center',
            lineHeight: '48px',
            color: '#eee',
          },
        },
        'x',
      ),
      ctx(),
    );
    expect([t.fontSize, t.fontWeight, t.align, t.lineHeight, t.fill]).toEqual([
      32,
      700,
      'center',
      1.5,
      '#eee',
    ]);
  });
  it('canonical transforms become editable props around the box center; others compose a matrix', () => {
    const [a] = toNodes(
      h('rect', {
        id: 'a',
        width: 100,
        height: 50,
        style: { transform: 'translate(10px, 5px) rotate(90deg) scale(2)' },
      }),
      ctx(),
    );
    expect([a.x, a.y, a.rotation, a.scaleX, a.scaleY, a.originX, a.originY]).toEqual([
      10, 5, 90, 2, 2, 50, 25,
    ]);
    const t = parseTransform(
      'scale(2) translate(10px, 0)',
      { parent: { width: 0, height: 0 }, self: { width: 0, height: 0 } },
      { x: 0, y: 0 },
      '',
    );
    expect(t.matrix).toEqual([2, 0, 0, 2, 20, 0]);
    expect(
      codeOf(() => toNodes(h('rect', { style: { transform: 'rotateY(30deg)' } }), ctx())),
    ).toBe('JSX_STYLE_UNSUPPORTED');
  });
  it('gradients follow CSS angle semantics', () => {
    const g = parseGradient(
      'linear-gradient(90deg, #000 0%, #fff 100%)',
      { width: 200, height: 100 },
      '',
    );
    expect(g).toMatchObject({ type: 'linear', from: { x: 0, y: 50 }, to: { x: 200, y: 50 } });
    const [r] = toNodes(
      h('rect', { id: 'r', style: { background: 'radial-gradient(circle, #fff, #000)' } }),
      ctx(),
    );
    expect(r.gradient?.type).toBe('radial');
  });
  it('unsupported CSS fails with an alternative instead of mis-rendering', () => {
    const problem = (style: Record<string, unknown>) => {
      try {
        toNodes(h('rect', { id: 'r', style }), ctx());
      } catch (e) {
        return [(e as { code: string }).code, (e as Error).message];
      }
    };
    expect(problem({ display: 'flex' })?.[0]).toBe('JSX_LAYOUT_CONTEXT');
    expect(problem({ display: 'inline' })?.[0]).toBe('JSX_STYLE_UNSUPPORTED');
    expect(problem({ marginLeft: 4 })?.[1]).toMatch(/children of a display: 'flex'\/'grid' group/);
    expect(problem({ padding: 4 })?.[0]).toBe('JSX_LAYOUT_CONTEXT');
    expect(problem({ gap: 4 })?.[1]).toMatch(/needs display: 'flex' or 'grid'/);
    expect(problem({ order: 1 })?.[0]).toBe('JSX_STYLE_UNSUPPORTED');
    expect(problem({ transition: 'all 1s' })?.[1]).toMatch(/useClock/);
    expect(problem({ position: 'sticky' })?.[0]).toBe('JSX_STYLE_UNSUPPORTED');
    expect(problem({ borderRadius: '4px 4px 0 0' })?.[1]).toMatch(/per-corner/);
    expect(problem({ overflow: 'scroll' })?.[0]).toBe('JSX_STYLE_UNSUPPORTED');
    expect(problem({ letterSpacing: 2 })?.[1]).toMatch(/<text> only/);
    expect(problem({ fooBar: 1 })?.[1]).toMatch(/Supported:/);
  });
});

describe('diagnostics for DOM/React habits', () => {
  it('runtime rejects HTML tags, audio, events, className, unknown props and stray text', () => {
    expect(codeOf(() => toNodes(h('div', {}), ctx()))).toBe('JSX_HTML_ELEMENT');
    expect(codeOf(() => toNodes(h('audio', {}), ctx()))).toBe('JSX_AUDIO');
    expect(codeOf(() => toNodes(h('blink', {}), ctx()))).toBe('JSX_UNKNOWN_ELEMENT');
    expect(codeOf(() => toNodes(h('rect', { onClick: () => {} }), ctx()))).toBe(
      'JSX_EVENT_HANDLER',
    );
    expect(codeOf(() => toNodes(h('rect', { className: 'x' }), ctx()))).toBe('JSX_CLASSNAME');
    expect(codeOf(() => toNodes(h('group', {}, 'loose text'), ctx()))).toBe('JSX_TEXT_CHILD');
    expect(codeOf(() => toNodes(h('rect', {}, h('rect', {})), ctx()))).toBe('JSX_CHILDREN');
    expect(codeOf(() => toNodes(h('rect', { opacityy: 1 }), ctx()))).toBe('JSX_PROP');
    expect(codeOf(() => toNodes(h('rect', { width: -4 }), ctx()))).toBe('JSX_PROP_VALUE');
    let message = '';
    try {
      toNodes(h('rect', { rotate: 4 }), ctx());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/did you mean rotation/);
    const Async = async () => h('rect', {});
    expect(codeOf(() => toNodes(h(Async as never, null), ctx()))).toBe('JSX_ASYNC');
  });
  it('static lint reports React imports, hooks, browser APIs, nondeterminism, HTML tags and style keys with lines', () => {
    const source = [
      "import { useState } from 'react';",
      "import { defineComponent, useClock } from '@vmotion/sdk';",
      'const Bad = () => {',
      '  const [x] = useState(0);',
      '  const w = window.innerWidth + Math.random() + Date.now();',
      '  return <div onClick={() => {}} style={{ display: "flex", margin: 4, left: 3 }}><rect id="ok" /><rect /></div>;',
      '};',
      'export default defineComponent({ name: "b", parameters: {}, render: () => <Bad /> });',
    ].join('\n');
    const d = lintJsxSource('components/bad.tsx', source),
      codes = d.map((x) => `${x.code}@${x.line}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'JSX_REACT_IMPORT@1',
        'JSX_REACT_HOOK@4',
        'JSX_BROWSER_API@5',
        'JSX_NONDETERMINISTIC@5',
        'JSX_HTML_ELEMENT@6',
        'JSX_AUTO_ID@6',
      ]),
    );
    expect(d.filter((x) => x.code === 'JSX_AUTO_ID')).toHaveLength(1);
    expect(d.find((x) => x.code === 'JSX_AUTO_ID')?.severity).toBe('warning');
    // HTML element props are not linted twice (the tag error already covers them).
    expect(
      lintJsxSource('c.tsx', '<rect onClick={f} style={{ order: 1 }} id="a" />;').map(
        (x) => x.code,
      ),
    ).toEqual(['JSX_EVENT_HANDLER', 'JSX_STYLE_UNSUPPORTED']);
    expect(
      lintJsxSource('c.tsx', '<rect style={{ display: "flex", gap: 4, margin: 2 }} id="a" />;').map(
        (x) => x.code,
      ),
    ).toEqual(['JSX_LAYOUT_CONTEXT', 'JSX_LAYOUT_CONTEXT']);
    expect(
      lintJsxSource('c.tsx', '<group id="g" style={{ display: "grid", gap: 4 }}><rect id="a" style={{ flexGrow: 1 }} /></group>;'),
    ).toEqual([]);
    expect(
      lintJsxSource(
        'c.tsx',
        'const window = 1; const o = { fetch: 1 }; o.fetch; <rect id="a" x={window} />;',
      ),
    ).toEqual([]);
  });
});

describe('literal write-back', () => {
  const src = [
    'const A = () => <group id="g">',
    '  <rect id="box" x={10} y={-4} fill="#fff" width={remap(f, [0, 1], [0, 9])} />',
    '  <text key="label">hi</text>',
    '</group>;',
  ].join('\n');
  it('rewrites literal attributes, inserts missing ones and leaves computed ones', () => {
    const r = writeBackJsxProps('a.tsx', src, 'box', {
      x: 42,
      y: 7,
      fill: '#000',
      width: 3,
      opacity: 0.5,
      gradient: { type: 'x' },
    });
    expect(r.written).toEqual(['x', 'y', 'fill', 'opacity']);
    expect(r.skipped).toEqual([
      { prop: 'width', reason: 'computed' },
      { prop: 'gradient', reason: 'non-literal-value' },
    ]);
    expect(r.source).toContain(
      '<rect id="box" x={42} y={7} fill="#000" width={remap(f, [0, 1], [0, 9])} opacity={0.5} />',
    );
    expect(writeBackJsxProps('a.tsx', src, 'label', { fontSize: 30 }).source).toContain(
      '<text key="label" fontSize={30}>',
    );
  });
  it('refuses missing or ambiguous targets', () => {
    expect(() => writeBackJsxProps('a.tsx', src, 'nope', { x: 1 })).toThrow(/No JSX element/);
    expect(() => writeBackJsxProps('a.tsx', src + '<rect id="box" />', 'box', { x: 1 })).toThrow(
      /distinct ids/,
    );
  });
});
