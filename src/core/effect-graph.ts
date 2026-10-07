import {
  effectGraphSchema,
  type EffectGraph,
  type EffectGraphInput,
  type EffectGraphNode,
  type GraphEffect,
} from './effect-graph-schema.js';
import { VmotionError, type Snapshot } from './model.js';
import { resolveParameters, type ParameterDefinitions, ParameterError } from './parameters.js';
import { pinGrid } from './warp-grid.js';
export type CompiledGraphNode =
  Exclude<EffectGraphNode, { type: 'subgraph' }> | { id: string; type: 'alias'; input: string };
export type CompiledEffectGraph = {
  name: string;
  nodes: CompiledGraphNode[];
  output: string;
  inputs: string[];
  resources: string[];
  parameters: Record<string, unknown>;
  unused: string[];
  peakSurfaces: number;
  outputs: Record<string, string>;
  selectedOutput?: string;
};
export function graphDependencies(node: EffectGraphNode | CompiledGraphNode): string[] {
  if (node.type === 'channels')
    return [node.red, node.green, node.blue, node.alpha].flatMap((channel) =>
      typeof channel === 'number' ? [] : [channel.input],
    );
  if (node.type === 'blend') return [node.background, node.foreground];
  if (node.type === 'mask') return [node.input, node.matte];
  if (node.type === 'displace') return [node.input, node.map];
  if (node.type === 'subgraph') return Object.values(node.inputs);
  return 'input' in node ? [node.input] : [];
}
function order(graph: {
  nodes: Array<EffectGraphNode | CompiledGraphNode>;
  output: string;
  outputs?: Record<string, string>;
}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (byId.size !== graph.nodes.length)
    throw new VmotionError('EFFECT_GRAPH_IDS', 'Graph node IDs must be unique');
  if (!byId.has(graph.output))
    throw new VmotionError('EFFECT_GRAPH_OUTPUT', 'Graph output node is missing', {
      output: graph.output,
    });
  for (const [name, nodeId] of Object.entries(graph.outputs ?? {}))
    if (!byId.has(nodeId))
      throw new VmotionError('EFFECT_GRAPH_OUTPUT', 'Named graph output node is missing', {
        name,
        nodeId,
      });
  const done = new Set<string>(),
    stack: string[] = [],
    sorted: Array<EffectGraphNode | CompiledGraphNode> = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (stack.includes(id))
      throw new VmotionError('EFFECT_GRAPH_CYCLE', 'Effect graph contains a dependency cycle', {
        cycle: [...stack.slice(stack.indexOf(id)), id],
      });
    const node = byId.get(id);
    if (!node)
      throw new VmotionError('EFFECT_GRAPH_INPUT', 'Graph dependency node is missing', {
        nodeId: stack.at(-1),
        input: id,
      });
    if (stack.length >= 256)
      throw new VmotionError('EFFECT_GRAPH_LIMIT', 'Graph dependency depth exceeds 256');
    stack.push(id);
    for (const input of graphDependencies(node)) visit(input);
    stack.pop();
    done.add(id);
    sorted.push(node);
  };
  for (const node of graph.nodes) visit(node.id);
  return sorted;
}
function parametersFor(definitions: ParameterDefinitions, values: Record<string, unknown>) {
  try {
    return resolveParameters(definitions, values);
  } catch (error) {
    throw new VmotionError('EFFECT_GRAPH_PARAMETER', (error as Error).message, {
      parameter: error instanceof ParameterError ? error.path : undefined,
    });
  }
}
function connectedValue(value: unknown, path: string) {
  let current: any = value;
  for (const part of path.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    )
      throw new Error(`Missing parameter field ${path}`);
    current = current[part];
  }
  return current;
}
function connect(node: EffectGraphNode, path: string, value: unknown) {
  const parts = path.split('.');
  if (
    [
      'id',
      'type',
      'input',
      'inputs',
      'foreground',
      'background',
      'map',
      'matte',
      'source',
      'slot',
      'output',
    ].includes(parts[0])
  )
    throw new Error('Parameter links preserve graph IDs, types and input topology');
  if (node.type === 'channels' && typeof node[parts[0] as 'red'] !== 'number')
    throw new Error('Parameter links preserve channel input routing');
  let current: any = node;
  for (const [index, part] of parts.entries()) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      (part === 'length' && Array.isArray(current)) ||
      !current ||
      typeof current !== 'object'
    )
      throw new Error('Invalid parameter connection path');
    if (index === parts.length - 1) current[part] = structuredClone(value);
    else {
      if (!Object.hasOwn(current, part))
        throw new Error('Parameter connection parent field is missing');
      current = current[part];
    }
  }
}
export type ReadonlyGraph<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyGraph<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyGraph<T[K]> }
    : T;
