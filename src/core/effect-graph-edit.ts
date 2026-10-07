import { z } from 'zod';
import {
  effectGraphNodeSchema,
  effectGraphLinkSchema,
  effectGraphSchema,
  type EffectGraph,
} from './effect-graph-schema.js';
import { VmotionError } from './model.js';
import { mergeMotionParameters } from './motion-template.js';
import { defineEffectGraph } from './effect-graph.js';
export const effectGraphActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), node: effectGraphNodeSchema }).strict(),
  z
    .object({ type: z.literal('update'), nodeId: z.string(), patch: z.record(z.unknown()) })
    .strict(),
  z
    .object({ type: z.literal('replace'), nodeId: z.string(), node: effectGraphNodeSchema })
    .strict(),
  z.object({ type: z.literal('remove'), nodeId: z.string() }).strict(),
  z.object({ type: z.literal('output'), nodeId: z.string() }).strict(),
  z
    .object({
      type: z.literal('outputs'),
      outputs: effectGraphSchema.innerType().shape.outputs.unwrap(),
    })
    .strict(),
  z.object({ type: z.literal('links'), links: z.array(effectGraphLinkSchema).max(512) }).strict(),
  z.object({ type: z.literal('parameters'), parameters: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('name'), name: z.string().min(1).max(200) }).strict(),
]);
export type EffectGraphAction = z.input<typeof effectGraphActionSchema>;
export function editEffectGraph(source: EffectGraph, actions: EffectGraphAction[]) {
  const graph = structuredClone(source);
  if (!actions.length || actions.length > 256)
    throw new VmotionError('EFFECT_GRAPH_EDIT', 'Provide 1–256 graph edits');
  for (const raw of actions) {
    const action = effectGraphActionSchema.parse(raw);
    if (action.type === 'add') {
      if (graph.nodes.some((node) => node.id === action.node.id))
        throw new VmotionError('EFFECT_GRAPH_IDS', 'Added node ID already exists', {
          nodeId: action.node.id,
        });
      graph.nodes.push(action.node);
    } else if (action.type === 'output') graph.output = action.nodeId;
    else if (action.type === 'outputs') graph.outputs = action.outputs;
    else if (action.type === 'links') graph.links = action.links;
    else if (action.type === 'parameters') graph.parameters = action.parameters;
    else if (action.type === 'name') graph.name = action.name;
    else {
      const index = graph.nodes.findIndex((node) => node.id === action.nodeId);
      if (index < 0)
        throw new VmotionError('EFFECT_GRAPH_INPUT', 'Edited node ID was not found', {
          nodeId: action.nodeId,
        });
      if (action.type === 'remove') graph.nodes.splice(index, 1);
      else if (action.type === 'replace') {
        if (action.node.id !== action.nodeId)
          throw new VmotionError('EFFECT_GRAPH_IDS', 'Replace preserves the stable node ID');
        graph.nodes[index] = action.node;
      } else {
        if ('id' in action.patch || 'type' in action.patch)
          throw new VmotionError(
            'EFFECT_GRAPH_EDIT',
            'Use replace to change node type; preserve stable IDs',
          );
        graph.nodes[index] = effectGraphNodeSchema.parse(
          mergeMotionParameters(
            graph.nodes[index] as unknown as Record<string, unknown>,
            action.patch,
          ),
        );
      }
    }
  }
  return defineEffectGraph(effectGraphSchema.parse(graph));
}
