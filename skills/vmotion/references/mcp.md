# MCP: the last resort

Use MCP only when editing files and the CLI cannot do the job, for example:

- your client can only talk MCP (no shell or file access), or the human already connected you to the running app
  through 连接 MCP and wants you to work inside that session;
- you need live editor state the CLI does not expose (the human's current selection, the interactive
  composition/interaction locators of what they are pointing at);
- you need a capability's media evidence inline in the conversation and cannot open PNG files.

Everything else (authoring, validation, frames, render, any capability via `vmotion tool-call`) is cheaper and more
transparent through files and the CLI. MCP results are JSON envelopes; catalogs and schemas cost context.

## Connecting

```
vmotion mcp --project <dir> [--tools compact|all|auto]
```

The desktop app's top-bar **连接 MCP** dialog copies a ready `{"mcpServers": {"vmotion": {command, args, env}}}`
config for the open project (`args` = `<cli> mcp --project <dir> --tools compact`). If the app is open, the MCP server
attaches to it, so your writes share its undo history and appear in its change feed with your client name.

## Compact mode (default)

`tools/list` exposes 10 entry tools: `agent_guide`, `project_context`, `project_file_read`, `project_preflight`,
`project_apply`, `frame_capture`, `tools_search`, `tool_schema`, `tool_call`, `tools_load`. All other ~148
capabilities exist but are **not callable by name** until loaded:

- `tools_search {"query": "海报 poster", "category": "image"}` → names and one-line summaries.
- `tool_schema {"name": "still_plan"}` → that one interface (cache `schemaHash`, pass `ifHash` next time).
- `tool_call {"name": "still_inspect", "arguments": {…}}` → call any capability.
- `tools_load {"categories": ["image"]}` → make them direct tools for this connection (then re-list).
- Calling an unloaded tool by name returns `TOOL_NOT_LOADED` with instructions; unknown names return
  `TOOL_NOT_FOUND` with suggestions. `--tools all` exposes every legacy direct tool; `--tools auto` promotes tools you
  used through `tool_call`/`tool_schema` (max 32).
- Keep results short: `tool_call` `fields: ["summary", "plan.planId"]`, `media: false`; `response: "full"` only
  when needed.

Start with `agent_guide {"topic": "jsx"}` (topics: overview, review, animation, effects, editing, image, glyphs, jsx,
sound, performance, 3d, math, recovery, plugins) and `project_context`.

## The write contract: plan → project_preflight → project_apply

Every capability declares `effect`: `read`, `plan` (returns a stored candidate, never commits) or `write`.

- **Planners** (`*_plan`, `mesh_generate`, `mesh_import`, `scene3d_materials`, `plugins_install`, and direct write
  tools called with `mode: "plan"`) return:

  ```json
  {"committed": false, "effect": "plan",
   "plan": {"planId": "<sha256>", "candidateRevision": "<rev>", "baseRevision": "<rev>", "summary": {…}, "samples": […]},
   "next": "project_preflight({planId}) then project_apply({planId})"}
  ```

  Then always: `project_preflight {"planId": …}` → inspect diagnostics and sample images → `project_apply
  {"planId": …}`. Do not regenerate the plan between preflight and apply.
- **File edits over MCP**: `project_preflight {"files": [{type: "text"|"replace"|"delete", path, expectedHash,
  …}], "samples": [{sceneId, frame}], "determinism": true}` then `project_apply` with the same request plus
  `expectedCandidateRevision`. This is the MCP equivalent of writing the file yourself; prefer real file writes.
- **Direct write tools** (`animation_edit`, `composition_edit_layer`, `component_parameters_edit`, `sequence_edit`,
  `captions_import`, `asset_place`, …) commit immediately unless `mode: "plan"`; results carry `committed` and `next`.
- `samples: false` (or `visual: false` with no samples) skips sample renders on preflight/apply.
- Argument errors (`TOOL_ARGUMENTS`) list the failing `path`, allowed values, limits and a minimal valid `example`.
- If the human paused external AI edits, writes fail with `AGENT_ON_HOLD`; read-only tools still work. Wait.

## Typical MCP-only flows

- Inspect what the human selected: `project_context` (includes `selection`) → `tool_call composition_inspect` /
  `component_query`.
- Promote the human's visual tweaks into JSX: `tool_call jsx_writeback_plan {sceneId, nodeId}` → preflight/apply
  the planId (CLI equivalent: `vmotion jsx-writeback … --apply`).
- Still export of an unapplied candidate: `tool_call image_export {sceneId, planId}`.

Repo docs: `docs/AGENT-DISCOVERY.md` (contract details), `docs/AGENT-WORKFLOW.md`, `docs/AGENT-WORKBENCH.md`.