export type GraphDefinitionInput = EffectGraphInput | ReadonlyGraph<EffectGraphInput>;
export function defineEffectGraph(input: GraphDefinitionInput) {
  const graph = effectGraphSchema.parse(input);
  order(graph);
  return graph;
}
export function effectGraphResource(snapshot: Snapshot, file: string) {
  const content = snapshot.files[file];
  if (content === undefined)
    throw new VmotionError(
      'EFFECT_GRAPH_SOURCE',
      'Effect graph resource is missing from this revision',
      { file },
    );
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new VmotionError('EFFECT_GRAPH_LIMIT', 'Graph resource exceeds 8MiB', { file });
  try {
    return defineEffectGraph(JSON.parse(content));
  } catch (error) {
    throw new VmotionError(
      error instanceof VmotionError ? error.code : 'EFFECT_GRAPH_DOCUMENT',
      (error as Error).message,
      {
        file,
        ...(error instanceof VmotionError && typeof error.details === 'object'
          ? error.details
          : {}),
      },
    );
  }
}
export function compileEffectGraph(
  graph: EffectGraphInput | EffectGraph,
  params: Record<string, unknown> = {},
  resource: (file: string) => EffectGraph = () => {
    throw new VmotionError('EFFECT_GRAPH_SOURCE', 'A resource resolver is required');
  },
  outputName?: string,
): CompiledEffectGraph {
  const flat: CompiledGraphNode[] = [],
    resources = new Set<string>(),
    path: string[] = [],
    definitions = new Map<string, EffectGraph>();
  const load = (file: string) => {
    let definition = definitions.get(file);
    if (!definition) {
      definition = resource(file);
      definitions.set(file, definition);
    }
    return definition;
  };
  const expand = (
    input: EffectGraphInput | EffectGraph,
    values: Record<string, unknown>,
    prefix: string,
    mappings?: Record<string, string>,
    selectedOutput?: string,
  ): { output: string; outputs: Record<string, string>; params: Record<string, unknown> } => {
    let document = effectGraphSchema.parse(input);
    const parameters = parametersFor(document.parameters as ParameterDefinitions, values),
      nodes = structuredClone(document.nodes),
      seen = new Set<string>();
    for (const node of nodes)
      if (node.type === 'subgraph')
        node.params = parametersFor(
          load(node.source).parameters as ParameterDefinitions,
          node.params,
        );
    for (const link of document.links) {
      const node = nodes.find((node) => node.id === link.nodeId);
      if (!node)
        throw new VmotionError('EFFECT_GRAPH_LINK', 'Parameter link targets a missing node', {
          nodeId: link.nodeId,
        });
      const key = link.nodeId + ':' + link.property;
      if (seen.has(key))
        throw new VmotionError('EFFECT_GRAPH_LINK', 'A field may have only one parameter link', {
          nodeId: link.nodeId,
          property: link.property,
        });
      seen.add(key);
      try {
        const value = connectedValue(parameters, link.parameter);
        if (typeof value === 'number') {
          const number = value * link.scale + link.offset;
          if (!Number.isFinite(number))
            throw new Error('Parameter connection produced a nonfinite number');
          connect(node, link.property, number);
        } else {
          if (link.mode === 'number' || link.scale !== 1 || link.offset !== 0)
            throw new Error('Numeric scale/offset needs a numeric parameter');
          connect(node, link.property, value);
        }
      } catch (error) {
        throw new VmotionError('EFFECT_GRAPH_LINK', (error as Error).message, {
          nodeId: link.nodeId,
          property: link.property,
          parameter: link.parameter,
        });
      }
    }
    document = effectGraphSchema.parse({ ...document, nodes });
    const inputs = new Set(
      document.nodes
        .filter((node) => node.type === 'input')
        .map((node) => (node as Extract<EffectGraphNode, { type: 'input' }>).slot),
    );
    if (mappings && [...inputs].some((slot) => !Object.hasOwn(mappings, slot)))
      throw new VmotionError('EFFECT_GRAPH_INPUT', 'Subgraph input mapping is incomplete', {
        missing: [...inputs].filter((slot) => !Object.hasOwn(mappings, slot)),
      });
    if (mappings && Object.keys(mappings).some((slot) => !inputs.has(slot)))
      throw new VmotionError('EFFECT_GRAPH_INPUT', 'Subgraph mapping names an unknown slot');
    const ref = (id: string) => prefix + id;
    for (const raw of order(document) as EffectGraphNode[]) {
      if (raw.type === 'subgraph') {
        if (path.includes(raw.source))
          throw new VmotionError('EFFECT_GRAPH_CYCLE', 'Subgraph resources contain a cycle', {
            cycle: [...path, raw.source],
          });
        if (path.length >= 8)
          throw new VmotionError('EFFECT_GRAPH_LIMIT', 'Subgraph nesting exceeds 8');
        resources.add(raw.source);
        path.push(raw.source);
        const child = expand(
          load(raw.source),
          raw.params,
          ref(raw.id) + '/',
          Object.fromEntries(Object.entries(raw.inputs).map(([slot, input]) => [slot, ref(input)])),
          raw.output,
        );
        path.pop();
        flat.push({ id: ref(raw.id), type: 'alias', input: child.output });
      } else if (raw.type === 'input' && mappings)
        flat.push({ id: ref(raw.id), type: 'alias', input: mappings[raw.slot] });
      else {
        let node = { ...raw, id: ref(raw.id) } as CompiledGraphNode;
        if ('input' in node) node = { ...node, input: ref(node.input) };
        if (node.type === 'blend')
          node = { ...node, foreground: ref(node.foreground), background: ref(node.background) };
        if (node.type === 'mask') node = { ...node, matte: ref(node.matte) };
        if (node.type === 'displace') node = { ...node, map: ref(node.map) };
        if (node.type === 'channels')
          for (const channel of ['red', 'green', 'blue', 'alpha'] as const) {
            const value = node[channel];
            if (typeof value !== 'number') node[channel] = { ...value, input: ref(value.input) };
          }
        if (node.type === 'pass') {
          const effect = node.effect;
          if (
            effect.type === 'meshWarp' &&
            effect.points.length !== (effect.columns + 1) * (effect.rows + 1)
          )
            throw new VmotionError('WARP_GRID', 'Graph mesh point count is invalid', {
              nodeId: node.id,
            });
          if (effect.type === 'cornerPin') pinGrid(effect.corners);
          if (effect.type === 'levels' && effect.inputBlack >= effect.inputWhite)
            throw new VmotionError('LEVELS_RANGE', 'Graph input white must exceed black', {
              nodeId: node.id,
            });
          if (
            effect.type === 'lut3d' &&
            (effect.data.length !== effect.size ** 3 * 3 ||
              effect.domainMax.some((v, i) => v <= effect.domainMin[i]))
          )
            throw new VmotionError('LUT_FORMAT', 'Graph LUT data/domain mismatch', {
              nodeId: node.id,
            });
        }
        flat.push(node);
      }
      if (flat.length > 256)
        throw new VmotionError('EFFECT_GRAPH_LIMIT', 'Expanded graph exceeds 256 nodes');
    }
    const output =
      selectedOutput === undefined ? document.output : document.outputs?.[selectedOutput];
    if (!output)
      throw new VmotionError('EFFECT_GRAPH_OUTPUT', 'Selected named graph output is missing', {
        name: selectedOutput,
        available: Object.keys(document.outputs ?? {}),
      });
    return {
      output: ref(output),
      outputs: Object.fromEntries(
        Object.entries(document.outputs ?? {}).map(([name, id]) => [name, ref(id)]),
      ),
      params: parameters,
    };
  };
  const root = expand(graph, params, '', undefined, outputName),
    byId = new Map(flat.map((node) => [node.id, node])),
    reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const input of graphDependencies(byId.get(id)!)) walk(input);
  };
  walk(root.output);
  const nodes = (order({ nodes: flat, output: root.output }) as CompiledGraphNode[]).filter(
      (node) => reachable.has(node.id),
    ),
    uses = new Map<string, number>([[root.output, 1]]);
  for (const node of nodes)
    for (const input of graphDependencies(node)) uses.set(input, (uses.get(input) ?? 0) + 1);
  let live = 0,
    peakSurfaces = 0;
  for (const node of nodes) {
    live++;
    peakSurfaces = Math.max(peakSurfaces, live);
    for (const input of graphDependencies(node)) {
      const n = uses.get(input)! - 1;
      uses.set(input, n);
      if (n === 0) live--;
    }
  }
  return {
    name: graph.name,
    nodes,
    output: root.output,
    outputs: root.outputs,
    selectedOutput: outputName,
    inputs: [
      ...new Set(
        nodes
          .filter((node) => node.type === 'input')
          .map((node) => (node as Extract<CompiledGraphNode, { type: 'input' }>).slot),
      ),
    ],
    resources: [...resources],
    parameters: root.params,
    unused: flat.filter((node) => !reachable.has(node.id)).map((node) => node.id),
    peakSurfaces,
  };
}
export function resolveEffectGraph(snapshot: Snapshot, effect: GraphEffect) {
  if (!!effect.source === !!effect.graph)
    throw new VmotionError('EFFECT_GRAPH_SOURCE', 'Choose exactly one inline graph or source file');
  const graph = effect.graph ?? effectGraphResource(snapshot, effect.source!);
  return compileEffectGraph(
    graph,
    effect.params,
    (file) => effectGraphResource(snapshot, file),
    effect.output,
  );
}
