import { VmotionError } from './model.js';
/** Bounded binary framing; pixel payloads are copied once, never concatenated/base64 encoded. */
export class GpuFrames {
  private prefix = Buffer.alloc(8);
  private prefixAt = 0;
  private header?: Buffer;
  private headerAt = 0;
  private body?: Buffer;
  private bodyAt = 0;
  constructor(readonly receive: (header: any, body: Buffer) => void) {}
  push(chunk: Buffer) {
    let at = 0;
    while (at < chunk.length) {
      if (this.prefixAt < 8) {
        const size = Math.min(8 - this.prefixAt, chunk.length - at);
        chunk.copy(this.prefix, this.prefixAt, at, at + size);
        this.prefixAt += size;
        at += size;
        if (this.prefixAt < 8) continue;
        const header = this.prefix.readUInt32LE(0),
          body = this.prefix.readUInt32LE(4);
        if (
          !header ||
          header > 512 * 1024 ||
          body > 3840 * 2160 * 4 + Math.ceil((3840 * 2160) / 32) * 4
        )
          throw new VmotionError('GPU_PROTOCOL', 'GPU response exceeds binary frame bounds');
        this.header = Buffer.allocUnsafe(header);
        this.body = Buffer.allocUnsafe(body);
      }
      if (this.headerAt < this.header!.length) {
        const size = Math.min(this.header!.length - this.headerAt, chunk.length - at);
        chunk.copy(this.header!, this.headerAt, at, at + size);
        this.headerAt += size;
        at += size;
        if (this.headerAt < this.header!.length) continue;
      }
      if (this.bodyAt < this.body!.length) {
        const size = Math.min(this.body!.length - this.bodyAt, chunk.length - at);
        chunk.copy(this.body!, this.bodyAt, at, at + size);
        this.bodyAt += size;
        at += size;
        if (this.bodyAt < this.body!.length) continue;
      }
      const header = JSON.parse(this.header!.toString('utf8')),
        body = this.body!;
      this.prefixAt = this.headerAt = this.bodyAt = 0;
      this.header = this.body = undefined;
      this.receive(header, body);
    }
  }
}
