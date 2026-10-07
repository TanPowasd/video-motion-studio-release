import { contentTiming } from '../content-time.js';
import { VmotionError } from '../model.js';
import type { NodeRenderer } from './registry.js';
export const renderers: NodeRenderer[] = [
  {
    type: 'program',
    async render(context, node) {
      if (!node.programSource)
        throw new VmotionError('PROGRAM_SOURCE', 'Program layer needs a renderer manifest', {
          nodeId: node.id,
        });
      if (node.width === 0 || node.height === 0)
        return { target: context.target, skipChildren: true };
      const timing = contentTiming(context.snapshot, node, context.frame, true);
      if (!timing.present) return { target: context.target, skipChildren: true };
      const width = Math.ceil(node.width),
        height = Math.ceil(node.height),
        image = await context.services.programs.render(
          context.snapshot,
          node.programSource,
          timing.sourceFrame,
          width,
          height,
          node.params,
        );
      try {
        context.target.drawImage(image, 0, 0, node.width, node.height);
      } finally {
        image.width = 1;
        image.height = 1;
      }
      return { target: context.target };
    },
  },
];
