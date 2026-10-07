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

## Layer structure and drawing workflow

- Use composition_structure or composition_structure_batch to add, group, copy, delete and reorder native/generated layers. Generated edits live in structure and overrides; do not rewrite TypeScript unless changing code logic.
- Drawing documents live in drawings/*.json referenced by project.drawings. Create/edit layers independently, publish whole documents or selected layers, then use asset_place for scene or sequence placement.
- MCP drawing_create, drawing_get, drawing_edit, drawing_frame, drawing_publish and drawing_open_asset share editor transactions. drawing_frame returns an image for visual checks.
- CLI drawing create/inspect/edit/frame/publish and asset-place support the same workflow. Use --operations-file for complex pen paths.

## Candidate code workflow

- Start with project_context for concise IDs, revisions, file hashes and diagnostics. Read source ranges with project_file_read and request project_schema only when needed.
- Use project_preflight with operations/files and sample frames before committing. determinism=true compares repeated renders; preflight does not replace source files or history.
- Apply the same candidate using project_apply with revision and expectedCandidateRevision. Failed checks preserve the last usable preview.
- If pendingFiles is true, read and repair version=pending. Do not overwrite unresolved conflicts or future format versions.
- CLI context/read/schema/preflight/apply share the same rules and accept JSON request files.

## Structured component parameters

- defineComponent infers typed params. Declare number/string/color/boolean/enum/vec2/vec3/array/object controls with defaults, labels and limits. Unknown fields and invalid defaults are rejected.
- component_parameters returns defaults, static/evaluated values, JSON Schema and numeric animation channels. component_parameters_edit edits nested paths, resets defaults and adds keyframes atomically.
- Use arrays insert/remove/move operations when changing array order so keyframes follow their original items. Animate numeric leaves such as params.origin.x and params.data.1.value; integer channels should use hold.

## Keyframe editing

- animation_inspect reads paginated channel keys and sampled values/velocities. animation_edit atomically changes native/generated layers with upsert/remove/ease/transform actions.
- transform supports copy, shift and scale of selected key times/values around pivots, preserving easing and Bezier data. Default time collisions are errors.
- SDK editKeyframes/sampleAnimation and CLI animation/animate share these rules. Use revision checks and sample pictures after retiming.

## Audio checks

- audio_timeline exposes audible sequence clips, exact sample positions and nested speed/volume/fade envelopes.
- audio_preview renders up to 10 seconds of the sequence mix at 48 kHz, returning playable WAV plus RMS, peak and waveform metrics.
- Main timeline playback and export share the local mixer. Standalone scene/group preview is silent; ctx.audio is an animation analysis input, not an automatic sound track.
- Import audio/video to record duration metadata, then asset_place on the matching track. Use revision and sample ranges for repeatable checks.

## Visual audit

- visual_audit checks sampled scene/group/component frames for definite text truncation and review hints: overflow, clipping, overlap, opaque rectangle coverage and fast/jumping motion. Results include stable IDs, owner paths, times and annotated native images.
- Request adjacent frames around suspected jumps. Geometry hints need visual judgement; effects, masks and transparent media are not final pixel visibility proofs.
- project_preflight supports visual=true and visualOptions for scene samples. Definite errors block commit; review hints remain warnings. Check incomplete/omitted and refine filters before drawing conclusions.
