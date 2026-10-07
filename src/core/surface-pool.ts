import { createCanvas, type Canvas } from '@napi-rs/canvas';
export class SurfacePool {
  private entries: Canvas[] = [];
  private bytes = 0;
  readonly stats = { allocations: 0, reuses: 0, evictions: 0 };
  constructor(readonly budgetBytes = 96 * 1024 * 1024) {}
  acquire(width: number, height: number) {
    const index = this.entries.findIndex(
      (canvas) => canvas.width === width && canvas.height === height,
    );
    let canvas: Canvas;
    if (index >= 0) {
      canvas = this.entries.splice(index, 1)[0];
      this.bytes -= width * height * 4;
      this.stats.reuses++;
      canvas.getContext('2d').reset();
    } else {
      canvas = createCanvas(width, height);
      this.stats.allocations++;
    }
    return canvas;
  }
  release(canvas: Canvas) {
    if (this.entries.includes(canvas)) return;
    const bytes = canvas.width * canvas.height * 4;
    if (bytes > this.budgetBytes) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    while (this.entries.length && this.bytes + bytes > this.budgetBytes) {
      const oldest = this.entries.shift()!;
      this.bytes -= oldest.width * oldest.height * 4;
      oldest.width = 1;
      oldest.height = 1;
      this.stats.evictions++;
    }
    this.entries.push(canvas);
    this.bytes += bytes;
  }
  report() {
    return {
      ...this.stats,
      retainedBytes: this.bytes,
      retainedSurfaces: this.entries.length,
      budgetBytes: this.budgetBytes,
    };
  }
  clear() {
    for (const canvas of this.entries) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.entries = [];
    this.bytes = 0;
  }
}
