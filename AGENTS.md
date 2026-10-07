# Vmotion repository

This is a local programmable video workstation. The application never calls AI models; external agents author TypeScript/JSON and operate CLI/MCP.

- Keep source, tests, documentation and editable examples under Git. Commit verified feature stages locally; do not include dependencies, dist/release, caches, logs or exported media. The existing ignore rules cover these outputs.
- Preserve user edits and production projects. Example authoring scripts need an explicit rebuild guard; use render-only mode to export an existing example.
- Editor, CLI and MCP use the same project service, candidate checks, atomic transactions and shared undo. Generated edits belong to stable-ID overrides/structure; preserve component source.
- SDK animation and temporal code must support random seeking and derive time from supplied clocks, with seeded randomness. Preview/export share rendering; explicit budgets return diagnostics rather than silently lowering export resolution.
- Update tool catalog, discovery categories, agent guide counts, schemas, SDK types/examples and relevant docs together. Default MCP stays compact, with capabilities discovered on demand.
- Verify changes with relevant tests and real artifacts. Normal commands: npm run typecheck, npm test, npm run build, npx tsx scripts/package.ts. Packaged CLI/MCP/window check scripts live in scripts/.
- Quality, freedom and external agent use take priority. The user now wants autonomous stage selection without asking what to do next. Continue authorized feature batches independently; ask only for essential missing information.
- Group related features into batches. During development run necessary focused checks; run the full regression/build/package/real MCP checks once the batch is ready, then commit the verified batch. Repeat full checks only for new changes/failures that warrant it.
- Prioritize MCP verification and agent context cost. Use real external stdio clients, test negative requests and exact candidates/undo, and measure catalog/schema/result JSON sizes. Keep startup compact, use valid local schema refs and conditional schema hashes, avoid duplicating media Base64 in text/metadata, and preserve full responses as explicit opt-ins.
- The user explicitly prioritizes breadth, high performance and optimization. Do not keep deepening one subsystem because it was recently mentioned. Balance general visual/video capabilities, measured core performance and agent usability in related batches.
