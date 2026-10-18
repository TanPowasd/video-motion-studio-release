# Project files: layout, schemas, ids

Authoritative JSON Schemas live in the Vmotion repo under `schemas/` (`project.schema.json`, `scene.schema.json`,
`node.schema.json`, `sequence.schema.json`, `still.schema.json`, `glyphSet.schema.json`, …; generated from the zod
models by `scripts/schema.ts`, do not edit them by hand). From any project you can also print one schema:
`vmotion schema --project . --name scene` (or `--name operation --operation updateNode`).

## Contents

1. What the app loads
2. `project.vmotion.json`
3. `scenes/<id>.json` and nodes
4. Component layers
5. `sequences/<id>.json`
6. Assets and media
7. Stills (posters, covers)
8. Captions
9. Glyph sets and other resources under `components/`
10. Files you must not edit
11. Editing safely

## 1. What the app loads

- `project.vmotion.json` (always).
- Every scene/sequence/drawing file **listed in the manifest**. An unlisted `scenes/x.json` is ignored.
- Every `*.ts`, `*.tsx`, `*.json`, `*.py`, `*.wgsl` under `components/` (recursive), whether referenced or not.
- The watcher ignores `.vmotion/`, `node_modules/`, `exports/` and `*.tmp`.

## 2. `project.vmotion.json`

Required: `formatVersion` (1), `id` (any unique string, a UUID is conventional), `name`, `width`, `height`,
`fps` (`{ "num": 30, "den": 1 }`, integer rational), `activeSequence` (sequence id rendered by `vmotion render`),
`scenes` (paths), `sequences` (paths), `assets` (array, may be empty). Optional: `kind` (`"video"` default or
`"still"`), `colorSpace` (`"srgb"`), `sampleRate` (48000), `drawings`, `plugins`, `motionBlur`, `sdkVersion`.

```json
{
  "formatVersion": 1,
  "id": "0c7d6a52-5f3e-4c1b-9a8e-2f4d1b7e9a10",
  "name": "Starter",
  "width": 1280, "height": 720,
  "fps": { "num": 30, "den": 1 },
  "activeSequence": "main",
  "scenes": ["scenes/intro.json"],
  "sequences": ["sequences/main.json"],
  "assets": []
}
```

Video canvases are limited to 3840×2160; still artboards may reach 8192 px per side / 48 MP.

## 3. `scenes/<id>.json` and nodes

Required: `id`, `name`, `duration` (integer frames), `nodes`. Optional: `background` (default `#101525`),
`width`/`height` (default to the project size), `still` (makes it an image artboard).

A node requires only `id` and `type`; `vmotion init` and the UI write every field out in full, but you do not have
to. Node types: `group`, `rect`, `ellipse`, `path`, `text`, `formula`, `image`, `video`, `chart`, `component`,
`drawing`, `scene` (nested scene reference), `scene3d`, `program`.

Common fields: `x`, `y`, `width`, `height`, `rotation`, `scaleX`, `scaleY`, `originX`, `originY`, `matrix`,
`opacity`, `visible`, `fill`, `gradient`, `stroke`, `strokeWidth`, `radius`, `blend`, `blur`, `shadow`, `effects`,
`maskId`, `clip`, `parentId` (grouping in flat lists), `start`/`end` (frames the layer is alive), `animations`
(keyframes), `expressions`, `layout`, `motionPath`. Text: `text`, `fontFamily`, `fontSize`, `fontWeight`, `align`,
`lineHeight`, `textAnimators`, `glyphSet`, `glyphFallback`. Keyframe format: `vmotion schema --project . --name
keyframe`. For anything animated, prefer a component over hand-written keyframes: it is shorter, reviewable and
seekable by construction.

```json
{ "id": "headline", "type": "text", "text": "秋季发布", "x": 120, "y": 200, "width": 1040, "height": 120,
  "fontSize": 96, "fontWeight": 700, "fill": "#ffffff", "align": "center" }
```

## 4. Component layers

```json
{
  "id": "title-card",
  "type": "component",
  "name": "Title card",
  "component": "components/title-card.tsx",
  "width": 1280, "height": 720,
  "params": { "title": "你好，Vmotion" },
  "overrides": {},
  "audioAssetId": "music"
}
```

- `component`: project-relative path to the `.tsx`/`.ts` file whose default export is `defineComponent(...)`.
- `width`/`height`: the component's box (`ctx.width/height`, `<Stage>` size).
- `params`: values for the component's `parameters` (by name); omitted ones use defaults.
- `overrides` / `structure`: visual edits the human made to generated layers, keyed by generated id. Preserve them.
  You may remove an entry deliberately (e.g. after `jsx-writeback`), but never rewrite them blindly.
- `audioAssetId` + `audioOffset`: feeds `ctx.audio` analysis (no sound output).
- `timeMapping`, `start`: retime/offset the component's clock (`docs/CONTENT-TIME.md`).

## 5. `sequences/<id>.json`

