import { z } from 'zod';
import {
  ProjectReferences,
  referenceKey,
  type ReferenceEntity,
  type ProjectReference,
} from '../core/project-references.js';
import { VmotionError, type Snapshot } from '../core/model.js';
const kind = z.enum(['project', 'scene', 'sequence', 'asset', 'drawing', 'file']),
  entity = z.object({ kind, id: z.string().min(1).max(400) }).strict(),
  offset = z.number().int().nonnegative().default(0),
  limit = z.number().int().min(1).max(100).default(24);
export const projectReferencesSchema = z
  .object({
    revision: z.string().optional(),
    section: z.enum(['references', 'entities', 'reachable', 'uncertainties']).default('references'),
    entity: entity.optional(),
    direction: z.enum(['incoming', 'outgoing']).default('incoming'),
    kinds: z.array(kind).min(1).max(6).optional(),
    files: z.array(z.string().min(1)).min(1).max(100).optional(),
    includeHints: z.boolean().default(false),
    query: z.string().max(200).default(''),
    offset,
    limit,
    detail: z.boolean().default(false),
  })
  .strict();
export function summarizeReference(edge: ProjectReference, detail = false) {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    evidence: edge.evidence,
    replaceable: edge.replaceable,
    file: edge.file,
    ...(edge.sceneId ? { sceneId: edge.sceneId } : {}),
    ...(edge.nodeId ? { nodeId: edge.nodeId } : {}),
    ...(edge.sequenceId
      ? {
          sequenceId: edge.sequenceId,
          trackId: edge.trackId,
          clipId: edge.clipId,
          locked: edge.locked,
        }
      : {}),
    ...(detail
      ? {
          pointer:
            '/' + edge.pointer.map((p) => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/'),
          stablePath: edge.stablePath,
          line: edge.line,
          column: edge.column,
        }
      : {}),
  };
}
export function queryProjectReferences(
  indexer: ProjectReferences,
  snapshot: Snapshot,
  raw: unknown,
) {
  const p = projectReferencesSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project reference version changed');
  const index = indexer.resolve(snapshot),
    target = p.entity && referenceKey(p.entity);
  if (target && !index.entities.has(target))
    throw new VmotionError('REFERENCE_ENTITY', 'Requested reference entity is missing', {
      entity: p.entity,
    });
  if (p.section === 'reachable' && !target)
    throw new VmotionError('REFERENCE_ENTITY', 'Reachability requires an entity');
  const words = p.query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    matches = (text: string) => words.every((word) => text.toLowerCase().includes(word)),
    fileSet = p.files ? new Set(p.files) : undefined,
    direct = target
      ? ((p.direction === 'incoming' ? index.incoming : index.outgoing).get(target) ?? [])
      : index.references,
    references = direct.filter(
      (e) =>
        (p.includeHints || e.evidence === 'declared') &&
        (!fileSet || fileSet.has(e.file)) &&
        (!p.kinds || p.kinds.includes(e.to.kind)) &&
        matches([e.from.id, e.to.id, e.file, e.relation, e.nodeId ?? ''].join(' ')),
    );
  let rows: unknown[] = [],
    available = 0;
  if (p.section === 'references') {
    available = direct.length;
    rows = references;
  } else if (p.section === 'uncertainties') {
    available = index.uncertainties.length;
    rows = index.uncertainties.filter(
      (u) => (!fileSet || fileSet.has(u.file)) && matches(u.file + ' ' + u.reason),
    );
  } else if (p.section === 'entities') {
    available = index.entities.size;
    rows = [...index.entities.values()]
      .filter(
        (e) =>
          (!p.kinds || p.kinds.includes(e.kind)) &&
          (!fileSet || (!!e.file && fileSet.has(e.file))) &&
          (!target || referenceKey(e) === target) &&
          matches(e.id + ' ' + (e.name ?? '')),
      )
      .map((e) => ({
        ...e,
        ...(p.detail
          ? {
              incoming: (index.incoming.get(referenceKey(e)) ?? []).length,
              outgoing: (index.outgoing.get(referenceKey(e)) ?? []).length,
            }
          : {}),
      }));
  } else {
    const queue = [{ key: target!, depth: 0 }],
      seen = new Set([target!]);
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      for (const edge of (p.direction === 'incoming' ? index.incoming : index.outgoing).get(
        current.key,
      ) ?? []) {
        if (!p.includeHints && edge.evidence === 'literal') continue;
        const next = referenceKey(p.direction === 'incoming' ? edge.from : edge.to);
        if (seen.has(next)) continue;
        if (seen.size >= 10000)
          throw new VmotionError('REFERENCE_BUDGET', 'Reachability exceeds 10000 entities');
        seen.add(next);
        queue.push({ key: next, depth: current.depth + 1 });
      }
    }
    available = queue.length - 1;
    rows = queue
      .slice(1)
      .map((row) => ({ ...index.entities.get(row.key), depth: row.depth }))
      .filter(
        (e) =>
          (!p.kinds || p.kinds.includes(e.kind!)) &&
          (!fileSet || (!!e.file && fileSet.has(e.file))) &&
          matches(e.id ?? ''),
      );
  }
  const total = rows.length,
    items = rows.slice(p.offset, p.offset + p.limit);
  return {
    revision: snapshot.revision,
    section: p.section,
    entity: p.entity,
    direction: p.direction,
    summary: {
      entities: index.entities.size,
      references: index.references.length,
      declared: index.references.filter((e) => e.evidence === 'declared').length,
      hints: index.references.filter((e) => e.evidence === 'literal').length,
      uncertainties: index.uncertainties.length,
    },
    total,
    offset: p.offset,
    ...(p.offset + items.length < total ? { nextOffset: p.offset + items.length } : {}),
    coverage: {
      available,
      returned: items.length,
      omitted: total - items.length,
      filteredOut: available - total,
      staticOnly: true,
      runtimeComplete: false,
    },
    items:
      p.section === 'references'
        ? (items as ProjectReference[]).map((e) => summarizeReference(e, p.detail))
        : items,
    index: indexer.report(),
    limitations: [
      'Known JSON roles and static TypeScript imports/literals only. Dynamic code, arbitrary parameters/custom resource semantics and actual media availability require runtime/source inspection.',
      'Reachability counts declared references even when muted/invisible; registration does not prove an asset is used in a picture. This query never deletes sources or compiles code.',
    ],
  };
}
