import { createHash } from 'node:crypto';
import { nodeSchema, VmotionError, type Node, type Snapshot } from './model.js';
import { templateDocumentSchema, type TemplateDocument } from './template-schema.js';
import { templateFileSchema } from './template-instance-schema.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  parameterJsonSchema,
  type ParameterDefinitions,
  ParameterError,
} from './parameters.js';
import { themePathValue, themeSetPath } from './theme.js';
import { GeometryCache } from './geometry-cache.js';
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
type Entry = {
  document: TemplateDocument;
  hash: string;
  probes: Map<string, string>;
  defaults: Record<string, unknown>;
  changedFiles: string[];
};
export class TemplateResolver {
  private readonly cache: GeometryCache<Entry>;
  private stats = { prepares: 0, portWrites: 0 };
  constructor(budget = 8 * 1024 * 1024) {
    this.cache = new GeometryCache(budget, 128);
  }
  clear() {
    this.cache.clear();
  }
  report() {
    return { ...this.stats, cache: this.cache.report() };
  }
  resolve(snapshot: Snapshot, source: string): Entry {
    templateFileSchema.parse(source);
    const old = this.cache.get(source);
    if (old && [...old.probes].every(([f, s]) => snapshot.files[f] === s)) return old;
    const text = snapshot.files[source];
    if (text === undefined)
      throw new VmotionError('TEMPLATE_SOURCE', 'Template manifest is missing', { file: source });
    let document: TemplateDocument;
    try {
      document = templateDocumentSchema.parse(JSON.parse(text));
      validateParameterDefinitions(document.parameters as ParameterDefinitions);
    } catch (e) {
      throw new VmotionError(
        'TEMPLATE_DOCUMENT',
        `Invalid template manifest: ${(e as Error).message}`,
        { file: source },
      );
    }
    const scene = snapshot.scenes.find((s) => s.id === document.sceneId);
    if (!scene)
      throw new VmotionError('TEMPLATE_SCENE', 'Template source scene is missing', {
        file: source,
        sceneId: document.sceneId,
      });
    const sceneFile = snapshot.project.scenes[snapshot.scenes.indexOf(scene)],
      probes = new Map([
        [source, text],
        [sceneFile, snapshot.files[sceneFile]],
      ]);
    for (const file of Object.keys(document.files)) {
      if (snapshot.files[file] === undefined)
        throw new VmotionError('TEMPLATE_SOURCE', 'A captured template dependency is missing', {
          file,
        });
      probes.set(file, snapshot.files[file]);
    }
    const entry = {
      document,
      hash: digest(text),
      probes,
      defaults: resolveParameters(document.parameters as ParameterDefinitions, {}),
      changedFiles: Object.entries(document.files)
        .filter(([file, hash]) => digest(snapshot.files[file]) !== hash)
        .map(([file]) => file),
    };
    this.stats.prepares++;
    this.cache.put(
      source,
      entry,
      [...probes.values()].reduce((n, s) => n + (s?.length ?? 0) * 2, 0),
    );
    return entry;
  }
  metadata(snapshot: Snapshot, node: Node, options: { schema?: boolean } = {}) {
    if (node.type !== 'scene' || !node.templateInstance)
      throw new VmotionError('TEMPLATE_TYPE', 'Template instance must be a scene layer');
    const entry = this.resolve(snapshot, node.templateInstance.source),
      { document: d } = entry;
    if (node.sceneId !== d.sceneId)
      throw new VmotionError(
        'TEMPLATE_SCENE',
        'Instance scene differs from its template manifest',
        { nodeId: node.id },
      );
    if (node.templateInstance.mode === 'linked') {
      if (entry.hash !== node.templateInstance.hash)
        throw new VmotionError(
          'TEMPLATE_VERSION_CHANGED',
          'Published manifest changed; publish and select a new version',
          { file: node.templateInstance.source, nodeId: node.id },
        );
      if (d.fps.num !== snapshot.project.fps.num || d.fps.den !== snapshot.project.fps.den)
        throw new VmotionError(
          'TEMPLATE_FPS',
          'Template FPS differs; explicitly migrate/detach before changing the project timebase',
        );
      if (entry.changedFiles.length)
        throw new VmotionError(
          'TEMPLATE_VERSION_CHANGED',
          'Published dependency changed; edit the author source and publish a new version',
          { file: entry.changedFiles[0], nodeId: node.id },
        );
    }
    const parameters = d.parameters as ParameterDefinitions;
    return {
      name: d.name,
      parameters,
      defaults: entry.defaults,
      template: d,
      hash: entry.hash,
      jsonSchema:
        options.schema === false
          ? undefined
          : {
              type: 'object',
              properties: Object.fromEntries(
                Object.entries(parameters).map(([key, s]) => [key, parameterJsonSchema(s)]),
              ),
              additionalProperties: false,
            },
    };
  }
  apply(snapshot: Snapshot, node: Node, nodes: Node[]) {
    if (!node.templateInstance) return nodes;
    const meta = this.metadata(snapshot, node, { schema: false });
    let params: Record<string, unknown>;
    try {
      params = resolveParameters(meta.parameters, node.params);
    } catch (e) {
      if (e instanceof ParameterError)
        throw new VmotionError(e.code, e.message, {
          file: node.templateInstance.source,
          path: e.path,
          nodeId: node.id,
        });
      throw e;
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const addressed = new Map<string, string[]>();
    for (const p of meta.template.ports) {
      const old = addressed.get(p.nodeId) ?? [];
      if (
        old.some(
          (field) =>
            field === p.property ||
            field.startsWith(p.property + '.') ||
            p.property.startsWith(field + '.'),
        )
      )
        throw new VmotionError(
          'TEMPLATE_PORT',
          'Port targets must not overlap; combine parameter logic in author code',
          { nodeId: p.nodeId, property: p.property },
        );
      old.push(p.property);
      addressed.set(p.nodeId, old);
    }
    for (const port of meta.template.ports) {
      const target = byId.get(port.nodeId);
      if (!target)
        throw new VmotionError('TEMPLATE_PORT', 'Port target layer is missing', {
          nodeId: port.nodeId,
        });
      const value = themePathValue(params, port.parameter);
      let changed = themeSetPath(target, port.property, value);
      if (changed.theme) {
        const removed = Object.keys(changed.theme.links).filter(
          (p) => p === port.property || p.startsWith(port.property + '.'),
        );
        if (removed.length)
          changed = {
            ...changed,
            theme: {
              ...changed.theme,
              links: Object.fromEntries(
                Object.entries(changed.theme.links).filter(([p]) => !removed.includes(p)),
              ),
              baseline: Object.fromEntries(
                Object.entries(changed.theme.baseline).filter(([p]) => !removed.includes(p)),
              ),
              overrides: Object.fromEntries(
                Object.entries(changed.theme.overrides).filter(([p]) => !removed.includes(p)),
              ),
            },
          };
      }
      try {
        const root = port.property.split('.')[0],
          schema = nodeSchema.shape[root as keyof typeof nodeSchema.shape];
        byId.set(target.id, { ...changed, [root]: schema.parse((changed as any)[root]) });
      } catch (e) {
        throw new VmotionError(
          'TEMPLATE_PORT',
          `Port value does not fit the target: ${(e as Error).message}`,
          { nodeId: port.nodeId, property: port.property, parameter: port.parameter },
        );
      }
      this.stats.portWrites++;
    }
    return nodes.map((n) => byId.get(n.id)!);
  }
}
