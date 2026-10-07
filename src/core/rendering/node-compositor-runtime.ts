import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import type { EffectGraphResolver } from '../effect-graph-cache.js';
import type { GpuPoints } from '../gpu-points.js';
import type { GraphExecution } from '../graph-execution.js';
import type { Matrix } from '../interaction.js';
export interface ManagedRenderSurface {
  canvas: Canvas;
  ctx: SKRSContext2D;
  release: () => void;
}
export interface NodeCompositorRuntime {
  timings: { paintCalls: number };
  surface: (ctx: SKRSContext2D, width?: number, height?: number) => ManagedRenderSurface;
  canvasMatrix: Matrix;
  fullFieldScan: boolean;
  fieldPixels: number;
  temporalBytes: number;
  effectGraphs: EffectGraphResolver;
  effectGraphStack: Set<string>;
  graphOptimize: boolean;
  graphRegions: boolean;
  graphTileRows: number;
  graphExecution: GraphExecution;
  layerBytes: number;
  graphScratchBytes: number;
  graphScratchPeakBytes: number;
  gpu: GpuPoints;
  effectGraphWork: number;
}
