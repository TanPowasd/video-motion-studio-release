# Vmotion project · JSX lab

This is a local project, not an AI integration. External agents may edit these files or use CLI/MCP.

A 15-second demo authored entirely in JSX/TSX (docs/JSX-COMPONENTS.md): 32 beats at 128 BPM
(450 frames at 30 fps) split into five beat-locked `<Step>`s — typewriter opener, pseudo-3D card
array that steps one card per beat, component explosion with a spectrum, per-beat style cuts, and
fragments converging into the logo.

- components/jsx-lab.tsx is the entry (defineComponent returning JSX); components/lab/scenes.tsx holds
  the five scenes; components/lab/geometry.ts is a plain .ts helper (.ts and .tsx mix freely).
- Elements use id/key so generated IDs are stable (e.g. `stage/s2/cards/card3/face`); visual edits are
  stable-ID overrides on the `lab` component layer and leave the source intact.
- Frame math only: useClock(), beatClock(clock, 128), springTo(), remap(). No React hooks, DOM tags,
  timers, Math.random() or Date — preflight reports JSX_* diagnostics for those.
- Exposed parameters: line (typewriter text), title (logo text), accent (color).
- Check: `vmotion validate --project . --json`, `vmotion frame --project . --frame 160 --output f.png`,
  `vmotion render --project . --output jsx-lab.mp4`. Chinese text uses the bundled runtime fonts
  (set VMOTION_RUNTIME when running from source).
- project.vmotion.json is the manifest; scenes/ and sequences/ contain authoritative JSON. Do not edit
  .vmotion caches.
