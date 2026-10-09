import { createHash } from 'node:crypto';
import { VmotionError, type Snapshot } from '../model.js';
import { GeometryCache } from '../geometry-cache.js';
import { builtinDemoGlyphSet } from './builtin-demo.js';
import { GlyphComposer } from './compose.js';
import {
  glyphSetFile,
  glyphSetFilePattern,
  glyphSetSchema,
  type GlyphSetDocument,
} from './glyph-schema.js';

export const builtinGlyphSets: Record<string, () => GlyphSetDocument> = {
  demo: () => glyphSetSchema.parse(builtinDemoGlyphSet()),
};
const builtinCache = new Map<string, GlyphSetDocument>();
export function builtinGlyphSet(id: string) {
  const factory = builtinGlyphSets[id];
  if (!factory) return undefined;
  let doc = builtinCache.get(id);
  if (!doc) {
    doc = Object.freeze(factory());
    builtinCache.set(id, doc);
  }
  return doc;
}
export const builtinGlyphSetIds = Object.keys(builtinGlyphSets);

export type PreparedGlyphSet = {
  ref: string;
  document: GlyphSetDocument;
  composer: GlyphComposer;
  file?: string;
  builtin: boolean;
  /** Source files read (for cache invalidation). */
  probes: Map<string, string>;
  hash: string;
};

/** Project glyph sets visible in a snapshot, by ID. */
export function glyphSetFiles(snapshot: Pick<Snapshot, 'files'>) {
  const out = new Map<string, string>();
  for (const file of Object.keys(snapshot.files)) {
    const match = glyphSetFilePattern.exec(file);
    if (match) out.set(match[1], file);
  }
  return out;
}

function mergeSets(base: GlyphSetDocument, child: GlyphSetDocument): GlyphSetDocument {
  return {
    ...child,
    metrics: { ...base.metrics, ...child.metrics },
    style: { ...base.style, ...child.style },
    operators: { ...base.operators, ...child.operators },
    components: { ...base.components, ...child.components },
    glyphs: { ...base.glyphs, ...child.glyphs },
    kerning: { ...base.kerning, ...child.kerning },
  };
}

function mergeRaw(base: GlyphSetDocument, child: Record<string, any>): Record<string, unknown> {
  const pick = (key: keyof GlyphSetDocument) => ({
    ...(base[key] as object),
    ...((child[key] as object | undefined) ?? {}),
  });
  return {
    ...child,
    metrics: pick('metrics'),
    style: pick('style'),
    operators: pick('operators'),
    components: pick('components'),
    glyphs: pick('glyphs'),
    kerning: pick('kerning'),
  };
}

export class GlyphSetResolver {
  private readonly cache: GeometryCache<PreparedGlyphSet>;
  private stats = { resolutions: 0, compositions: 0 };
  constructor(budget = 4 * 1024 * 1024) {
    this.cache = new GeometryCache(budget, 64);
  }
  report() {
    return { ...this.stats, cache: this.cache.report() };
  }
  clear() {
    this.cache.clear();
  }
  /** Resolve "<id>" (project) or "builtin:<id>"; project sets shadow nothing. */
  resolve(snapshot: Pick<Snapshot, 'files'>, ref: string): PreparedGlyphSet {
    const cached = this.cache.get(ref);
    if (cached && [...cached.probes].every(([p, s]) => snapshot.files[p] === s)) return cached;
    this.stats.resolutions++;
    const probes = new Map<string, string>(),
      stack: string[] = [],
      load = (target: string): GlyphSetDocument => {
        if (stack.includes(target) || stack.length >= 8)
          throw new VmotionError('GLYPH_CYCLE', 'Glyph set inheritance has a cycle or exceeds depth 8', {
            sets: [...stack, target],
          });
        stack.push(target);
        let document: GlyphSetDocument;
        if (target.startsWith('builtin:')) {
          const builtin = builtinGlyphSet(target.slice(8));
          if (!builtin)
            throw new VmotionError('GLYPH_SET', `Built-in glyph set "${target}" does not exist`, {
              available: builtinGlyphSetIds,
            });
          document = builtin;
        } else {
          const file = glyphSetFile(target),
            source = snapshot.files[file];
          if (source === undefined && builtinGlyphSet(target) && stack.length === 1) {
            // A plain ID without a project file resolves the built-in set of that name.
            const resolved = builtinGlyphSet(target)!;
            stack.pop();
            return resolved;
          }
          if (source === undefined)
            throw new VmotionError('GLYPH_SET', `Glyph set resource is missing: ${file}`, { file });
          probes.set(file, source);
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(source);
            document = glyphSetSchema.parse(raw);
          } catch (e) {
            throw new VmotionError('GLYPH_DOCUMENT', `Invalid glyph set: ${(e as Error).message}`, {
              file,
            });
          }
          if (document.id !== target)
            throw new VmotionError('GLYPH_DOCUMENT', 'Glyph set ID must match its filename', { file });
          // Inherit: only fields the child file states override the parent (no schema defaults).
          if (document.extends) {
            const merged = glyphSetSchema.parse(mergeRaw(load(document.extends), raw));
            stack.pop();
            return merged;
          }
        }
        const resolved = document.extends ? mergeSets(load(document.extends), document) : document;
        stack.pop();
        return resolved;
      };
    const document = load(ref),
      builtin = ref.startsWith('builtin:') || snapshot.files[glyphSetFile(ref)] === undefined,
      prepared: PreparedGlyphSet = {
        ref,
        document,
        composer: new GlyphComposer(document),
        file: builtin ? undefined : glyphSetFile(ref),
        builtin,
        probes,
        hash: createHash('sha256')
          .update(JSON.stringify([ref, document]))
          .digest('hex')
          .slice(0, 16),
      };
    if (this.cache.budgetBytes)
      this.cache.put(
        ref,
        prepared,
        Object.keys(document.components).length * 512 + Object.keys(document.glyphs).length * 64 + 4096,
      );
    return prepared;
  }
  /** Resolve without throwing (rendering falls back to the font instead of failing). */
  tryResolve(snapshot: Pick<Snapshot, 'files'>, ref: string) {
    try {
      return this.resolve(snapshot, ref);
    } catch {
      return undefined;
    }
  }
  list(snapshot: Pick<Snapshot, 'files'>) {
    const refs = [
      ...builtinGlyphSetIds.map((id) => `builtin:${id}`),
      ...[...glyphSetFiles(snapshot).keys()],
    ];
    return refs.map((ref) => {
      try {
        const prepared = this.resolve(snapshot, ref);
        return {
          id: ref,
          name: prepared.document.name,
          builtin: prepared.builtin,
          file: prepared.file,
          components: Object.keys(prepared.document.components).length,
          glyphs: Object.keys(prepared.document.glyphs).length,
          metrics: prepared.document.metrics,
          style: prepared.document.style,
          hash: prepared.hash,
          ...(prepared.document.extends ? { extends: prepared.document.extends } : {}),
          ...(prepared.document.description ? { description: prepared.document.description } : {}),
        };
      } catch (e) {
        return { id: ref, builtin: ref.startsWith('builtin:'), error: (e as Error).message };
      }
    });
  }
}

/** One shared resolver for SDK/measurement paths that have no renderer. */
export const sharedGlyphSets = new GlyphSetResolver();
