# Vmotion project

This is a local project, not an AI integration. External agents may edit these files or use CLI/MCP.

- MCP starts with 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any capability. tools_load enables task-specific direct tools for this connection; mcp --tools all preserves legacy direct tools/results. See docs/AGENT-DISCOVERY.md.
- Edits return compact revisions, IDs, diagnostics and undo state; use project_file_read/drawing_get for source or tool_call response=full when needed. Native images/audio remain media blocks.
- project.vmotion.json is the manifest; scenes/ and sequences/ contain authoritative JSON.
- components/ contains TypeScript components. Import helpers from @vmotion/sdk.
- Preserve stable IDs. Visual editing writes node properties and component params.
- Components export default defineComponent({name, parameters, render(ctx, params)}).
- ctx supplies frame, seconds, fps, width, height and seed. Return scene nodes.
- Use seeded random and ctx.seconds; do not use wall-clock time or asynchronous frame rendering.
- Scenes support text, rect, ellipse, path, image, video, formula, chart, component, drawing, scene3d and nested scene nodes.
- Run vmotion validate --project . --json after edits; vmotion frame --project . --frame 90 --output frame.png checks the picture.
- Use vmotion mcp --project . for transactions, screenshots and cancellable render jobs.
- Dynamic component internals are inspectable; edit their exposed params or TypeScript source.
- Do not edit .vmotion caches or overwrite unresolved conflicts.

## Effect graph authoring

