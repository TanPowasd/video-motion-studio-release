/*
 * Vmotion JSX runtime. JSX elements are inert descriptions; `toNodes()` lowers them to the
 * flat node list the native renderer already draws. No DOM, no reconciler, no state:
 * every frame is a pure function of the clock, so random seeking stays exact.
 */
import { ZodError } from 'zod';
import { newNode, nodeBaseSchema, VmotionError, type Node, type NodeInput } from '../core/model.js';
import type { ComponentContext } from './index.js';
import { lowerStyle, styleKeyProblem, type VmStyle } from './jsx-style.js';
import {
  containerKeys,
  itemKeys,
  boxKeys,
  lengthSpec,
  type BoxKind,
  type Spec,
} from './jsx-layout.js';
import { LayoutSession, styleForLowering, type SessionBox } from './jsx-layout-session.js';
import { applyLetterSpacing } from '../core/text-layout.js';
export type { VmStyle } from './jsx-style.js';

export const VM_ELEMENT = Symbol.for('vmotion.jsx.element');
type ContainerKind = 'fragment' | 'stage' | 'localTime' | 'steps' | 'step';
export interface VmElement<P = Record<string, unknown>> {
  readonly $$typeof: typeof VM_ELEMENT;
  readonly type: string | VmFunctionComponent<any>;
  readonly props: P;
  readonly key: string | null;
}
export type VmChild =
  | VmElement<any>
  | (Partial<Node> & Pick<Node, 'id' | 'type'>)
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly VmChild[];
export type VmFunctionComponent<P = Record<string, unknown>> = ((props: P) => VmChild) & {
  displayName?: string;
  $$vmContainer?: ContainerKind;
};

/** The clock seen inside a time container: frame/seconds are local to the container. */
export interface LocalClock extends ComponentContext {
  /** Length of the enclosing LocalTime/Step in frames (undefined when open-ended). */
  duration?: number;
  /** Component frame at which this local clock reads 0. */
  start: number;
}

/* ------------------------------------------------------------------ element creation */
const createElement = (type: VmElement['type'], props: Record<string, unknown>, key: unknown) => {
  if (typeof type !== 'string' && typeof type !== 'function')
    throw new VmotionError(
      'JSX_ELEMENT_TYPE',
      `JSX element type must be an intrinsic tag or a function component (got ${String(type)})`,
    );
  return Object.freeze({
    $$typeof: VM_ELEMENT,
    type,
    props: props ?? {},
    key: key === undefined || key === null ? null : String(key),
  }) as VmElement;
};
/** Automatic JSX runtime entry points (`jsxImportSource: "@vmotion/sdk"`). */
export const jsx = (type: VmElement['type'], props: Record<string, unknown>, key?: unknown) =>
  createElement(type, props, key);
export const jsxs = jsx;
export const jsxDEV = (type: VmElement['type'], props: Record<string, unknown>, key?: unknown) =>
  createElement(type, props, key);
/** Classic-runtime factory, e.g. for hand-written element trees in plain .ts. */
export function h(
  type: VmElement['type'],
  props: Record<string, unknown> | null,
  ...children: VmChild[]
) {
  const { key, ...rest } = props ?? {};
  return createElement(
    type,
    children.length ? { ...rest, children: children.length === 1 ? children[0] : children } : rest,
    key,
  );
}
export const isElement = (value: unknown): value is VmElement =>
  !!value && typeof value === 'object' && (value as VmElement).$$typeof === VM_ELEMENT;

const container = <P>(kind: ContainerKind, name: string): VmFunctionComponent<P> => {
  const fn = (() => {
    throw new VmotionError(
      'JSX_CONTAINER',
      `${name} is lowered by the Vmotion runtime, not called`,
    );
  }) as unknown as VmFunctionComponent<P>;
  fn.$$vmContainer = kind;
  fn.displayName = name;
  return fn;
};
export const Fragment = container<{ children?: VmChild }>('fragment', 'Fragment');

/** Full-frame layer: a group at 0,0 sized to the component (or parent group), optional background. */
export const Stage = container<ElementProps & { background?: string; children?: VmChild }>(
  'stage',
  'Stage',
);
/** Time-shift container: children see frame 0 at `start`; hidden before start and after duration. */
export const LocalTime = container<{ start?: number; duration?: number; children?: VmChild }>(
  'localTime',
  'LocalTime',
);
/** Sequential container: each <Step duration> starts when the previous one ends (offset overlaps). */
export const Steps = container<{ start?: number; children?: VmChild }>('steps', 'Steps');
export const Step = container<{ duration?: number; offset?: number; children?: VmChild }>(
  'step',
  'Step',
);

