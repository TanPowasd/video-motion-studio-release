import { animationRpcHandlers } from './animation.js';
import { audioRpcHandlers } from './audio.js';
import { cacheRpcHandlers } from './cache.js';
import { compositionRpcHandlers } from './composition.js';
import { coreRpcHandlers } from './core.js';
import { designRpcHandlers } from './design.js';
import { drawingRpcHandlers } from './drawing.js';
import { editingRpcHandlers } from './editing.js';
import { graphicsRpcHandlers } from './graphics.js';
import { mathRpcHandlers } from './math.js';
import { mediaRpcHandlers } from './media.js';
import { organizationRpcHandlers } from './organization.js';
import { recoveryRpcHandlers } from './recovery.js';
import { renderRpcHandlers } from './render.js';
import { reviewRpcHandlers } from './review.js';
import { scene3dRpcHandlers } from './scene3d.js';
import { trackingRpcHandlers } from './tracking.js';
import { visualRpcHandlers } from './visual.js';
export const builtinRpcHandlers = {
  ...animationRpcHandlers,
  ...audioRpcHandlers,
  ...cacheRpcHandlers,
  ...compositionRpcHandlers,
  ...coreRpcHandlers,
  ...designRpcHandlers,
  ...drawingRpcHandlers,
  ...editingRpcHandlers,
  ...graphicsRpcHandlers,
  ...mathRpcHandlers,
  ...mediaRpcHandlers,
  ...organizationRpcHandlers,
  ...recoveryRpcHandlers,
  ...renderRpcHandlers,
  ...reviewRpcHandlers,
  ...scene3dRpcHandlers,
  ...trackingRpcHandlers,
  ...visualRpcHandlers,
};
