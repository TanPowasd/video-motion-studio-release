import { z } from 'zod';
import {
  ProjectReferences,
  referenceKey,
  type ReferenceEntity,
  type ProjectReference,
} from '../core/project-references.js';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { applyOperations } from './operations.js';
import { hash, validateSnapshot } from './project.js';
import { inspectMedia, type AssetCheck } from './media-evidence.js';
import { clipContentDuration } from '../core/clip-window.js';
import { summarizeReference } from './project-references.js';
const entity = z
  .object({
    kind: z.enum(['scene', 'sequence', 'asset', 'drawing', 'file']),
    id: z.string().min(1).max(400),
  })
  .strict();
export const referencePlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    items: z
      .array(
        z
          .object({
            from: entity,
            to: entity,
            referenceIds: z
              .array(z.string().regex(/^[a-f0-9]{32}$/))
              .min(1)
              .max(1000)
              .optional(),
            files: z.array(z.string().min(1)).min(1).max(100).optional(),
            expectedUses: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    samples: z
      .array(
        z
          .object({
            sceneId: z.string().optional(),
            sequenceId: z.string().optional(),
            frame: z.number().finite().nonnegative(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: z.array(z.number().finite().nonnegative()).max(32).default([]),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
export async function planReferences(
  root: string,
  indexer: ProjectReferences,
  snapshot: Snapshot,
  raw: unknown,
) {
  const p = referencePlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before reference replacement');
  const index = indexer.resolve(snapshot),
    documents = new Map<string, any>(),
    changes: Array<{ reference: ProjectReference; to: ReferenceEntity }> = [],
    touched = new Set<string>(),
    assetChecks: AssetCheck[] = [],
    checkedAssets = new Map<string, Awaited<ReturnType<typeof inspectMedia>>>();
  const document = (file: string) => {
    let doc = documents.get(file);
    if (!doc) {
      doc = JSON.parse(snapshot.files[file]);
      documents.set(file, doc);
    }
    return doc;
  };
  for (const item of p.items) {
    if (item.from.kind !== item.to.kind)
      throw new VmotionError('REFERENCE_KIND', 'Replacement preserves the source category');
    if (referenceKey(item.from) === referenceKey(item.to))
      throw new VmotionError('REFERENCE_SAME', 'Choose a different replacement');
    const target = index.entities.get(referenceKey(item.to));
    if (!target || target.availability === 'missing-reference')
      throw new VmotionError('REFERENCE_ENTITY', 'Replacement is not registered/tracked', {
        entity: item.to,
      });
    const all = index.incoming.get(referenceKey(item.from)) ?? [],
      tracked = item.to.kind !== 'file' || Object.hasOwn(snapshot.files, item.to.id),
      selected = all.filter(
        (e) =>
          e.replaceable &&
          e.evidence === 'declared' &&
          (!item.files || item.files.includes(e.file)) &&
          (!item.referenceIds || item.referenceIds.includes(e.id)),
      );
    if (!tracked)
      throw new VmotionError(
        'REFERENCE_ENTITY',
        'Resource replacements need tracked project source; use media_relink_plan for external file paths',
      );
    if (item.referenceIds)
      for (const id of item.referenceIds)
        if (!selected.some((e) => e.id === id))
          throw new VmotionError(
            'REFERENCE_SELECTION',
            'Selected reference is stale, unsupported or outside requested files',
            { id },
          );
    if (!selected.length)
      throw new VmotionError('REFERENCE_SELECTION', 'No replaceable declared uses were selected', {
        from: item.from,
        hints: all.filter((e) => e.evidence === 'literal').length,
      });
    if (item.expectedUses !== undefined && item.expectedUses !== selected.length)
      throw new VmotionError('REFERENCE_COUNT', 'Declared use count differs from inspected count', {
        expected: item.expectedUses,
        actual: selected.length,
      });
    if (item.from.kind === 'asset') {
      const old = snapshot.project.assets.find((a) => a.id === item.from.id),
        next = snapshot.project.assets.find((a) => a.id === item.to.id);
      if (!old || !next || old.type !== next.type)
        throw new VmotionError(
          'REFERENCE_MEDIA_TYPE',
          'Asset replacement retains the registered media type',
        );
      let media = checkedAssets.get(next.id);
      if (!media) {
        media = await inspectMedia(root, snapshot, { assetId: next.id });
        checkedAssets.set(next.id, media);
        assetChecks.push(...('assetChecks' in media ? media.assetChecks! : [media.assetCheck]));
      }
      const manifest = document('project.vmotion.json'),
        entry = manifest.assets.find((a: any) => a.id === next.id);
      entry.metadata = { ...entry.metadata, ...media.metadata };
      entry.fingerprint = media.fingerprint;
    }
    for (const ref of selected) {
      if (ref.locked)
        throw new VmotionError('TRACK_LOCKED', 'Reference belongs to a locked track', {
          sequenceId: ref.sequenceId,
          trackId: ref.trackId,
          clipId: ref.clipId,
        });
      if (touched.has(ref.id))
        throw new VmotionError('REFERENCE_OVERLAP', 'A reference may be replaced once in a batch', {
          id: ref.id,
        });
      touched.add(ref.id);
      let owner = document(ref.file);
      for (const part of ref.pointer.slice(0, -1)) {
        if (!Object.hasOwn(owner, part))
          throw new VmotionError('REFERENCE_SELECTION', 'Reference container changed');
        owner = owner[part];
      }
      const field = ref.pointer.at(-1)!;
      if (owner[field] !== item.from.id)
        throw new VmotionError('REFERENCE_SELECTION', 'Reference value no longer matches');
      owner[field] = item.to.id;
      changes.push({ reference: ref, to: item.to });
      if (ref.clipId) {
        const clip = snapshot.sequences
            .find((s) => s.id === ref.sequenceId)!
            .tracks.find((t) => t.id === ref.trackId)!
            .clips.find((c) => c.id === ref.clipId)!,
          last = clip.sourceIn + Math.max(0, Math.ceil(clipContentDuration(clip)) - 1) * clip.speed,
          duration =
            item.to.kind === 'scene'
              ? snapshot.scenes.find((s) => s.id === item.to.id)!.duration
              : item.to.kind === 'sequence'
                ? snapshot.sequences.find((s) => s.id === item.to.id)!.duration
                : checkedAssets.get(item.to.id)?.sourceEnd;
        if (duration !== undefined && last >= duration)
          throw new VmotionError(
            'REFERENCE_RANGE',
            'Replacement is shorter than the existing source window',
            { referenceId: ref.id, lastSourceFrame: last, sourceEnd: duration },
          );
      }
    }
  }
  const files = [...documents]
      .filter(
        ([file, doc]) => JSON.stringify(doc) !== JSON.stringify(JSON.parse(snapshot.files[file])),
      )
      .map(([file, doc]) => ({
        type: 'replace' as const,
        path: file,
        expectedHash: hash(snapshot.files[file]),
        content: JSON.stringify(doc, null, 2) + '\n',
      })),
    operations: Operation[] = [{ type: 'editFiles', edits: files }],
    candidate = applyOperations(root, snapshot, operations),
    diagnostics = await validateSnapshot(root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError(
      'VALIDATION_FAILED',
      'Reference candidate failed validation; no source saved',
      diagnostics,
    );
  const proposed: Array<{
      sceneId?: string;
      sequenceId?: string;
      frame: number;
      path: string[];
      contextFrames: number[];
    }> = p.samples.length
      ? p.samples
      : changes.flatMap<{
          sceneId?: string;
          sequenceId?: string;
          frame: number;
          path: string[];
          contextFrames: number[];
        }>(({ reference: ref }) => {
          if (ref.sequenceId && ref.clipId) {
            const seq = snapshot.sequences.find((s) => s.id === ref.sequenceId)!,
              clip = seq.tracks
                .find((t) => t.id === ref.trackId)!
                .clips.find((c) => c.id === ref.clipId)!;
            return [
              clip.start,
              Math.floor(clip.start + clip.duration / 2),
              clip.start + clip.duration - 1,
            ]
              .filter((f) => f < seq.duration)
              .map((frame) => ({ sequenceId: seq.id, frame, path: [], contextFrames: [] }));
          }
          if (ref.sceneId) {
            const scene = snapshot.scenes.find((s) => s.id === ref.sceneId)!;
            return [0, Math.floor(scene.duration / 2), scene.duration - 1].map((frame) => ({
              sceneId: scene.id,
              frame,
              path: [],
              contextFrames: [],
            }));
          }
          return [];
        }),
    unique = [...new Map(proposed.map((s) => [JSON.stringify(s), s])).values()],
    first = [...new Map(unique.map((s) => [s.sceneId ?? s.sequenceId, s])).values()],
    samples = [...first, ...unique]
      .filter(
        (s, i, all) => all.findIndex((other) => JSON.stringify(s) === JSON.stringify(other)) === i,
      )
      .slice(0, 12);
  return {
    request: p,
    candidate,
    operations,
    assetChecks: [...new Map(assetChecks.map((c) => [c.assetId, c])).values()],
    samples,
    changes: changes
      .slice(0, 24)
      .map(({ reference, to }) => ({ ...summarizeReference(reference, true), to })),
    coverage: {
      references: changes.length,
      reported: Math.min(24, changes.length),
      unreported: Math.max(0, changes.length - 24),
      sampled: samples.length,
      proposedSamples: unique.length,
      omittedSamples: unique.length - samples.length,
      runtimeComplete: false,
    },
    files: files.map((f) => ({
      file: f.path,
      beforeHash: f.expectedHash,
      afterHash: hash(f.content),
    })),
    limitations: [
      'Only selected editable declared fields change; author TypeScript, object IDs, timelines, transforms, keyframes and source files are retained.',
      'Code literals and computed references are not rewritten. Pinned templates/plugin/tracking sources use their dedicated migration/reanalysis tools. Shared resource-only changes need explicit sample scopes.',
    ],
  };
}