/* ------------------------------------------------------------------ clock */
const clockStack: LocalClock[] = [];
export function rootClock(ctx: ComponentContext): LocalClock {
  return { ...ctx, start: 0 };
}
export function withClock<T>(clock: LocalClock, fn: () => T): T {
  clockStack.push(clock);
  try {
    return fn();
  } finally {
    clockStack.pop();
  }
}
/** Current (local) clock while a component renders. Inside <LocalTime>/<Step> frame is local. */
export function useClock(): LocalClock {
  const clock = clockStack.at(-1);
  if (!clock)
    throw new VmotionError(
      'JSX_CLOCK',
      'useClock() can only be called while a Vmotion component renders (inside render() or a JSX function component)',
    );
  return clock;
}

/* ------------------------------------------------------------------ intrinsic catalogue */
export const intrinsicTags = [
  'group',
  'rect',
  'ellipse',
  'path',
  'text',
  'formula',
  'image',
  'video',
  'chart',
  'drawing',
  'scene',
  'component',
  'scene3d',
  'program',
  'node',
] as const;
export type IntrinsicTag = (typeof intrinsicTags)[number];
const intrinsicSet = new Set<string>(intrinsicTags);
/** HTML/SVG tags agents often reach for, with the Vmotion replacement. */
export const htmlAlternatives: Record<string, string> = {
  div: '<group> for containers or <rect> for a filled box',
  section: '<group>',
  main: '<group>',
  header: '<group>',
  footer: '<group>',
  article: '<group>',
  nav: '<group>',
  aside: '<group>',
  ul: '<group> with computed y offsets',
  ol: '<group> with computed y offsets',
  li: '<group> or <text>',
  span: '<text>',
  p: '<text>',
  h1: '<text fontSize={...} fontWeight={700}>',
  h2: '<text fontSize={...} fontWeight={700}>',
  h3: '<text fontSize={...} fontWeight={700}>',
  h4: '<text>',
  h5: '<text>',
  h6: '<text>',
  strong: '<text fontWeight={700}>',
  em: '<text>',
  b: '<text fontWeight={700}>',
  i: '<text>',
  a: '<text> (there are no links in rendered frames)',
  label: '<text>',
  button: '<group> with <rect> and <text> (no interaction in rendered frames)',
  input: 'parameters on defineComponent({ parameters }) (frames are not interactive)',
  img: '<image src="assets/..."> or <image asset="assetId">',
  picture: '<image>',
  svg: '<path d="..."> / <group> (SVG documents are not parsed)',
  g: '<group>',
  circle: '<ellipse>',
  line: '<path d="M x1 y1 L x2 y2" stroke=...>',
  polyline: '<path d="..."> (use pointsPath())',
  polygon: '<path d="... Z"> (use pointsPath(points, true))',
  canvas: '<path>/<rect> nodes or a render program (no 2D canvas access)',
  iframe: 'nothing: external pages cannot be rendered',
  audio:
    'a sequence audio clip (editing tools) or audioAssetId on the component node to drive ctx.audio',
};
const nodeKeys = new Set(
  Object.keys(nodeBaseSchema.shape).filter(
    (k) => !['id', 'type', 'parentId', 'overrides'].includes(k),
  ),
);
const groupLike = new Set(['group', 'stage']);
const propSuggestions: Record<string, string> = {
  rotate: 'rotation',
  left: 'x (or style.left)',
  top: 'y (or style.top)',
  w: 'width',
  h: 'height',
  alpha: 'opacity',
  color: 'fill (or style.color)',
  backgroundColor: 'fill (or style.backgroundColor)',
  background: 'fill (or style.background)',
  borderRadius: 'radius (or style.borderRadius)',
  cornerRadius: 'radius',
  font: 'fontFamily / fontSize',
  content: 'text (or text children)',
  value: 'text (or text children)',
  textAlign: 'align',
  href: 'nothing: rendered frames have no links',
  transform: 'style.transform or x/y/rotation/scale props',
  translateX: 'x',
  translateY: 'y',
  strokeColor: 'stroke',
  lineWidth: 'strokeWidth',
  delay: '<LocalTime start={...}> around the element',
  from: '<LocalTime start={...}> (time) or remap() (values)',
  durationInFrames: '<LocalTime duration={...}> or <Step duration={...}>',
};
const levenshtein = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};
export function suggestProp(name: string): string | undefined {
  if (propSuggestions[name]) return propSuggestions[name];
  let best: string | undefined,
    score = 3;
  for (const key of [...nodeKeys, ...extraProps]) {
    const d = levenshtein(name.toLowerCase(), key.toLowerCase());
    if (d < score) {
      score = d;
      best = key;
    }
  }
  return best;
}
/** Convenience props accepted on intrinsics in addition to node properties. */
const extraProps = [
  'style',
  'scale',
  'origin',
  'skewX',
  'skewY',
  'zIndex',
  'd',
  'src',
  'asset',
  'tex',
  'trimStart',
  'playbackRate',
  'background',
];

