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

## Animation and effect workflow

- Read `vmotion guide` or the MCP `animation_guide` tool before authoring motion.
- Compose timeline helpers, physics, gradients, text animators, masks and ordered effect stacks in TypeScript.
- Use `group` for whole-layer opacity/effects; place glow on particle groups.
- Sample multiple frames with `vmotion sample` or MCP `frame_sample` to check entrance, midpoint, transition and exit.
- Use `project3D` for 2.5D projection only; do not claim full mesh lighting or AE compatibility.

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

## Vector animation

- SDK booleanPath/trimPath/outlinePath/simplifyPath/roundPath return new SVG geometry. path_geometry queries the same native algorithms without edits.
- Animate pathTrim.start/end (0–1), pathTrim.offset (turns), strokeWidth, strokeDashOffset (pixels), strokeDash.N and radius. Trim uses combined contour length; start>end wraps, equal endpoints are empty.
- vector_bake creates a static sibling rect/ellipse/path snapshot at a frame and preserves source layers/code, with optional hiding and one undo step. Masks/effects and source animation are not baked; dashed stroke outlining is not supported.
- Read docs/VECTOR-ANIMATION.md and inspect sampled frames before applying geometry to the project.

## Repeater animation

- SDK repeatGraph/repeatGrid/repeatRadial create stable copy-N hierarchies with masks, fractional counts, layout, affine transforms and per-copy callbacks.
- repeat_describe predicts matrices and conservative bounds. repeat_create creates a complete parameter-editable TypeScript component from sibling sources, preserving originals and one-step undo. The base graph is copied; later source structure changes are not automatically synchronized.
- Animate params with component_parameters_edit/animation_edit. Edit individual copies through composition_inspect/composition_edit_layer/composition_structure; increasing count or reversing stacking preserves IDs and overrides.
- All nodes support matrix[0..5] and matrix.N numeric channels. See docs/REPEATERS.md and inspect actual frames after modifying patterns.

## Shared scene composition

- scene_precompose creates a reusable JSON scene from adjacent sibling layers/descendants and replaces them at their stacking slot, with one undo step. Native keyframes/masks are preserved; generated leaf content is captured at the selected frame, with source code retained.
- scene_place inserts a reference and scene_references queries declared incoming/outgoing dependencies. Missing/cyclic declared links are rejected before saving.
- Enter an instance using composition_inspect path and edit its internal stable IDs using ordinary composition/animation tools. Instance overrides win over shared-source updates; directly edit source JSON only when updating all uses.
- scene_reset_instance removes locally stored internal edits while preserving outer placement and source defaults. Source width/height and camera participate in rendering and picking. Instances currently share their owning frame without time remapping.
- Read docs/SHARED-SCENES.md and inspect actual sampled frames after shared edits.
