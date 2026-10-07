export type GraphExecutionEvent = {
  nodeId: string;
  type: string;
  kind: 'alias' | 'passthrough' | 'surface' | 'fused';
  surfacePixels: number;
  readbackPixels: number;
  scalarPixels: number;
  gpuPixels?: number;
  fused?: boolean;
  elapsedMs?: number;
};
export type GraphNodeRecord = Omit<GraphExecutionEvent, 'kind'> & {
  kind: GraphExecutionEvent['kind'] | 'mixed';
  ownerId: string;
  index: number;
  effectId?: string;
  source?: string;
  output: string;
  graph: string;
  executions: number;
  passthroughs: number;
  surfaces: number;
};
export class GraphExecution {
  private totals = {
    executions: 0,
    aliases: 0,
    passthroughs: 0,
    surfaces: 0,
    surfacePixels: 0,
    readbackPixels: 0,
    scalarPixels: 0,
    gpuPixels: 0,
    fusedExecutions: 0,
    fused: 0,
  };
  private nodes = new Map<string, GraphNodeRecord>();
  private omittedExecutions = 0;
  constructor(
    readonly trace = false,
    readonly maxNodes = 256,
  ) {}
  add(
    event: GraphExecutionEvent,
    owner: Pick<GraphNodeRecord, 'ownerId' | 'index' | 'effectId' | 'source' | 'output' | 'graph'>,
  ) {
    this.totals.executions++;
    this.totals.gpuPixels += event.gpuPixels ?? 0;
    if (event.fused) this.totals.fusedExecutions++;
    this.totals[
      event.kind === 'surface'
        ? 'surfaces'
        : event.kind === 'alias'
          ? 'aliases'
          : event.kind === 'fused'
            ? 'fused'
            : 'passthroughs'
    ]++;
    for (const field of ['surfacePixels', 'readbackPixels', 'scalarPixels'] as const)
      this.totals[field] += event[field];
    if (!this.trace) return;
    const key = JSON.stringify([
      owner.ownerId,
      owner.index,
      owner.source,
      owner.output,
      event.nodeId,
    ]);
    let record = this.nodes.get(key);
    if (!record) {
      if (this.nodes.size >= this.maxNodes) {
        this.omittedExecutions++;
        return;
      }
      record = {
        ...owner,
        ...event,
        executions: 0,
        passthroughs: 0,
        surfaces: 0,
        surfacePixels: 0,
        readbackPixels: 0,
        scalarPixels: 0,
        gpuPixels: 0,
        elapsedMs: 0,
      };
      this.nodes.set(key, record);
    }
    record.executions++;
    record.gpuPixels = (record.gpuPixels ?? 0) + (event.gpuPixels ?? 0);
    if (record.kind !== event.kind) record.kind = 'mixed';
    if (event.kind === 'passthrough') record.passthroughs++;
    if (event.kind === 'surface') record.surfaces++;
    for (const field of ['surfacePixels', 'readbackPixels', 'scalarPixels'] as const)
      record[field] += event[field];
    record.elapsedMs! += event.elapsedMs ?? 0;
  }
  report() {
    return { ...this.totals };
  }
  detail(limit = 8) {
    const rows = [...this.nodes.values()].sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));
    return {
      trackedNodes: rows.length,
      maxNodes: this.maxNodes,
      omittedExecutions: this.omittedExecutions,
      returned: Math.min(limit, rows.length),
      omitted: Math.max(0, rows.length - limit),
      items: rows.slice(0, limit).map((row) => ({ ...row })),
      scope:
        'Cumulative sampled graph node wall time; includes nested input capture, not a sum of exclusive timings. Tracking stops at bounded capacity.',
    };
  }
}
