import { effectSchema, newNode, type Effect, type NodeInput } from '../core/model.js';
export {
  renderProgramPathSchema,
  renderProgramSchema,
} from '../core/programs/render-program-schema.js';
export type { RenderProgram } from '../core/programs/render-program-schema.js';
export function programLayer(
  id: string,
  source: string,
  props: Omit<NodeInput, 'id' | 'type'> = {},
) {
  return newNode({ ...props, id, type: 'program', programSource: source });
}
export function programEffect(
  source: string,
  params: Record<string, unknown> = {},
): Extract<Effect, { type: 'program' }> {
  return effectSchema.parse({ type: 'program', source, params }) as Extract<
    Effect,
    { type: 'program' }
  >;
}
