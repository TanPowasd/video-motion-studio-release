import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GeometryCache } from './geometry-cache.js';
import type { Node } from './model.js';
export class AnimationPrograms {
  private refs = new WeakMap<object, number>();
  private counter = 0;
  private cache: GeometryCache<{
    key: string;
    program: ReturnType<AnimationPrograms['definition']>;
  }>;
  private stats = { hashes: 0, reused: 0, invalidations: 0 };
  constructor(enabled = true) {
    this.cache = new GeometryCache(enabled ? 8 * 1024 * 1024 : 0, 128);
  }
  private ref(value: object | undefined) {
    if (!value) return 0;
    let id = this.refs.get(value);
    if (id === undefined) {
      id = ++this.counter;
      this.refs.set(value, id);
    }
    return id;
  }
  definition(node: Node) {
    return {
      animations: node.animations,
      layers: (node.animationLayers ?? []).map((layer) => ({
        id: layer.id,
        channels: layer.channels,
      })),
    };
  }
  resolve(node: Node) {
    const program = this.definition(node),
      id = this.ref(node.animations) + ':' + this.ref(node.animationLayers),
      old = this.cache.get(id);
    if (old && isDeepStrictEqual(old.program, program)) {
      this.stats.reused++;
      return old;
    }
    if (old) this.stats.invalidations++;
    const text = JSON.stringify(program),
      key = createHash('sha256').update(text).digest('hex');
    this.stats.hashes++;
    const entry = { key, program: structuredClone(program) };
    this.cache.put(id, entry, text.length * 2 + 128);
    return entry;
  }
  report() {
    return {
      ...this.stats,
      ...this.cache.report(),
      accounting:
        'Retained definition copies estimated from serialized JS data; weak identity probes never skip content equality',
    };
  }
  clear() {
    this.cache.clear();
  }
}
