# Vmotion project

This is a local project, not an AI integration. External agents may edit these files or use CLI/MCP.

- project.vmotion.json is the manifest; scenes/ and sequences/ contain authoritative JSON.
- components/ contains TypeScript components. Import helpers from @vmotion/sdk.
- Preserve stable IDs. Visual editing writes node properties and component params.
- Components export default defineComponent({name, parameters, render(ctx, params)}).
- ctx supplies frame, seconds, fps, width, height and seed. Return scene nodes.
- Use seeded random and ctx.seconds; do not use wall-clock time or asynchronous frame rendering.
- Scenes support text, rect, ellipse, path, image, video, formula, chart, component, drawing and nested scene nodes.
- Run vmotion validate --project . --json after edits; vmotion frame --project . --frame 90 --output frame.png checks the picture.
- Use vmotion mcp --project . for transactions, screenshots and cancellable render jobs.
- Dynamic component internals are inspectable; edit their exposed params or TypeScript source.
- Do not edit .vmotion caches or overwrite unresolved conflicts.

## Candidate code workflow

- Start with project_context for concise metadata, revision, file hashes and stable IDs. Use project_file_read for source ranges and project_schema only for the schema you need.
- Use project_preflight to check operations and hash-checked file edits before saving. Request samples and determinism=true to inspect native frames and detect stateful code. The active project and undo history remain unchanged during preflight.
- Commit the same request through project_apply with revision and expectedCandidateRevision. Failed checks preserve source files and the last usable preview.
- For invalid external edits, read version=pending and preflight/apply that pending version to repair files. Preserve unresolved conflicts; future formats are not automatically rewritten.
- CLI context/read/schema/preflight/apply provide the same flow. Put complex requests in JSON and use --request-file.

## Structured component parameters

- defineComponent infers typed params. Declare number/string/color/boolean/enum/vec2/vec3/array/object controls, labels, defaults and limits. Unknown fields and invalid defaults are rejected.
- MCP component_parameters returns defaults, values, evaluated values, JSON Schema and numeric leaf channels. component_parameters_edit edits relative paths, resets defaults, adds keyframes and inserts/removes/moves array items atomically.
- Use arrays operations for array structure changes so index keyframes follow their original items. params.origin.x and params.data.1.value can animate; integer channels should use hold.

## Keyframe editing

- animation_inspect reads paginated channel keys and sampled values/velocities. animation_edit atomically changes multiple native/generated layers with upsert/remove/ease/transform actions.
- transform can copy, shift or scale selected key times and values around pivots. Default collisions are errors; do not silently overwrite keys. Retiming preserves easing and Bezier controls.
- SDK editKeyframes/sampleAnimation share these algorithms. CLI animation/animate expose the same commands.

## Layer structure and drawing workflow

- Use MCP composition_structure or composition_structure_batch for group, copy, delete, add and order actions in scene/group/component scopes. Generated edits live in structure and overrides; preserve stable IDs.
- Drawings are independent documents in drawings/*.json, referenced by project.drawings. Create/edit layers first, publish the whole document or selected layers, then use asset_place to put assets in scenes or sequence tracks.
- MCP drawing_create, drawing_get, drawing_edit, drawing_frame, drawing_publish and drawing_open_asset share the editor revision checks and undo history. drawing_frame returns an image.
- CLI drawing create/inspect/edit/frame/publish and asset-place support the same workflow. Pass complex pen paths using --operations-file.

## Animation and effect workflow

- Read `vmotion guide` or the MCP `animation_guide` tool before authoring motion.
- Compose timeline helpers, physics, gradients, text animators, masks and ordered effect stacks in TypeScript.
- Use `group` for whole-layer opacity/effects; place glow on particle groups.
- Sample multiple frames with `vmotion sample` or MCP `frame_sample` to check entrance, midpoint, transition and exit.
- Use `project3D` for 2.5D projection only; do not claim full mesh lighting or AE compatibility.

## Audio checks

- audio_timeline exposes audible sequence clips, exact sample positions and nested speed/volume/fade envelopes.
- audio_preview renders up to 10 seconds of the sequence mix at 48 kHz, returning playable WAV plus RMS, peak and waveform metrics.
- Main timeline playback and export share the local mixer. Standalone scene/group preview is silent; ctx.audio is an animation analysis input, not an automatic sound track.
- Import audio/video to record duration metadata, then asset_place on the matching track. Use revision and sample ranges for repeatable checks.

## Visual audit

- visual_audit checks sampled scene/group/component frames for definite text truncation and review hints: overflow, clipping, overlap, opaque rectangle coverage and fast/jumping motion. Results include stable IDs, owner paths, times and annotated native images.
- Request adjacent frames around suspected jumps. Geometry hints need visual judgement; effects, masks and transparent media are not final pixel visibility proofs.
- project_preflight supports visual=true and visualOptions for scene samples. Definite errors block commit; review hints remain warnings. Check incomplete/omitted and refine filters before drawing conclusions.
