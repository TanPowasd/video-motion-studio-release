import { z } from 'zod';
import { effectGraphInspectSchema, graphInspectionSource } from './effect-graphs.js';
import { graphDependencies } from '../core/effect-graph.js';
import type { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { parameterJsonSchema, type ParameterDefinitions } from '../core/parameters.js';
type ParameterDefinition = ParameterDefinitions[string];
import { hash } from './project.js';

export const effectGraphQuerySchema = effectGraphInspectSchema
  .omit({ includeGraph: true, includeValues: true, nodeIds: true })
  .extend({
    section: z
      .enum(['nodes', 'parameters', 'links', 'unused', 'resources', 'outputs'])
      .default('nodes'),
    ids: z.array(z.string().min(1).max(1000)).min(1).max(256).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(24),
    detail: z.boolean().default(false),
  })
  .strict();

function preview(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > 160
      ? { kind: 'string', length: value.length, preview: value.slice(0, 160), truncated: true }
      : value;
  if (Array.isArray(value))
    return {
      kind: 'array',
      length: value.length,
      items: depth < 2 ? value.slice(0, 4).map((v) => preview(v, depth + 1)) : [],
      truncated: value.length > (depth < 2 ? 4 : 0),
    };
  if (value && typeof value === 'object') {
    const keys = Object.keys(value),
      shown = depth < 2 ? keys.slice(0, 4) : [];
    return {
      kind: 'object',
      total: keys.length,
      values: Object.fromEntries(
        shown.map((k) => [k, preview((value as Record<string, unknown>)[k], depth + 1)]),
      ),
      truncated: shown.length < keys.length,
    };
  }
  return value;
}
export async function queryEffectGraph(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = effectGraphQuerySchema.parse(raw),
    request = effectGraphInspectSchema.parse({
      source: p.source,
      params: p.params,
      output: p.output,
      revision: p.revision,
    }),
    { effect, locator } = await graphInspectionSource(renderer, snapshot, request),
    definition = effect.graph ?? renderer.effectGraphs.definition(snapshot, effect.source!),
    compiled = renderer.effectGraphs.resolve(snapshot, effect),
    resources = [...(effect.source ? [effect.source] : []), ...compiled.resources],
    rows =
      p.section === 'nodes'
        ? compiled.nodes.map((n) => ({ id: n.id, value: n }))
        : p.section === 'parameters'
          ? Object.entries(compiled.parameters).map(([id, value]) => ({ id, value }))
          : p.section === 'links'
            ? definition.links.map((link) => ({
                id: link.nodeId + ':' + link.property,
                value: link,
              }))
            : p.section === 'unused'
              ? compiled.unused.map((id) => ({ id, value: id }))
              : p.section === 'resources'
                ? resources.map((id) => ({ id, value: snapshot.files[id] }))
                : Object.entries(compiled.outputs).map(([id, value]) => ({ id, value }));
  const known = new Set(rows.map((row) => row.id));
  for (const id of p.ids ?? [])
    if (!known.has(id))
      throw new VmotionError(
        'EFFECT_GRAPH_INPUT',
        'Requested graph query ID is missing in selected section',
        { section: p.section, id },
      );
  const wanted = p.ids ? new Set(p.ids) : undefined,
    selected = wanted ? rows.filter((row) => wanted.has(row.id)) : rows,
    page = selected.slice(p.offset, p.offset + p.limit);
  return {
    revision: snapshot.revision,
    locator,
    name: compiled.name,
    output: compiled.output,
    selectedOutput: compiled.selectedOutput,
    source: effect.source
      ? { file: effect.source, hash: hash(snapshot.files[effect.source]) }
      : { inline: true },
    section: p.section,
    counts: {
      nodes: compiled.nodes.length,
      parameters: Object.keys(compiled.parameters).length,
      links: definition.links.length,
      unused: compiled.unused.length,
      resources: resources.length,
      outputs: Object.keys(compiled.outputs).length,
    },
    total: selected.length,
    offset: p.offset,
    ...(p.offset + page.length < selected.length ? { nextOffset: p.offset + page.length } : {}),
    coverage: {
      available: rows.length,
      returned: page.length,
      omitted: selected.length - page.length,
      filteredOut: rows.length - selected.length,
    },
    items: page.map(({ id, value }) => {
      if (p.section === 'nodes') {
        const node = compiled.nodes.find((n) => n.id === id)!;
        return {
          id,
          type: node.type,
          inputs: graphDependencies(node),
          fields: Object.keys(node),
          ...(p.detail ? { values: node } : {}),
        };
      }
      if (p.section === 'parameters')
        return {
          id,
          type: (definition.parameters[id] as ParameterDefinition).type,
          value: p.detail ? value : preview(value),
          ...(p.detail
            ? { schema: parameterJsonSchema(definition.parameters[id] as ParameterDefinition) }
            : {}),
        };
      if (p.section === 'resources')
        return {
          file: id,
          hash: hash(value as string),
          ...(p.detail
            ? {
                bytes: Buffer.byteLength(value as string),
                lines: (value as string).split('\n').length,
              }
            : {}),
        };
      if (p.section === 'links') return { id, ...(value as object) };
      if (p.section === 'outputs')
        return { name: id, nodeId: value, selected: compiled.selectedOutput === id };
      return { id };
    }),
    liveNodeImagesEstimate: compiled.peakSurfaces,
    interpretation:
      'Selected output reachability; aliases may share surfaces. Query still resolves/validates the complete definition; paging bounds response, not compile work. No source text/pixel images are cached.',
  };
}
