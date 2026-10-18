# Recipes

Each recipe is a file edit plus the CLI checks. The component snippets below were rendered with `vmotion sample`
while writing this skill. Register every new scene in `project.vmotion.json` and place it in a sequence (see
`project-files.md`).

## Contents

1. Text animation (typewriter, word stagger)
2. Beat-synced cuts and pulses
3. Captions / subtitles
4. Still images (poster, cover, thumbnail)
5. Chinese text, fonts and composed glyphs
6. Multi-scene edit in a sequence
7. Check, render, export

## 1. Text animation

```tsx
import { defineComponent, useClock, remap, springTo, Stage } from '@vmotion/sdk';

function Typewriter({ line, cps = 18 }: { line: string; cps?: number }) {
  const { frame, fps } = useClock();
  const chars = Array.from(line);                       // code-point safe for CJK
  const shown = Math.min(chars.length, Math.floor((frame / fps) * cps));
  const caret = Math.floor(frame / 8) % 2 === 0 ? '▍' : '';
  return <text id="typed" x={80} y={180} width={1120} height={80} fontSize={56} fill="#f4f7ff">
    {chars.slice(0, shown).join('') + caret}
  </text>;
}

function WordsIn({ words }: { words: string[] }) {
  const clock = useClock();
  return (
    <group id="words" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', left: 80, top: 320, width: 1120 }}>
      {words.map((w, i) => {
        const at = 20 + i * 4;                            // stagger: 4 frames per word
        const t = springTo(clock, { start: at, stiffness: 200, damping: 18 });
        return <text id={`word${i}`} fontSize={48} fontWeight={700} fill="#7cf3ff"
          opacity={remap(clock.frame, [at, at + 6], [0, 1])}
          style={{ transform: `translateY(${(1 - t) * 30}px)` }}>{w}</text>;
      })}
    </group>
  );
}

export default defineComponent({
  name: 'Text recipes',
  parameters: { line: { type: 'string', default: '用 JSX 写动画，原生渲染。' } },
  render: (ctx, p) => (
    <Stage id="stage">
      <Typewriter line={p.line} />
      <WordsIn words={['Files', 'first,', 'CLI', 'second,', 'MCP', 'last.']} />
    </Stage>
  ),
});
```

Notes: unique `id={`word${i}`}` per mapped intrinsic element (a shared `id` would be a duplicate). For per-glyph
effects on long text without layout, the native `textAnimators` node prop (selectors by grapheme/word/line) is
cheaper; see `docs/TYPOGRAPHY-SHAPES.md`.

## 2. Beat-synced cuts and pulses

```tsx
import { defineComponent, useClock, beatClock, cycle, mixColor, Stage, Steps, Step } from '@vmotion/sdk';

const BPM = 120;
const beats = (n: number, fps: number) => (n * fps * 60) / BPM;   // fractional frames are fine
const palette = ['#7cf3ff', '#ff5fa2', '#ffd166', '#5dffa8'];

function Pulse({ label }: { label: string }) {
  const clock = useClock();                         // local to the Step
  const b = beatClock(clock, BPM);
  const color = cycle(palette, b.index);            // new style every beat
  return (
    <group id="pulse" width={1280} height={720}>
      <rect id="flash" x={0} y={0} width={1280} height={720} fill={mixColor('#07090f', color, b.pulse * 0.25)} />
      <ellipse id="dot" x={560} y={280} width={160} height={160} fill={color} scale={1 + b.pulse * 0.3} origin="center" />
    </group>
  );
}

export default defineComponent({
  name: 'Beat cuts',
  parameters: {},
  render: (ctx) => (
    <Stage id="stage" background="#07090f">
      <Steps>
        <Step key="a" duration={beats(2, ctx.fps)}><Pulse label="A" /></Step>
        <Step key="b" duration={beats(2, ctx.fps)}><Pulse label="B" /></Step>
        <Step key="c"><Pulse label="C" /></Step>
      </Steps>
    </Stage>
  ),
});
```

- `key` on each `<Step>` scopes ids (`stage/a/pulse/dot`, `stage/b/pulse/dot`), so the same component can repeat.
- `beat.pulse` is 1 on each beat and decays (`decay` option, in beats); `beat.frameOfBeat(i)` gives cut frames.
- Beat offset: if the music's first downbeat is not at frame 0, pass `beatClock(clock, bpm, { offset: frames })`.
- Music: register the audio once (`vmotion tool-call --name asset_import`, `{"path": "…", "type": "audio",
  "copy": true}`), then put it on the sequence's audio track (`vmotion asset-place --asset <id> --sequence main
  --track <audioTrackId> --frame 0`, or add a clip `{ "id", "assetId", "start", "duration" }` to an `"audio"` track).
  Optional `"kind": "beat"` markers in the sequence help the human see the grid.
- Audio-reactive motion (levels, not just tempo): set `audioAssetId` on the component node and read `ctx.audio`;
  `vmotion audio-analyze --asset <id>` shows what is available. Variable tempo: the sound module's `tempoClock()`.
- Full 22.5 s example with six beat-locked chapters: `examples/jsx-lab/` in the repo.

## 3. Captions / subtitles

Quick path (SRT/VTT → editable cues + caption track, one undo step):

```
echo '{"path": "subs.srt", "format": "srt", "fontSize": 42, "bottom": 72}' > cap.json
vmotion captions-import --project . --request cap.json
```

It writes `components/captions-<uuid>.json` (cues in frames; edit text/timing there), a generated
`captions-<uuid>.ts` renderer, a `captions-<uuid>` scene and a new top video track. Cues must stay ordered and
non-overlapping, and must end within the sequence duration (`CAPTION_RANGE` otherwise). Running it twice adds two
tracks; check `vmotion context` first.

Styled path: your own component reading a cue JSON, with layout and animation:

```tsx
import { defineComponent, remap } from '@vmotion/sdk';
import data from './cues.json';   // { "cues": [ { "id": "c1", "start": 0, "end": 40, "text": "第一句" }, … ] }

