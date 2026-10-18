---
name: vmotion
description: Make and edit videos, motion graphics, title cards, beat-synced cuts, captions/subtitles and still images (posters, covers, thumbnails) with Vmotion, the local programmable video workstation. Use whenever a task touches a Vmotion project (a folder with project.vmotion.json) or asks to create one. Author by editing project files directly (JSX/TSX components + scene/sequence JSON), validate and render with the `vmotion` CLI, and use the MCP server only as a last resort.
---

# Vmotion for external agents

Vmotion is a local video workstation (Electron UI + Rust/Skia native renderer). It never calls an AI
model: **you** author the project, and the app, the CLI and MCP all share one project service with the
same checks, atomic saves and undo history. The UI is in Chinese (e.g. 连接 MCP, 预检代码, 写回源码);
project names and default strings are often Chinese too. That is expected.

## The rule: files first, CLI second, MCP last

| Order | Channel | Use it for |
|---|---|---|
| 1 | **Edit project files** with your normal file tools | All authoring: `components/*.tsx` / `*.ts`, `scenes/*.json`, `sequences/*.json`, `project.vmotion.json` |
| 2 | **`vmotion` CLI** | Validate, look at frames, render/export, and run any built-in capability (`tool-call`) |
| 3 | **MCP** (`vmotion mcp`) | Only when 1–2 cannot do it: you are already wired to a running app over MCP and need its live state, or a client that can only speak MCP |

Why files first:

- **Diffable and reviewable.** A `.tsx`/`.json` change is a plain diff the human can read, `git diff`, and comment on.
- **Undoable twice over.** Git covers your history; the running app also records every external file change in its
  change journal and pushes it onto the shared undo stack (the human can undo your edit with Ctrl+Z).
- **Visible live.** An open Vmotion window watches the project folder (chokidar) and hot-reloads valid edits; its
  change feed counts them as AI changes, labelled 文件 (file) with the changed path. Invalid edits never replace the
  working project (see "Live app" below).
- **Cheap context.** Reading one 80-line component costs far less than MCP catalogs, schemas and JSON envelopes.
- **Deterministic.** Components are pure functions of the frame clock; the same files always render the same pixels.

MCP is not wrong, just the most expensive and least transparent path. Never reach for it to do something a
file edit plus `vmotion validate` can do. See `references/mcp.md` when you truly need it.

## Running the CLI

Pick whichever exists, then call it `vmotion` in your head:

| Install | Command |
|---|---|
| Portable Windows package | `.\vmotion.cmd <command> …` (in the Vmotion folder) |
| Built source checkout | `node dist/cli/index.mjs <command> …` |
| Source checkout (dev) | `npx tsx src/cli/index.ts <command> …` or `npm run cli -- <command> …` (run from the repo root so `tsx` resolves) |

- Every project command takes `--project <dir>` (alias `-p`, default `.`) and prints JSON on stdout. Errors print
  `{"error":{code,message,details}}` on stderr with exit 1; `validate`/`preflight` exit **2** when invalid; `render`
  exits **3** if the job did not complete.
- From source, the first command compiles TypeScript and can take a minute or two. Run long commands (render, the
  first call) in the background and poll their output.
- Chinese text needs CJK fonts. The portable package bundles them; from source set `VMOTION_RUNTIME` to a runtime
  directory containing `fonts/NotoSansSC-Regular.otf` and `-Bold.otf` (registered as family `Vmotion Sans`, used as
  fallback for every text). Optional overrides: `VMOTION_NATIVE` (vmotion-core binary), `VMOTION_FFMPEG`,
  `VMOTION_FFPROBE`.
- If the desktop app (or `vmotion serve`) has the project open, CLI commands are routed through that running service,
  so they see the same state and land in the same undo history.

## Project anatomy (one-screen version)

```
my-project/
  project.vmotion.json     manifest: size, fps, activeSequence, scenes[], sequences[], assets[]
  scenes/<id>.json         compositions: { id, name, duration (frames), background, nodes[] }
  sequences/<id>.json      timeline: tracks[] of clips that place scenes in time (+ audio tracks)
  components/**            your code: *.tsx / *.ts components, JSON data, captions, glyph sets, themes…
  drawings/*.json          frame-by-frame drawings (edit through the drawing tools)
  assets/                  imported media (register through asset_import, not by hand)
  exports/                 render output (ignored by the watcher)
  .vmotion/                caches, undo history, change journal, preflight renders: NEVER edit
  AGENTS.md                short notes the template writes for agents
```

