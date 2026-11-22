// 零依赖静态服务器：支持 Range 请求，便于浏览器拖动/逐帧播放真实视频。
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[3] ?? '.');
const port = Number(process.argv[2] ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = resolve(join(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

http
  .createServer(async (req, res) => {
    try {
      const urlPath = req.url === '/' ? '/index.html' : req.url;
      const file = safePath(urlPath);
      if (!file) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(file);
      if (info.isDirectory()) {
        res.writeHead(302, { Location: urlPath.replace(/\/?$/, '/') + 'index.html' }).end();
        return;
      }
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] !== '' ? Number(m[1]) : 0;
        let end = m && m[2] !== '' ? Number(m[2]) : info.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
          return;
        }
        end = Math.min(end, info.size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500).end();
          else res.end();
        });
        stream.pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      const stream = createReadStream(file);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      });
      stream.pipe(res);
    } catch {
      // 客户端中断 Range 请求时可能已发送过响应头，不能再写 404。
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      } else {
        res.end();
      }
    }
  })
  .listen(port, () => {
    console.log(`导盲视觉服务已启动: http://localhost:${port}/index.html`);
    console.log(`评测台: http://localhost:${port}/eval.html`);
  });
