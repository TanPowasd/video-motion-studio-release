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
