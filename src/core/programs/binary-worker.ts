import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { GpuFrames } from '../gpu-transport.js';
import { VmotionError } from '../model.js';
export class BinaryWorker {
  private child?: ChildProcessWithoutNullStreams;
  private counter = 0;
  private pending?: {
    id: number;
    resolve: (reply: { header: Record<string, unknown>; body: Buffer }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private stderr = '';
  private terminations = new Set<Promise<void>>();
  constructor(
    private binary: string,
    private args: string[],
    private cwd?: string,
  ) {}
  request(
    method: string,
    parameters: Record<string, unknown>,
    body: Buffer,
    timeoutMs = 10000,
  ): Promise<{ header: Record<string, unknown>; body: Buffer }> {
    const work = () => this.send(method, parameters, body, timeoutMs);
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private send(
    method: string,
    parameters: Record<string, unknown>,
    body: Buffer,
    timeoutMs: number,
  ): Promise<{ header: Record<string, unknown>; body: Buffer }> {
    if (this.closed) throw new VmotionError('PROGRAM_CLOSED', 'Renderer process is closed');
    if (!this.child) {
      const child = spawn(this.binary, this.args, {
        cwd: this.cwd,
        stdio: 'pipe',
        windowsHide: true,
      });
      this.child = child;
      const reader = new GpuFrames((header: unknown, body) => {
        if (!header || typeof header !== 'object')
          return this.fail(new VmotionError('PROGRAM_PROTOCOL', 'Malformed renderer header'));
        const value = header as Record<string, unknown>,
          pending = this.pending;
        if (!pending || value.id !== pending.id)
          return this.fail(new VmotionError('PROGRAM_PROTOCOL', 'Renderer reply ID differs'));
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (value.error)
          pending.reject(
            new VmotionError('PROGRAM_RENDER', String(value.error), { stderr: this.stderr }),
          );
        else if (value.result && typeof value.result === 'object')
          pending.resolve({ header: value.result as Record<string, unknown>, body });
        else
          pending.reject(new VmotionError('PROGRAM_PROTOCOL', 'Renderer result is not an object'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        try {
          reader.push(chunk);
        } catch (error) {
          this.fail(error as Error);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-8192);
      });
      child.on('error', (error) => {
        if (this.child === child) this.fail(new VmotionError('PROGRAM_RUNTIME', error.message));
      });
      child.on('exit', (code) => {
        if (this.child === child)
          this.fail(
            new VmotionError('PROGRAM_EXIT', `Renderer exited (${code})`, { stderr: this.stderr }),
          );
      });
      child.stdin.on('error', (error) => {
        if (this.child === child) this.fail(error);
      });
    }
    const id = ++this.counter,
      header = Buffer.from(JSON.stringify({ id, method, ...parameters }));
    if (header.length > 512 * 1024 || body.length > 3840 * 2160 * 4)
      throw new VmotionError('PROGRAM_BUDGET', 'Renderer request exceeds bounded transport');
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(header.length);
    prefix.writeUInt32LE(body.length, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new VmotionError('PROGRAM_TIMEOUT', `Renderer exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.pending = { id, resolve, reject, timer };
      this.child!.stdin.write(prefix);
      this.child!.stdin.write(header);
      this.child!.stdin.write(body);
    });
  }
  private fail(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        if (process.platform === 'win32')
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 4000 },
            () => {
              child.kill();
            },
          );
        else child.kill();
      });
      this.terminations.add(done);
      void done.finally(() => this.terminations.delete(done));
    }
  }
  async close() {
    this.closed = true;
    this.fail(new VmotionError('PROGRAM_CLOSED', 'Renderer process closed'));
    await Promise.all(this.terminations);
  }
}
