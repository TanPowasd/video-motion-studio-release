export const animationReference = {
  version: '0.3.0',
  model:
    'External agents author TypeScript/JSON. The application contains no AI model integration.',
  timing:
    'progress/tween/stagger/enter/wipe/localClock use frames. particles uses seconds for start and lifetime, pixels/second for velocity. Always derive time from ctx; use seeded random.',
  helpers: [
    {
      name: 'programLayer / programEffect',
      purpose:
        'Project-authored Python RGBA render(ctx,params,input_rgba) and complete WGSL main code through renderer manifests. Layers and graph pass effects share clocks/compositing/export. Bundled Python or VMOTION_PYTHON environment; explicit GPU, bounded binary workers/pipeline cache and source-located diagnostics. Use project_schema renderProgram and sampled preflight/apply. See docs/RENDER-PROGRAMS.md.',
    },
    {
      name: 'Visual workstation / compact MCP delivery',
      purpose:
        'Eight dedicated UI tools share existing node/motion/3D/particle/storyboard/mix/review/render services. composition_edit_layers mode=plan returns exact candidates for generated overrides with one undo. tools_search/tool_schema detail opts into metadata; tool_call fields selects output paths with revision/validity and explicit missing, media=false omits inline media. Full opt-ins remain. See docs/VISUAL-WORKSTATION.md.',
    },
    {
      name: 'Direct3D12 / render_profile / render_compare',
      purpose:
        'Fused colorMatrix/keyer/single-input channel GPU kernels share preview/export with explicit cpu/auto/gpu modes, binary transfer, bounded buffers and host rounding correction. Profile reports hardware and correction/fallback/transfer counts; compare is exact by default, explicit pixelTolerance reports premultiplied SDR evidence. Full-scene/3D GPU and shared textures remain unfinished. See docs/GPU-EFFECTS.md.',
    },
    {
      name: 'vmotion.organization / project_references / reference_plan',
      purpose:
        'Page known JSON dependencies, TypeScript imports/literal hints, runtime generated samples and stored clip windows. Static analysis does not prove runtime completeness; queries report uncertainty and bounded caches. Select same-kind editable references, preserve stable object IDs, author code and windows, check media/locks/hash then exact preflight/apply/one undo. Pinned templates/plugins/tracking keep dedicated provenance/migration workflows. See docs/PROJECT-REFERENCES.md.',
    },
    {
      name: 'vmotion.math plugin',
      purpose:
        'Linear algebra and matrix3d Agent tools are registered as the extracted math builtin plugin. CLI/MCP/schema and application dispatch share this module; use linear_algebra for numerical evidence and matrix3d for camera/vertex/depth geometry.',
    },
    {
      name: 'vmotion.effects plugin',
      purpose:
        'Visual queries, effect/graph/motion candidates, particle authoring and scene transitions use the vmotion.effects builtin module. Candidate delivery shares exact operations, scope clocks, preflight/apply and one undo without changing source authors.',
    },
    {
      name: 'vmotion.media plugin',
      purpose:
        'Media status, source metadata and bounded frame evidence use the extracted vmotion.media builtin plugin. Asset fingerprints and native images remain shared evidence for relink, proxy and sequence planning.',
    },
    {
      name: 'vmotion.audio / builtin registry',
      purpose:
        'All 12 sound/music/mix/timeline/evidence tools use the audio builtin module and the same host candidate/media guards. Eighteen modules dispatch all 147 capabilities through a validated tool/method/dependency registry; core/recovery/cache/review use shared host services. project_diagnostics pages compact diagnostic/conflict/pending-file evidence with detail opt-in; queries preserve history and source. audio_timeline pages 24 clips by default with exact rational sample clocks; includeAll opts into full data.',
    },
    {
      name: 'vmotion.editing / vmotion.render',
      purpose:
        'Storyboard/sequence candidates, subtitle editing, whole-sequence evidence, render profiling, revision-pinned jobs/status/cancel use builtin modules with shared host transactions and render lifecycle. render_query pages compact task status by IDs/states/revision; detail or render_status supplies complete output/error evidence. Legacy render_list keeps its array format.',
    },
    {
      name: 'vmotion.3d / vmotion.vector / vmotion.animation',
      purpose:
        'Mesh generation/OBJ/material/depth evidence, typography/vector/repeaters and property/animation/time/parameter operations use builtin modules and shared history. component_query reads selected relative parameters and paged numeric channels with bounded previews; includeSchema/fullValues are explicit. Legacy component_parameters remains full. Sample values cover themes and native keys, with final driver/pixel evidence queried separately.',
    },
    {
      name: 'vmotion.drawing / vmotion.composition / vmotion.tracking',
      purpose:
        'Drawing edit/publication/native evidence, generated composition structure/overrides/shared scene instances and background tracking all use builtin modules with shared source/history/task guards. assets_query returns paged asset summaries; drawing_query pages layers/strokes and explicit pressure-point ranges. Full documents, metadata and native media remain opt-in.',
    },
    {
      name: 'definePlugin / definePluginTool / plugins_inspect / plugins_plan / plugins_pack / plugins_install',
      purpose:
        'Project-local typed plugin tools and reusable component/effect/motion/theme/sound/template resources. Semantic dependencies/API/IDs are checked. Explicit bounded context and deterministic exact candidates reuse worker/cache/preflight/apply/undo; MCP schemas/discovery refresh with manifests. Portable deterministic .vmplugin bundles (per-file sha256, bundled plugin dependencies) install from folders/bundles/explicit Git refs as exact candidates. Design is the first extracted builtin module, other host modules remain to migrate. See docs/PLUGINS.md.',
    },
    {
      name: 'bindTheme / ThemeResolver / template_inspect / template_plan',
      purpose:
        'Typed live brand tokens with inheritance/aliases and literal/local override baselines. Pinned scene/code releases expose persistent instance parameter ports; selective upgrades preserve custom values, keys and overrides, while detach creates a private editable copy. Source authors remain intact; media, shared scenes, live themes and external packages remain project dependencies. Exact stored candidates share preflight/apply/undo. tool_schema paths reads only the required property branches. See docs/THEMES-TEMPLATES.md.',
    },
    {
      name: 'visualPreset / prepareTexture / bloom / radialRays / gradientMap',
      purpose:
        'Seeded fbm/turbulence/ridged/cellular/marble/waves/checker textures, premultiplied palettes, graph layer-map displacement with channel/alpha/midpoint/space controls, multilevel bloom and linear-light radial rays. visual_templates/plan reuse typed parameter resources and numeric keys; bounded field/ray regions match full-scan pixels, with work reported by render_profile. See docs/VISUAL-FIELDS.md.',
    },
    {
      name: 'sceneTransition / Node.isolation / blend=lighter / render_profile',
      purpose:
        'Parameterized scene crossfade/slide/push/wipe/iris/zoom/dip/cut with exact transparent endpoints and source content clocks. Isolated additive mixing uses native surfaces. transition_plan materializes reusable components and declared scene dependencies for candidate/undo. render_profile reports actual cold/warm timing, compilation dependency reuse, bounded surface memory and pixel determinism; no frame cache hides stateful code. See docs/PERFORMANCE-TRANSITIONS.md.',
    },
    {
      name: 'compileSound / SoundRenderer / soundPreset / tempoClock / importSoundMidi / exportSoundMidi',
      purpose:
        'Pure deterministic stereo music/sound design: note/tempo clocks, synth/FM/noise/drums/sampler, band-limited sample pitch, gain/pan automation and acyclic buses with EQ/delay/reverb/compression. Editable JSON resources integrate timeline preview/export. External agents use sound_plan + sound_preview on the exact candidate before atomic apply. MIDI omission diagnostics are explicit. See docs/SOUND-MUSIC.md.',
    },
    {
      name: 'node.expressions / layout / motionPath / evaluateDrivers / sampleCurvePath',
      purpose:
        'Unified post-keyframe property dependencies, responsive anchors/insets/fraction sizes/aspect ratios and SVG curve arc-length positions/tangents. Numeric expressions use deterministic clocks/base/final layer references; cycles and conflicts return locators. Renderer/selection/agent queries share results; drivers_plan batches native/generated scenes for exact preflight/apply. See docs/PROPERTY-DRIVERS.md.',
    },
    {
      name: 'defineEffectGraph / effectGraph / compileEffectGraph / editEffectGraph',
      purpose:
        'Reusable JSON/inline DAGs with channels, sRGB/linear 4x5 colorMatrix and chroma/luma keyer (threshold, softness, spill, invert, color/matte). Named output choices and typed links preserve author structure. Runtime exact passthrough, real alpha support and row tiles reduce image work with explicit memory errors. render_compare pairs pinned frame hashes/timings/work/locators; graphOptimize/graphRegions/graphTileRows and graphCache permit separate baselines. No frame cache or automatic source rewrite; exact preflight/apply retains generated source and shared undo. See docs/EFFECT-GRAPHS.md.',
    },
    {
      name: 'motionBlur / echo / liquify / particleField / particleState',
      purpose:
        'Layer-local time sampling re-evaluates raw/generated content at historical frames; linear-light premultiplied alpha, sample-once root opacity/mask and ordered effects. Analytic seeded birth-ID particles support drag/gravity, sprites, color/size/spin and birth-origin callbacks. Local brush sampling fields are editable/animatable. particles_inspect/plan expose evidence and parameterized component candidates; see docs/TEMPORAL-PARTICLES.md.',
    },
    {
      name: 'applyMotionCues / applyMotionLayers / editAnimationLayers / prepareKeyframes',
      purpose:
        'Motion cues compile to editable keys or stable-ID weighted add/multiply/replace layers, with independent clocks/windows and before/after continuation/cycles. Layers precede expressions/layout/path, control keys remap by stable IDs, generic effect/graphics/parameter edits retain layer channels. prepareKeyframes/sampleKeyframes provide immutable sorted indexes with binary search. Native indexed programs and property-only IPC reuse exact definitions, recover evictions and retain TypeScript fallback; nativeCache=false gives pixel-equivalent evidence. Agent queries page layers/channels/keys; exact candidates keep source and shared undo. See docs/ANIMATION-LAYERS.md.',
    },
    {
      name: 'waveWarp / twirl / bulge / rgbSplit / linearWipe / radialWipe / editEffectStack',
      purpose:
        'Layer-local spatial effects and exact wipe endpoints with premultiplied-alpha sampling, canvas-space alternative, explicit region and ordered composition. Stable effect IDs/enabled flags; editEffectStack preserves numeric channels through copy/move/remove. effects_guide/inspect/plan expose compact atomic multi-layer authoring with stored preflight/apply plans. See docs/EFFECTS2D.md.',
    },
    {
      name: 'standardMaterial / unlitMaterial / smoothMesh / scene3d_materials',
      purpose:
        'Native smooth/flat per-pixel materials: metallic/roughness GGX direct lighting, directional/point lights, emissive, double-sided surfaces, exposure and SDR tone mapping. Normals use inverse transpose and perspective-correct interpolation. scene3d_materials inspects or plans stable-instance edits without vertex arrays, updating active numeric keys. No texture/IBL/shadow/world transparency yet. See docs/MATERIALS3D.md.',
    },
    {
      name: 'sphereMesh / cylinderMesh / coneMesh / torusMesh / planeMesh / surfaceMesh / parseOBJ',
      purpose:
        'Reusable procedural and OBJ geometry with outward winding, no degenerate poles, mathematical height surfaces, bounds/normalization and topology inspection. mesh_generate/mesh_import plan project mesh resources and optional camera-fitted placement; meshSource resolves against the pinned snapshot. Concave OBJ polygons use ear clipping. UV/normal references are metadata; shading is flat/opaque. Stored planId avoids echoing vertex arrays. See docs/MESHES.md.',
    },
    {
      name: 'scene3DLayer / scene3d_render',
      purpose:
        'Persistent scene3d JSON/TS layers use a tile-based native Rust depth rasterizer with 1/4 antialias samples, six-plane clipping and flat lighting. Correctly resolves intersecting opaque faces. Numeric camera/TRS/matrix channels support keys; preview/export share rasterization. Agent evidence includes color, perspective-correct eye-depth and stable face IDs. No textures/PBR/transparent materials yet.',
    },
    {
      name: 'mat4Compose / prepareCamera3D / project3DBatch / scene3D / mesh3D / cubeMesh',
      purpose:
        '4x4 model/view/projection matrices, prepared batch vertices, hierarchical mesh instances, six-plane polygon clipping, flat lighting and global depth sorting. Produces native stable-ID path layers; matrix3d provides paginated geometry evidence to agents. No pixel z-buffer/textures/PBR. See docs/MATRIX3D.md.',
    },
    {
      name: 'matrixMultiply / matrixLU / leastSquares / preparePointTransform / conjugateGradient',
      purpose:
        'Pure row-major linear algebra with reusable scaled-pivot LU, rank-aware column-pivoted QR fitting, prepared batch affine/perspective transforms and quadratic optimization traces. Precompute static data outside render(ctx); linear_algebra returns numerical evidence through MCP/CLI. See docs/LINEAR-ALGEBRA.md.',
    },
    {
      name: 'editSequence / parseCaptions / measureTextBlock',
      purpose:
        'Movie/remix timeline operations with preserved fade/source windows, linked clips, ripple edits, work areas and beat grids. SRT/VTT parsing emits editable cue JSON; native text measurement shares renderer wrapping. sequence_edit and captions_import expose the same workflow to agents.',
    },
    {
      name: 'sceneRef / scene_precompose / scene_place / scene_references',
      purpose:
        'Reusable JSON scene instances with source dimensions/camera, stable prefixed IDs, instance property/structure overrides and shared-source updates. Precompose native adjacent sibling graphs atomically; generated leaf graphs are captured at one frame while source code is preserved. timeMapping supports per-instance visual retiming; transforms/parameters use the parent clock.',
    },
    {
      name: 'repeatGraph / repeatGrid / repeatRadial / describeRepeater / affineMatrix',
      purpose:
        'Deterministic layer-graph repeaters with stable copy IDs, fractional counts, layout/rotation/scale/skew/pivot, opacity ramps and stacking order. Supports per-copy callbacks, affine transforms and native/generated overrides. repeat_describe predicts transforms/bounds; repeat_create creates a parameter-editable TypeScript component while preserving source layers.',
    },
    {
      name: 'booleanPath / trimPath / outlinePath / simplifyPath / roundPath / pathGeometry',
      purpose:
        'Native immutable SVG geometry: booleans, wrapping cumulative-length trim, solid outline, self-intersection simplification and rounded corners. Use pathTrim numeric channels for timeline editing; strokeDashOffset animates flow. path_geometry queries geometry; vector_bake creates a static editable snapshot while preserving sources.',
    },
    {
      name: 'layoutAnimatedText / textSelectorWeight / applyShapeOperators / editGraphicsStack',
      purpose:
        'Shared native path text, fixed-layout grapheme/word/line range animation and editable ordered shape operators. Renderer, selection and graphics_inspect share results; graphics_plan uses stable IDs and exact candidates. Bounded layout/geometry caches expose accounting through render_profile; graphicsCache=false measures a pixel-identical baseline. See docs/TYPOGRAPHY-SHAPES.md.',
    },
    {
      name: 'progress / tween',
      purpose: 'Explicit start, duration, easing, repeat and yoyo; pure random-access evaluation.',
    },
    {
      name: 'prepareTracking / sampleTrackedPoint / trackingMotion / fitTrackingMotion / smoothTrackingMotion',
      purpose:
        'Editable sparse source-pixel tracks, confidence/gap evidence, random-access sampling, deterministic robust translation/similarity/affine fitting and rotation-safe smoothing. tracking_analyze uses an isolated worker; tracking_plan bakes attachment/stabilization/corner-pin keys with source clock/fit/parent conversion and exact preflight/apply. Original code/media remain editable. See docs/TRACKING.md.',
    },
    {
      name: 'spring',
      purpose:
        'Analytical mass/stiffness/damping/velocity spring, including critical and overdamping.',
    },
    {
      name: 'stagger / localClock',
      purpose: 'Sequence independent elements; offset nested animation clocks.',
    },
    {
      name: 'followPath / morphPoints / pointsPath',
      purpose: 'Arc-length polyline motion, equal-topology point morphing and SVG paths.',
    },
    {
      name: 'group',
      purpose: 'Namespace child IDs and preserve parents/masks. Returns a flat Node[] scene graph.',
    },
    {
      name: 'linearGradient / radialGradient',
      purpose:
        'Typed paint in local layer coordinates; shapes and native text. Formula SVG uses fill color.',
    },
    {
      name: 'glow / blur / effects',
      purpose:
        'Ordered non-destructive whole-layer passes: glow, blur, color and shadow. Apply glow to particle groups to avoid one large surface per particle.',
    },
    {
      name: 'enter / wipe',
      purpose: 'Composable opacity/offset/scale entrance and local rectangular reveal.',
    },
    {
      name: 'trail',
      purpose: 'Evaluate a pure drawing function at past frames. Deterministic after seeking.',
    },
    {
      name: 'particles',
      purpose:
        'Seeded analytical emission, velocity, gravity, lifetime, fade and repeat; no accumulated state.',
    },
    {
      name: 'project3D',
      purpose:
        'Perspective camera projection with near-plane culling for 2.5D scenes. Not a mesh/PBR/lighting engine.',
    },
    {
      name: 'textMotion',
      purpose:
        'Native text animator for graphemes or words using font-measured positions; start/duration/stagger are frames.',
    },
    {
      name: 'chromaKey / levels / curves / parseCube / vignette / grain / displacement / pixelate',
      purpose:
        'Composable color-key, grading, 3D LUT and pixel effects. LUT supports 2–33 cube grids; keyer is a chroma-distance keyer, not automatic rotoscoping.',
    },
    {
      name: 'cubicEasing / params.* / effects.* animation targets',
      purpose:
        'Animate exposed component controls and numeric effect fields with Bezier keyframes, matching Rust and TypeScript evaluators.',
    },
    {
      name: 'audioAssetId / ctx.audio',
      purpose:
        'Feed RMS, peak, bass/mid/treble and heuristic onset/BPM features to a component. Analysis is cached in bounded 30s windows; use audio_analyze for explicit ranges.',
    },
    {
      name: 'composition_inspect / composition_edit_layer',
      purpose:
        'Navigate isolated scene/group/component pages and edit generated stable-ID layers through persisted overrides. Source code remains intact.',
    },
  ],
  workflow: [
    'Read the SDK guide and project schema.',
    'Define timing and visual hierarchy before rendering.',
    'Keep stable IDs and group related visuals; use exposed params for editable controls.',
    'Run project_validate, then frame_sample at entrance/midpoint/exit times.',
    'Inspect missing elements, overlap, excessive glow and motion rhythm across the contact sheet.',
    'Fix source or semantic node properties; render a short preview before a full export.',
  ],
  limits: [
    'CPU Skia rendering. Temporary effect surfaces have a 256MB active-frame budget.',
    'Masks and targets must share a parent coordinate space.',
    'No AE .aep/.aex compatibility, GPU shaders, 3D camera tracking or dense optical-flow retiming. Sparse point motion analysis, GGX mesh lighting and opaque depth compositing are implemented.',
    'project.motionBlur supports 2–16 linear-light temporal samples with a 0–360 degree shutter. CPU work increases approximately with sample count; optical-flow video retiming is not provided.',
    'morphPoints requires equal counts; morphPaths resamples paths with different point counts.',
  ],
  example: `import {defineComponent, text, rect, group, enter, glow, linearGradient, particles} from '@vmotion/sdk';
export default defineComponent({name:'Animated title',parameters:{},render(ctx){
  const title=text('title','可编程动效',{width:1400,height:160,fontSize:96,fill:'#e8f0ff',textMotion:{unit:'grapheme',start:0,duration:22,stagger:4,offsetX:0,offsetY:28,rotation:-8,scale:0.9}});
  return [...group('heading',[title],{x:120,y:200,effects:[glow('#537fff',14,0.7)]}),
    ...group('dust',particles('spark',ctx,{count:60,origin:{x:960,y:800},spread:{x:1500,y:200},seed:17}),{effects:[glow('#537fff',10,0.6)]})];
}});`,
};