- **New scene or sequence files must be listed in `project.vmotion.json`** (`scenes` / `sequences` arrays) in the
  same edit, or they are not loaded. Files under `components/` are discovered automatically.
- A scene node needs only `id` and `type`; everything else has a default. A component layer is
  `{ "id": "title-card", "type": "component", "component": "components/title-card.tsx", "width": 1280, "height": 720, "params": { … } }`.
- Full field reference, ids and schemas: `references/project-files.md`.

## Workflow

1. **Read the project.** `project.vmotion.json`, the scenes and the components you will touch, and `AGENTS.md`.
   `vmotion context --project .` gives ids, durations, file hashes and current diagnostics in one compact JSON.
2. **Edit files.** Prefer a JSX component for anything animated or laid out; use plain scene JSON nodes for simple
   static layers. Keep existing ids. Put tunable values in `parameters` so the human can tweak them in the UI.
3. **Validate.** `vmotion validate --project . --json`. Fix every `error`; read every `warning` (e.g. `JSX_AUTO_ID`).
   Static TSX diagnostics carry `file`, `line`, `column`. Validate compiles but does not render (see step 4).
4. **Look at it.** `vmotion sample --project . --frames 0,15,45,89 --width 480 -o sheet.png` renders a contact sheet
   (1–12 frames). `vmotion frame --project . --frame 45 -o f45.png` renders one full frame. Open the PNG and actually
   check entrance, midpoint, transitions and the last frame. Check text is not clipped and nothing is off-canvas.
5. **Iterate** 2–4 until it looks right. Optional deeper checks: `vmotion audit --project . --scene <id>` (overflow,
   overlap, truncated text, jumpy motion) and `preflight` with `"determinism": true` (renders twice, compares pixels).
6. **Render.** `vmotion render --project . -o exports/out.mp4` (active sequence; `--start/--end` frames,
   `--format png|wav`, `--width/--height`). Stills: `vmotion image export --project . --format png`.
7. **Report** what you changed (files), what you rendered (paths), and anything you could not verify.

The verified starter in `examples/starter/` (a 3 s, 1280×720 title card with CJK text, flex layout, springs and a
beat pulse) shows all of this; copy it as a template.

## Minimal component

```tsx
/** @jsxImportSource @vmotion/sdk */
import { defineComponent, useClock, remap, springTo, Stage } from '@vmotion/sdk';

export default defineComponent({
  name: 'Title',
  parameters: { title: { type: 'string', default: '你好' }, accent: { type: 'color', default: '#7cf3ff' } },
  render(ctx, p) {
    return (
      <Stage id="stage" background="#07090f">
        <text id="title" x={0} y={300 + springTo(ctx, { from: 40, to: 0 })} width={ctx.width} height={110}
          align="center" fontSize={84} fontWeight={700} fill="#f4f7ff"
          opacity={remap(ctx.frame, [0, 12], [0, 1], { easing: 'outCubic' })}>
          {p.title}
        </text>
        <rect id="bar" x={ctx.width / 2 - 180} y={430} height={6} radius={3} fill={p.accent}
          width={remap(ctx.frame, [6, 30], [0, 360])} />
      </Stage>
    );
  },
});
```

The `@jsxImportSource` pragma is optional for Vmotion (its compiler sets it for `.tsx`) but helps editors/tsc.

## JSX essentials

- `render(ctx, params)` runs **once per frame** and returns JSX (or SDK node arrays). There is no React, DOM,
  reconciler or state. Elements are *lowered* to plain nodes and drawn by the native core.
- **Lowercase tags are node types:** `group` (the only container), `rect`, `ellipse`, `path d`, `text`, `formula`,
  `image src`, `video src`, `scene`, `component src`, `chart`, `drawing`, `scene3d`, `program`, `node type`.
  Props are node props (`x y width height rotation scale origin opacity fill gradient radius stroke strokeWidth shadow
  blur blend fontSize fontWeight fontFamily align lineHeight effects maskId clip zIndex …`) or a CSS-like `style`.
