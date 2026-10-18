# `vmotion` CLI reference (verified against `src/cli/index.ts`)

Invocation: `vmotion` (global bin), `.\vmotion.cmd` (portable), `node dist/cli/index.mjs` (built) or
`npx tsx src/cli/index.ts` (source; run from the repo root). `vmotion --help` and `vmotion <command> --help` list
everything; this page covers what an authoring agent needs.

Conventions:

- `-p, --project <dir>` (default `.`) on every project command; output is JSON on stdout.
- Errors: `{"error":{"code","message","details"}}` on stderr, exit 1. `validate`, `preflight`, `apply` exit 2 when
  invalid; `render` exits 3 when the job did not complete; `jsx-writeback --apply` exits 2 if its preflight fails.
- If the desktop app or `vmotion serve` has the project open, commands go through that service over a local pipe
  (30 s RPC timeout). An `RPC_TIMEOUT` on a write does **not** mean it failed; run `vmotion context` before retrying,
  or you may apply it twice.
- Complex input goes in a JSON file (`--request`, `--request-file`, `--action-file`, `--operations-file`).

## Create

| Command | What |
|---|---|
| `vmotion init --project <dir> [--name N] [--template blank\|science] [--fps 30] [--duration 10] [--width W --height H]` | New video project (1920×1080 by default) with `scenes/intro.json`, `sequences/main.json`, `AGENTS.md` |
| `vmotion init --project <dir> --kind still [--preset square] [--still-template blank\|poster\|cover\|card]` | New still-image project |
| `vmotion image presets` | Still presets and templates (no project needed) |
| `vmotion image new -p <dir> --preset video-cover-1080 --template cover [--name N] [--id sceneId] [--dry-run]` | Add an artboard (plan → preflight → apply) |

You can equally create a project by writing the files yourself (see `examples/starter/`).

## Inspect

| Command | What |
|---|---|
| `vmotion context -p <dir> [--scene id] [--sequence id] [--offset 0] [--limit 100]` | Compact ids, durations, components, file hashes (sha256), diagnostics, undo state, `pendingFiles` |
| `vmotion inspect -p <dir>` | Full state (large; prefer `context`) |
| `vmotion read -p <dir> --file components/x.tsx [--start-line 1] [--line-count 200] [--pending]` | File range + hash; `--pending` reads an invalid external edit the app is holding |
| `vmotion schema -p <dir> --name scene` / `--name operation --operation updateNode` / `--name keyframe` | One authoritative schema |
| `vmotion project-diagnostics -p <dir> --request q.json` | Paged diagnostics/conflicts/pending files (`{}` is a valid request) |
| `vmotion component-params -p <dir> --scene id --node id [--frame 0]` | Typed parameters and current values of a component layer |
| `vmotion animation -p <dir> --scene id --node id [--frames 0,10,20]` | Keyframes and sampled values |
| `vmotion guide` | SDK helper / animation reference (no project needed) |

## Validate and look

| Command | What |
|---|---|
| `vmotion validate -p <dir> --json` | Schema, references, TypeScript compile and static JSX lint (`JSX_*` with file/line/column). **Does not render frames**: runtime errors such as `JSX_DUPLICATE_ID` only show when a frame renders |
| `vmotion sample -p <dir> --frames 0,15,45,89 [--scene id] [--width 640] [-o sheet.png]` | 1–12 frames in one labelled contact sheet |
| `vmotion frame -p <dir> --frame 45 [-o f.png] [--scene id] [--width W --height H]` | One full frame (native Skia). Give both width and height or neither: width alone squeezes the aspect |
| `vmotion audit -p <dir> --scene id [--frames 0,30,60] [-o dir]` | Overflow, clipping, text overlap/truncation, jumpy motion, with annotated evidence images |
| `vmotion preflight -p <dir> --request-file req.json` | Check a candidate without saving (see below) |

Preflight request (files must carry `expectedHash`, the sha256 from `context`/`read`, or `null` for a new file):

```json
{
  "files": [
    { "type": "text", "path": "components/title-card.tsx", "expectedHash": "<sha256>",
      "replacements": [ { "before": "fontSize={84}", "after": "fontSize={72}" } ] }
  ],
  "samples": [ { "sceneId": "intro", "frame": 0 }, { "sceneId": "intro", "frame": 45 } ],
  "width": 320,
  "determinism": true
}
```

