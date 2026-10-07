import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { hash } from './project.js';
import type { Application } from './application.js';
import { VmotionError } from '../core/model.js';
export function pipeName(root: string) {
  const normalized = path.resolve(root);
  const key = hash(process.platform === 'win32' ? normalized.toLowerCase() : normalized).slice(
    0,
    24,
  );
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vmotion-${key}`
    : path.join(os.tmpdir(), `vmotion-${key}.sock`);
}
export function rpc(root: string, method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName(root));
    let buffer = '';
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new VmotionError('RPC_TIMEOUT', 'Project service did not respond'));
    });
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024 * 1024) {
        socket.destroy();
        reject(new Error('RPC response too large'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        socket.end();
        if (message.error)
          reject(
            new VmotionError(message.error.code, message.error.message, message.error.details),
          );
        else resolve(message.result);
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
  });
}
export async function existingService(root: string) {
  try {
    try {
      await rpc(root, 'ping');
    } catch (e) {
      if (e instanceof VmotionError && e.code === 'METHOD_NOT_FOUND') await rpc(root, 'state');
      else throw e;
    }
    return true;
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === 'ENOENT' ||
      (e as NodeJS.ErrnoException).code === 'ECONNREFUSED'
    )
      return false;
    throw e;
  }
}
export async function servePipe(app: Application) {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 16 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void (async () => {
          try {
            const { method, params } = JSON.parse(line);
            const result = await app.dispatch(method, params);
            socket.write(JSON.stringify({ result }) + '\n');
          } catch (e) {
            socket.write(
              JSON.stringify({
                error: {
                  code: e instanceof VmotionError ? e.code : 'INTERNAL_ERROR',
                  message: (e as Error).message,
                  details: e instanceof VmotionError ? e.details : undefined,
                },
              }) + '\n',
            );
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName(app.root), () => resolve());
  });
  return server;
}