- SDK defineEffectGraph/effectGraph and MCP effect_graph_inspect/plan use reusable JSON DAG resources under components/effects/*.json. Branch pass/blend/mask/transform/noise/displace/solid nodes and reuse subgraphs; all frames resolve fixed snapshot resources.
- Named inputs bind same-parent layer IDs; precompose other spaces. Parameters link to typed fields and nested defaults; numeric effects.N.params.* paths animate. Preserve stable IDs and reject cycles instead of silently bypassing branches.
- effect_graph_inspect can filter nodeIds/includeValues; effect_graph_plan supports short add/update/replace/remove/output/links/parameters/name actions with resource hashes. resetParams/resetKeys explicitly handles upgrades.
- Preflight pictures and determinism, add extra samples if coverage is incomplete, then commit unchanged for one undo. Resources-only edits should sample their existing use sites. Source TypeScript stays editable. See docs/EFFECT-GRAPHS.md.

## Temporal effects and particles

- motionBlur/echo share the ordinary effect stack and time-sample the same raw/generated layer source; sample opacity and masks once, and use deterministic ctx clocks. Apply to groups for emitter-wide effects rather than one full surface per particle.
- particles_inspect returns bounded birth IDs, positions/velocities, age and truncation without files; particles_plan creates a parameterized component and returns exact candidate/apply with one undo. SDK particleField/particleState use analytic gravity/drag and optional originAt(birth,index).
- liquify uses localized ordered inverse-sampling push/twirl/inflate fields, with brushes.N numeric channels. It is not physical fluid or mesh simulation. Check zero strength, extreme poses, early births and adjacent frames.
- Temporal queries/pixels/depth and scratch buffers are bounded; budget errors never lower export resolution. Parent/camera motion requires sampling an owning layer/group or project motion blur. See docs/TEMPORAL-PARTICLES.md.

## Motion orchestration

- motion_templates lists builtin/shared JSON templates, parameter schemas and controlled channels. motion_plan combines cue IDs, parameter bindings and frame/second timings across scene/scoped targets; target offsets stagger their clocks.
- Existing channels are protected by default. Choose replaceChannels deliberately or merge to preserve old keys and reject time collisions. Overlapping cue tracks need explicit sequencing; no automatic summation.
- Save reusable templates in components/motions/*.json in the same plan; generated key edits preserve TypeScript. Native keys remain independently editable and do not silently change when a template resource is updated. SDK parseMotionTemplate/applyMotionCues can reuse live JSON dependencies in code.
- Inspect poseChecks and coverage; add extra project_preflight samples for omitted scopes/frames before committing unchanged. Integer parameter channels should use hold. See docs/MOTION-TEMPLATES.md.

## Visual review and export

- Start with agent_guide topic=review. visual_audit findings carry revision-bound IDs and locators for the expanded layer and local/context frames.
- visual_repair_plan takes explicit fitText/move/insideCanvas intents and stable expanded IDs, resolves generated owners, and returns before/after findings plus exact candidate/apply payloads. allKeys preserves whole motion trajectories; currentKey edits a local pose.
- Preflight the stored candidate for native pictures, determinism and visual diagnostics, then apply unchanged for one undo. Do not automatically resolve artistic overlap, clipping or motion reviews.
- Pass the applied revision to render_start or CLI render --revision HASH so intervening edits cannot silently change the export. See docs/AGENT-REVIEW.md.

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

## Audio checks

- audio_timeline exposes audible sequence clips, sample positions and nested gain/fade envelopes. audio_preview renders up to 10 seconds at 48 kHz and returns playable audio plus RMS/peak/waveform metrics.
- Main timeline preview and export share the local mixer. Standalone scenes/groups are silent; ctx.audio drives animation analysis and does not create a sound track.
- Import audio/video to record duration metadata, then asset_place on the matching track. Use revision checks and explicit sample ranges for repeatable audio checks.

## Visual audit

- visual_audit checks sampled scene/group/component frames for definite text truncation and review hints: overflow, clipping, text overlap, opaque rectangle coverage and fast/jumping motion. It returns stable IDs, owner paths, times and annotated native images.
- Include adjacent frames around suspected jumps. Geometry hints require visual judgement; masks/effects/transparent media are not final pixel visibility proofs.
- project_preflight supports visual=true and visualOptions for scene samples. Definite errors block apply, while review hints remain warnings. Filter nodeIds or ignoreNodeIds and check summary.incomplete/omitted before drawing conclusions.

## Vector animation

- SDK booleanPath/trimPath/outlinePath/simplifyPath/roundPath return new SVG geometry; path_geometry performs the same native query without edits.
- Animate pathTrim.start/end (0–1), pathTrim.offset (turns), strokeWidth, strokeDashOffset (pixels), strokeDash.N and radius. Trim uses combined contour length; start>end wraps, equal endpoints are empty.
- vector_bake creates static sibling rect/ellipse/path snapshots at a frame and preserves source layers/code, with optional hiding and one revision-checked undo step. Only geometry/transforms are baked; masks, effects and source animation remain on originals. Dashed stroke outlining is not yet supported. See docs/VECTOR-ANIMATION.md.

## Repeater animation

- SDK repeatGraph/repeatGrid/repeatRadial generate stable copy-N layer graphs, including masks and native animations. Fractional count fades the final copy; parameters support layout, opacity, scale, skew, rotation and stacking. Per-copy callbacks can derive styling and timing from ctx.
- repeat_describe predicts affine transforms and conservative bounds without edits. repeat_create creates a complete TypeScript component from sibling sources and descendants, with exposed parameters and one undo step; the base graph is copied, while original layers/code remain available.
- Edit params with component_parameters_edit/animation_edit and generated copies with normal composition tools. Copy IDs stay stable across count and order changes. Use frame evidence after changes.
- All nodes support matrix[0..5] affine coefficients and numeric matrix.N keyframes; SDK affineMatrix and the advanced inspector share rendering/selection behavior. See docs/REPEATERS.md.

## Layer structure and drawing workflow

- Use MCP composition_structure or composition_structure_batch for group, copy, delete, add and order actions in scene/group/component scopes. Generated edits live in structure and overrides; preserve stable IDs.
- Drawings are independent documents in drawings/*.json, referenced by project.drawings. Create/edit layers first, publish the whole document or selected layers, then use asset_place to put assets in scenes or sequence tracks.
- MCP drawing_create, drawing_get, drawing_edit, drawing_frame, drawing_publish and drawing_open_asset share the editor revision checks and undo history. drawing_frame returns an image.
- CLI drawing create/inspect/edit/frame/publish and asset-place support the same workflow. Pass complex pen paths using --operations-file.

## Shared scene composition

- scene_precompose turns adjacent sibling layers/descendants into a reusable JSON scene and one reference, with a single undo step. Native animations/masks are preserved; generated leaf content is captured at the chosen frame, not automatically converted from arbitrary code.
- scene_place inserts a shared reference; scene_references queries declared incoming/outgoing dependencies. Source edits affect all instances, while instance overrides win.
- Enter instances with composition_inspect path and edit generated/scene-reference IDs using ordinary composition/animation tools. scene_reset_instance clears locally stored internal edits but retains outer placement/source defaults.
- Scene width/height default to project size. time_inspect/time_edit expose visual content retiming (rate/reverse/freeze/repeat/remap). Use local frame and ancestor contextFrames from composition_interactions; transforms/parameters stay on the parent clock. See docs/CONTENT-TIME.md.

## Agent-first assembly and math

- Start with agent_guide for overview/animation/editing/math/recovery routing. The app never calls AI models.
- media_inspect/media_sample return actual source metadata, project-source frame timestamps, native images and assetCheck. Retain checks through sequence_plan, project_preflight and project_apply; changed assets reject the commit. Fingerprints are size/mtime checks, not cryptographic hashes.
- sequence_plan creates exact candidate/apply requests for append/insert/overwrite and optional linked audioTrackId. Review candidate through project_preflight, then use apply unchanged with its fixed IDs/revision; do not regenerate the reviewed plan. SourceOut is exclusive, and preserves fractional source limits. Insert respects all affected track locks; partial linked overwrite is rejected.
- sequence_edit provides split/trim/slip/move/ripple/link/locks/markers/work areas/BPM. captions_import creates editable cue JSON from SRT/VTT, and captions_inspect reads it. Use audio_preview for sample-based sound evidence.
- linear_algebra provides matrix solve/inverse/determinant/product, pivoted QR leastSquares, batch transforms and conjugateGradient traces. SDK matrixLU and preparePointTransform can be prepared outside render(ctx); inspect residual/rank/converged. Row-major matrices use column vectors; A*B applies B first. See docs/AGENT-MEDIA.md and docs/LINEAR-ALGEBRA.md.

## Matrix-driven 3D

- Use agent_guide topic=3d and matrix3d to inspect 4x4 model/view/projection, vertex depth, clipping and face bounds.
- SDK mat4Compose, prepareCamera3D/project3DBatch and scene3D/mesh3D share row-major matrices and column vectors. Cache camera per frame and models per object; derive transforms from ctx.frame.
- scene3D emits individually editable path faces. Use scene3DLayer for persistent scene3d data and native Rust tiled depth buffering: intersecting opaque meshes, 1/4 antialias samples, flat lighting, numeric camera/TRS/matrix keys and preview/export parity. scene3d_render returns color/depth/face-ID images, visible counts and pixel picks; outer effects/masks are excluded from this local evidence.
- mesh_generate/mesh_import plan reusable components/meshes/*.json resources with optional placement and auto-fitted camera. Pass returned planId through project_preflight and project_apply unchanged; stored source data is content checked. mesh_inspect provides bounds/area/topology and face pagination. meshSource references use pinned project files; resource edits update all instances.
- SDK sphereMesh/cylinderMesh/coneMesh/torusMesh/planeMesh/surfaceMesh/parseOBJ support procedural and local OBJ geometry. OBJ concave faces are triangulated; normal references feed smooth materials; UVs remain metadata. standardMaterial supports GGX metallic/roughness direct lighting, directional/point lights, emissive and exposure. scene3d_materials queries/plans instance controls and updates numeric keys. Textures/IBL/world transparency/shadows/GPU are not implemented. See docs/MATERIALS3D.md, docs/MESHES.md and docs/DEPTH3D.md.

## Animation and effect workflow

- Read `vmotion guide` or the MCP `animation_guide` tool before authoring motion.
- Compose timeline helpers, physics, gradients, text animators, masks and ordered effect stacks in TypeScript.
- Use effects_guide/inspect/plan for stable-ID multi-layer append/update/copy/move/toggle/remove/keys, then preflight/apply the stored plan for one undo. Copies and ordering retain logical key channels.
- SDK waveWarp/twirl/bulge/rgbSplit/linearWipe/radialWipe use layer-local coordinates, normalized centers and premultiplied-alpha sampling. Declare group width/height or supply region; tools can fit current content bounds. Zero strength, disabled effects and wipe endpoints are exact. See docs/EFFECTS2D.md.
- Use `group` for whole-layer opacity/effects; place glow on particle groups.
- Sample multiple frames with `vmotion sample` or MCP `frame_sample` to check entrance, midpoint, transition and exit.
- Use scene3D for matrix-driven mesh paths and project3DBatch for point effects; do not claim complete 3D/PBR or AE compatibility.