/** Diagnose a prop name on an intrinsic; returns [code, message] or undefined when allowed. */
export function intrinsicPropProblem(tag: string, name: string): [string, string] | undefined {
  if (name === 'children' || name === 'id' || name === 'key') return undefined;
  if (/^on[A-Z]/.test(name))
    return [
      'JSX_EVENT_HANDLER',
      `${name} on <${tag}>: Vmotion renders frames offline, there are no events. Derive changes from useClock() (frame) or component parameters.`,
    ];
  if (name === 'className' || name === 'class')
    return [
      'JSX_CLASSNAME',
      `${name} on <${tag}>: there is no stylesheet; use node props or the style subset.`,
    ];
  if (name === 'ref')
    return [
      'JSX_REF',
      `ref on <${tag}>: nodes are rebuilt every frame; refer to layers by their stable id instead.`,
    ];
  if (name === 'dangerouslySetInnerHTML')
    return ['JSX_HTML', `dangerouslySetInnerHTML on <${tag}>: HTML is not rendered; use <text>.`];
  if (name === 'type' && tag !== 'node')
    return [
      'JSX_PROP',
      `type on <${tag}>: the tag already sets the node type (use <node type=...> for raw kinds).`,
    ];
  if (name === 'parentId' || name === 'overrides')
    return [
      'JSX_PROP',
      `${name} on <${tag}>: nesting sets parents; overrides are written by visual edits.`,
    ];
  if (nodeKeys.has(name) || extraProps.includes(name)) return undefined;
  const suggestion = suggestProp(name);
  return [
    'JSX_PROP',
    `Unknown prop ${name} on <${tag}>${suggestion ? `; did you mean ${suggestion}?` : ''}`,
  ];
}

/* ------------------------------------------------------------------ lowering */
export interface ElementProps extends Partial<
  Omit<NodeInput, 'id' | 'type' | 'parentId' | 'overrides'>
> {
  id?: string;
  /** Stable sibling identity (lifted out of props by the runtime); used as id when id is absent. */
  key?: string | number | null;
  style?: VmStyle;
  /** Uniform scale (sets scaleX and scaleY). */
  scale?: number;
  /** Pivot for rotation/scale: 'center', 'top-left', [x, y] or {x, y} (local px). */
  origin?: 'center' | 'top-left' | readonly [number, number] | { x: number; y: number };
  /** Shear in degrees (composed into matrix). */
  skewX?: number;
  skewY?: number;
  /** Draw order among siblings (stable; default 0). */
  zIndex?: number;
}

interface Scope {
  prefix: string;
  parentId?: string;
  box: { width: number; height: number };
  clock: LocalClock;
  counters: Map<string, number>;
  path: string;
  /** Set inside a flex/grid subtree: the layout tree and this scope's parent box. */
  layout?: { session: LayoutSession; parent: number; kind: BoxKind };
}
interface State {
  out: Node[];
  ids: Map<string, string>;
  z: Map<string, number>;
  sorted: boolean;
}
const err = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new VmotionError(code, message, details);

const flatten = (child: VmChild, list: VmChild[]) => {
  if (Array.isArray(child)) for (const c of child) flatten(c, list);
  else if (
    child !== null &&
    child !== undefined &&
    child !== false &&
    child !== true &&
    child !== ''
  )
    list.push(child);
};
const isNode = (value: unknown): value is Partial<Node> & Pick<Node, 'id' | 'type'> =>
  !!value &&
  typeof value === 'object' &&
  !isElement(value) &&
  typeof (value as Node).id === 'string' &&
  typeof (value as Node).type === 'string';
const tagName = (type: VmElement['type']) =>
  typeof type === 'string' ? type : type.displayName || type.name || 'Component';

