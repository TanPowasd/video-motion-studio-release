import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { newNode, type Project, type Scene, type Sequence } from '../core/model.js';
import { atomicWrite, json, safePath } from './project.js';
import { projectCreationSchema, type ProjectCreationInput } from '../core/project-creation.js';
export async function initProject(
  root: string,
  name = 'Untitled science project',
  options: Omit<ProjectCreationInput, 'name'> = { template: 'science' },
) {
  const settings = projectCreationSchema.parse({ name, ...options });
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length)
    throw new Error('Project directory must be empty; existing files were preserved');
  const project: Project = {
    formatVersion: 1,
    id: randomUUID(),
    name: settings.name,
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    colorSpace: 'srgb',
    sampleRate: 48000,
    activeSequence: 'main',
    scenes: ['scenes/intro.json'],
    sequences: ['sequences/main.json'],
    assets: [],
    drawings: [],
    sdkVersion: '0.1.0',
  };
  const scene: Scene = {
    id: 'intro',
    name: 'The geometry of waves',
    duration: 300,
    background: '#101525',
    nodes: [
      newNode({
        id: 'eyebrow',
        type: 'text',
        name: 'Section label',
        text: 'MATH / EXPLAINED',
        x: 110,
        y: 78,
        fontSize: 22,
        fill: '#8491b7',
        width: 700,
      }),
      newNode({
        id: 'title',
        type: 'text',
        name: 'Title',
        text: 'The geometry of waves',
        x: 110,
        y: 145,
        fontSize: 76,
        fontWeight: 700,
        fill: '#f4f6ff',
        width: 1500,
        height: 160,
        animations: [
          {
            property: 'opacity',
            keys: [
              { frame: 0, value: 0, easing: 'easeOut' },
              { frame: 24, value: 1, easing: 'linear' },
            ],
          },
          {
            property: 'y',
            keys: [
              { frame: 0, value: 180, easing: 'easeOut' },
              { frame: 30, value: 145, easing: 'linear' },
            ],
          },
        ],
      }),
      newNode({
        id: 'subtitle',
        type: 'text',
        name: 'Explanation',
        text: 'Every wave is a story of repetition.\nChange amplitude. Change frequency. See the relationship.',
        x: 112,
        y: 295,
        width: 1500,
        height: 160,
        fontSize: 32,
        fill: '#9aa8cb',
      }),
      newNode({
        id: 'wave',
        type: 'component',
        name: 'Sine wave',
        component: 'components/wave.ts',
        x: 110,
        y: 490,
        width: 1700,
        height: 350,
        params: { amplitude: 100, frequency: 2, color: '#92a0ff' },
      }),
      newNode({
        id: 'formula',
        type: 'formula',
        name: 'Wave equation',
        text: 'y=A\\sin(\\omega t+\\varphi)',
        x: 115,
        y: 890,
        width: 950,
        height: 90,
        fill: '#e8ecff',
        fontSize: 48,
      }),
      newNode({
        id: 'badge',
        type: 'text',
        name: 'Footer',
        text: 'VMOTION  /  PROGRAMMABLE STORIES',
        x: 1340,
        y: 1000,
        width: 500,
        fontSize: 18,
        fill: '#697797',
        align: 'right',
      }),
    ],
  };
  const sequence: Sequence = {
    id: 'main',
    name: 'Main sequence',
    duration: 300,
    markers: [
      { id: 'start', frame: 0, label: 'Introduction' },
      { id: 'equation', frame: 180, label: 'Equation' },
    ],
    tracks: [
      {
        id: 'visual',
        name: 'Scenes',
        type: 'video',
        muted: false,
        clips: [
          {
            id: 'intro-clip',
            sceneId: 'intro',
            start: 0,
            duration: 300,
            sourceIn: 0,
            speed: 1,
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
          },
        ],
      },
      { id: 'voice', name: 'Voice / music', type: 'audio', muted: false, clips: [] },
    ],
  };
  const source = `import {defineComponent, node} from '@vmotion/sdk';\n\nexport default defineComponent({\n  name: 'Sine wave',\n  parameters: {\n    amplitude: {type: 'number', default: 100, min: 0, max: 180},\n    frequency: {type: 'number', default: 2, min: 0.1, max: 8},\n    color: {type: 'color', default: '#92a0ff'}\n  },\n  render(ctx, params) {\n    const amplitude = Number(params.amplitude);\n    const frequency = Number(params.frequency);\n    const color = String(params.color);\n    const line = Array.from({length: 401}, (_, i) => {\n      const x = i * ctx.width / 400;\n      const y = ctx.height / 2 - Math.sin(i / 400 * Math.PI * 2 * frequency - ctx.seconds) * amplitude;\n      return (i ? 'L' : 'M') + ' ' + x + ' ' + y;\n    }).join(' ');\n    return [\n      node({id: 'axis', type: 'path', path: 'M 0 ' + ctx.height / 2 + ' L ' + ctx.width + ' ' + ctx.height / 2, fill: 'transparent', stroke: '#38445f', strokeWidth: 2}),\n      node({id: 'curve', type: 'path', path: line, fill: 'transparent', stroke: color, strokeWidth: 5}),\n      node({id: 'dot', type: 'ellipse', x: ctx.width / 2 - 9, y: ctx.height / 2 - Math.sin(Math.PI * frequency - ctx.seconds) * amplitude - 9, width: 18, height: 18, fill: '#ffffff'})\n    ];\n  }\n});\n`;
  const duration = Math.round((settings.durationSeconds * settings.fps.num) / settings.fps.den);
  scene.duration = sequence.duration = duration;
  sequence.tracks[0].clips[0].duration = duration;
  sequence.markers = sequence.markers.filter((marker) => marker.frame < duration);
  if (settings.template === 'blank') {
    scene.name = '合成 1';
    scene.background = '#101525';
    scene.nodes = [];
    sequence.name = '主序列';
    sequence.markers = [];
    sequence.tracks[0].name = '画面';
    sequence.tracks[1].name = '声音';
  } else if (settings.width !== 1920 || settings.height !== 1080) {
    scene.nodes.unshift(
      newNode({
        id: 'template-layout',
        type: 'group',
        name: '模板布局',
        width: 1920,
        height: 1080,
        scaleX: settings.width / 1920,
        scaleY: settings.height / 1080,
      }),
    );
    for (const node of scene.nodes.slice(1)) node.parentId = 'template-layout';
  }
  for (const directory of ['components', 'assets', 'drawings', 'exports'])
    await mkdir(safePath(root, directory), { recursive: true });
  const agents = `# Vmotion project\n\nThis is a local project, not an AI integration. External agents may edit these files or use CLI/MCP.\n\n- MCP starts with 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any capability. tools_load enables task-specific direct tools for this connection; mcp --tools all preserves legacy direct tools/results. See docs/AGENT-DISCOVERY.md.\n- Edits return compact revisions, IDs, diagnostics and undo state; use project_file_read/drawing_get for source or tool_call response=full when needed. Native images/audio remain media blocks.\n- project.vmotion.json is the manifest; scenes/ and sequences/ contain authoritative JSON.\n- components/ contains TypeScript, Python/WGSL render-program sources and JSON resources. project_schema renderProgram describes manifests; programLayer/programEffect submit arbitrary project render code via supplied clocks and RGBA. Bundle dependencies in files; use sampled deterministic preflight before apply. VMOTION_PYTHON selects an external environment; WGSL requires hardware GPU. See docs/RENDER-PROGRAMS.md. Import helpers from @vmotion/sdk.\n- Preserve stable IDs. Visual editing writes node properties and component params.\n- Components export default defineComponent({name, parameters, render(ctx, params)}).\n- ctx supplies frame, seconds, fps, width, height and seed. Return scene nodes.\n- Use seeded random and ctx.seconds; do not use wall-clock time or asynchronous frame rendering.\n- Scenes support text, rect, ellipse, path, image, video, formula, chart, component, drawing, scene3d and nested scene nodes.\n- Run vmotion validate --project . --json after edits; vmotion frame --project . --frame 90 --output frame.png checks the picture.\n- Use vmotion mcp --project . for transactions, screenshots and cancellable render jobs.\n- Dynamic component internals are inspectable; edit their exposed params or TypeScript source.\n- Do not edit .vmotion caches or overwrite unresolved conflicts.\n`;
  for (const [file, value] of Object.entries({
    'project.vmotion.json': json(project),
    'scenes/intro.json': json(scene),
    'sequences/main.json': json(sequence),
    ...(settings.template === 'science' ? { 'components/wave.ts': source } : {}),
    'AGENTS.md':
      agents +
      '\n## Plugins and task-specific capabilities\n\n- tools_search/tool_schema default to short metadata; detail=true restores full information. tool_call fields selects output paths, retains revision/validity and reports missing paths. media=false omits inline media; full responses remain explicit. composition_edit_layers mode=plan returns exact candidates without saving. See docs/AGENT-DISCOVERY.md and docs/VISUAL-WORKSTATION.md.\n- plugins_inspect discovers builtin/project plugin IDs, semantic versions/dependencies and component/effectGraph/motion/theme/sound/template contributions. plugins_package returns a paginated content-hash/file-size index without duplicating source; use project_file_read for selected ranges. Full manifests are opt-in. plugins_plan batches hash-checked source files, registration/toggle/removal and component placement into one candidate.\n- Tool entry code exports definePlugin({name,tools:{id:definePluginTool({parameters,run(ctx,p)})}}). Manifest parameters must match the exported definitions. Query tools return bounded data; plan tools return deterministic operations/files/samples/summary, with no creative commit until exact preflight/apply.\n- tools_search pluginId discovers plugin.<id>.<tool>; tool_schema/ifHash/paths and tools_load work with live manifests. _context supplies explicitly selected scopes/files within declared reads. Default MCP still has 10 entries.\n- Eighteen builtin modules dispatch all 140 capabilities through one checked registry, including core/recovery/cache/review; shared services own transactions and task lifecycles. assets_query pages 24 registered summaries with detail opt-in; drawing_query pages 24 layers/16 strokes and explicit pressure-point ranges. Full drawing_get/source/native evidence remain available. project_references pages known JSON usages/imports/literal hints with runtime uncertainty; reference_sample inspects explicit generated/retimed scopes. reference_plan swaps selected declared same-kind sources with hashes/media checks/locks/ranges, keeps TS and one undo. sequence_query pages source/range windows without full project dumps. plugins_inspect reports moduleTools/hostTools. project_diagnostics pages 20 diagnostic/conflict/pending-file locators with files/codes/severities filters; detail opts into full selected evidence. Query has no reload/history side effects; repair using pending file hashes. project_schema exposes every registered resource kind. Exact file probes reuse bounded plugin hashes; explicit pin=false releases both content and manifest pins. Local plugin TypeScript is user-trusted code in bounded workers, not a security sandbox. Disabling/removing a library preserves files and independently referenced components/resources. Native/UI/audio ABI hooks remain unfinished. See docs/PLUGINS.md.\n' +
      '\n## Themes and versioned instances\n\n- theme_inspect/plan work with typed brand tokens, inheritance/aliases and live property/parameter bindings. Literal/local values and animation remain explicit; clearLocal resets a binding, detach materializes its current base value. SDK bindTheme captures the literal baseline.\n- template_inspect/plan publish pinned scene/code versions, place persistent port-editable instances, selectively upgrade custom params/keys/overrides, or detach a private editable copy. Author source files remain intact. Media, shared scenes, live themes and external packages remain project dependencies; captured code is not an arbitrary self-contained package.\n- Query tool_schema paths=["revision","publish.definition","publish.capture"] or paths=["revision","upgrades"] for only the relevant interface branches. projection.partial=true is documentation only; all supplied fields still undergo full validation. Cache schemaHash with ifHash.\n- Inspect exact candidate pictures, preflight/apply unchanged for one undo. render_profile resourceCache=false compares exact pixels and parse/preparation counts against bounded caches. See docs/THEMES-TEMPLATES.md.\n' +
      '\n## Media recovery, proxy preview and cache budgets\n\n- media_status pages missing/ready assets and source/FPS-matched proxy state. media_relink_plan points stable IDs at explicit existing files with compatible/replace policy, fresh metadata/fingerprints and unchanged references. Preflight accurate pictures, then exact apply/one undo; missing-path history remains diagnosable.\n- media_proxy start/status/cancel/inspect/release supports background lossless intra FFV1 proxies and idle-reader release before Windows file moves. Proxies use project rational FPS, no audio and atomic source-checked publication. Auto preview decodes at screen dimensions; native evidence/export stays original.\n- cache_inspect reports generated-group bytes/protection. cache_plan proposes fixed paths toward maxBytes/minAgeSeconds/maxFiles without deletion; cache_apply rechecks hash/size/mtime/resolved roots and reports actual bytes/skips. Active media/render tasks block cleanup; source/assets/history/candidates/checkpoints/compiled and registered cache references remain protected.\n- Keep token cost low with media/asset paging and plan IDs. Do not use cache cleanup as creative undo or delete original files. See docs/MEDIA-CACHE.md.\n' +
      '\n## Visual fields and light graphs\n\n- visual_templates returns short summaries of texture/marble/cellular/textureDisplace/layerDisplace/inkReveal/neonBloom/radialRays/duotone. Select one preset before includeGraph. visual_plan attaches reused editable JSON graphs across scoped targets with parameter keys and same-parent map bindings; preserve user-edited resources.\n- Graph texture settings offer deterministic seed/scale/octaves/evolution/angle/warp/contrast/bias and alpha color stops. Displacement map channels, midpoint, alpha multiply/ignore, vector space and edge mode are explicit.\n- Ordinary bloom/radialRays/gradientMap effects compose with graph and temporal passes. Length/center/intensity/decay use numeric channels; discrete samples/levels stay fixed. Radiant effects are 2D SDR operations, not volume/HDR/GPU.\n- render_profile fieldScan=bounded/full compares exact pixel hashes and scalar work. Regions bound texture/map/ray calculations; total field/ray work is capped at 256M, without lowering output dimensions. Read measured cold/warm times and complex-scene limits; no realtime claim from the small example. See docs/VISUAL-FIELDS.md.\n' +
      '\n## Storyboard and whole-sequence review\n\n- storyboard_plan authors components/storyboards JSON with chapter/shot IDs, scene/media/sequence sources, durations and explicit narration bindings. A short ordered action list can update/reorder/remove shots. Generated clips use sb/document/shot/kind IDs, shared linkedGroup and chapter markers. Only owned generated content is replaced; existing overlaps/locks fail. Optional operations can create scene/code/sound resources atomically.\n- Use storyboard_inspect with offset/limit; includeDocument opts into full data. Stored candidates are fixed. Cumulative second-to-frame boundaries use rational project FPS; zero-frame shots and narration extending beyond its shot require explicit correction.\n- sequence_audit checks structural source ranges and sampled full-composite images, mapped scene object locators and gaps/flat frames. Read coverage/omitted and source units; masks/effects are in final evidence, but per-object visibility/artistic correctness and intelligibility are not automatically proven. Run audio_preview/audit separately.\n- Desktop preview uses lossless RGBA over local HTTP to avoid PNG encode/decode. Native CLI/MCP evidence/export stays PNG; timestamps/version/clock filtering still rejects stale responses. See docs/STORYBOARD-PREVIEW.md.\n' +
      '\n## General creation and performance\n\n- Prioritize breadth, measured performance and agent use. render_profile inspects scene/sequence/focused/candidate frames, cold/warm timing, optional PNG encoding, component dependency hits, surface-pool memory and pixel determinism. detail=true opts into per-round records; surfacePoolMb=0 is an allocation baseline with identical pixels.\n- transition_plan creates parameterized crossfade/slide/push/wipe/iris/zoom/dip/cut compositions between existing scenes and optional explicit timeline placements; source scenes remain editable. Native scene references have their own dimensions/content clocks, and generated components declare sceneDependencies for cycle checks.\n- Node.isolation creates a transparent compositing group; blend=lighter permits premultiplied additive mixing. Do not emulate transparent crossfade with two source-over fades. Inspect start/mid/end pictures and apply the same stored plan for one undo. See docs/PERFORMANCE-TRANSITIONS.md.\n- Sequence mix config supplies track/bus/master EQ/effects, acyclic sends and explicit sidechain ducking. audio_mix_plan/inspect and audio_audit measure actual EBU R128/BS.1770 LUFS/true peak. Audition audio_preview planId before unchanged apply; random seeking preserves full-history effects. This is incremental audio support, not a complete DAW or two-hour performance certification.\n' +
      '\n## Music and sound design\n\n- Start with agent_guide topic=sound and sound_library; query project_schema sound/soundInstrument/soundEffect on demand. Scores are versioned JSON under components/sounds, exposed as audio assets with soundSource. The app does not call any models.\n- Compose beat/second note events with tempo maps, synth/FM/noise/drums or imported audio samples. Samples have explicit second windows and root notes; long windows are disk-paged. Gain/pan automation and EQ/delay/chorus/reverb/compressor/limiter processors route through acyclic buses and post-fader sends.\n- sound_inspect pages stable note IDs and timing. sound_plan creates full/short-edited multi-score candidates with optional audio-track placement and sample assetChecks. sound_preview planId auditions the exact unsaved candidate, returning native playable WAV and clipping evidence; random seek retains effect history. Structural project_preflight does not replace listening. Apply the same stored plan for one undo.\n- sound_midi imports format 0/1 PPQ notes/tempo/velocity/sustain and maps GM to local instruments. Read explicit unsupported control/plugin/effect warnings. Music remains editable after export. See docs/SOUND-MUSIC.md.\n' +
      '\n## Property drivers batch\n\n- drivers_inspect reports actual expression/layout/path poses and property dependencies. drivers_plan edits multiple scenes/native/generated scopes in one candidate and shared undo. animation_inspect reports keys-and-drivers when applicable.\n- Numeric expressions use deterministic frame/time/fps/value, self/base/parent/scene and layer("stable ID") references with arithmetic/functions/conditions. No arbitrary JS, loops, async or wall-clock randomness. Use TypeScript components for general algorithms.\n- Layout anchors/insets/sizes/aspect ratios use declared boxes in parent coordinates. Curved motion uses SVG or a vector layer ID, normalized arc length and optional autoRotate; curve_path returns positions/tangents.\n- Expression outputs override layout/path properties; value/base refer to the original animated field, while self refers to final dependencies. Avoid self cycles. layout and path cannot both drive position.\n- Null driver configs + explicit removeChannels remove configuration keys safely. Validate the final batch, preflight native pictures/determinism, then apply unchanged. See docs/PROPERTY-DRIVERS.md.\n' +
      '\n## Effect graph authoring\n\n- SDK defineEffectGraph/effectGraph and MCP effect_graph_query/inspect/plan use reusable JSON DAG resources under components/effects/*.json. Choose root/subgraph named outputs; channels routes straight RGBA/luma or constants, colorMatrix uses row-major 4x5 coefficients in sRGB/linear RGB. Branch pass/blend/mask/transform/noise/displace/solid nodes and reuse subgraphs; all frames resolve fixed snapshot resources.\n- Named inputs bind same-parent layer IDs; precompose other spaces. Parameters link to typed fields and nested defaults; numeric effects.N.params.* paths animate. Preserve stable IDs and reject cycles instead of silently bypassing branches.\n- effect_graph_query pages 24 nodes/parameters/links/unused IDs/resources/outputs, with explicit totals and selected detail/schema opt-ins. render_compare pairs pinned baseline/optimized frame hashes, graph work, scratch and bounded locators without rewriting. graphOptimize/graphRegions/graphTileRows control exact passthrough, alpha support and row tiles; keyer supports chroma/luma/softness/spill and matte output. render_profile graphCache=false provides identical-pixel compilation baseline; compiled plans validate exact resource probes and never cache frames. effect_graph_inspect can filter nodeIds/includeValues; effect_graph_plan supports short add/update/replace/remove/output/links/parameters/name actions with resource hashes. resetParams/resetKeys explicitly handles upgrades.\n- Preflight pictures and determinism, add extra samples if coverage is incomplete, then commit unchanged for one undo. Resources-only edits should sample their existing use sites. Source TypeScript stays editable. See docs/EFFECT-GRAPHS.md.\n' +
      '\n## Temporal effects and particles\n\n- motionBlur/echo share the ordinary effect stack and time-sample the same raw/generated layer source; sample opacity and masks once, and use deterministic ctx clocks. Apply to groups for emitter-wide effects rather than one full surface per particle.\n- particles_inspect returns bounded birth IDs, positions/velocities, age and truncation without files; particles_plan creates a parameterized component and returns exact candidate/apply with one undo. SDK particleField/particleState use analytic gravity/drag and optional originAt(birth,index).\n- liquify uses localized ordered inverse-sampling push/twirl/inflate fields, with brushes.N numeric channels. It is not physical fluid or mesh simulation. Check zero strength, extreme poses, early births and adjacent frames.\n- Temporal queries/pixels/depth and scratch buffers are bounded; budget errors never lower export resolution. Parent/camera motion requires sampling an owning layer/group or project motion blur. See docs/TEMPORAL-PARTICLES.md.\n' +
      '\n## Motion orchestration\n\n- motion_templates lists builtin/shared JSON templates, parameter schemas and controlled channels. motion_plan combines cue IDs, parameter bindings and frame/second timings across scene/scoped targets; target offsets stagger their clocks.\n- motion_plan output=layers creates ordered additive/factor/replace cues while keeping base keys; blend/weight/window/valueBasis/before/after are explicit layer options. animation_layers_inspect/plan page and edit stable-ID stacks across scopes, including weight/rate/offset controls and remapping. Existing channels are protected by default. Choose replaceChannels deliberately or merge to preserve old keys and reject time collisions. Overlapping cue tracks need explicit sequencing; no automatic summation.\n- Save reusable templates in components/motions/*.json in the same plan; generated key edits preserve TypeScript. Native keys remain independently editable and do not silently change when a template resource is updated. SDK parseMotionTemplate/applyMotionCues can reuse live JSON dependencies in code.\n- Inspect poseChecks and coverage; add extra project_preflight samples for omitted scopes/frames before committing unchanged. Integer parameter channels should use hold. See docs/MOTION-TEMPLATES.md.\n' +
      '\n## Visual review and export\n\n- Start with agent_guide topic=review. visual_audit findings carry revision-bound IDs and locators for the expanded layer and local/context frames.\n- visual_repair_plan takes explicit fitText/move/insideCanvas intents and stable expanded IDs, resolves generated owners, and returns before/after findings plus exact candidate/apply payloads. allKeys preserves whole motion trajectories; currentKey edits a local pose.\n- Preflight the stored candidate for native pictures, determinism and visual diagnostics, then apply unchanged for one undo. Do not automatically resolve artistic overlap, clipping or motion reviews.\n- Pass the applied revision to render_start or CLI render --revision HASH so intervening edits cannot silently change the export. render_query pages 20 compact task records by IDs/statuses/used revision; follow nextOffset and read detail=true/render_status for output/error evidence. Legacy render_list keeps its full array. See docs/AGENT-REVIEW.md.\n' +
      '\n## Candidate code workflow\n\n- Start with project_context for concise metadata, revision, file hashes and stable IDs. Use project_file_read for source ranges and project_schema only for the schema you need.\n- Use project_preflight to check operations and hash-checked file edits before saving. Request samples and determinism=true to inspect native frames and detect stateful code. The active project and undo history remain unchanged during preflight.\n- Commit the same request through project_apply with revision and expectedCandidateRevision. Failed checks preserve source files and the last usable preview.\n- For invalid external edits, read version=pending and preflight/apply that pending version to repair files. Preserve unresolved conflicts; future formats are not automatically rewritten.\n- CLI context/read/schema/preflight/apply provide the same flow. Put complex requests in JSON and use --request-file.\n' +
      '\n## Structured component parameters\n\n- defineComponent infers typed params. Declare number/string/color/boolean/enum/vec2/vec3/array/object controls, labels, defaults and limits. Unknown fields and invalid defaults are rejected.\n- MCP component_query reads selected relative parameter paths, 16 descriptor/value previews and 32 numeric channels by default, including pages beyond channel 1000. includeSchema/fullValues are opt-ins; themes/native keys are reflected, while final drivers/pixels need separate evidence. Legacy component_parameters returns full defaults/values/schema with the old 1000-channel limit. component_parameters_edit edits relative paths, resets defaults, adds keyframes and inserts/removes/moves array items atomically.\n- Use arrays operations for array structure changes so index keyframes follow their original items. params.origin.x and params.data.1.value can animate; integer channels should use hold.\n' +
      '\n## Keyframe editing\n\n- animation_inspect reads paginated channel keys and sampled values/velocities. animation_edit atomically changes multiple native/generated layers with upsert/remove/ease/transform actions.\n- transform can copy, shift or scale selected key times and values around pivots. Default collisions are errors; do not silently overwrite keys. Retiming preserves easing and Bezier controls.\n- SDK editKeyframes/sampleAnimation share these algorithms. CLI animation/animate expose the same commands.\n' +
      '\n## Audio checks\n\n- audio_timeline pages 24 audible sequence clips by default, with exact sample positions and nested gain/fade envelopes. Follow offset/limit and totalClips/nextOffset; includeAll=true requests the complete list. audio_preview renders up to 10 seconds at 48 kHz and returns playable audio plus RMS/peak/waveform metrics.\n- Main timeline preview and export share the local mixer. Standalone scenes/groups are silent; ctx.audio drives animation analysis and does not create a sound track.\n- Import audio/video to record duration metadata, then asset_place on the matching track. Use revision checks and explicit sample ranges for repeatable audio checks.\n' +
      '\n## Visual audit\n\n- visual_audit checks sampled scene/group/component frames for definite text truncation and review hints: overflow, clipping, text overlap, opaque rectangle coverage and fast/jumping motion. It returns stable IDs, owner paths, times and annotated native images.\n- Include adjacent frames around suspected jumps. Geometry hints require visual judgement; masks/effects/transparent media are not final pixel visibility proofs.\n- project_preflight supports visual=true and visualOptions for scene samples. Definite errors block apply, while review hints remain warnings. Filter nodeIds or ignoreNodeIds and check summary.incomplete/omitted before drawing conclusions.\n' +
      '\n## Typography and shape stacks\n\n- graphics_inspect returns shared glyph poses/bounds with 16-unit paging; full values and SVG are opt-in.\n- graphics_plan batches native/generated pathText, textAnimators and shapeOperators. Use stable IDs, stored planId, unchanged preflight/apply and one undo.\n- Selectors use grapheme/word/line, percent/index ranges and shape weights. Advanced reveal preserves full layout. Shape order: primitive, operators, legacy reveal, layer trim. Offset requires closed contours; dash has on/off/phase.\n- render_profile graphicsCache=false supplies a pixel-identical uncached baseline. Cache accounting is serialized/key bytes, not native RAM. See docs/TYPOGRAPHY-SHAPES.md.\n' +
      '\n## Tracking and stabilization\n\n- tracking_analyze starts a cancellable source-video point analysis. Source frames use rational project FPS; manual seeds/reseeds use displayed source pixels, or automatic corners when points is empty. Poll status for an immutable analysisId. Default portable hashing verifies the whole source; portable=false opts into metadata-only checks.\n- tracking_inspect paginates point/gap summaries and selected frame evidence; tracking_evidence returns annotated native source pictures. Lost points need an explicit reseed; confidence is a heuristic, not a probability.\n- tracking_plan saves editable components/tracking JSON and batches point/transform attachment, video stabilization/smoothing/zoom or four-point corner pin into ordinary keys. It converts source clock/letterbox/parent/TRS, pins source checks and preserves code. Default loss policy rejects gaps; explicit hold reports use.\n- Use unchanged stored preflight/apply for one undo. Matrix channels are protected; replaceChannels explicitly bakes/combines existing matrix motion. Repeated binding adds to the current matrix, so undo prior baking before updating that binding. Transparent borders and sparse tracking limitations remain explicit. See docs/TRACKING.md.\n- render_profile mediaFraming=direct/concat compares real decode copy work and identical pixels; no export dimensions change.\n' +
      '\n## Vector animation\n\n- SDK booleanPath/trimPath/outlinePath/simplifyPath/roundPath return new SVG geometry; path_geometry performs the same native query without edits.\n- Animate pathTrim.start/end (0–1), pathTrim.offset (turns), strokeWidth, strokeDashOffset (pixels), strokeDash.N and radius. Trim uses combined contour length; start>end wraps, equal endpoints are empty.\n- vector_bake creates static sibling rect/ellipse/path snapshots at a frame and preserves source layers/code, with optional hiding and one revision-checked undo step. Only geometry/transforms are baked; masks, effects and source animation remain on originals. Dashed stroke outlining is not yet supported. See docs/VECTOR-ANIMATION.md.\n' +
      '\n## Repeater animation\n\n- SDK repeatGraph/repeatGrid/repeatRadial generate stable copy-N layer graphs, including masks and native animations. Fractional count fades the final copy; parameters support layout, opacity, scale, skew, rotation and stacking. Per-copy callbacks can derive styling and timing from ctx.\n- repeat_describe predicts affine transforms and conservative bounds without edits. repeat_create creates a complete TypeScript component from sibling sources and descendants, with exposed parameters and one undo step; the base graph is copied, while original layers/code remain available.\n- Edit params with component_parameters_edit/animation_edit and generated copies with normal composition tools. Copy IDs stay stable across count and order changes. Use frame evidence after changes.\n- All nodes support matrix[0..5] affine coefficients and numeric matrix.N keyframes; SDK affineMatrix and the advanced inspector share rendering/selection behavior. See docs/REPEATERS.md.\n' +
      '\n## Layer structure and drawing workflow\n\n- Use MCP composition_structure or composition_structure_batch for group, copy, delete, add and order actions in scene/group/component scopes. Generated edits live in structure and overrides; preserve stable IDs.\n- Drawings are independent documents in drawings/*.json, referenced by project.drawings. Create/edit layers first, publish the whole document or selected layers, then use asset_place to put assets in scenes or sequence tracks.\n- MCP drawing_create, drawing_get, drawing_edit, drawing_frame, drawing_publish and drawing_open_asset share the editor revision checks and undo history. drawing_frame returns an image.\n- CLI drawing create/inspect/edit/frame/publish and asset-place support the same workflow. Pass complex pen paths using --operations-file.\n' +
      '\n## Shared scene composition\n\n- scene_precompose turns adjacent sibling layers/descendants into a reusable JSON scene and one reference, with a single undo step. Native animations/masks are preserved; generated leaf content is captured at the chosen frame, not automatically converted from arbitrary code.\n- scene_place inserts a shared reference; scene_references queries declared incoming/outgoing dependencies. Source edits affect all instances, while instance overrides win.\n- Enter instances with composition_inspect path and edit generated/scene-reference IDs using ordinary composition/animation tools. scene_reset_instance clears locally stored internal edits but retains outer placement/source defaults.\n- Scene width/height default to project size. time_inspect/time_edit expose visual content retiming (rate/reverse/freeze/repeat/remap). Use local frame and ancestor contextFrames from composition_interactions; transforms/parameters stay on the parent clock. See docs/CONTENT-TIME.md.\n' +
      '\n## Agent-first assembly and math\n\n- Start with agent_guide for overview/animation/editing/math/recovery routing. The app never calls AI models.\n- media_inspect/media_sample return actual source metadata, project-source frame timestamps, native images and assetCheck. Retain checks through sequence_plan, project_preflight and project_apply; changed assets reject the commit. Fingerprints are size/mtime checks, not cryptographic hashes.\n- sequence_plan creates exact candidate/apply requests for append/insert/overwrite and optional linked audioTrackId. Review candidate through project_preflight, then use apply unchanged with its fixed IDs/revision; do not regenerate the reviewed plan. SourceOut is exclusive, and preserves fractional source limits. Insert respects all affected track locks; partial linked overwrite is rejected.\n- sequence_edit provides split/trim/slip/move/ripple/link/locks/markers/work areas/BPM. captions_import creates editable cue JSON from SRT/VTT, and captions_inspect reads it. Use audio_preview for sample-based sound evidence.\n- linear_algebra provides matrix solve/inverse/determinant/product, pivoted QR leastSquares, batch transforms and conjugateGradient traces. SDK matrixLU and preparePointTransform can be prepared outside render(ctx); inspect residual/rank/converged. Row-major matrices use column vectors; A*B applies B first. See docs/AGENT-MEDIA.md and docs/LINEAR-ALGEBRA.md.\n' +
      '\n## Matrix-driven 3D\n\n- Use agent_guide topic=3d and matrix3d to inspect 4x4 model/view/projection, vertex depth, clipping and face bounds.\n- SDK mat4Compose, prepareCamera3D/project3DBatch and scene3D/mesh3D share row-major matrices and column vectors. Cache camera per frame and models per object; derive transforms from ctx.frame.\n- scene3D emits individually editable path faces. Use scene3DLayer for persistent scene3d data and native Rust tiled depth buffering: intersecting opaque meshes, 1/4 antialias samples, flat lighting, numeric camera/TRS/matrix keys and preview/export parity. scene3d_render returns color/depth/face-ID images, visible counts and pixel picks; outer effects/masks are excluded from this local evidence.\n- mesh_generate/mesh_import plan reusable components/meshes/*.json resources with optional placement and auto-fitted camera. Pass returned planId through project_preflight and project_apply unchanged; stored source data is content checked. mesh_inspect provides bounds/area/topology and face pagination. meshSource references use pinned project files; resource edits update all instances.\n- SDK sphereMesh/cylinderMesh/coneMesh/torusMesh/planeMesh/surfaceMesh/parseOBJ support procedural and local OBJ geometry. OBJ concave faces are triangulated; normal references feed smooth materials; UVs remain metadata. standardMaterial supports GGX metallic/roughness direct lighting, directional/point lights, emissive and exposure. scene3d_materials queries/plans instance controls and updates numeric keys. Textures/IBL/world transparency/shadows/GPU are not implemented. See docs/MATERIALS3D.md, docs/MESHES.md and docs/DEPTH3D.md.\n' +
      '\n## Animation and effect workflow\n\n- render_profile.gpu and render_compare baseline/optimized.gpu select cpu/auto/gpu. Windows DX12 accelerates fused colorMatrix/keyer/single-input channels; fullSceneGpu=false. Check hardware, transfer/buffer/correction/fallback counters. Default performance tools remain CPU; pixelTolerance is explicit. Export pins GPU runtime and fails on device loss. See docs/GPU-EFFECTS.md.\n- Read `vmotion guide` or the MCP `animation_guide` tool before authoring motion.\n- Compose timeline helpers, physics, gradients, text animators, masks and ordered effect stacks in TypeScript.\n- Use effects_guide/inspect/plan for stable-ID multi-layer append/update/copy/move/toggle/remove/keys, then preflight/apply the stored plan for one undo. Copies and ordering retain logical key channels.\n- SDK waveWarp/twirl/bulge/rgbSplit/linearWipe/radialWipe use layer-local coordinates, normalized centers and premultiplied-alpha sampling. Declare group width/height or supply region; tools can fit current content bounds. Zero strength, disabled effects and wipe endpoints are exact. See docs/EFFECTS2D.md.\n- Use `group` for whole-layer opacity/effects; place glow on particle groups.\n- Sample multiple frames with `vmotion sample` or MCP `frame_sample` to check entrance, midpoint, transition and exit.\n- Use scene3D for matrix-driven mesh paths and project3DBatch for point effects; do not claim complete 3D/PBR or AE compatibility.\n',
  }))
    await atomicWrite(safePath(root, file), value);
  return project;
}
