import { z } from 'zod';
import { editSequence, sequenceActionSchema } from '../core/editing.js';
import { VmotionError, type Snapshot } from '../core/model.js';
export const sequenceEditSchema = z
  .object({
    sequenceId: z.string().optional(),
    revision: z.string().optional(),
    actions: z.array(sequenceActionSchema).min(1).max(1000),
  })
  .strict();
export function sequenceEdits(snapshot: Snapshot, raw: unknown) {
  const request = sequenceEditSchema.parse(raw),
    id = request.sequenceId ?? snapshot.project.activeSequence,
    sequence = snapshot.sequences.find((s) => s.id === id);
  if (!sequence) throw new VmotionError('NOT_FOUND', 'Sequence not found');
  return { request, ...editSequence(snapshot, sequence, request.actions) };
}
