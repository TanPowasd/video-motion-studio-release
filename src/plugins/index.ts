import { animationPlugin } from './animation.js';
import { audioPlugin } from './audio.js';
import { cachePlugin } from './cache.js';
import { compositionPlugin } from './composition.js';
import { corePlugin } from './core.js';
import { designPlugin } from './design.js';
import { drawingPlugin } from './drawing.js';
import { editingPlugin } from './editing.js';
import { graphicsPlugin } from './graphics.js';
import { mathPlugin } from './math.js';
import { mediaPlugin } from './media.js';
import { organizationPlugin } from './organization.js';
import { recoveryPlugin } from './recovery.js';
import { BuiltinPluginRegistry } from './registry.js';
import { renderPlugin } from './render.js';
import { reviewPlugin } from './review.js';
import { scene3dPlugin } from './scene3d.js';
import { trackingPlugin } from './tracking.js';
import { visualPlugin } from './visual.js';

export const builtinPlugins = new BuiltinPluginRegistry([
  designPlugin,
  mathPlugin,
  visualPlugin,
  mediaPlugin,
  audioPlugin,
  editingPlugin,
  renderPlugin,
  scene3dPlugin,
  graphicsPlugin,
  animationPlugin,
  drawingPlugin,
  compositionPlugin,
  trackingPlugin,
  corePlugin,
  recoveryPlugin,
  cachePlugin,
  reviewPlugin,
  organizationPlugin,
]);
