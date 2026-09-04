// ─────────────────────────────────────────────────────────────────────────────
// emulatorSHARE — internal per-console static server.
//
// Each console's game binaries (its host.html + the emulator's .js/.wasm) are
// served on loopback for the container's OWN headless Chromium and nobody else.
// Viewers never see these files — they get video. This process is utterly
// independent of server.js so the guarantee is structural, not a routing quirk.
//
// Directory layout:
//   host/host.js                 <- SHARED host runtime (every console uses it)
//   consoles/<key>/host/html     <- package.json-style dir: the emulator page
//   consoles/<key>/bin/          <- emulator binaries (.js/.wasm/boards/roms)
//
// serve-host is launched with CONSOLE_KEY env; it serves that one console.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.HOST_STATIC_PORT || 8091);
const CONSOLE_KEY = process.env.CONSOLE_KEY || '';

const SHARED_DIR = __dirname;                       // host/
const CONSOLE_DIR = process.env.CONSOLE_DIR || path.resolve(__dirname, '..', 'consoles', CONSOLE_KEY);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ttf':  'font/ttf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.webp': 'image/webp',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function safeJoin(root, rel) {
    const target = path.normalize(path.join(root, rel));
    return target.startsWith(root + path.sep) ? target : null;
}

http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400).end(); return; }

    let root, rel;
    if (url.startsWith('/_shared/')) {
        root = SHARED_DIR;
        rel = url.slice('/_shared/'.length);
        if (rel === '') rel = 'host.js';
    } else {
        root = CONSOLE_DIR;
        rel = url;
    }
    if (rel === '/' || rel === '') rel = 'index.html';

    const target = safeJoin(root, rel);
    if (!target) { res.writeHead(403).end('Forbidden'); return; }
    try {
        const data = fs.readFileSync(target);
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`[host-static:${CONSOLE_KEY || '?'}] 127.0.0.1:${PORT} serving ${CONSOLE_DIR}`);
});
