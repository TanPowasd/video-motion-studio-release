# JSX / TSX components: full reference

Source of truth in the Vmotion repo: `src/sdk/jsx.ts` (runtime, elements, ids), `src/sdk/jsx-time.ts` (time
helpers), `src/sdk/jsx-style.ts` (CSS map), `src/sdk/jsx-layout.ts` (flex/grid), `src/core/jsx-lint.ts` (static
checks), `src/core/jsx-writeback.ts`. Human doc: `docs/JSX-COMPONENTS.md` (Chinese), which documents the same
flex/grid layout support and limits as section 6 below.

## Contents

1. Component shape
2. Elements and props
3. Ids
4. Time
5. Style map
6. Flex / grid layout
7. Not supported (and what to do instead)
8. Mixing with SDK builders and `.ts`
9. Visual edits and write-back

## 1. Component shape

```tsx
/** @jsxImportSource @vmotion/sdk */            // optional for Vmotion, helps editors and tsc
import { defineComponent, useClock, Stage } from '@vmotion/sdk';

export default defineComponent({
  name: '标题卡',                                // shown in the UI
  parameters: {                                  // typed, editable in the inspector, overridable per layer
    label: { type: 'string', default: 'Hello' },
    accent: { type: 'color', default: '#7cf3ff' },
    count: { type: 'number', default: 3, min: 1, max: 12 },
    mode: { type: 'enum', options: ['a', 'b'] as const, default: 'a' },
  },
  render(ctx, p) {                               // pure function of ctx (the clock) and p (params)
    return <Stage id="stage" background="#07090f">{/* … */}</Stage>;
  },
});
```

- Parameter types: `number`, `string`, `color`, `boolean`, `enum`, `vec2`, `vec3`, `array`, `object` (labels,
  defaults, limits; unknown fields and invalid defaults are rejected). See `docs/COMPONENT-PARAMETERS.md`.