const autoName = (scope: Scope, base: string) => {
  const n = scope.counters.get(base) ?? 0;
  scope.counters.set(base, n + 1);
  return `${base}-${n}`;
};
const localName = (value: unknown, at: string, what: string) => {
  const name = String(value);
  if (!name || name.length > 120)
    throw err('JSX_ID', `${what} must be a non-empty string up to 120 characters`, { at });
  return name;
};

function emit(state: State, node: Node, at: string, zIndex?: number) {
  const previous = state.ids.get(node.id);
  if (previous !== undefined)
    throw err(
      'JSX_DUPLICATE_ID',
      `Duplicate node id "${node.id}" (${previous} and ${at}). Give siblings distinct id= or key= props; a key on a component or <LocalTime> scopes the ids inside it.`,
      { nodeId: node.id },
    );
  state.ids.set(node.id, at);
  state.out.push(node);
  if (zIndex !== undefined && zIndex !== 0) {
    state.z.set(node.id, zIndex);
    state.sorted = true;
  }
}

function lowerChildren(children: unknown, scope: Scope, state: State) {
  const list: VmChild[] = [];
  flatten(children as VmChild, list);
  for (const child of list) lowerChild(child, scope, state);
}

function lowerChild(child: VmChild, scope: Scope, state: State) {
  if (Array.isArray(child)) return lowerChildren(child, scope, state);
  if (child === null || child === undefined || typeof child === 'boolean' || child === '') return;
  if (typeof child === 'string' || typeof child === 'number')
    throw err(
      'JSX_TEXT_CHILD',
      `Text "${String(child).slice(0, 40)}" must be inside <text>…</text> (at ${scope.path || 'root'})`,
      { at: scope.path },
    );
  if (isNode(child)) {
    const p = scope.prefix;
    emit(
      state,
      {
        ...(child as Node),
        id: p + child.id,
        parentId: child.parentId ? p + child.parentId : scope.parentId,
        maskId: child.maskId ? p + child.maskId : undefined,
      } as Node,
      `${scope.path}/${child.id}`,
    );
    return;
  }
  if (!isElement(child)) {
    if (child && typeof (child as { then?: unknown }).then === 'function')
      throw err(
        'JSX_ASYNC',
        'Components must render synchronously; async components and Promises are not supported. Load data through parameters or project files.',
        { at: scope.path },
      );
    throw err('JSX_CHILD', `Unsupported JSX child at ${scope.path || 'root'}: ${typeof child}`, {
      at: scope.path,
    });
  }
  const { type, props, key } = child;
  if (typeof type === 'function') {
    const kind = type.$$vmContainer;
    if (kind === 'stage') return lowerIntrinsic('stage', props, key, scope, state);
    const scoped =
      key !== null && kind !== 'step'
        ? {
            ...scope,
            prefix: scope.prefix + localName(key, scope.path, 'key') + '/',
            counters: new Map(),
            path: `${scope.path}/${key}`,
          }
        : scope;
    if (kind === 'fragment') return lowerChildren(props.children, scoped, state);
    if (kind === 'localTime') {
      const start = num(props.start ?? 0, 'LocalTime start', scope.path),
        duration =
          props.duration === undefined
            ? undefined
            : positive(props.duration, 'LocalTime duration', scope.path);
      return lowerTimed(props.children, scoped, state, start, duration);
    }
    if (kind === 'steps') {
      let cursor = num(props.start ?? 0, 'Steps start', scope.path);
      const steps: VmChild[] = [];
      flatten(props.children as VmChild, steps);
      steps.forEach((step, i) => {
        if (!isElement(step) || (step.type as VmFunctionComponent).$$vmContainer !== 'step')
          throw err(
            'JSX_STEPS_CHILD',
            `<Steps> children must be <Step duration={...}> elements (child ${i} at ${scope.path || 'root'})`,
            { at: scope.path },
          );
        const sp = step.props as { duration?: unknown; offset?: unknown; children?: VmChild },
          offset = num(sp.offset ?? 0, 'Step offset', scope.path),
          last = i === steps.length - 1;
        if (sp.duration === undefined && !last)
          throw err(
            'JSX_STEP_DURATION',
            `Only the last <Step> may omit duration (step ${i} at ${scope.path || 'root'})`,
            { at: scope.path },
          );
        const duration =
            sp.duration === undefined
              ? undefined
              : positive(sp.duration, 'Step duration', scope.path),
          start = cursor + offset,
          stepScope =
            step.key !== null
              ? {
                  ...scope,
                  prefix: scope.prefix + localName(step.key, scope.path, 'key') + '/',
                  counters: new Map(),
                  path: `${scope.path}/${step.key}`,
                }
              : scoped;
        lowerTimed(sp.children, stepScope, state, start, duration);
        cursor = start + (duration ?? 0);
      });
      return;
    }
    if (kind === 'step')
      throw err(
        'JSX_STEP_OUTSIDE',
        '<Step> must be a direct child of <Steps>; use <LocalTime start duration> for a single time window',
        { at: scope.path },
      );
    const result = withClock(scope.clock, () => type(props));
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw err(
        'JSX_ASYNC',
        `${tagName(type)} returned a Promise; components must render synchronously`,
        { at: scope.path },
      );
    return lowerChild(
      result,
      { ...scoped, path: scoped === scope ? `${scope.path}/<${tagName(type)}>` : scoped.path },
      state,
    );
  }
  return lowerIntrinsic(type, props, key, scope, state);
}

