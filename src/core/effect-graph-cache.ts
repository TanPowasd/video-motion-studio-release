import { isDeepStrictEqual } from 'node:util';
import { GeometryCache } from './geometry-cache.js';
import {
  compileEffectGraph,
  effectGraphResource,
  type CompiledEffectGraph,
} from './effect-graph.js';
import type { EffectGraph, GraphEffect } from './effect-graph-schema.js';
import { VmotionError, type Snapshot } from './model.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
type Request = Pick<GraphEffect, 'source' | 'graph' | 'params' | 'output'>;
type CachedGraph = {
  request: Request;
  probes: Map<string, string>;
  graph: CompiledEffectGraph;
};
/** Reuse validated/compiled resources, never rendered frames or component results. */
export class EffectGraphResolver {
  private readonly definitions: GeometryCache<{ text: string; graph: EffectGraph }>;
  private readonly compiled: GeometryCache<CachedGraph>;
  private stats = { parses: 0, compiles: 0, reused: 0, invalidations: 0 };
  constructor(budgetBytes = 8 * 1024 * 1024, maxEntries = 128) {
    this.definitions = new GeometryCache(budgetBytes / 2, maxEntries);
    this.compiled = new GeometryCache(budgetBytes, maxEntries);
  }
  definition(snapshot: Snapshot, file: string) {
    const text = snapshot.files[file],
      old = this.definitions.get(file);
    if (text !== undefined && old?.text === text) return old.graph;
    const graph = freeze(effectGraphResource(snapshot, file));
    this.stats.parses++;
    this.definitions.put(file, { text, graph }, text.length * 2 + JSON.stringify(graph).length * 2);
    return graph;
  }
  resolve(snapshot: Snapshot, effect: GraphEffect): CompiledEffectGraph {
    if (!!effect.source === !!effect.graph)
      throw new VmotionError(
        'EFFECT_GRAPH_SOURCE',
        'Choose exactly one inline graph or source file',
      );
    const request: Request = {
        source: effect.source,
        graph: effect.graph,
        params: effect.params,
        output: effect.output,
      },
      key = JSON.stringify(request),
      cached = this.compiled.get(key);
    // Deep equality also distinguishes undefined/nonfinite values lost by JSON.stringify.
    if (
      cached &&
      isDeepStrictEqual(cached.request, request) &&
      [...cached.probes].every(([file, text]) => snapshot.files[file] === text)
    ) {
      this.stats.reused++;
      return cached.graph;
    }
    if (cached) this.stats.invalidations++;
    const probes = new Map<string, string>();
    const resource = (file: string) => {
      const graph = this.definition(snapshot, file);
      probes.set(file, snapshot.files[file]);
      return graph;
    };
    const graph = freeze(
      compileEffectGraph(
        effect.graph ?? resource(effect.source!),
        effect.params,
        resource,
        effect.output,
      ),
    );
    this.stats.compiles++;
    const stored = { request: freeze(structuredClone(request)), probes, graph },
      size =
        JSON.stringify(graph).length * 2 +
        key.length * 2 +
        [...probes].reduce(
          (bytes, [file, text]) => bytes + (file.length + text.length) * 2 + 128,
          0,
        );
    this.compiled.put(key, stored, size);
    return graph;
  }
  report() {
    return {
      ...this.stats,
      definitions: this.definitions.report(),
      compiled: this.compiled.report(),
      accounting:
        'Retained keys, source probes and serialized JS data estimates; excludes frame/native surface memory',
    };
  }
  clear() {
    this.definitions.clear();
    this.compiled.clear();
  }
}
