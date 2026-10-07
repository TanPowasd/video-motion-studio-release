import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from './application.js';
import { VmotionError } from '../core/model.js';
import { safePath } from './project.js';
import { runtimeFile } from '../core/bundled-runtime.js';
import { assertSurfaceMethod, surfaceManifest } from './surfaces.js';

async function serveClient(url: URL, res: http.ServerResponse, clientDirectory: string) {
  let file = path.resolve(clientDirectory, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.resolve(clientDirectory) + path.sep))
    file = path.join(clientDirectory, 'index.html');
  try {
    if (!(await stat(file)).isFile()) file = path.join(clientDirectory, 'index.html');
  } catch {
    file = path.join(clientDirectory, 'index.html');
  }
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  res.writeHead(200, {
    'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(await readFile(file));
}
export async function serveHttp(
  app: Application | undefined,
  port = 4318,
  clientDirectory = path.resolve('dist/client'),
) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/api/surfaces') {
        send(surfaceManifest);
        return;
      }
      if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
        const agentUrl = new URL(url);
        agentUrl.pathname = url.pathname.slice('/agent'.length) || '/';
        await serveClient(agentUrl, res, path.resolve(clientDirectory, '../agent'));
        return;
      }
      if (url.pathname === '/runtime/font.otf' || url.pathname === '/runtime/font-bold.otf') {
        const file = runtimeFile(
          url.pathname.includes('bold')
            ? 'fonts/NotoSansSC-Bold.otf'
            : 'fonts/NotoSansSC-Regular.otf',
        );
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'font/otf',
          'Cache-Control': 'public, max-age=86400',
        });
        createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
        return;
      }
      if (!app) {
        if (url.pathname.startsWith('/api/'))
          send({ error: { code: 'NO_PROJECT', message: '请先新建或打开项目' } }, 409);
        else await serveClient(url, res, clientDirectory);
        return;
      }
      if (url.pathname === '/watch') {
        const files = await readdir(path.join(app.root, 'exports')),
          name = url.searchParams.get('file') ?? files.find((f) => f.endsWith('.mp4'));
        if (!name) throw new VmotionError('NO_VIDEO', 'This project has no exported video');
        const esc = (s: string) =>
          s.replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
          );
        const title = esc(app.service.snapshot.project.name),
          duration =
            (app.service.snapshot.sequences.find(
              (s) => s.id === app.service.snapshot.project.activeSequence,
            )!.duration *
              app.service.snapshot.project.fps.den) /
            app.service.snapshot.project.fps.num;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Vmotion</title><style>*{box-sizing:border-box}body{margin:0;background:#12151c;color:#e5e7ef;font-family:"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1200px;margin:36px auto;padding:0 30px}.brand{color:#b9affb;font-size:13px;letter-spacing:3px}h1{font-size:28px;font-weight:500;margin:18px 0 10px}p{color:#8592a9;font-size:13px}video{width:100%;margin-top:24px;border-radius:8px;box-shadow:0 10px 60px #0007;background:#faf8f3}.links{display:flex;gap:22px;margin-top:22px;font-size:13px}a{color:#b9affb;text-decoration:none}.meta{color:#77849b}</style></head><body><main><div class="brand">VMOTION / 本地播放</div><h1>${title}</h1><p>本地成片 · ${Math.floor(duration / 60)} 分 ${Math.round(duration % 60)} 秒 · ${app.service.snapshot.project.width} × ${app.service.snapshot.project.height} / ${(app.service.snapshot.project.fps.num / app.service.snapshot.project.fps.den).toFixed(2)} fps</p><video controls preload="metadata" poster="/api/frame?frame=90&width=1280&height=720" src="/api/export?file=${encodeURIComponent(name)}"></video><div class="links"><a href="/">打开可编辑工程 →</a><a href="/api/export?file=${encodeURIComponent(name)}" download>下载 MP4</a><span class="meta">本片通过 Vmotion 原生渲染核心制作</span></div></main></body></html>`,
        );
        return;
      }
      if (url.pathname === '/api/export') {
        const name = url.searchParams.get('file') ?? '';
        if (path.basename(name) !== name || !name.endsWith('.mp4'))
          throw new VmotionError('EXPORT_FILE', 'Expected an exported MP4 filename');
        const file = safePath(app.root, `exports/${name}`),
          info = await stat(file);
        const headers = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        };
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
          let begin = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2])),
            end = match[1] ? (match[2] ? Number(match[2]) : info.size - 1) : info.size - 1;
          end = Math.min(end, info.size - 1);
          if (
            !Number.isSafeInteger(begin) ||
            !Number.isSafeInteger(end) ||
            begin < 0 ||
            begin > end ||
            begin >= info.size
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            ...headers,
            'Content-Length': end - begin + 1,
            'Content-Range': `bytes ${begin}-${end}/${info.size}`,
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(file, { start: begin, end });
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': info.size });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (url.pathname === '/api/sound-audio') {
        const key = url.searchParams.get('key') ?? '';
        if (!/^[a-f0-9]{64}$/.test(key))
          throw new VmotionError('SOUND_AUDIO', 'Expected a rendered sound cache key');
        const file = safePath(app.root, `.vmotion/sound-cache/${key}.wav`),
          info = await stat(file);
        let start = 0,
          end = info.size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match && (match[1] || match[2])) {
            start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          } else start = -1;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= info.size
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=86400',
          'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (
        req.method === 'POST' &&
        ['/api/rpc', '/api/studio/rpc', '/api/agent/rpc', '/api/agent/discovery'].includes(
          url.pathname,
        )
      ) {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):(4318|5173|\d+)$/.test(origin))
          throw new VmotionError('ORIGIN', 'Only the local editor may call the HTTP API');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16 * 1024 * 1024)
            throw new VmotionError('BODY_LIMIT', 'Request exceeds 16MB');
        }
        if (url.pathname === '/api/agent/discovery') {
          send({ result: app.agentDiscovery(JSON.parse(body)) });
          return;
        }
        const { method, params } = JSON.parse(body);
        assertSurfaceMethod(
          url.pathname === '/api/studio/rpc'
            ? 'studio'
            : url.pathname === '/api/agent/rpc'
              ? 'agent'
              : 'legacy',
          method,
        );
        send({ result: await app.dispatch(method, params) });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/music-live/')) {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
          throw new VmotionError('ORIGIN', 'Only the local music editor may stream audio');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 128 * 1024)
            throw new VmotionError('BODY_LIMIT', 'Live audio request exceeds 128 KiB');
        }
        const pcm = await app.audioLive.block(
          url.pathname.slice('/api/music-live/'.length),
          JSON.parse(body),
        );
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Vmotion-Audio-Format': 'f32le-stereo',
        });
        res.end(pcm);
        return;
      }
      if (url.pathname === '/api/drawing-frame') {
        let params: any = {
          id: url.searchParams.get('id'),
          width: Number(url.searchParams.get('width') ?? 960),
          height: url.searchParams.has('height')
            ? Number(url.searchParams.get('height'))
            : undefined,
        };
        if (req.method === 'POST') {
          const origin = req.headers.origin;
          if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
            throw new VmotionError('ORIGIN', 'Only the local editor may call the HTTP API');
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 16 * 1024 * 1024)
              throw new VmotionError('BODY_LIMIT', 'Request exceeds 16MB');
          }
          params = JSON.parse(body);
        }
        const { buffer, revision } = await app.drawingFrame(params);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'X-Vmotion-Revision': revision,
        });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/asset-thumbnail') {
        const buffer = await app.assetThumbnail(
          url.searchParams.get('id') ?? '',
          Number(url.searchParams.get('width') ?? 160),
          Number(url.searchParams.get('height') ?? 100),
        );
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/frame') {
        const frame = Number(url.searchParams.get('frame') ?? 0),
          width = Number(url.searchParams.get('width') ?? 960),
          height = Number(url.searchParams.get('height') ?? 540),
          sceneId = url.searchParams.get('scene') ?? undefined;
        const focusPath = url.searchParams.get('path')
          ? JSON.parse(url.searchParams.get('path')!)
          : undefined;
        const {
          buffer,
          stale,
          error,
          revision,
          frame: renderedFrame,
          format,
          width: renderedWidth,
          height: renderedHeight,
          renderMs,
          encodeMs,
          media,
        } = await app.frame({
          frame,
          width,
          height,
          sceneId,
          path: focusPath,
          contextFrames: url.searchParams.get('context')
            ? JSON.parse(url.searchParams.get('context')!)
            : undefined,
          draft: url.searchParams.get('draft')
            ? JSON.parse(url.searchParams.get('draft')!)
            : undefined,
          fallback: true,
          format: url.searchParams.get('format') === 'rgba' ? 'rgba' : 'png',
          mediaQuality: url.searchParams.get('media') === 'auto' ? 'auto' : 'original',
        });
        res.writeHead(200, {
          'Content-Type': format === 'rgba' ? 'application/x-vmotion-rgba' : 'image/png',
          'Cache-Control': 'no-store',
          'X-Vmotion-Stale': String(stale),
          'X-Vmotion-Revision': revision,
          'X-Vmotion-Frame': String(renderedFrame),
          'X-Vmotion-Format': format,
          'X-Vmotion-Media-Quality': media?.quality ?? 'original',
          'X-Vmotion-Proxy-Count': String(media?.proxyCount ?? 0),
          'X-Vmotion-Decode-Pixels': String(media?.decodePixels ?? 0),
          ...(renderedWidth
            ? {
                'X-Vmotion-Width': String(renderedWidth),
                'X-Vmotion-Height': String(renderedHeight),
              }
            : {}),
          ...(renderMs !== undefined
            ? { 'X-Vmotion-Render-Ms': String(renderMs), 'X-Vmotion-Encode-Ms': String(encodeMs) }
            : {}),
          ...(error ? { 'X-Vmotion-Error': encodeURIComponent(error) } : {}),
        });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/audio-chunk') {
        const controller = new AbortController(),
          disconnect = () => {
            if (!res.writableEnded) controller.abort();
          };
        res.on('close', disconnect);
        try {
          const result = await app.audioRange(
            app.service.snapshot,
            {
              sequenceId: url.searchParams.get('sequence') ?? undefined,
              revision: url.searchParams.get('revision') ?? undefined,
              startSample: Number(url.searchParams.get('start') ?? 0),
              sampleCount: Number(url.searchParams.get('samples') ?? 192000),
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Vmotion-Revision': result.revision,
            'X-Vmotion-Start-Sample': String(result.startSample),
            'X-Vmotion-Sample-Count': String(result.sampleCount),
            'X-Vmotion-Sample-Rate': String(result.sampleRate),
            'X-Vmotion-Audio-Clips': String(result.clipCount),
          });
          res.end(result.buffer);
        } finally {
          res.off('close', disconnect);
        }
        return;
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ kind: 'change', state: app.service.state() })}\n\n`);
        const change = (state: unknown) =>
            res.write(`data: ${JSON.stringify({ kind: 'change', state })}\n\n`),
          render = (jobs: unknown) =>
            res.write(`data: ${JSON.stringify({ kind: 'render', jobs })}\n\n`);
        app.on('change', change);
        app.on('render', render);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          app.off('change', change);
          app.off('render', render);
        });
        return;
      }
      if (url.pathname === '/api/health') {
        send({ ok: true, project: app.service.snapshot.project.name });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
        return;
      }
      await serveClient(url, res, clientDirectory);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: e instanceof VmotionError ? e.code : 'INTERNAL_ERROR',
            message: (e as Error).message,
            details: e instanceof VmotionError ? e.details : undefined,
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
