import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(process.cwd());
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not found');
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`ShiftBridge frontend: http://localhost:${port}`));
