import './compiler-runtime.js';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import ts from 'typescript';
import { hash, safePath } from '../platform/project-files.js';
import { VmotionError, type Snapshot, type Node, type Diagnostic } from './model.js';
import type { ComponentContext, Parameter } from '../sdk/index.js';
import {
  ParameterError,
  validateParameterDefinitions,
  resolveParameters,
  parameterJsonSchema,
} from './parameters.js';
import { evaluateNode } from './time.js';
import { PluginRegistry } from './plugins.js';
const canonical = (value: any): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

const moduleDirectory = path.dirname(
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? fileURLToPath(import.meta.url)
    : String(import.meta.url),
);
const sdkFile = existsSync(path.resolve(moduleDirectory, '../sdk/index.mjs'))
  ? path.resolve(moduleDirectory, '../sdk/index.mjs')
  : path.resolve(moduleDirectory, '../sdk/index.ts');
const nativeCanvasModule = createRequire(path.join(moduleDirectory, 'vmotion-require.cjs')).resolve(
  '@napi-rs/canvas',
);
const workerScript = `
const {parentPort}=require('node:worker_threads');
let component;
parentPort.on('message',async ({id,method,payload})=>{
  try {
    let result;
    if(method==='load') {
      const imported=await import(payload.url);
      component=imported.default?.render||imported.default?.tools?imported.default:imported.default?.default;
      if(payload.kind==='plugin') {
        if(!component?.tools)throw new Error('Plugin must export default definePlugin({...})');
        const tools={};
        for(const [name,tool] of Object.entries(component.tools)) {
          if(typeof tool.run!=='function')throw new Error('Plugin tool needs a synchronous run function');
          tools[name]=tool.parameters;
        }
        result={name:component.name,parameters:{},tools};
      } else {
        if(!component||typeof component.render!=='function')throw new Error('Component must export default defineComponent({...})');
        result={name:component.name,parameters:component.parameters};
      }
    } else if(method==='plugin') {
      const tool=component.tools[payload.toolId];
      if(!tool)throw new Error('Plugin tool implementation is missing');
      result=tool.run(payload.context,payload.params);
      if(result&&typeof result.then==='function')throw new Error('Plugin tools must return synchronously');
      if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw new Error('Plugin result exceeds 8MiB');
    } else {
      result=component.render(payload.context,payload.params);
      if(result&&typeof result.then==='function')throw new Error('Frame rendering must be synchronous and deterministic');
      if(!Array.isArray(result))throw new Error('Component render() must return nodes');
      if(result.length>10000)throw new Error('Component exceeds 10000 nodes');
    }
    parentPort.postMessage({id,result});
  }catch(e){parentPort.postMessage({id,error:{message:e.message,stack:e.stack,code:typeof e.code==='string'?e.code:undefined,path:e.path}});}
});`;
interface Loaded {
  failed?: boolean;
  worker: Worker;
  metadata: {
    name: string;
    parameters: Record<string, Parameter>;
    tools?: Record<string, Record<string, Parameter>>;
  };
  pending: Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >;
  counter: number;
}
export class ComponentHost {
  private modules = new Map<string, Promise<Loaded>>();
  private typeDiagnostics = new Map<
    string,
    { diagnostics: Diagnostic[]; probes: Map<string, string | null> }
  >();
  private moduleDependencies = new Map<
    string,
    Array<{ key: string; sdk: string; kind: string; probes: Map<string, string | null> }>
  >();
  private sdkSignatures = new Map<string, { stamp: string; hash: string }>();
  readonly stats = {
    compiles: 0,
    moduleHits: 0,
    typechecks: 0,
    typecheckHits: 0,
    renderCalls: 0,
    pluginCalls: 0,
  };
  private sdkIdentity(file: string) {
    const info = statSync(file),
      stamp = `${info.size}:${info.mtimeMs}`,
      old = this.sdkSignatures.get(file);
    if (old?.stamp === stamp) return old.hash;
    const value = hash(readFileSync(file));
    this.sdkSignatures.set(file, { stamp, hash: value });
    return value;
  }
  private matches(snapshot: Snapshot, probes: Map<string, string | null>) {
    for (const [name, value] of probes)
      if (
        (name.startsWith('@dir:')
          ? Object.keys(snapshot.files).some((file) => file.startsWith(name.slice(5) + '/'))
            ? 'present'
            : null
          : (snapshot.files[name] ?? null)) !== value
      )
        return false;
    return true;
  }
  diagnostics() {
    return {
      ...this.stats,
      activeModules: this.modules.size,
      dependencyEntries: [...this.moduleDependencies.values()].reduce(
        (n, list) => n + list.length,
        0,
      ),
    };
  }
  constructor(private root: string) {}
  private request(loaded: Loaded, method: string, payload: unknown) {
    return new Promise<any>((resolve, reject) => {
      const id = ++loaded.counter;
      const timer = setTimeout(() => {
        loaded.failed = true;
        loaded.pending.delete(id);
        void loaded.worker.terminate();
        reject(new VmotionError('COMPONENT_TIMEOUT', 'Component execution exceeded 5 seconds'));
      }, 5000);
      loaded.pending.set(id, { resolve, reject, timer });
      loaded.worker.postMessage({ id, method, payload });
    });
  }
  private async load(snapshot: Snapshot, source: string, kind = 'component'): Promise<Loaded> {
    safePath(this.root, source);
    if (!snapshot.files[source])
      throw new VmotionError('MISSING_COMPONENT', `Component not found: ${source}`);
    const bundledSdk = process.env.VMOTION_SDK_SOURCE ?? sdkFile,
      sdk = this.sdkIdentity(bundledSdk);
    for (const dependency of this.moduleDependencies.get(source) ?? [])
      if (
        dependency.kind === kind &&
        dependency.sdk === sdk &&
        this.matches(snapshot, dependency.probes)
      ) {
        const cached = this.modules.get(dependency.key);
        if (cached) {
          const loaded = await cached;
          if (loaded.failed) {
            if (this.modules.get(dependency.key) === cached) this.modules.delete(dependency.key);
            continue;
          }
          this.stats.moduleHits++;
          this.modules.delete(dependency.key);
          this.modules.set(dependency.key, cached);
          return loaded;
        }
      }
    const key = hash(
      source +
        kind +
        sdk +
        Object.entries(snapshot.files)
          .filter(([n]) => n.startsWith('components/'))
          .sort()
          .map(([n, t]) => n + t)
          .join(''),
    );
    if (this.modules.has(key)) {
      const cached = this.modules.get(key)!,
        loaded = await cached;
      if (!loaded.failed) {
        this.stats.moduleHits++;
        return loaded;
      }
      if (this.modules.get(key) !== cached) return this.load(snapshot, source, kind);
      this.modules.delete(key);
    }
    const promise = (async () => {
      this.stats.compiles++;
      const probes = new Map<string, string | null>(),
        remember = (relative: string) => {
          if (!relative.startsWith('../') && !path.isAbsolute(relative))
            probes.set(relative, snapshot.files[relative] ?? null);
        };
      const dir = safePath(this.root, '.vmotion/compiled');
      await mkdir(dir, { recursive: true });
      const output = path.join(dir, `${key}.cjs`);
      const projectRoot = this.root;
      try {
        await build({
          entryPoints: [safePath(this.root, source)],
          outfile: output,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node22',
          sourcemap: 'inline',
          logLevel: 'silent',
          nodePaths: [path.resolve('node_modules')],
          plugins: [
            {
              name: 'project-snapshot',
              setup(b) {
                b.onResolve({ filter: /^@vmotion\/sdk$/ }, () => ({ path: bundledSdk }));
                b.onResolve({ filter: /^@napi-rs\/canvas$/ }, () => ({
                  path: nativeCanvasModule,
                  external: true,
                }));
                b.onResolve({ filter: /.*/ }, (args) => {
                  if (args.kind !== 'entry-point' && !args.path.startsWith('.')) return undefined;
                  const base =
                    args.kind === 'entry-point'
                      ? path.resolve(args.path)
                      : path.resolve(args.resolveDir || path.dirname(args.importer), args.path);
                  for (const candidate of [
                    base,
                    base + '.ts',
                    base + '.tsx',
                    base + '.json',
                    path.join(base, 'index.ts'),
                  ]) {
                    const relative = path
                      .relative(projectRoot, candidate)
                      .split(path.sep)
                      .join('/');
                    remember(relative);
                    if (snapshot.files[relative] !== undefined)
                      return { path: candidate, namespace: 'project-source' };
                  }
                  const relative = path.relative(projectRoot, base).split(path.sep).join('/');
                  if (relative.startsWith('components/'))
                    return {
                      errors: [
                        {
                          text: `Component source is absent from this project version: ${relative}`,
                        },
                      ],
                    };
                  return undefined;
                });
                b.onLoad({ filter: /\.(ts|tsx|json)$/ }, async (args) => {
                  const relative = path.relative(projectRoot, args.path).split(path.sep).join('/');
                  if (snapshot.files[relative] !== undefined) remember(relative);
                  if (snapshot.files[relative] !== undefined)
                    return {
                      contents: snapshot.files[relative],
                      loader: args.path.endsWith('.json')
                        ? 'json'
                        : args.path.endsWith('.tsx')
                          ? 'tsx'
                          : 'ts',
                      resolveDir: path.dirname(args.path),
                    };
                  return undefined;
                });
              },
            },
          ],
        });
      } catch (e) {
        const message = (
          e as { errors?: Array<{ text: string; location?: { file: string; line: number } }> }
        ).errors?.[0];
        throw new VmotionError('COMPONENT_COMPILE', message?.text ?? (e as Error).message, {
          file: message?.location?.file ?? source,
          line: message?.location?.line,
        });
      }
      const worker = new Worker(workerScript, {
          eval: true,
          stdout: true,
          stderr: true,
          execArgv: ['--enable-source-maps'],
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        }),
        loaded: Loaded = {
          worker,
          pending: new Map(),
          counter: 0,
          metadata: { name: source, parameters: {} },
        };
      worker.stdout?.on('data', () => {});
      worker.stderr?.on('data', () => {});
      worker.on('message', ({ id, result, error }) => {
        const request = loaded.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        loaded.pending.delete(id);
        if (error)
          request.reject(
            new VmotionError(
              error.code ?? (kind === 'plugin' ? 'PLUGIN_RUNTIME' : 'COMPONENT_RUNTIME'),
              error.message,
              {
                file: source,
                stack: error.stack,
                path: error.path,
              },
            ),
          );
        else request.resolve(result);
      });
      const fail = (error: Error) => {
        loaded.failed = true;
        for (const pending of loaded.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        loaded.pending.clear();
        if (this.modules.get(key) === promise) this.modules.delete(key);
      };
      worker.on('error', fail);
      worker.on('exit', (code) => {
        fail(new VmotionError('COMPONENT_EXIT', `Component worker exited (${code})`));
      });
      loaded.metadata = await this.request(loaded, 'load', {
        url: pathToFileURL(output).href,
        kind,
      });
      try {
        validateParameterDefinitions(loaded.metadata.parameters ?? {});
        for (const parameters of Object.values(loaded.metadata.tools ?? {}))
          validateParameterDefinitions(parameters);
      } catch (e) {
        await worker.terminate();
        if (e instanceof ParameterError)
          throw new VmotionError(e.code, e.message, { file: source, path: e.path });
        throw e;
      }
      const records = (this.moduleDependencies.get(source) ?? []).filter(
        (record) => this.modules.has(record.key) && record.key !== key,
      );
      records.push({ key, sdk, probes, kind });
      this.moduleDependencies.set(source, records.slice(-12));
      return loaded;
    })();
    this.modules.set(key, promise);
    try {
      const loaded = await promise;
      if (this.modules.size > 12) {
        const first = this.modules.keys().next().value!;
        const old = this.modules.get(first)!;
        this.modules.delete(first);
        for (const [source, records] of this.moduleDependencies) {
          const live = records.filter((record) => this.modules.has(record.key));
          if (live.length) this.moduleDependencies.set(source, live);
          else this.moduleDependencies.delete(source);
        }
        void old.then((v) => v.worker.terminate()).catch(() => {});
      }
      return loaded;
    } catch (e) {
      this.modules.delete(key);
      throw e;
    }
  }
  async describe(snapshot: Snapshot, source: string, options: { schema?: boolean } = {}) {
    const metadata = (await this.load(snapshot, source)).metadata,
      parameters = metadata.parameters ?? {};
    return {
      ...metadata,
      parameters,
      defaults: resolveParameters(parameters, {}),
      jsonSchema:
        options.schema === false
          ? undefined
          : {
              type: 'object',
              properties: Object.fromEntries(
                Object.entries(parameters).map(([key, spec]) => [key, parameterJsonSchema(spec)]),
              ),
              additionalProperties: false,
            },
    };
  }
  async describePlugin(snapshot: Snapshot, source: string) {
    return (await this.load(snapshot, source, 'plugin')).metadata.tools ?? {};
  }
  async callPlugin(
    snapshot: Snapshot,
    source: string,
    toolId: string,
    context: unknown,
    params: Record<string, unknown>,
  ) {
    const loaded = await this.load(snapshot, source, 'plugin'),
      parameters = loaded.metadata.tools?.[toolId];
    if (!parameters)
      throw new VmotionError('PLUGIN_TOOL', 'Plugin tool implementation is missing', {
        file: source,
        toolId,
      });
    this.stats.pluginCalls++;
    return this.request(loaded, 'plugin', {
      toolId,
      context,
      params: resolveParameters(parameters, params),
    });
  }
  async sourceDependencies(snapshot: Snapshot, source: string) {
    await this.load(snapshot, source);
    const record = (this.moduleDependencies.get(source) ?? []).find((r) =>
      this.matches(snapshot, r.probes),
    );
    return [...(record?.probes.keys() ?? [])].filter((f) => snapshot.files[f] !== undefined);
  }
  async render(snapshot: Snapshot, node: Node, context: ComponentContext) {
    this.stats.renderCalls++;
    const loaded = await this.load(snapshot, node.component!);
    let params: Record<string, unknown>;
    try {
      params = resolveParameters(loaded.metadata.parameters ?? {}, node.params);
    } catch (e) {
      if (e instanceof ParameterError)
        throw new VmotionError(e.code, e.message, {
          file: node.component,
          path: e.path,
          nodeId: node.id,
        });
      throw e;
    }
    return this.request(loaded, 'render', { context, params }) as Promise<Partial<Node>[]>;
  }
  async validate(snapshot: Snapshot) {
    for (const entry of new PluginRegistry()
      .resolve(snapshot)
      .filter((e) => e.enabled && e.manifest.tools.length)) {
      const exported = await this.describePlugin(snapshot, entry.manifest.entry!);
      for (const tool of entry.manifest.tools)
        if (!exported[tool.id] || canonical(exported[tool.id]) !== canonical(tool.parameters))
          throw new VmotionError(
            'PLUGIN_PARAMETERS',
            'Manifest parameter schema differs from exported tool',
            { file: entry.manifest.entry, toolId: tool.id },
          );
    }
    for (const source of new Set(
      snapshot.scenes.flatMap((s) =>
        s.nodes.filter((n) => n.type === 'component').map((n) => n.component!),
      ),
    ))
      await this.describe(snapshot, source);
    for (const scene of snapshot.scenes)
      for (const node of scene.nodes.filter((n) => n.type === 'component')) {
        const metadata = await this.describe(snapshot, node.component!);
        for (const frame of new Set([
          0,
          ...node.animations.flatMap((a) =>
            a.property.startsWith('params.') ? a.keys.map((k) => k.frame) : [],
          ),
        ])) {
          try {
            resolveParameters(metadata.parameters, evaluateNode(node, frame).params);
          } catch (e) {
            if (e instanceof ParameterError)
              throw new VmotionError(e.code, e.message, {
                file: node.component,
                path: e.path,
                nodeId: node.id,
                frame,
              });
            throw e;
          }
        }
      }
  }
  typecheck(snapshot: Snapshot): Diagnostic[] {
    const files = Object.entries(snapshot.files)
      .filter(([name]) => /\.(ts|tsx)$/.test(name))
      .sort(([a], [b]) => a.localeCompare(b, 'en'));
    if (!files.length) return [];
    const key = hash(files.map(([name, text]) => name + text).join(''));
    const cached = this.typeDiagnostics.get(key);
    if (cached && this.matches(snapshot, cached.probes)) {
      this.stats.typecheckHits++;
      return cached.diagnostics;
    }
    this.stats.typechecks++;
    const probes = new Map<string, string | null>(),
      remember = (name: string) => {
        if (!name.startsWith('../') && !path.isAbsolute(name))
          probes.set(name, snapshot.files[name] ?? null);
      };
    const declaration = path.resolve(moduleDirectory, '../types/sdk/index.d.ts'),
      sdk = existsSync(declaration) ? declaration : sdkFile;
    const installRoot = path.resolve(moduleDirectory, '../..');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      baseUrl: this.root,
      paths: { '@vmotion/sdk': [sdk] },
      types: ['node'],
      typeRoots: [
        path.join(installRoot, 'node_modules/@types'),
        path.join(this.root, 'node_modules/@types'),
      ],
    };
    const host = ts.createCompilerHost(options),
      read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host),
      directoryExists = host.directoryExists?.bind(host);
    host.fileExists = (file) => {
      const name = path.relative(this.root, file).split(path.sep).join('/');
      remember(name);
      return (
        snapshot.files[name] !== undefined ||
        (name.startsWith('components/') ? false : exists(file))
      );
    };
    host.directoryExists = (directory) => {
      const relative = path.relative(this.root, directory).split(path.sep).join('/');
      if (!relative.startsWith('../') && !path.isAbsolute(relative))
        probes.set(
          '@dir:' + relative,
          Object.keys(snapshot.files).some((name) => name.startsWith(relative + '/'))
            ? 'present'
            : null,
        );
      return (
        Object.keys(snapshot.files).some((name) => name.startsWith(relative + '/')) ||
        (directoryExists?.(directory) ?? false)
      );
    };
    host.readFile = (file) => {
      const name = path.relative(this.root, file).split(path.sep).join('/');
      remember(name);
      return snapshot.files[name] ?? (name.startsWith('components/') ? undefined : read(file));
    };
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      const name = path.relative(this.root, file).split(path.sep).join('/');
      if (snapshot.files[name] !== undefined) {
        remember(name);
        return ts.createSourceFile(file, snapshot.files[name], languageVersion, true);
      }
      if (name.startsWith('components/')) {
        remember(name);
        return undefined;
      }
      return originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    };
    const program = ts.createProgram(
      files.map(([name]) => safePath(this.root, name)),
      options,
      host,
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => ({
        severity: 'error' as const,
        code: `TS${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        file: d.file?.fileName,
        line:
          d.file && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
            : undefined,
        column:
          d.file && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start).character + 1
            : undefined,
      }));
    this.typeDiagnostics.set(key, { diagnostics, probes });
    if (this.typeDiagnostics.size > 8)
      this.typeDiagnostics.delete(this.typeDiagnostics.keys().next().value!);
    return diagnostics;
  }
  async close() {
    for (const module of this.modules.values())
      try {
        await (await module).worker.terminate();
      } catch {}
    this.modules.clear();
    this.moduleDependencies.clear();
    this.typeDiagnostics.clear();
    this.sdkSignatures.clear();
  }
}