Required: `id`, `name`, `duration` (frames), `tracks`. Track: `id`, `name`, `type` (`"video"` | `"audio"`), `clips`
(+ `muted`, `locked`). Clip: `id`, `start`, `duration` (+ `sceneId` or `assetId` or `sequenceId`, `sourceIn`,
`sourceOut`, `speed`, `volume`, `fadeIn`, `fadeOut`, `audioEnabled`, `linkedGroup`). Markers: `id`, `frame`, `label`
(+ `kind`, e.g. `"beat"`).

```json
{
  "id": "main", "name": "Main", "duration": 90,
  "tracks": [
    { "id": "visual", "name": "Picture", "type": "video", "muted": false,
      "clips": [ { "id": "intro-clip", "sceneId": "intro", "start": 0, "duration": 90, "sourceIn": 0,
                   "speed": 1, "volume": 1, "fadeIn": 0, "fadeOut": 0 } ] }
  ],
  "markers": []
}
```

Tracks later in the array draw on top. Keep the sequence duration ≥ the last clip end. `vmotion render` exports the
manifest's `activeSequence`.

## 6. Assets and media

`project.assets[]` entries are `{ id, name, path, type: image|video|audio|font|drawing, managed, fingerprint,
metadata }`. Register media with the import capability so duration/size/fingerprint metadata are recorded:

```
echo '{"path":"D:/media/song.wav","type":"audio","copy":true}' > req.json   # schema: vmotion tool-schema --name asset_import
vmotion tool-call --project . --name asset_import --request req.json
vmotion asset-place --project . --asset <assetId> --sequence main --track <audioTrackId> --frame 0
```

In JSX, `<image src="assets/logo.png">` takes a project-relative path (or `asset="<id>"`). Keep media inside the
project (or `vmotion pack` it) so the project stays portable.

## 7. Stills (posters, covers)

A still is a scene with `still` set; it renders frame 0. `project.kind: "still"` opens the image workspace.

```json
{ "id": "image", "name": "Cover", "duration": 1, "background": "#111827", "width": 1080, "height": 1080,
  "still": { "preset": "square", "dpi": 72, "bleed": 0, "safeArea": 54, "transparent": false, "variants": [] },
  "nodes": [ … ] }
```

`still`: `dpi` (36–2400), `bleed` (px, all sides), `safeArea` (inset from trim), `transparent`, `variants` (≤16,
`{id, name, width, height, fit: contain|cover|reflow, background?}`). Presets: `poster-a4`, `poster-a3`,
`xiaohongshu`, `wechat-cover`, `video-cover-720`, `video-cover-1080`, `square`, `vertical`. See
`docs/STILL-IMAGES.md`.

## 8. Captions

`vmotion captions-import` (SRT/VTT) generates, in one undoable step: `components/captions-<uuid>.json`
(the cue document), `components/captions-<uuid>.ts` (renderer component), a `captions-<uuid>` scene and a new video
track on the sequence. The cue document is plain JSON you may edit:

```json
{ "version": 1, "fps": { "num": 30, "den": 1 },
  "cues": [ { "id": "1", "start": 0, "end": 36, "text": "第一句字幕" } ] }
```

Cues: integer frames, unique ids, ordered, non-overlapping, `end > start`. For styled/animated captions write your
own component that imports a cue JSON (see recipes).

## 9. Glyph sets and other resources under `components/`

- `components/glyphs/<id>.vmglyph.json`: radical-composed glyph sets (`docs/GLYPHS.md`); text layers use them via
  `glyphSet` (`"<id>"` or `"builtin:demo"`) + `glyphFallback` (`font` | `none` | `tofu`).
- `components/effects/*.json` effect graphs, `components/motions/*.json` motion templates, `components/sounds/*`
  scores, `components/themes/*.json`, `components/templates/*.json`, `components/storyboards/*`,
  `components/meshes/*.json`, `components/tracking/*`. Each has a schema (`vmotion schema --name <kind>`) and a
  `*_plan` capability; prefer the plan capability for these structured resources unless the edit is trivial.

## 10. Files you must not edit

- `.vmotion/**`: compile cache, undo history (`.vmotion/undo/`), change journal (`.vmotion/changes.json`), commit
  journal, preflight renders. Editing these corrupts history or is silently overwritten.
- `exports/**`: render output.
- Imported media under `assets/` (replace through relink/import, never overwrite in place).
- Future-format projects (`formatVersion` newer than the app): the app refuses to rewrite them; so should you.

## 11. Editing safely

- Write whole files atomically (write then rename) when your tool allows; the watcher waits ~150 ms for writes to
  settle, then reloads.
- Change the manifest in the same edit as adding/removing a scene or sequence file.
- Keep ids stable: scene ids, node ids, sequence/track/clip ids, parameter names, generated JSX ids.
- After a batch of edits run `vmotion validate`, then render frames. If the app is open, an invalid edit leaves the
  last good project active and reports pending files; fix the file rather than reverting the human's work.
- Prefer one coherent edit per intent so the human's undo steps map to your changes.