File edit types: `text` (exact unique replacements), `replace` (whole `content`), `delete`. The result has `valid`,
`candidateRevision`, `diagnostics`, per-sample `status`/`pixelHash`, and a contact sheet under
`.vmotion/preflight/`. `determinism: true` renders each sample twice and compares pixels. `vmotion apply` takes the
same request plus `"expectedCandidateRevision"` and commits it atomically as one undo step.

When to use preflight/apply instead of plain file edits: when the app is open and you want an all-or-nothing,
hash-checked commit that never shows a half-written state, or when you want determinism checking. For normal
authoring, editing the files and running `validate` + `sample` is simpler and equally safe.

## Render and export

| Command | What |
|---|---|
| `vmotion render -p <dir> -o exports/out.mp4 [--format mp4\|png\|wav] [--start F] [--end F] [--width W --height H] [--revision HASH] [--no-resume]` | Export the active sequence; waits for the job and prints its final record (`status: completed`, `output`) |
| `vmotion image export -p <dir> [--scene id] [--format png\|jpeg\|webp] [--quality 92] [--scale 1] [--transparent] [--trim] [--variants all] [-o path]` | Still export (default `exports/images/`) |
| `vmotion pack -p <dir> -o <folder>` | Collect project + referenced media into a portable folder |

`--start`/`--end` are frames of the active sequence (end exclusive). `--format png` writes
`<output>/frame-00000000.png …` into a directory. `--revision` pins the export to an accepted project revision, so an edit landing mid-render cannot change it.
Render needs FFmpeg (bundled in the portable package; `VMOTION_FFMPEG`/`VMOTION_FFPROBE` from source).

## Text, captions, glyphs, write-back

| Command | What |
|---|---|
| `vmotion captions-import -p <dir> --request r.json` | `{"path":"subs.srt","format":"srt"}` (or `"content"`; options `fontSize`, `fontFamily`, `color`, `bottom`, `glyphSet`, `sequenceId`) → cue JSON + component + scene + track. Prints the whole snapshot; use `tool-call --name captions_import --fields revision` for a short result |
| `vmotion glyphs inspect -p <dir> [--set builtin:demo] [--text 文字] [--coverage]` | Glyph-set coverage and composition |
| `vmotion glyphs preview -p <dir> --text 好 [--ids ⿰氵⿱木口] -o g.png` | Render composed glyphs |
| `vmotion glyphs plan -p <dir> --request plan.json [--apply]` | Create/edit glyph sets, assign to layers |
| `vmotion jsx-writeback -p <dir> --scene id --node componentLayerId [--ids a,b] [--props x,fill] [--apply]` | Fold visual overrides back into `.tsx` literals |

## Any capability without MCP

Every one of the ~148 built-in capabilities (and enabled plugin tools) is callable from the CLI with the same schema
and compact results as MCP:

```
vmotion tools-search --query "字幕 caption" [--category editing] [--detail]
vmotion tool-schema --name captions_import
vmotion tool-call -p <dir> --name still_inspect --request args.json [--fields a.b,c] [--no-media] [--full]
```

Many also have direct commands taking `--request <file>` (e.g. `sequence-edit`, `effects-plan`, `motion-plan`,
`visual-plan`, `transition-plan`, `storyboard-plan`, `audio-mix-plan`, `theme-plan`, `plugins-inspect`). Planner
capabilities return `plan.planId`; commit with `preflight`/`apply` using `{"planId": "…"}`.

## Plugins

```
vmotion plugin pack <id> -p <dir> [-o file.vmplugin]
vmotion plugin install <folder|file.vmplugin|git-url> -p <dir> [--git --ref v1.2.0 --subdir plugin] [--pin] [--dry-run]
```

## Service

`vmotion serve -p <dir> [--port 4318]` runs the editor service headless (file watching, HTTP UI, pipe for the CLI).
`vmotion mcp -p <dir> [--tools compact|all|auto]` starts the stdio MCP server (see `mcp.md`, last resort).