export default defineComponent({
  name: 'Styled captions',
  parameters: { bottom: { type: 'number', default: 80, min: 0, max: 400 } },
  render(ctx, p) {
    const cue = data.cues.find((c) => ctx.frame >= c.start && ctx.frame < c.end);
    if (!cue) return [];
    const local = ctx.frame - cue.start;
    return (
      <group id="caption" style={{ display: 'flex', justifyContent: 'center', left: 0, top: ctx.height - p.bottom - 70, width: ctx.width }}>
        <group id="pill" style={{ display: 'flex', padding: '12px 28px' }} opacity={remap(local, [0, 5], [0, 1])}>
          <rect id="bg" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 14 }} fill="#000000b0" />
          <text id="text" fontSize={38} fill="#ffffff">{cue.text}</text>
        </group>
      </group>
    );
  },
});
```

Put the caption scene on its own video track above the picture (later tracks draw on top), with a transparent
scene `background` (`"transparent"`).

## 4. Still images (poster, cover, thumbnail)

- New project: `vmotion init --project poster --kind still --preset poster-a4 --still-template poster` (or write
  the files: a scene with `"still": {…}`, `"duration": 1`, and `"kind": "still"` in the manifest).
- Add an artboard to an existing project: `vmotion image new -p . --preset video-cover-1080 --template cover --id cover`.
- Author it like any scene: native nodes for simple layouts, or a component layer for flex/grid layouts (frame 0 is
  the picture, so do not rely on animation).
- Check: `vmotion frame -p . --scene cover --frame 0 -o check.png`; `vmotion audit -p . --scene cover`.
- Export: `vmotion image export -p . --scene cover --format png [--scale 2] [--trim] [--variants all]`. Over 8192 px
  per side / 48 MP fails with `RESOLUTION` (never silently downscaled). JPEG has no transparency; WebP has no DPI.

## 5. Chinese text, fonts and composed glyphs

- CJK renders through the bundled Noto Sans SC (`Vmotion Sans`) fallback. From source set `VMOTION_RUNTIME`; without
  it Chinese renders as tofu boxes. `fontFamily` names a system font first (default `Microsoft YaHei`).
- Use `Array.from(str)` (not `str.split('')`/index slicing) when animating characters.
- Width matters: give `<text>` an explicit `width` (it wraps) or let flex layout measure it. Check frames for
  truncation; `vmotion audit` flags definite truncation.
- Glyph sets compose characters from radicals without a font file:
  `<text glyphSet="builtin:demo" glyphFallback="font">湖国好</text>` (characters missing from the set use the font;
  `tofu` shows boxes, `none` skips). Inspect coverage with `vmotion glyphs inspect -p . --set builtin:demo --text 湖国好`
  and preview with `vmotion glyphs preview -p . --text 好 -o g.png`. Project sets live in
  `components/glyphs/<id>.vmglyph.json` (`docs/GLYPHS.md`).

## 6. Multi-scene edit in a sequence

```json
{ "id": "main", "name": "Main", "duration": 360, "markers": [],
  "tracks": [ { "id": "visual", "name": "Picture", "type": "video", "clips": [
    { "id": "c-text",  "sceneId": "text",  "start": 0,   "duration": 90 },
    { "id": "c-beats", "sceneId": "beats", "start": 90,  "duration": 90, "fadeIn": 6 },
    { "id": "c-caps",  "sceneId": "caps",  "start": 180, "duration": 90 } ] } ] }
```

Clips need only `id`, `start`, `duration` and a source (`sceneId` / `assetId` / `sequenceId`). Use `sourceIn` to
start later inside a scene and `speed` to retime. For designed transitions (crossfade, slide, wipe, iris, zoom)
between two scenes use `vmotion transition-plan --request …` and commit its planId with `preflight`/`apply`.

## 7. Check, render, export

```
vmotion validate --project . --json                                  # compile + static lint (no frames)
vmotion sample   --project . --scene intro --frames 0,15,45,89 --width 480 -o sheet.png
vmotion frame    --project . --frame 45 -o f45.png                   # one full-size frame
vmotion render   --project . -o exports/preview.mp4 --start 0 --end 90   # a short range first
vmotion render   --project . -o exports/final.mp4                    # the whole active sequence
vmotion render   --project . -o exports/frames --format png          # PNG sequence
vmotion render   --project . -o exports/mix.wav --format wav         # audio only
```

Render a short range before the full export; `render` resumes from checkpoints unless `--no-resume`. Pin a reviewed
state with `--revision <hash>` (from `vmotion context`). Report output paths and what you looked at.
