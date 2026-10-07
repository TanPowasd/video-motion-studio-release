import { z } from 'zod';
import { visualPreset, visualPresetNames } from '../core/visual-presets.js';
import { effectGraphResource } from '../core/effect-graph.js';
import { effectGraphPathSchema } from '../core/effect-graph-schema.js';
import { effectGraphPlanSchema, planEffectGraph } from './effect-graphs.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { hash } from './project.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
export const visualTemplatesSchema = z
  .object({
    preset: z.enum(visualPresetNames).optional(),
    includeGraph: z.boolean().default(false),
  })
  .strict();
export function visualTemplates(raw: unknown) {
  const request = visualTemplatesSchema.parse(raw);
  if (request.includeGraph && !request.preset)
    throw new VmotionError(
      'VISUAL_TEMPLATE_SELECTION',
      'Select one preset before requesting its graph',
    );
  return {
    templates: (request.preset ? [request.preset] : visualPresetNames).map((name) => {
      const graph = visualPreset(name);
      return {
        name,
        parameters: graph.parameters,
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type })),
        inputs: graph.nodes.filter((n) => n.type === 'input').map((n) => n.slot),
        ...(request.includeGraph ? { graph } : {}),
      };
    }),
    use: 'visual_plan attaches a parameterized reusable graph to selected layers; layerDisplace requires bindings.map to a same-parent stable layer ID. effects_plan can compose raw bloom/radialRays/gradientMap or temporal passes. Always inspect candidate pictures and preserve exact apply payload.',
    coordinateSpace:
      'Texture uses graph layer/canvas region; displacement input/map share the same captured canvas. Source scene clocks and matrix/scales affect fields; no random wall clock.',
    limits:
      'CPU fields; texture region bounds reduce scalar evaluations while full pixel surfaces retain existing memory/work limits. Radial rays have an explicit 256M sampling cap.',
    reference: 'docs/VISUAL-FIELDS.md',
  };
}
export const visualPlanSchema = z
  .object({
    revision: z.string(),
    preset: z.enum(visualPresetNames),
    source: effectGraphPathSchema.optional(),
    targets: effectGraphPlanSchema.shape.targets,
  })
  .strict();
export async function planVisual(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<any>,
) {
  const request = visualPlanSchema.parse(raw),
    source = request.source ?? `components/effects/visual-${request.preset}.json`,
    text = snapshot.files[source],
    graph =
      text === undefined ? visualPreset(request.preset) : effectGraphResource(snapshot, source);
  return planEffectGraph(
    root,
    renderer,
    snapshot,
    {
      revision: request.revision,
      source,
      graph,
      expectedHash: text === undefined ? null : hash(text),
      targets: request.targets,
      delivery: 'stored',
    },
    edit,
  );
}
