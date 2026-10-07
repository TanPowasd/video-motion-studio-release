import { z } from 'zod';
import { VmotionError, type Snapshot } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { referenceKey, type ReferenceEntity } from '../core/project-references.js';
export const referenceSampleSchema = z
  .object({
    revision: z.string().optional(),
    samples: z
      .array(
        z
          .object({
            sceneId: z.string(),
            frame: z.number().finite().nonnegative(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: z.array(z.number().finite().nonnegative()).max(32).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    entity: z
      .object({ kind: z.enum(['asset', 'scene', 'drawing', 'file']), id: z.string().min(1) })
      .strict()
      .optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(24),
    detail: z.boolean().default(false),
  })
  .strict();
export async function sampleReferences(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = referenceSampleSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError(
      'REVISION_CONFLICT',
      'Project changed before runtime reference sampling',
    );
  const rows: Array<{
      sample: number;
      sceneId: string;
      frame: number;
      nodeId: string;
      path: string[];
      contextFrames: number[];
      localFrame: number;
      field: string;
      to: ReferenceEntity;
      visible: boolean;
      editable: boolean;
    }> = [],
    diagnostics: unknown[] = [];
  for (const [index, sample] of p.samples.entries()) {
    const editScopes = new Map<string, Awaited<ReturnType<Renderer['inspectComposition']>>>();
    const scope = await renderer.inspectComposition(
        snapshot,
        sample.sceneId,
        sample.frame,
        sample.path,
        sample.contextFrames,
      ),
      graph = await renderer.inspectInteractions(
        snapshot,
        sample.sceneId,
        sample.frame,
        sample.path,
        {
          contextFrames: sample.contextFrames,
          includeInactive: true,
          includeEmpty: true,
          includeEvaluated: true,
        },
      );
    for (const layer of graph.layers) {
      const node = layer.node;
      const hasReference = !!(
        node.assetId ||
        node.audioAssetId ||
        node.sceneId ||
        node.component ||
        node.source ||
        node.theme ||
        node.templateInstance ||
        node.effects.some((e) => e.type === 'effectGraph' && e.source) ||
        node.scene3d?.instances.some((i) => i.meshSource)
      );
      if (!hasReference) continue;
      const key = JSON.stringify([layer.path, layer.frame, layer.contextFrames]);
      let editableScope = editScopes.get(key);
      if (!editableScope) {
        if (editScopes.size >= 256)
          throw new VmotionError(
            'REFERENCE_SAMPLE_BUDGET',
            'Runtime editability lookup exceeds 256 scopes per sample',
          );
        editableScope = await renderer.inspectComposition(
          snapshot,
          sample.sceneId,
          layer.frame ?? sample.frame,
          layer.path,
          layer.contextFrames ?? [],
        );
        editScopes.set(key, editableScope);
      }
      const base = {
          sample: index,
          sceneId: sample.sceneId,
          frame: sample.frame,
          nodeId: node.id,
          path: layer.path,
          contextFrames: layer.contextFrames ?? [],
          localFrame: layer.frame ?? sample.frame,
          visible: node.visible,
          editable: !!editableScope.targets[node.id],
        },
        add = (kind: ReferenceEntity['kind'], id: unknown, field: string) => {
          if (
            typeof id === 'string' &&
            (!p.entity || referenceKey({ kind, id }) === referenceKey(p.entity))
          )
            rows.push({ ...base, field, to: { kind, id } });
        };
      add('asset', node.assetId, 'assetId');
      add('asset', node.audioAssetId, 'audioAssetId');
      if (node.type === 'image' || node.type === 'video') add('file', node.source, 'source');
      add('scene', node.sceneId, 'sceneId');
      add('file', node.component, 'component');
      if (node.theme) add('file', node.theme.source, 'theme.source');
      if (node.templateInstance)
        add('file', node.templateInstance.source, 'templateInstance.source');
      node.effects.forEach((fx, i) => {
        if (fx.type === 'effectGraph') add('file', fx.source, `effects.${i}.source`);
      });
      node.scene3d?.instances.forEach((inst, i) =>
        add('file', inst.meshSource, `scene3d.instances.${i}.meshSource`),
      );
    }
    if (!scope.scene.nodes.length)
      diagnostics.push({
        sample: index,
        code: 'REFERENCE_SAMPLE_EMPTY',
        message: 'Selected scope has no nodes at this sampled content clock',
      });
  }
  const page = rows.slice(p.offset, p.offset + p.limit);
  return {
    revision: snapshot.revision,
    total: rows.length,
    offset: p.offset,
    ...(p.offset + page.length < rows.length ? { nextOffset: p.offset + page.length } : {}),
    coverage: {
      requestedSamples: p.samples.length,
      returned: page.length,
      omitted: rows.length - page.length,
      runtimeComplete: false,
    },
    items: page.map((r) =>
      p.detail
        ? r
        : {
            sample: r.sample,
            sceneId: r.sceneId,
            nodeId: r.nodeId,
            to: r.to,
            field: r.field,
            editable: r.editable,
          },
    ),
    diagnostics,
    limitations: [
      'Actual generated/retimed node references at requested scopes and frames only; not every timeline frame or arbitrary file/audio dependency.',
      'This is object evidence, not visibility after masks or export inspection. For generated edits use the detailed path/localFrame/contextFrames with shared composition tools; source remains editable.',
    ],
  };
}