- **Time:** `useClock()` → `{frame, seconds, fps, width, height, seed, duration, start, audio}` (local inside time
  containers). `remap(v, [in…], [out…], {easing, clamp})`, `springTo(clock, {from, to, start, stiffness, damping, mass})`,
  `springSettle(fps, opts)`, `beatClock(clock, bpm)` → `{beat, index, phase, bar, beatInBar, pulse, framesPerBeat,
  frameOfBeat(i)}`, `mixColor(a, b, t)`, `cycle(list, i)`, `toFrames(seconds, clock)`. Easing names: `linear`,
  `inCubic`, `outCubic`, `inOutCubic`, `outBack`, or `cubicEasing(x1, y1, x2, y2)`.
- **Time containers:** `<Stage background>` (full-frame group), `<LocalTime start duration>` (shift/trim time),
  `<Steps>` + `<Step duration offset>` (play children back to back; negative `offset` overlaps; only the last Step may
  omit `duration`). Fractional frames are fine, so beat math never drifts.
- **Layout:** `style={{ display: 'flex' | 'grid', … }}` on a `<group>` (or `<Stage>`) lays out its children every
  frame with taffy (flex direction/wrap, justify/align, gap, grow/shrink/basis, padding/margin, min/max, aspectRatio,
  grid templates with px/%/fr/auto/minmax/repeat, line/span placement, `position: 'absolute'` children). Text is
  measured with the real render fonts. Layout values may animate.
- Details, the full style map and every unsupported feature with its alternative: `references/jsx.md`.

## Stable ids (they matter)

The human edits your output visually; those edits are stored as **overrides keyed by generated node id** on the
component layer, and the change feed/undo attach to ids too. So:

- Give every element that matters an `id`. Ids nest: `<group id="card">` → children are `card/<id>`;
  `<Stage id="stage">` → `stage/title`. A keyed function component, `<LocalTime>`, `<Step>` or Fragment with `key`
  adds a `key/` prefix, so `items.map(i => <Card key={i.id} />)` gives `card-a/title`, `card-b/title`.
- On intrinsic tags `key` is only a fallback name, not a scope: `list.map((w, i) => <text key={i} id="word">)` makes
  `word` twice → `JSX_DUPLICATE_ID`. In maps over intrinsic elements use unique ids (or key alone); use a keyed
  function component for per-item scopes.
- Elements without `id`/`key` get positional names like `rect-0` that shift when siblings change (`JSX_AUTO_ID`
  warning). The root element of a function component needs its own `id` too.
- Never rename ids casually in an existing project: it orphans the human's overrides. Scene node ids, sequence/clip
  ids and parameter names are equally load-bearing.