- The scene's component node sets `params` (by parameter name) to override defaults per layer.
- `ctx`: `frame`, `seconds`, `fps`, `width`, `height` (the component layer's size), `seed`, `duration`, `start`,
  `audio` (analysis of the node's `audioAssetId`, if any).
- Imports: anything from `@vmotion/sdk`; relative `.ts`/`.tsx`/`.json` files inside `components/`. `.ts` and `.tsx`
  mix freely. Do heavy precomputation at module level (it runs once), not per frame, when it does not depend on time.

## 2. Elements and props

| Tag | Node | Notes |
|---|---|---|
| `<group>` | group | Only graphic element with children; children use the group's local coordinates |
| `<rect>`, `<ellipse>` | rect / ellipse | |
| `<path d="M…">` | path | `d` aliases `path` |
| `<text>…</text>` | text | Children must be strings/numbers (joined) |
| `<formula>` | formula | TeX from children or `tex` |
| `<image src>` / `<video src>` | image / video | `src` project-relative path, or `asset` = asset id; video: `trimStart` (frames), `playbackRate` |
| `<scene>`, `<component src>`, `<chart>`, `<drawing>`, `<scene3d>`, `<program>` | same | nested scenes/components etc. |
| `<node type="…">` | any | escape hatch for any node type |

Props are node props, identical to the SDK `rect()`/`text()` builders: `x y width height rotation scaleX scaleY
opacity fill gradient radius stroke strokeWidth strokeDash shadow blur blend brightness saturation effects maskId clip
visible`; text: `fontSize fontWeight fontFamily align (left|center|right) lineHeight letterSpacing textTransform whiteSpace
textAnimators glyphSet glyphFallback`. Convenience props: `scale` (both axes), `origin` (`'center'`, `'top-left'`,
`[x, y]`, `{x, y}`), `skewX`/`skewY` (degrees), `zIndex` (stable sibling order). `opacity` is clamped to 0–1 so spring
overshoot is safe.

Children may be arrays, Fragments (`<>…</>`), `null`/`false`/conditionals, and SDK builder output
(`particles()`, `group()`…), which gets the parent's id prefix.

Fonts: `fontFamily` defaults to `Microsoft YaHei`; when the bundled runtime is present every text falls back to
`Vmotion Sans` (Noto Sans SC), so Chinese renders without system fonts.

## 3. Ids

1. Local name = `id` › `key` › automatic `<type>-<n>` (counted per type within the scope).
2. Inside `<group id="card">` (and `<Stage id="stage">`) children are `card/<name>`.
3. A function component, `<LocalTime>`, `<Step>` or Fragment **with `key`** prefixes `key/`; without `key` it adds
   nothing. So in `items.map(i => <Card key={i.id} />)` every card's `title` stays unique.
4. Duplicates throw `JSX_DUPLICATE_ID` naming both places. Auto names warn `JSX_AUTO_ID`.

Pitfall: on an **intrinsic** element (`<rect>`, `<text>`, `<group>`…) `key` is only a fallback name, used when there
is no `id`; it does not open a prefix scope. So `items.map((w, i) => <text key={`w${i}`} id="word">…)` produces the
same id `word` twice and fails with `JSX_DUPLICATE_ID` at render time. In a `.map()` over intrinsic elements give
each one a unique `id` (or only a `key`); use a keyed function component when you want per-item scopes.

Example from the starter (`Chip` is a function component rendered with `key={`chip${i}`}` and a root
`<group id="chip">`): `title-card` layer → `stage/title`, `stage/chips/chip0/chip/label`.

## 4. Time

| API | What it does |
|---|---|
| `useClock()` | Current clock; local inside `LocalTime`/`Step`. `render`'s `ctx` is the root clock |
| `<LocalTime start duration>` | Children see frame 0 at `start`; nothing renders before `start` or after `duration` |
| `<Steps start>` + `<Step duration offset>` | Sequential: each Step starts when the previous ends; negative `offset` overlaps; only the last Step may omit `duration` |
| `<Stage background id>` | Group at 0,0 sized to the component/parent with an optional background rect `stage/background` |
| `remap(v, input[], output[], {easing, clamp})` | Piecewise map; clamps by default; `clamp:false` extrapolates; `'start'`/`'end'` one side; `easing` name, function or one per segment; inputs must strictly increase |
| `springTo(clock, {from=0, to=1, start, mass=1, stiffness=170, damping=24, velocity})` | Closed-form damped spring, seekable |
| `springSettle(fps, {stiffness, damping, mass, threshold=0.001})` | Frames until settled; use for Step durations |
| `beatClock(clock, bpm, {offset, beatsPerBar=4, decay=0.5})` | `beat`, `index`, `phase`, `bar`, `beatInBar`, `framesPerBeat`, `pulse` (1 on the beat, decays), `frameOfBeat(i)`; bpm 20–400. Tempo maps: sound `tempoClock()` |
| `mixColor(a, b, t)` | Hex blend (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), t clamped |
| `cycle(list, i)` | Wrap-around pick (per-beat styles) |
| `toFrames(seconds, clock)` | seconds × fps |
| `random(seed)` | Seeded generator: `const rnd = random(clock.seed + i); rnd()` |

Also available: `progress`, `tween`, `stagger`, `easings`, `cubicEasing`, `spring`, `interpolate` and many more
(`vmotion guide` lists them).

Beat math: at 128 BPM and 30 fps a beat is 14.0625 frames; containers accept fractional frames, so
`const beats = (n: number, fps: number) => (n * fps * 60) / 128;` never drifts.

## 5. Style map (`style={{…}}`)

Explicit props win over `style`.

| CSS | Node |
|---|---|
| `position:'absolute'`, `left/top/right/bottom`, `width/height` (number px, `'12px'`, `'50%'` of parent) | x / y / width / height |
| `transform` (translate/scale/rotate/skew/matrix), `transformOrigin` | x/y/rotation/scale (canonical order, pivot defaults to the box center) or exact `matrix` |
| `opacity`, `visibility`, `display:'none'`, `zIndex` | opacity / visible / order |
| `background`, `backgroundColor`, `backgroundImage`, `color`, `fill` (color or `linear-gradient()`/`radial-gradient()`) | fill / gradient |
| `border`, `borderWidth`, `borderColor`, `stroke`, `strokeWidth`, `borderRadius` (one radius; equal per-corner keys) | stroke / strokeWidth / strokeDash / radius |
| `boxShadow`, `textShadow`, `filter: blur() brightness() saturate() opacity() drop-shadow()` | shadow / blur / brightness / saturation |
| `mixBlendMode` (normal, multiply, screen, overlay, darken, lighten, difference, plus-lighter) | blend |
| `fontSize`, `fontFamily`, `fontWeight` (100–900, normal, bold), `textAlign` (left/center/right), `lineHeight` (number or px), `letterSpacing` (px or em), `textTransform` | text props |
| `whiteSpace` (`normal` default, `pre` keeps all spaces / breaks only at `\n`, `pre-wrap` keeps spaces and wraps; `<text>` only, not inherited) | text `whiteSpace` — use `pre` + `{'  indented\n    code'}` for code |
| `overflow`/`overflowX`/`overflowY`: `visible`, `hidden`, `clip` | clip rect |
| `objectFit`: `fill`, `contain`, `cover` | image/video/component fit |
| Layout keys (next section) | taffy layout |

## 6. Flex / grid layout

Put `display: 'flex'` or `'grid'` on a `<group>` (or `<Stage>`). All descendants inside that subtree are laid out by
taffy (compiled to wasm, embedded) once per frame and written back as plain `x/y/width/height`.

- Container keys (need `display` on the same group): `flexDirection`, `flexWrap`, `flexFlow`, `justifyContent`,
  `alignItems`, `alignContent`, `justifyItems`, `placeItems`, `placeContent`, `gap`, `rowGap`, `columnGap`,
  `gridTemplateColumns`, `gridTemplateRows`, `gridAutoColumns`, `gridAutoRows`, `gridAutoFlow`.
- Item keys (only on children of a layout group): `flex`, `flexGrow`, `flexShrink`, `flexBasis`, `alignSelf`,
  `justifySelf`, `placeSelf`, `gridColumn`, `gridRow`, `gridColumnStart/End`, `gridRowStart/End`, `margin*`
  (including `auto`).
- Box keys (inside layout): `padding*`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `aspectRatio`.
- Grid tracks: `repeat(3, 1fr)`, `'200px 1fr auto'`, `minmax(80px, auto)`, `repeat(auto-fill, …)`/`auto-fit`, an
  array `[120, '1fr']` or a count. Placement by line number, `span N` or `auto`; named lines/areas are not supported.
- `position: 'absolute'` children inside a layout group are positioned against it with `left/top/right/bottom` and
  `%` sizes (great for a background rect behind flex content).
- Text without explicit size is measured with the real render fonts (CJK, glyph sets).
- Position the layout root with `left/top/width/height` in its `style` (or props).
- Any value may be animated: column counts, gaps, widths are just frame functions.

```tsx
<group id="chips" style={{ display: 'flex', gap: 18, justifyContent: 'center', left: 0, top: 420, width: 1280 }}>
  {labels.map((label, i) => (
    <group key={`chip${i}`} style={{ display: 'flex', alignItems: 'center', padding: '10px 22px' }}>
      <rect id="bg" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 22 }} fill="#141b2e" />
      <text id="label" fontSize={26} fill="#e8eeff">{label}</text>
    </group>
  ))}
</group>
```

A full animated grid that reflows on the beat is `examples/jsx-lab/components/lab/layout.tsx` in the repo.

## 7. Not supported (and what to do instead)

| You wrote | Diagnostic | Do this |
|---|---|---|
| `<div>`, `<span>`, `<img>`, `<svg>`, `<p>`… | `JSX_HTML_ELEMENT` | `<group>`, `<rect>`, `<text>`, `<image>`, `<path>` |
| `<audio>` | `JSX_AUDIO` | Sequence audio track; `audioAssetId` on the component node feeds `ctx.audio` for analysis |
| `onClick`, `className`, `ref` | `JSX_EVENT_HANDLER` / `JSX_CLASSNAME` / `JSX_REF` | Drive from frame and params; reference layers by stable id |
| `useState`, `useEffect`, `import 'react'` | `JSX_REACT_HOOK` / `JSX_REACT_IMPORT` | `useClock()`, params, module-level precompute |
| `async`/`await`, Promises | `JSX_ASYNC` | Synchronous render; put data in project files or params |
| `window`, `document`, `fetch`, `setTimeout`, `requestAnimationFrame` | `JSX_BROWSER_API` | Clock and project files |
| `Math.random()`, `Date.now()`, `new Date()` | `JSX_NONDETERMINISTIC` | `random(seed)`, `useClock().seconds` |
| `transition`, `animation` | `JSX_STYLE_UNSUPPORTED` | `remap()` / `springTo()` |
| `perspective`, `rotateX/Y`, `translateZ`, `matrix3d`, `backfaceVisibility` | `JSX_STYLE_UNSUPPORTED` | `project3D()`/matrix helpers (`docs/MATRIX3D.md`) or pseudo-3D: `scaleX = cos(angle)`, a little `skewY`, depth-sorted `zIndex`/opacity |
| `order`, `gridArea`, `gridTemplateAreas`, named grid lines, `inset`, `float` | `JSX_STYLE_UNSUPPORTED` | `row-reverse`, numeric lines/`span`, `left/top/right/bottom` |
| `clipPath`, `mask` | `JSX_STYLE_UNSUPPORTED` | `overflow:'hidden'`, `clip` prop, `maskId` |
| `textDecoration`, `textOverflow`, `fontStyle`… | `JSX_STYLE_UNSUPPORTED` | `textAnimators`/`pathText`, pre-format the string |
| Per-corner `borderRadius` | `JSX_STYLE_UNSUPPORTED` | One radius, or a `<path d>` |
| `filter: hue-rotate()` etc. | `JSX_STYLE_UNSUPPORTED` | `effects={[…]}` raster effects (`docs/EFFECTS2D.md`) |
| Layout keys outside a layout context, `display:flex` on non-group | `JSX_LAYOUT_CONTEXT` | See section 6 |
| `rotate` / `color` on a rect | `JSX_PROP` (did you mean …) | `rotation`, `fill` |
| Text directly in `<group>`, children on `<rect>` | `JSX_TEXT_CHILD` / `JSX_CHILDREN` | `<text>`; wrap in `<group>` |
| Scrolling, interaction CSS (`cursor`, `pointerEvents`…) | `JSX_STYLE_UNSUPPORTED` | Frames are offline renders |

Static checks (TypeScript phase of validate/preflight) report file/line/column. Dynamic cases (tag names built at
runtime, duplicate ids from data) fail when a frame renders, with the same codes.

## 8. Mixing with SDK builders and `.ts`

`render` may return JSX, an array of SDK nodes (`rect('id', {...})`, `text('id', 'str', {...})`, `group(...)`), or a
mix. Plain `.ts` components (no JSX) keep working unchanged. Rich SDK helpers (particles, repeaters, 3D, effect
graphs, science/charts) are documented by `vmotion guide` and `docs/*.md`; they all follow the same "pure function of
the clock" rule.

## 9. Visual edits and write-back

When the human drags/recolours a generated layer in the UI, Vmotion stores the change in the component node's
`overrides`/`structure` keyed by the generated id; your source is untouched. If you later rename that id, the
override is orphaned, so keep ids stable.

Promote overrides into source when asked:

```
vmotion jsx-writeback --project . --scene intro --node title-card            # plan only
vmotion jsx-writeback --project . --scene intro --node title-card --apply    # preflight + apply, one undo
```

Options: `--ids a,b` (generated node ids), `--props x,fill`. Literal attributes (`x={120}`, `fill="#fff"`) are
rewritten or inserted; expression attributes (`x={remap(…)}`) and layout-positioned geometry stay overrides and are
reported as `computed`/`layout`. With no overrides the plan is `{"unchanged": true}`. In the UI this is the inspector's
写回源码 section.