const num = (value: unknown, what: string, at: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw err('JSX_TIME', `${what} must be a finite number of frames`, { at });
  return value;
};
const positive = (value: unknown, what: string, at: string) => {
  const n = num(value, what, at);
  if (n <= 0) throw err('JSX_TIME', `${what} must be positive`, { at });
  return n;
};

function lowerTimed(
  children: unknown,
  scope: Scope,
  state: State,
  start: number,
  duration?: number,
) {
  const local = scope.clock.frame - start;
  if (local < 0 || (duration !== undefined && local >= duration)) return;
  const clock: LocalClock = {
    ...scope.clock,
    frame: local,
    seconds: local / scope.clock.fps,
    duration,
    start: scope.clock.start + start,
  };
  lowerChildren(children, { ...scope, clock }, state);
}

function lowerIntrinsic(
  tag: string,
  rawProps: Record<string, unknown>,
  key: string | null,
  scope: Scope,
  state: State,
) {
  if (!intrinsicSet.has(tag) && tag !== 'stage') {
    const alt = htmlAlternatives[tag];
    if (tag === 'audio')
      throw err('JSX_AUDIO', `<audio> cannot be emitted from a frame: use ${alt}`, {
        at: scope.path,
      });
    throw err(
      alt ? 'JSX_HTML_ELEMENT' : 'JSX_UNKNOWN_ELEMENT',
      alt
        ? `<${tag}> is an HTML/SVG element; Vmotion JSX is not DOM. Use ${alt}.`
        : `<${tag}> is not a Vmotion element. Use one of: ${intrinsicTags.join(', ')}, or a function component.`,
      { at: scope.path, tag },
    );
  }
  const {
    children,
    style,
    scale,
    origin,
    skewX,
    skewY,
    zIndex: zProp,
    d,
    src,
    asset,
    tex,
    trimStart,
    playbackRate,
    background,
    id: explicitId,
    ...rest
  } = rawProps as Record<string, any>;
  const local =
    explicitId !== undefined
      ? localName(explicitId, scope.path, 'id')
      : key !== null
        ? localName(key, scope.path, 'key')
        : autoName(scope, tag);
  const id = scope.prefix + local,
    at = `${scope.path}/${local}`;
  for (const name of Object.keys(rest)) {
    if (tag === 'node' && name === 'type') continue;
    const problem = intrinsicPropProblem(tag, name);
    if (problem) throw err(problem[0], problem[1], { at, nodeId: id });
  }
  if (background !== undefined && tag !== 'stage')
    throw err('JSX_PROP', `background on <${tag}>: use fill (or style.background)`, {
      at,
      nodeId: id,
    });
  const type = tag === 'stage' ? 'group' : tag === 'node' ? rest.type : tag;
  if (tag === 'node') delete rest.type;
  const props: Record<string, unknown> = { ...rest };
  if (tag === 'stage') {
    props.x ??= 0;
    props.y ??= 0;
    props.width ??= scope.box.width;
    props.height ??= scope.box.height;
  }
  if (scale !== undefined) {
    if (typeof scale !== 'number') throw err('JSX_PROP', 'scale must be a number', { at });
    props.scaleX ??= scale;
    props.scaleY ??= scale;
  }
  if (d !== undefined) props.path = d;
  if (tex !== undefined) props.text = tex;
  if (src !== undefined) {
    if (type === 'component') props.component = src;
    else if (type === 'image' || type === 'video' || type === 'drawing') props.source = src;
    else
      throw err(
        'JSX_PROP',
        `src on <${tag}>: only image, video, drawing and component accept src`,
        { at },
      );
  }
  if (asset !== undefined) props.assetId = asset;
  const selfWidth =
      (props.width as number | undefined) ?? (type === 'group' ? scope.box.width : 200),
    selfHeight =
      (props.height as number | undefined) ?? (type === 'group' ? scope.box.height : 100);
  if (origin !== undefined) {
    const o =
      origin === 'center'
        ? { x: selfWidth / 2, y: selfHeight / 2 }
        : origin === 'top-left'
          ? { x: 0, y: 0 }
          : Array.isArray(origin)
            ? { x: origin[0], y: origin[1] }
            : origin;
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number')
      throw err('JSX_PROP', "origin must be 'center', 'top-left', [x, y] or {x, y}", { at });
    props.originX = o.x;
    props.originY = o.y;
  }
  let zIndex = zProp as number | undefined,
    letterSpacing = 0,
    textTransform: string | undefined;
  // ---- flex/grid layout context
  const explicit = new Set(Object.keys(props));
  const styleObj =
    style && typeof style === 'object' && !Array.isArray(style)
      ? (style as Record<string, unknown>)
      : undefined;
  const display = styleObj?.display;
  const isContainer = display === 'flex' || display === 'grid';
  const parentLayout = scope.layout;
  const inLayout = parentLayout !== undefined;
  if (isContainer && type !== 'group')
    throw err(
      'JSX_LAYOUT_CONTEXT',
      `display: "${String(display)}" on <${tag}>: only <group> (or <Stage>) can be a flex/grid container; wrap the children in <group style={{ display: '${String(display)}' }}>`,
      { at, nodeId: id, key: 'display' },
    );
  if (styleObj)
    for (const key of Object.keys(styleObj)) {
      if (styleObj[key] === undefined) continue;
      if (containerKeys.has(key) && !isContainer)
        throw err(
          'JSX_LAYOUT_CONTEXT',
          `style.${key} on <${tag} id="${local}"> needs display: 'flex' or 'grid' on the same group`,
          { at, nodeId: id, key },
        );
      if (itemKeys.has(key) && !inLayout)
        throw err(
          'JSX_LAYOUT_CONTEXT',
          `style.${key} on <${tag} id="${local}"> only applies to children of a display: 'flex'/'grid' group; outside layout set x/y (left/top) directly`,
          { at, nodeId: id, key },
        );
      if (boxKeys.has(key) && !inLayout && !isContainer)
        throw err(
          'JSX_LAYOUT_CONTEXT',
          `style.${key} on <${tag} id="${local}"> only applies inside flex/grid layout; add display: 'flex' to this group or its parent`,
          { at, nodeId: id, key },
        );
    }
  const laidOut = inLayout || isContainer;
  if (style !== undefined) {
    const lowered = lowerStyle(
      laidOut && styleObj ? styleForLowering(styleObj, !inLayout) : style,
      {
        parent: scope.box,
        self: { width: selfWidth, height: selfHeight },
        fontSize: props.fontSize as number | undefined,
      },
      at,
      {
        originX: props.originX as number | undefined,
        originY: props.originY as number | undefined,
      },
    );
    if (lowered.zIndex !== undefined) zIndex ??= lowered.zIndex;
    delete lowered.zIndex;
    if (lowered.letterSpacing !== undefined) letterSpacing = lowered.letterSpacing as number;
    if (lowered.textTransform !== undefined) textTransform = lowered.textTransform as string;
    delete lowered.letterSpacing;
    delete lowered.textTransform;
    if ((letterSpacing || textTransform) && type !== 'text')
      throw err('JSX_STYLE_UNSUPPORTED', `letterSpacing/textTransform apply to <text> only (at <${tag} id="${local}">)`, {
        at,
        nodeId: id,
      });
    if (lowered.whiteSpace !== undefined && type !== 'text')
      throw err('JSX_STYLE_UNSUPPORTED', `whiteSpace applies to <text> only; set it on each <text> (at <${tag} id="${local}">)`, {
        at,
        nodeId: id,
      });
    if (lowered.fit !== undefined && type !== 'image' && type !== 'video')
      throw err('JSX_STYLE_UNSUPPORTED', `objectFit applies to <image>/<video> only (at <${tag} id="${local}">)`, {
        at,
        nodeId: id,
      });
    for (const [k, v] of Object.entries(lowered)) if (props[k] === undefined) props[k] = v;
  }
  if (skewX !== undefined || skewY !== undefined) {
    const ax = (((skewX as number) ?? 0) * Math.PI) / 180,
      ay = (((skewY as number) ?? 0) * Math.PI) / 180,
      base = (props.matrix as number[] | undefined) ?? [1, 0, 0, 1, 0, 0],
      m = [1, Math.tan(ay), Math.tan(ax), 1, 0, 0];
    props.matrix = [
      base[0] * m[0] + base[2] * m[1],
      base[1] * m[0] + base[3] * m[1],
      base[0] * m[2] + base[2] * m[3],
      base[1] * m[2] + base[3] * m[3],
      base[4],
      base[5],
    ];
  }
  if (typeof props.opacity === 'number') props.opacity = Math.max(0, Math.min(1, props.opacity));
  if (
    type === 'video' &&
    (scope.clock.start || trimStart !== undefined || playbackRate !== undefined)
  ) {
    const mapping = { ...((props.timeMapping as Record<string, number>) ?? {}) };
    mapping.anchor = (mapping.anchor ?? 0) + scope.clock.start;
    if (trimStart !== undefined)
      mapping.offset = (mapping.offset ?? 0) + num(trimStart, 'trimStart', at);
    if (playbackRate !== undefined) mapping.rate = num(playbackRate, 'playbackRate', at);
    props.timeMapping = mapping;
  } else if (trimStart !== undefined || playbackRate !== undefined)
    throw err('JSX_PROP', 'trimStart/playbackRate apply to <video> only', { at });
  // Children: text content for text/formula, nested nodes for groups.
  const list: VmChild[] = [];
  flatten(children as VmChild, list);
  if (type === 'text' || type === 'formula') {
    if (list.length) {
      if (list.some((c) => typeof c !== 'string' && typeof c !== 'number'))
        throw err(
          'JSX_CHILDREN',
          `<${tag}> children must be text; wrap shapes in a <group> next to the text`,
          { at, nodeId: id },
        );
      if (props.text !== undefined)
        throw err('JSX_CHILDREN', `<${tag}> has both text children and a text prop; use one`, {
          at,
          nodeId: id,
        });
      props.text = list.join('');
    }
    if (textTransform && typeof props.text === 'string')
      props.text =
        textTransform === 'uppercase'
          ? props.text.toUpperCase()
          : textTransform === 'lowercase'
            ? props.text.toLowerCase()
            : textTransform === 'capitalize'
              ? props.text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
              : props.text;
  } else if (list.length && !groupLike.has(tag) && type !== 'group')
    throw err(
      'JSX_CHILDREN',
      `<${tag}> cannot have children; wrap it with its siblings in a <group>`,
      { at, nodeId: id },
    );
  let node: Node;
  try {
    node = newNode({
      ...(props as Partial<NodeInput>),
      id,
      type,
      parentId: scope.parentId,
    } as NodeInput);
  } catch (e) {
    if (e instanceof ZodError) {
      const issue = e.issues[0];
      throw err(
        'JSX_PROP_VALUE',
        `<${tag} id="${local}">: ${issue.path.join('.') || 'props'} ${issue.message}`,
        { at, nodeId: id, path: issue.path.join('.') },
      );
    }
    throw e;
  }
  emit(state, node, at, zIndex as number | undefined);
  let backgroundNode: Node | undefined;
  if (tag === 'stage' && background !== undefined)
    emit(
      state,
      (backgroundNode = newNode({
        id: `${id}/background`,
        type: 'rect',
        parentId: id,
        width: node.width,
        height: node.height,
        fill: String(background),
      })),
      `${at}/background`,
    );
  // ---- register this element in the flex/grid tree
  let childLayout: Scope['layout'];
  let session: LayoutSession | undefined;
  if (laidOut) {
    session = parentLayout?.session ?? new LayoutSession(scope.box);
    const s = styleObj ?? {};
    const parentKind = parentLayout?.kind;
    const absolute =
      inLayout &&
      (s.position === 'absolute' ||
        (parentKind === 'free' && ['left', 'top', 'right', 'bottom'].some((k) => s[k] !== undefined)));
    const role: SessionBox['role'] = !inLayout
      ? 'root'
      : absolute
        ? 'absolute'
        : parentKind === 'free'
          ? 'cell'
          : 'flow';
    const fixedPx = (k: 'width' | 'height') =>
      s[k] !== undefined ? typeof s[k] === 'number' || /^\s*-?[\d.]+(px)?\s*$/.test(String(s[k])) : explicit.has(k);
    const kind: BoxKind = isContainer
      ? 'container'
      : type === 'text'
        ? 'text'
        : type === 'group' && list.length && !(fixedPx('width') && fixedPx('height'))
          ? 'free'
          : 'leaf';
    const size = (k: 'width' | 'height'): Spec =>
      s[k] !== undefined
        ? lengthSpec(s[k], k, at)
        : explicit.has(k)
          ? [1, node[k]]
          : kind === 'leaf' && type !== 'group' && (role === 'cell' || role === 'absolute')
            ? [1, node[k]]
            : [0, 0];
    const ox = explicit.has('x') ? node.x : 0,
      oy = explicit.has('y') ? node.y : 0;
    const index = session.add({
      kind,
      display: s.display === 'none' ? 'none' : display === 'grid' ? 'grid' : 'flex',
      absolute: role === 'absolute',
      width: size('width'),
      height: size('height'),
      margin: role === 'cell' ? [[1, ox], [1, 0], [1, oy], [1, 0]] : undefined,
      cell: role === 'cell',
      style: s,
      at,
      node,
      parent: inLayout ? parentLayout!.parent : -1,
      role,
      offset: { x: ox, y: oy },
      explicit,
      explicitOrigin: {
        originX: explicit.has('originX') ? (props.originX as number) : undefined,
        originY: explicit.has('originY') ? (props.originY as number) : undefined,
      },
      originCenter: origin === 'center',
      background: backgroundNode,
      letterSpacing: letterSpacing || undefined,
    });
    if (kind === 'container' || kind === 'free') childLayout = { session, parent: index, kind };
  } else if (letterSpacing && type === 'text') applyLetterSpacing(node, letterSpacing);
  if (type === 'group' && list.length)
    lowerChildren(
      list,
      {
        prefix: id + '/',
        parentId: id,
        box: { width: node.width, height: node.height },
        clock: scope.clock,
        counters: new Map(),
        path: at,
        layout: childLayout,
      },
      state,
    );
  if (laidOut && !inLayout) session!.run();
}