- To fold the human's visual tweaks back into source: `vmotion jsx-writeback --project . --scene <scene> --node
  <componentLayerId>` (prints the plan) then add `--apply`. Literal props are rewritten; expression- or layout-driven
  props stay overrides.

## Determinism and other hard rules

- No `Math.random()`, `Date.now()`, `new Date()` → use `random(seed)` from `@vmotion/sdk` (returns a generator
  function; seed it from `useClock().seed` plus an index) and the clock.
- No React hooks/imports, DOM/browser APIs (`window`, `document`, `fetch`, timers), `async`/Promises, event handlers,
  `className`, `ref`, HTML tags (`div`, `span`, `img`, `svg`…), `<audio>`, CSS `transition`/`animation`.
- Any frame must render correctly in isolation (random seeking). Never accumulate state across frames.
- Do not hand-edit generated or cache files: `.vmotion/**`, `exports/**`, `assets/` media; captions/component code
  generated by tools may be edited, but keep their ids. In the Vmotion repo itself, `schemas/*.schema.json` and
  `*.generated.ts` are generated by scripts.
- Do not overwrite unresolved conflicts or a file the human is editing; re-read before writing if time has passed.
- Sound comes from sequence audio tracks, not components (`ctx.audio` only *analyses* an assigned audio asset).

## Diagnostics you will meet

| Code | Meaning | Fix |
|---|---|---|
| `JSX_AUTO_ID` (warning) | Element has no `id`/`key`; positional id may shift | Add `id="…"` |
| `JSX_DUPLICATE_ID` | Two elements resolve to the same id | Rename one, or add `key` on the repeated component |
| `JSX_LAYOUT_CONTEXT` | Layout key used where it has no meaning: container keys (`gap`, `justifyContent`…) without `display:flex/grid` on the same group, item keys (`flexGrow`, `margin`, `gridColumn`…) outside a layout parent, `display:flex` on a non-group | Move the key, or wrap in `<group style={{display:'flex'}}>` |
| `JSX_STYLE_UNSUPPORTED` | CSS key/value with no mapping (transition, perspective, per-corner radius, clipPath…) | Message names the alternative |
| `JSX_STYLE_VALUE` | Value cannot be parsed (bad length, enum) | Use numbers/`'12px'`/`'50%'` or a listed keyword |
| `JSX_PROP` / `JSX_PROP_VALUE` | Unknown prop on an element / bad value (with "did you mean") | Use the node prop name |
| `JSX_HTML_ELEMENT`, `JSX_UNKNOWN_ELEMENT` | `div`, `span`, `img`, `svg`… / unknown tag | `group`, `rect`, `text`, `image`, `path` |
| `JSX_NONDETERMINISTIC` | `Math.random`, `Date` | `random(seed)`, clock |
| `JSX_REACT_HOOK`, `JSX_REACT_IMPORT`, `JSX_BROWSER_API`, `JSX_ASYNC`, `JSX_EVENT_HANDLER`, `JSX_CLASSNAME`, `JSX_REF`, `JSX_AUDIO` | React/browser habits | Clock, params, module-level precompute, sequence audio |
| `JSX_TEXT_CHILD`, `JSX_CHILDREN` | Text directly in a group / children on a leaf | Wrap in `<text>`; group the shapes |
| `JSX_STEPS_CHILD`, `JSX_STEP_DURATION`, `JSX_STEP_OUTSIDE`, `JSX_TIME` | Misused `<Steps>`/`<Step>` or bad frame numbers | Only `<Step>` inside `<Steps>`; every Step but the last needs `duration` |
| `JSX_CLOCK` | `useClock()` called outside rendering | Call it inside `render` or a function component |

Static checks run during validate/preflight (TypeScript phase, with line/column). **`validate` does not render
frames**: runtime errors (`JSX_DUPLICATE_ID`, layout/style errors from dynamic values, exceptions in your code) only
fire on frames that are actually rendered. A project with duplicate ids passes `validate` and then fails in
`frame`/`sample`/`render`. Always render a few frames across the timeline.

## Live app: what the human sees

- Valid external edits hot-reload in the open window (about 150 ms after the write settles) and appear in the change
  feed as a 文件 (file) change listing the touched scene/node ids; they are undoable from the UI.
- An invalid edit (bad JSON, failing TypeScript, schema error) does **not** replace the working project: the app keeps
  the last good version, marks pending files and shows diagnostics. Fix the file and it reloads.
- If you and the UI changed the same file, JSON is three-way merged; real conflicts are reported. Do not clobber them.
- The human can pause external AI edits; MCP writes then fail with `AGENT_ON_HOLD` and file reloads are deferred until
  they resume. Wait; do not work around it.

## References

- `references/jsx.md`: full JSX/TSX API, style map, flex/grid layout, unsupported features, write-back.
- `references/project-files.md`: manifest, scenes, nodes, sequences, assets, stills, captions, glyph sets, schemas.
- `references/cli.md`: verified CLI commands and options.
- `references/recipes.md`: text animation, beat-synced cuts, captions, still images, CJK/glyphs, render/export.
- `references/mcp.md`: last resort; the plan → project_preflight → project_apply contract and compact mode.
- `examples/starter/`: verified minimal project (validate, sample and render all pass).
- In the Vmotion repo: `docs/JSX-COMPONENTS.md`, `docs/STILL-IMAGES.md`, `docs/GLYPHS.md`, `docs/AGENT-WORKFLOW.md`,
  `examples/jsx-lab/` (22.5 s, 128 BPM, layout chapters). `vmotion guide` prints the SDK helper reference.