/**
 * Lower JSX output (elements, node objects or arrays of both) into the flat node list a
 * component returns. Called automatically by defineComponent() for JSX renders.
 */
export function toNodes(output: VmChild, ctx: ComponentContext | LocalClock): Node[] {
  const clock: LocalClock =
    'start' in ctx && typeof ctx.start === 'number' ? (ctx as LocalClock) : rootClock(ctx);
  const state: State = { out: [], ids: new Map(), z: new Map(), sorted: false };
  withClock(clock, () =>
    lowerChild(
      output,
      {
        prefix: '',
        box: { width: ctx.width, height: ctx.height },
        clock,
        counters: new Map(),
        path: '',
      },
      state,
    ),
  );
  if (!state.sorted) return state.out;
  return state.out
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) => (state.z.get(a.node.id) ?? 0) - (state.z.get(b.node.id) ?? 0) || a.index - b.index,
    )
    .map((entry) => entry.node);
}
/** True when a render result needs JSX lowering (anything but a plain node array). */
export function needsLowering(output: unknown): boolean {
  if (!Array.isArray(output)) return true;
  return output.some((item) => !isNode(item));
}

/* ------------------------------------------------------------------ types */
type ShapeProps = ElementProps & { children?: never };
type TextProps = ElementProps & {
  children?: string | number | ReadonlyArray<string | number | null | undefined | false>;
};
type GroupProps = ElementProps & { children?: VmChild };
type MediaProps = ElementProps & {
  /** Project-relative path, e.g. "assets/photo.png". */
  src?: string;
  /** Project asset id. */
  asset?: string;
  children?: never;
};
type VideoProps = MediaProps & { trimStart?: number; playbackRate?: number };

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace JSX {
  type Element = VmElement<any>;
  type ElementType = string | ((props: any) => VmChild);
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number | null;
  }
  interface IntrinsicElements {
    group: GroupProps;
    rect: ShapeProps;
    ellipse: ShapeProps;
    path: ShapeProps & { d?: string };
    text: TextProps;
    formula: TextProps & { tex?: string };
    image: MediaProps;
    video: VideoProps;
    chart: ShapeProps;
    drawing: MediaProps;
    scene: ShapeProps;
    component: ShapeProps & { src?: string };
    scene3d: ShapeProps;
    program: ShapeProps;
    node: ElementProps & { type: Node['type']; children?: VmChild };
    /** Anything else (div, span, img, audio…) type-checks but fails preflight with the Vmotion alternative. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [unsupported: string]: any;
  }
}
