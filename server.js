// ─────────────────────────────────────────────────────────────────────────────
// emulatorSHARE — share many emulators with many people at once.
//
// Every console is a headless Chromium ("the host") running one emulator. That
// host encodes its canvas + game audio with WebCodecs and pushes the stream to
// this relay, which fans it out to every connected viewer. Viewers never run
// the emulator — they get pixels, and they press buttons into a shared input
// pile that feeds back to the host.
//
//   host ──ws /host──► [ relay ] ──ws /stream──► viewers
//   host ◄─ merged input ─────────────◄──────── viewers
//
// A console is CREATED the first time its host registers (see `register`).
// Nothing is hardcoded: spin up a new chromium pointed at a game and it becomes
// a new console the moment it connects.
//
// Databases are in SQLite (better-sqlite3):
//   users    — usernames + password hashes
//   sessions — server-signed viewer tokens (so we can revoke / count them)
//   consoles — the registry: every console that has ever registered
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

// ── .env autoload ────────────────────────────────────────────────────────────
// Load `key=value` pairs from the project root .env into process.env, WITHOUT
// overriding variables that were already set (a real environment takes
// precedence). Supports # comments, blank lines, and simple `VAR=value`.
(function loadDotEnv() {
    const file = path.join(__dirname, '.env');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (let raw of text.split(/\r?\n/)) {
        raw = raw.trim();
        if (!raw || raw.startsWith('#')) continue;
        const eq = raw.indexOf('=');
        if (eq <= 0) continue;
        let key = raw.slice(0, eq).trim();
        let val = raw.slice(eq + 1).trim();
        if (key.startsWith('export ')) key = key.slice(7).trim();
        if (!key) continue;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
            val = val.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = val;
    }
})();

const PORT         = Number(process.env.EMULATOR_PORT || 8090);
const PUBLIC_DIR   = path.join(__dirname, 'public');
const DATA_DIR     = path.join(__dirname, 'data');
const SHOTS_DIR    = process.env.EMULATOR_SHOTS_DIR || path.join(DATA_DIR, 'shots');
const DB_PATH      = process.env.EMULATOR_DB || path.join(DATA_DIR, 'emulatorshare.db');
const HOST_TOKEN   = process.env.EMULATOR_HOST_TOKEN || '';
const JWT_SECRET   = process.env.EMULATOR_JWT_SECRET || 'dev-secret-change-me';
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = (process.env.DISCORD_REDIRECT_URI || 'https://emushare.alkonsafe.dpdns.org/').trim();
// Admin panel (/moderator): RELAY_OWNER names the implicit owner (always admin);
// every other admin lives in the `admins` table and is managed from the panel.
const RELAY_OWNER  = (process.env.RELAY_OWNER || '').trim();
const KEYLOG_FILE  = process.env.EMULATOR_KEYLOG_FILE || 'keylog.log';

// ── Logging ──────────────────────────────────────────────────────────────────
const LOG_INFO = process.env.EMULATOR_LOG || 'info'; // 'verbose' | 'info' | 'warn' | 'error'
const LEVELS = { verbose: 0, info: 1, warn: 2, error: 3 };
const LOG_FILE = process.env.EMULATOR_LOG_FILE || 'relay.log';  // set to '' to disable
let logStream = null;
function writeLog(line) {
    if (!LOG_FILE) return;
    try {
        if (!logStream) {
            fs.mkdirSync(path.dirname(path.resolve(LOG_FILE)), { recursive: true });
            logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
            logStream.on('error', () => {});
        }
        logStream.write(line + '\n');
    } catch {}
}
function logAt(level, ...a) {
    if ((LEVELS[level] || 1) < (LEVELS[LOG_INFO] || 1)) return;
    const line = `[${new Date().toISOString()}] [${String(level).toUpperCase().padEnd(7)}] ` + util.format(...a);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line);
    writeLog(line);
}
const log   = (...a) => logAt('info', ...a);
const logV  = (...a) => logAt('verbose', ...a);   // noisiest: per-message / per-frame
const warn  = (...a) => logAt('warn', ...a);
const error = (...a) => logAt('error', ...a);
log(`logging to file: ${path.resolve(LOG_FILE)}`);

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_VIEWERS_PER_CONSOLE = 250;
const MAX_TEXT_FRAME  = 4 * 1024;
const MAX_MEDIA_FRAME = 8 * 1024 * 1024;
const CHAT_MIN_GAP_MS = 800;
const CHAT_MAX_LEN    = 500;
const INPUT_STALE_MS  = 3000;
const TICK_HZ         = 30;

// ── Auth rate limiting ───────────────────────────────────────────────────────
// Password checks use scryptSync, which blocks the event loop (~50-100ms per
// attempt). Unauthenticated POST spam against /api/login or /api/register can
// therefore stall the relay — and every stream riding on it — with no
// credentials at all. Tiny in-memory fixed-window limiter keyed by IP+route;
// no dependencies. (It is deliberately strict: auth is a rare action.)
const AUTH_LIMITS = {
    '/api/login':    { max: 10, windowMs: 60 * 1000 },
    '/api/register': { max: 10, windowMs: 60 * 1000 },
    '/api/discord/auth': { max: 15, windowMs: 60 * 1000 },
};
const authHits = new Map(); // "route|ip" -> { count, resetAt }
function authRateLimited(req, route) {
    const limit = AUTH_LIMITS[route];
    if (!limit) return false;
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = `${route}|${ip}`;
    const now = Date.now();
    let entry = authHits.get(key);
    if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + limit.windowMs };
        authHits.set(key, entry);
        if (authHits.size > 10000) { // opportunistically GC dead windows
            for (const [k, v] of authHits) if (now >= v.resetAt) authHits.delete(k);
        }
    }
    entry.count++;
    if (entry.count > limit.max) {
        warn(`ratelimit: ${route} throttled for ${ip} (${entry.count} in window)`);
        return true;
    }
    return false;
}

// ── SQLite ───────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consoles (
    key         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    image       TEXT,
    category    TEXT,
    description TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    last_seen   INTEGER
  );
  CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bans (
    kind     TEXT NOT NULL,
    value    TEXT NOT NULL,
    reason   TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (kind, value)
  );
`);

// Discord-linked accounts: add column to existing DBs, index non-null rows only.
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'discord_id')) {
    db.exec('ALTER TABLE users ADD COLUMN discord_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id) WHERE discord_id IS NOT NULL');

const qUserByName     = db.prepare('SELECT * FROM users WHERE username = ?');
const qUserById       = db.prepare('SELECT * FROM users WHERE id = ?');
const qUserByDiscord  = db.prepare('SELECT * FROM users WHERE discord_id = ?');
const qCreateUser     = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)');
const qCreateDiscordUser = db.prepare('INSERT INTO users (username, password_hash, created_at, discord_id) VALUES (?,?,?,?)');
const qInsertSession  = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)');
const qDeleteSession  = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const qFindSession    = db.prepare('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?');

const qUpsertConsole  = db.prepare(`
  INSERT INTO consoles (key, name, image, category, description, created_at, updated_at, last_seen)
  VALUES (@key, @name, @image, @category, @description, @created_at, @updated_at, @last_seen)
  ON CONFLICT(key) DO UPDATE SET
    name = excluded.name,
    image = excluded.image,
    category = excluded.category,
    description = excluded.description,
    updated_at = excluded.updated_at,
    last_seen = excluded.last_seen
`);
const qTouchConsole   = db.prepare('UPDATE consoles SET last_seen = ? WHERE key = ?');
const qListConsoles   = db.prepare('SELECT * FROM consoles ORDER BY updated_at DESC');
const qDeleteConsole  = db.prepare('DELETE FROM consoles WHERE key = ?');
const qSetImage       = db.prepare('UPDATE consoles SET image = ?, updated_at = ? WHERE key = ?');

const qCountUsers     = db.prepare('SELECT COUNT(*) AS n FROM users');
const qListUsers      = db.prepare('SELECT id, username, created_at, discord_id FROM users ORDER BY id DESC LIMIT 500');
const qGetAdmin       = db.prepare('SELECT username FROM admins WHERE username = ?');
const qListAdmins     = db.prepare('SELECT username, added_at FROM admins ORDER BY added_at');
const qAddAdmin       = db.prepare('INSERT OR IGNORE INTO admins (username, added_at) VALUES (?,?)');
const qDelAdmin       = db.prepare('DELETE FROM admins WHERE username = ?');
const qListBans       = db.prepare('SELECT kind, value, reason, added_at FROM bans ORDER BY added_at DESC');
const qGetBan         = db.prepare('SELECT kind, value FROM bans WHERE kind = ? AND value = ?');
const qAddBan         = db.prepare('INSERT OR REPLACE INTO bans (kind, value, reason, added_at) VALUES (?,?,?,?)');
const qDelBan         = db.prepare('DELETE FROM bans WHERE kind = ? AND value = ?');
const qBannedUsers    = db.prepare("SELECT value FROM bans WHERE kind = 'user'");
const qDeleteSessionsByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');

// clean expired sessions occasionally
setInterval(() => { try { qDeleteSession.run(Date.now()); } catch {} }, 60 * 60 * 1000);

// ── Password hashing (scrypt, async off the event loop) ─────────────────────
// crypto.scryptSync used to block the whole relay ~50-100ms per attempt (every
// login/register froze ALL consoles). The async form runs on the libuv
// threadpool and leaves the event loop free.
function scrypt(password, salt, keylen) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
    });
}
async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    return `${salt}:${hash}`;
}
async function verifyPassword(password, stored) {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const calc = (await scrypt(password, salt, 64)).toString('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Signed tokens (JWT-like: header.payload.signature) ──────────────────────
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function sign(data) {
    return crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
}
function makeToken(payload, ttlMs) {
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + Math.floor(ttlMs / 1000) };
    const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
    const pl = b64urlJson(body);
    return `${header}.${pl}.${sign(`${header}.${pl}`)}`;
}
function verifyToken(token) {
    if (!token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expect = sign(`${h}.${p}`);
    const a = Buffer.from(s), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
        if (!payload.exp || Math.floor(Date.now() / 1000) >= payload.exp) return null;
        return payload;
    } catch { return null; }
}

// ── Live state: Map<consoleKey, console> ─────────────────────────────────────
//   { key, name, viewers:Map<id,viewer>, hostSock, hostAlive, mode,
//     videoConfig, audioConfig, lastKeyframe, + watchdog timestamps }
const consoles = new Map();

function getConsoleByKey(key) {
    return consoles.get(key);
}
function resolveConsole(id) {
    if (!id) return null;
    return consoles.get(id) || [...consoles.values()].find((c) => c.name === id) || null;
}

function registerConsole(meta) {
    const key = String(meta && meta.key || '').trim().toLowerCase().slice(0, 48);
    if (!key) return null;
    const now = Date.now();
    const row = { key, name: String(meta && meta.name || key).slice(0, 64),
        image: (meta && meta.image) || null,
        category: String(meta && meta.category || '').slice(0, 64),
        description: String(meta && meta.description || '').slice(0, 300),
        created_at: now, updated_at: now, last_seen: now };
    qUpsertConsole.run(row);
    if (!consoles.has(key)) {
        consoles.set(key, makeConsoleState(key, row.name));
    }
    return consoles.get(key);
}

function makeConsoleState(key, name) {
    return {
        key, name,
        motd: null,
        viewers: new Map(),
        hostSock: null, hostAlive: false,
        mode: 'anarchy',            // 'anarchy' | 'democracy'
        lastSentKeys: '',
        democracyBucket: new Map(),
        democracyVoters: new Set(),
        lastDemocracyResult: new Set(),
        democracyUntil: 0,
        videoConfig: null,
        audioConfig: null,
        lastKeyframe: null,
        keyframeRequestedAt: 0,
        hardkeyRequestedAt: 0,
        lastVideoAt: Date.now(),
        reloadSentAt: 0,
        stats: { frames: 0, bytes: 0, since: Date.now() },
        vote: null, voteCooldownUntil: 0,
        games: [],                    // offered games (full-host consoles) [{key,name}]
        currentGame: null,            // key of the game the full host is running
        gameVote: null, gameVoteCooldownUntil: 0,
    };
}

// Full hosts advertise games viewers can vote to launch. The host only sends
// key/name; we defensively strip anything else and dedupe by key.
function sanitizeGameList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const g of list) {
        if (!g || g.key == null) continue;
        const key = String(g.key).slice(0, 48);
        if (out.some((x) => x.key === key)) continue;
        out.push({ key, name: String(g.name || g.key).slice(0, 64), description: String(g.description || '').slice(0, 120) || null });
        if (out.length >= 50) break;
    }
    return out;
}

// ── Media framing ────────────────────────────────────────────────────────────
// [0] uint8  kind  2=video-key 3=video-delta 5=audio-chunk
// [1..8]     f64   timestamp (microseconds)
// [9..]      payload
const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5, SNAP: 6 };
function mediaKind(buf) { return buf.length > 0 ? buf[0] : 0; }

// ── Static file serving ─────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ttf':  'font/ttf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ogg':  'audio/ogg',
    '.ico':  'image/x-icon',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
};

function serveStatic(req, res) {
    let url;
    try {
        url = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
        // Malformed percent-encoding (e.g. "/%") used to throw and surface as a
        // 500; it's just a bad request.
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
        return;
    }
    if (url === '/' || url === '') url = '/index.html';
    const target = path.normalize(path.join(PUBLIC_DIR, url));
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(target, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            // No-cache the html/js/json so viewer edits appear on reload during dev;
            // only immutable media/images keep a short cache.
            'Cache-Control': ['.js', '.mjs', '.json', '.html'].includes(ext)
                ? 'no-cache, must-revalidate'
                : 'public, max-age=3600',
        }).end(data);
    });
}

function serveShot(req, res, url) {
    const key = path.basename(url).replace(/\.(jpg|jpeg|png|webp)$/i, '');
    if (!key) return res.writeHead(404).end('Not found');
    const file = path.join(SHOTS_DIR, `${key}.jpg`);
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-cache, must-revalidate',
        }).end(data);
    });
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(obj));
}
function readBody(req, cap = 32 * 1024) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', (c) => {
            n += c.length;
            if (n > cap) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function consoleShotUrl(key) {
    const file = shotFileFor(key);
    try { if (fs.existsSync(file)) return `/shots/${path.basename(file)}`; } catch {}
    return null;
}

function publicConsole(c) {
    const live = consoles.get(c.key);
    return {
        key: c.key,
        name: c.name,
        image: consoleShotUrl(c.key) || c.image,
        category: c.category,
        description: c.description,
        online: !!(live && live.hostAlive),
        players: live ? live.viewers.size : 0,
    };
}

// ── HTTP handlers ───────────────────────────────────────────────────────────
async function handleRegister(req, res) {
    if (req.method !== 'POST') return json(res, 405, { message: 'method not allowed' });
    if (authRateLimited(req, '/api/register')) return json(res, 429, { message: 'you are a birdvirus rate limiter' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { message: 'bad request' }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (qGetBan.get('ip', clientIp(req))) { log(`auth: register blocked — banned ip ${clientIp(req)}`); return json(res, 403, { message: 'banned' }); }
    if (qGetBan.get('user', username)) { log(`auth: register blocked — banned user "${username}"`); return json(res, 403, { message: 'banned' }); }
    if (username.length < 3 || username.length > 24 || !/^[A-Za-z0-9_.-]+$/.test(username)) {
        logV(`register rejected: bad username "${username}"`);
        return json(res, 400, { message: 'username must be 3-24 chars: letters, numbers, _ . -' });
    }
    if (password.length < 6) { logV(`register rejected: short password for "${username}"`); return json(res, 400, { message: 'password must be at least 6 characters' }); }
    if (qUserByName.get(username)) { logV(`register rejected: username taken "${username}"`); return json(res, 409, { message: 'username already taken' }); }
    qCreateUser.run(username, await hashPassword(password), Date.now());
    log(`auth: new account "${username}" created from ${req.socket.remoteAddress || 'unknown'}`);
    return json(res, 200, { message: 'registered' });
}

async function handleLogin(req, res) {
    if (req.method !== 'POST') return json(res, 405, { message: 'method not allowed' });
    if (authRateLimited(req, '/api/login')) return json(res, 429, { message: 'you are a birdvirus rate limiter' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { message: 'bad request' }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (qGetBan.get('ip', clientIp(req))) { warn(`auth: login blocked — banned ip ${clientIp(req)}`); return json(res, 403, { message: 'banned' }); }
    if (qGetBan.get('user', username)) { warn(`auth: login blocked — banned user "${username}"`); return json(res, 403, { message: 'banned' }); }
    const user = qUserByName.get(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
        warn(`auth: failed login for "${username}"`);
        return json(res, 401, { message: 'invalid username or password' });
    }

    const ttl = 14 * 24 * 60 * 60 * 1000; // 14 days
    const token = makeToken({ sub: user.id, username: user.username }, ttl);
    qInsertSession.run(token, user.id, Date.now(), Date.now() + ttl);
    log(`auth: "${user.username}" logged in (id=${user.id})`);
    return json(res, 200, {
        token,
        user: { id: user.id, username: user.username },
    });
}

// ── Admin panel (/moderator) ────────────────────────────────────────────────
// Access = RELAY_OWNER (implicit) OR a row in the admins table. The panel page
// is served at /moderator and talks to /api/admin/* with the viewer's session
// token as a Bearer header. Bans are enforced on register/login/WS-connect.
function isRelayAdmin(username) {
    if (!username) return false;
    if (RELAY_OWNER && username === RELAY_OWNER) return true;
    return !!qGetAdmin.get(username);
}
// Real client IP. Behind a reverse proxy / cloudflared tunnel every socket is
// local (127.0.0.1), so when the peer is loopback/private we read the IP from
// the proxy headers instead (CF-Connecting-IP set by Cloudflare edge, then
// X-Forwarded-For). Direct connections from public IPs ignore those headers —
// otherwise a client could spoof its way past an IP ban.
const TRUST_PROXY = process.env.EMULATOR_TRUST_PROXY === '1';
function isPrivateIp(ip) {
    return ip === '::1' ||
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) ||
        /^(::1|f[cd][0-9a-f]{2}:)/i.test(ip);
}
function clientIp(req) {
    const direct = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    if (TRUST_PROXY || isPrivateIp(direct)) {
        const cf = req.headers['cf-connecting-ip'];
        if (cf) return String(cf).trim().slice(0, 64);
        const xff = req.headers['x-forwarded-for'];
        if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
    }
    return direct;
}
function userFromReq(req) {
    let token = null;
    const h = String(req.headers['authorization'] || '');
    if (h.toLowerCase().startsWith('bearer ')) token = h.slice(7).trim();
    if (!token) { try { token = new URL(req.url, 'http://x').searchParams.get('token') || null; } catch {} }
    if (!token) return null;
    const payload = verifyToken(token);
    const sess = payload ? qFindSession.get(token, Date.now()) : null;
    return sess ? { id: sess.user_id, username: sess.username } : null;
}
// moderator.html cached in memory (re-read only when the file changes on disk);
// the readFileSync-per-request version blocked the loop on every panel load.
let moderatorCache = null;   // { mtimeMs, html }
async function serveModerator(res) {
    const file = path.join(PUBLIC_DIR, 'moderator.html');
    try {
        const st = await fs.promises.stat(file);
        if (!moderatorCache || moderatorCache.mtimeMs !== st.mtimeMs) {
            moderatorCache = { mtimeMs: st.mtimeMs, html: await fs.promises.readFile(file) };
        }
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('moderator.html missing');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(moderatorCache.html);
}

// Keylog: in-memory ring buffer (served to the panel) + dedicated keylog.log
// file capturing who pressed/released what, on which console.
const keylog = [];
let keylogStream = null;
function recordKeys(cons, v, pressed, released) {
    if (!pressed.length && !released.length) return;
    const entry = { at: Date.now(), user: v.username, console: cons.key, pressed, released };
    keylog.push(entry);
    if (keylog.length > 3000) keylog.splice(0, keylog.length - 3000);
    try {
        if (!keylogStream) {
            fs.mkdirSync(path.dirname(path.resolve(KEYLOG_FILE)), { recursive: true });
            keylogStream = fs.createWriteStream(KEYLOG_FILE, { flags: 'a' });
            keylogStream.on('error', () => {});
        }
        const parts = [];
        if (pressed.length) parts.push(`pressed [${pressed.join(',')}]`);
        if (released.length) parts.push(`released [${released.join(',')}]`);
        keylogStream.write(`[${new Date(entry.at).toISOString()}] user="${entry.user}" console="${entry.console}" ${parts.join(' ')}\n`);
    } catch {}
}

// Search the keylog: filter by user and/or find a "word" = letters the user
// pressed one after the other (e.g. word "corn" matches KeyC→KeyO→KeyR→KeyN in
// consecutive presses, ignoring modifier/non-character keys like Shift/Enter).
function domKeyToChar(k) {
    let m = /^Key([A-Z])$/.exec(k);
    if (m) return m[1].toLowerCase();
    m = /^Digit(\d)$/.exec(k);
    if (m) return m[1];
    m = /^Numpad(\d)$/.exec(k);
    if (m) return m[1];
    if (k === 'Space') return ' ';
    const map = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' };
    return map[k] || null;   // Shift/Enter/arrows/... never count as characters
}
function searchKeylog(userQ, wordQ) {
    const user = String(userQ || '').trim().toLowerCase().slice(0, 32);
    const rawWord = String(wordQ || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 32);
    const entries = keylog.filter((e) => !user || e.user.toLowerCase() === user);
    if (!rawWord) return { user, word: rawWord, matches: [], entries: entries.slice(-300) };
    const events = [];
    for (const e of entries) {
        for (const k of e.pressed || []) {
            const c = domKeyToChar(k);
            if (c != null) events.push({ e, c });
        }
    }
    const chars = events.map((x) => x.c).join('');
    const matches = [];
    let from = 0;
    while (matches.length < 100) {
        const i = chars.indexOf(rawWord, from);
        if (i === -1) break;
        from = i + 1;
        const evts = events.slice(i, i + rawWord.length);
        const evEntries = [...new Set(evts.map((x) => x.e))];   // insertion-ordered
        const ctxStart = Math.max(0, i - 24);
        const ctxEnd = Math.min(chars.length, i + rawWord.length + 24);
        matches.push({
            at: evts[evts.length - 1].e.at,
            user: evts[0].e.user,
            console: evts[0].e.console,
            context: chars.slice(ctxStart, ctxEnd),
            matchStart: i - ctxStart,
            wordLen: rawWord.length,
            events: evEntries.map((e) => ({ at: e.at, console: e.console, pressed: e.pressed, released: e.released })),
        });
    }
    return { user, word: rawWord, matches, entries: [] };
}

async function handleAdminApi(req, res, url) {
    const user = userFromReq(req);
    const admin = !!(user && isRelayAdmin(user.username));
    if (url === '/api/admin/check') {
        return json(res, 200, { loggedIn: !!user, admin, username: user ? user.username : null, owner: !!(user && RELAY_OWNER && user.username === RELAY_OWNER) });
    }
    if (!admin) return json(res, 403, { message: 'no' });

    const route = url.slice('/api/admin/'.length);
    if (req.method === 'GET' && route === 'keysearch') {
        const params = new URL(req.url, 'http://x').searchParams;
        return json(res, 200, searchKeylog(params.get('user'), params.get('word')));
    }
    if (req.method === 'GET' && route === 'panel') {
        const bannedUsers = new Set(qBannedUsers.all().map((r) => r.value));
        const consRows = [...consoles.values()].map((c) => ({
            key: c.key,
            name: c.name,
            online: !!c.hostAlive,
            mode: c.mode || 'anarchy',
            currentGame: c.currentGame || null,
            games: (c.games || []).length,
            viewers: [...c.viewers.values()].map((v) => ({ id: v.id, name: v.username, ip: v.ip || '', joinedAt: v.joinedAt })),
        }));
        return json(res, 200, {
            now: Date.now(),
            owner: RELAY_OWNER,
            status: {
                uptimeSec: Math.round(process.uptime()),
                consoles: consRows.length,
                online: consRows.filter((c) => c.online).length,
                viewers: consRows.reduce((n, c) => n + c.viewers.length, 0),
                users: qCountUsers.get().n,
                hostToken: !!HOST_TOKEN,
                discord: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
                logFile: LOG_FILE || '(stdout only)',
                keylogFile: KEYLOG_FILE || '(disabled)',
            },
            consoles: consRows,
            users: qListUsers.all().map((u) => ({ id: u.id, username: u.username, createdAt: u.created_at, discord: !!u.discord_id, banned: bannedUsers.has(u.username) })),
            admins: qListAdmins.all(),
            bans: qListBans.all(),
            keylog: keylog.slice(-300),
        });
    }

    if (req.method !== 'POST') return json(res, 404, { message: 'unknown admin route' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { message: 'bad request' }); }

    if (route === 'ban' || route === 'unban') {
        const kind = body.kind === 'ip' ? 'ip' : 'user';
        const value = String(body.value || '').trim().slice(0, 64);
        if (!value) return json(res, 400, { message: 'value required' });
        if (route === 'ban') {
            const reason = String(body.reason || '').slice(0, 200);
            qAddBan.run(kind, value, reason, Date.now());
            if (kind === 'user') {
                const u = qUserByName.get(value);
                if (u) qDeleteSessionsByUser.run(u.id);   // kill their tokens now
            }
            // Kick any live viewer matching the ban immediately.
            let kicked = 0;
            for (const c of consoles.values()) {
                for (const v of [...c.viewers.values()]) {
                    if ((kind === 'user' && v.username === value) || (kind === 'ip' && v.ip === value)) {
                        try { v.ws.close(4003, 'banned'); kicked++; } catch {}
                        c.viewers.delete(v.id);
                    }
                }
                broadcastRoster(c);
            }
            log(`admin: ${user.username} banned ${kind} "${value}"${reason ? ` (${reason})` : ''} — kicked ${kicked} live`);
            return json(res, 200, { ok: true, kicked });
        }
        qDelBan.run(kind, value);
        log(`admin: ${user.username} unbanned ${kind} "${value}"`);
        return json(res, 200, { ok: true });
    }

    if (route === 'addadmin' || route === 'removeadmin') {
        const value = String(body.username || '').trim().slice(0, 24);
        if (!/^[A-Za-z0-9_.-]{3,24}$/.test(value)) return json(res, 400, { message: 'bad username' });
        if (route === 'addadmin') {
            qAddAdmin.run(value, Date.now());
            log(`admin: ${user.username} added admin "${value}"`);
        } else {
            if (RELAY_OWNER && value === RELAY_OWNER) return json(res, 400, { message: 'cannot remove the owner' });
            qDelAdmin.run(value);
            log(`admin: ${user.username} removed admin "${value}"`);
        }
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { message: 'unknown admin route' });
}

// ── Discord Activity auth ──────────────────────────────────────────────────
// The viewer opens the page inside a Discord Activity, the SDK hands us a
// one-time `code`, and we exchange it for the user's identify info using the
// client secret (which NEVER leaves the server). On first sight we auto-create
// an account keyed to their Discord user id; afterwards we just log them in.
function shortLog(text, max = 300) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function httpsJSON(method, hostname, pathname, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({ method, hostname, path: pathname, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch {}
                resolve({ status: res.statusCode, json: parsed, text: raw });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function sanitizeDiscordUsername(raw) {
    let u = String(raw || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 24);
    u = u.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
    if (u.length < 3) u = (u + '___').slice(0, 24);
    return u || 'player';
}

function makeUniqueUsername(base, discordId) {
    if (!qUserByName.get(base)) return base;
    const digits = String(discordId).replace(/\D/g, '');
    const idSuffix = digits.slice(-4) || crypto.randomBytes(2).toString('hex');
    const cand = `${base.slice(0, 19)}_${idSuffix}`;
    if (!qUserByName.get(cand)) return cand;
    for (let n = 2; n < 10000; n++) {
        const s = String(n);
        const c = `${base.slice(0, 24 - s.length - 1)}_${s}`;
        if (c.length >= 3 && !qUserByName.get(c)) return c;
    }
    return `${base.slice(0, 21)}_${crypto.randomBytes(2).toString('hex')}`;
}

async function handleDiscordAuth(req, res) {
    if (req.method !== 'POST') return json(res, 405, { message: 'method not allowed' });
    if (authRateLimited(req, '/api/discord/auth')) return json(res, 429, { message: 'you are a birdvirus rate limiter' });
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)
        return json(res, 503, { message: 'discord auth not configured on server' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { message: 'bad request' }); }
    const code = String(body.code || '').trim();
    if (!code) return json(res, 400, { message: 'missing code' });
    const redirectUri = DISCORD_REDIRECT_URI;

    let exchange;
    // NOTE: never log the request body here — it contains DISCORD_CLIENT_SECRET
    // — nor the response body, which contains live access/refresh tokens.
    logV(`discord: exchanging code at discord.com/api/oauth2/token (code=${shortLog(code, 6)}…)`);
    try {
        exchange = await httpsJSON('POST', 'discord.com', '/api/oauth2/token', {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        }, new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        }).toString());
    } catch (e) {
        warn(`discord: token exchange failed: ${e.message}`);
        return json(res, 502, { message: `discord token exchange failed: ${e.message}` });
    }
    logV(`discord: token exchange response status=${exchange.status}`);
    const accessToken = exchange.json && exchange.json.access_token;
    if (!accessToken) {
        const dErr = exchange.json && (exchange.json.error || exchange.json.error_description);
        warn(`discord: token exchange rejected (${exchange.status}) ${shortLog(exchange.text)}`);
        const hint = dErr ? `discord rejection: ${dErr}` : 'discord token exchange failed';
        return json(res, 401, { message: hint });
    }

    let me;
    logV('discord: calling discord.com/api/users/@me');
    try {
        me = await httpsJSON('GET', 'discord.com', '/api/users/@me',
            { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' });
    } catch (e) {
        warn(`discord: identify failed: ${e.message}`);
        return json(res, 502, { message: 'discord identify failed' });
    }
    logV(`discord: identify response status=${me.status}`);
    const discordUser = me.json;
    if (!discordUser || discordUser.error || !discordUser.id || !discordUser.username) {
        warn(`discord: identify rejected (${me.status}) ${shortLog(me.text)}`);
        return json(res, 401, { message: 'discord identify failed' });
    }

    const discordId = String(discordUser.id);
    let user = qUserByDiscord.get(discordId);
    if (!user) {
        const username = makeUniqueUsername(sanitizeDiscordUsername(discordUser.username), discordId);
        const info = qCreateDiscordUser.run(username, await hashPassword(crypto.randomBytes(24).toString('hex')), Date.now(), discordId);
        user = qUserById.get(Number(info.lastInsertRowid));
        log(`auth: "${username}" auto-registered via Discord (discord_id=${discordId})`);
    }

    const ttl = 14 * 24 * 60 * 60 * 1000;
    const token = makeToken({ sub: user.id, username: user.username }, ttl);
    qInsertSession.run(token, user.id, Date.now(), Date.now() + ttl);
    log(`auth: "${user.username}" logged in via Discord (id=${user.id})`);
    return json(res, 200, {
        token,
        user: { id: user.id, username: user.username },
        discord: { id: discordId, username: discordUser.username },
    });
}

function consoleGridToClient() {
    const rows = qListConsoles.all();
    return { consoles: rows.map(publicConsole) };
}

const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const start = Date.now();
    res.on('finish', () => logV(`http ${req.method} ${url} -> ${res.statusCode} (${Date.now() - start}ms)`));
    try {
        if (url === '/api/register') return handleRegister(req, res);
        if (url === '/api/login') return handleLogin(req, res);
        if (url === '/api/discord/auth') return handleDiscordAuth(req, res);
        if (url === '/moderator') return serveModerator(res);
        if (url.startsWith('/api/admin/')) return handleAdminApi(req, res, url);
        if (url === '/api/consoles') {
            // Auth optional for browsing; only listing public metadata.
            return json(res, 200, consoleGridToClient());
        }
        if (url === '/api/health') {
            const online = [...consoles.values()].filter((c) => c.hostAlive).length;
            return json(res, 200, {
                ok: true, consoles: consoles.size, online,
                viewerCount: [...consoles.values()].reduce((n, c) => n + c.viewers.size, 0),
            });
        }
        if (url.startsWith('/shots/')) return serveShot(req, res, url);
        return serveStatic(req, res);
    } catch (err) {
        console.error('[http] error:', err);
        json(res, 500, { message: 'server error' });
    }
});

// ── WebSockets ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_FRAME });

server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    const params = new URL(req.url, 'http://x').searchParams;
    if (url !== '/host' && url !== '/stream') { socket.destroy(); return; }

    // Hosts are token-gated: only our own chromium processes may connect.
    if (url === '/host') {
        const token = params.get('token') || '';
        if (!HOST_TOKEN || token.length !== HOST_TOKEN.length ||
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HOST_TOKEN))) {
            socket.destroy(); return;
        }
    }

    // Viewers must present a signed session token.
    let user = null;
    if (url === '/stream') {
        if (qGetBan.get('ip', clientIp(req))) { warn(`ws: viewer connect blocked — banned ip ${clientIp(req)}`); socket.destroy(); return; }
        const token = params.get('token') || '';
        const payload = verifyToken(token);
        const sess = payload ? qFindSession.get(token, Date.now()) : null;
        if (sess) {
            if (qGetBan.get('user', sess.username)) { warn(`ws: viewer connect blocked — banned user "${sess.username}"`); socket.destroy(); return; }
            user = { id: sess.user_id, username: sess.username };
        } else {
            // Guest mode for local LAN testing without an account.
            if (process.env.EMULATOR_ALLOW_GUEST === '1') user = { id: null, username: 'Guest' };
            else { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
        }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (url === '/host') attachHost(ws, params.get('console') || '');
        else attachViewer(ws, params.get('console') || '', user, clientIp(req));
    });
});

// ── Host side ───────────────────────────────────────────────────────────────
function attachHost(ws, consoleParam) {
    // The host may send a `register` frame naming its console key + metadata.
    // Until then we hold it in a "pending" bucket keyed by its declared console.
    let consoleKey = consoleParam ? consoleParam.toLowerCase().slice(0, 48) : '';
    let cons = consoles.get(consoleKey) || null;
    if (cons && cons.hostSock) { try { cons.hostSock.close(4000, 'replaced'); } catch {} }

    let sawRegister = false, sawFirstFrame = false;
    log(`host ws: connected (console=${consoleKey || '?pending'})`);

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            if (!cons) return;
            if (data.length > MAX_MEDIA_FRAME) return;
            const kind = mediaKind(data);
            const now = Date.now();
            if (kind === KIND.SNAP) {
                handleShot(cons, data.subarray(9));
                return;
            }
            if (kind === KIND.VKEY && data.length > 9) { cons.lastKeyframe = Buffer.from(data); cons.stats.frames++; cons.lastVideoAt = now; }
            else if (kind === KIND.VDELTA) { cons.stats.frames++; cons.lastVideoAt = now; }
            cons.stats.bytes += data.length;
            if (!sawFirstFrame && cons.hostAlive) {
                sawFirstFrame = true;
                log(`host "${cons.name}" (${cons.key}): READY — streaming video to viewers`);
            }
            // Per-frame logging is OFF unless EMULATOR_LOG=verbose, and even
            // then it is rate-limited. Logging on EVERY frame blocks the relay
            // on stdout when the launch console/terminal buffers or pauses
            // output while unfocused (common on Windows Terminal), stalling
            // frame delivery to every viewer. Set EMULATOR_LOG=info (default)
            // to disable these frame lines entirely, or verbose for a ~1/s
            // throughput summary.
            if (LEVELS.verbose < (LEVELS[LOG_INFO] || 0)) {
                // verbose disabled → skip the accounting + log entirely.
            } else {
                const nowSec = now / 1000;
                if (cons.__frameLogSec === undefined) cons.__frameLogSec = 0;
                if (cons.__frameBytes === undefined) cons.__frameBytes = 0;
                cons.__frameBytes += data.length;
                if (nowSec - cons.__frameLogSec >= 1) {
                    if (cons.__frameLogSec > 0) {
                        logV(`host ${cons.key}: ≈${(cons.__frameBytes / 1000) | 0} KiB/s (once per second)`);
                    }
                    cons.__frameLogSec = nowSec;
                    cons.__frameBytes = 0;
                }
            }
            broadcastBinary(cons, data);
            return;
        }
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        switch (msg && msg.t) {
            case 'register': {
                // A host introduces/updates a console. Persist + create live state.
                const meta = msg.console || {};
                if (meta.key) consoleKey = String(meta.key).toLowerCase().slice(0, 48);
                const wasOnline = cons && cons.hostAlive;
                cons = registerConsole({ ...meta, key: consoleKey, last_seen: Date.now() });
                if (!cons) return;
                cons.name = meta.name || consoleKey;
                cons.motd = String(meta.motd || '').slice(0, CHAT_MAX_LEN).trim() || 'Welcome, $user!';
                if (cons.hostSock !== ws) {
                    if (cons.hostSock) { try { cons.hostSock.close(4000, 'replaced'); } catch {} }
                    cons.hostSock = ws;
                    cons.hostAlive = true;
                    cons.lastSentKeys = '';
                    cons.lastVideoAt = Date.now();
                }
                sawRegister = true; sawFirstFrame = false;
                if (!wasOnline) log(`host "${cons.name}" (${consoleKey}): connected & registered, waiting for stream`);
                else log(`host "${cons.name}" (${consoleKey}): re-registered (was already online)`);
                qTouchConsole.run(Date.now(), consoleKey);
                if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'registered', key: consoleKey, name: cons.name }));
                cons.games = sanitizeGameList(meta.games);
                if (cons.games.length) {
                    log(`games: "${cons.key}" advertises ${cons.games.length} launchable game(s)`);
                    broadcastJson(cons, { t: 'games', games: cons.games, current: cons.currentGame });
                }
                break;
            }
            default:
                if (!cons) return;
                if (msg.t === 'vconfig') {
                    cons.videoConfig = msg.config || null;
                    log(`host ${cons.key}: video config ${msg.config ? `${msg.config.codec} ${msg.config.codedWidth}x${msg.config.codedHeight}` : '(null)'}`);
                    broadcastJson(cons, { t: 'vconfig', config: cons.videoConfig });
                }
                else if (msg.t === 'aconfig') {
                    cons.audioConfig = msg.config || null;
                    log(`host ${cons.key}: audio config ${msg.config ? `${msg.config.codec} ${msg.config.sampleRate || ''}Hz` : '(null)'}`);
                    broadcastJson(cons, { t: 'aconfig', config: cons.audioConfig });
                }
                else if (msg.t === 'gamestate') {
                    cons.currentGame = (msg.state && msg.state.game) || null;
                    broadcastJson(cons, { t: 'gamestate', state: msg.state });
                    if (cons.games.length) broadcastJson(cons, { t: 'games', games: cons.games, current: cons.currentGame });
                }
                else if (msg.t === 'log') log(`host:${cons.key}]`, String(msg.text || '').slice(0, 300));
                break;
        }
    });

    ws.on('close', () => {
        if (cons && cons.hostSock === ws) {
            cons.hostSock = null;
            cons.hostAlive = false;
            cons.lastKeyframe = null;
            const wasStreaming = sawFirstFrame;
            log(`host "${cons.key}": disconnected${wasStreaming ? ' (was streaming)' : ''}`);
            broadcastJson(cons, { t: 'host', up: false });
            qTouchConsole.run(Date.now(), cons.key);
        }
    });
    ws.on('error', () => {});
}

function sendHost(cons, obj) {
    if (cons && cons.hostSock && cons.hostSock.readyState === 1) {
        try { cons.hostSock.send(JSON.stringify(obj)); } catch {}
    }
}
function requestKeyframe(cons) {
    const now = Date.now();
    if (now - (cons.keyframeRequestedAt || 0) < 400) return;
    cons.keyframeRequestedAt = now;
    logV(`keyframe: requesting keyframe from host "${cons.key}"`);
    sendHost(cons, { t: 'keyframe' });
}
// Urgent flavor: sent by a viewer whose decoder hit an error. The host restarts
// its video encoder (fresh GOP) for an immediate resync; routine `keyframe` is a
// no-op there because natural GOPs already arrive every second.
function hardKeyframe(cons) {
    const now = Date.now();
    if (now - (cons.hardkeyRequestedAt || 0) < 500) return;
    cons.hardkeyRequestedAt = now;
    logV(`keyframe: URGENT keyframe from host "${cons.key}"`);
    sendHost(cons, { t: 'hardkey' });
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
// The host JPEG-encodes the current frame and pushes it to us as a SNAP frame
// (kind 6). We park it under data/shots/<key>.jpg, expose it at /shots/<key>.jpg
// and flip the console's image to that URL so the grid shows live thumbnails.
// Console keys are host-supplied and only loosely constrained, so EVERY path
// into SHOTS_DIR must go through the same sanitizing helper.
function shotFileFor(key) {
    const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(SHOTS_DIR, `${safe}.jpg`);
}
function requestShot(cons) {
    if (cons && cons.hostSock && cons.hostSock.readyState === 1) {
        logV(`shot: requesting snapshot from host "${cons.key}"`);
        sendHost(cons, { t: 'snapshot' });
    }
}

// Snapshot writes used to be synchronous (writeFileSync) — every thumbnail the
// host pushed stalled the loop on the disk write. Async now, serialized per
// console so two shots for the same console can't interleave mid-file.
const shotWrites = new Map();
function handleShot(cons, payload) {
    if (!cons || !payload || !payload.length) return;
    const file = shotFileFor(cons.key);
    const prev = shotWrites.get(cons.key) || Promise.resolve();
    const next = prev.then(async () => {
        try {
            await fs.promises.writeFile(file, payload);
            const url = `/shots/${path.basename(file)}`;
            qSetImage.run(url, Date.now(), cons.key);
            log(`shot: updated ${cons.key} thumbnail -> ${url} (${payload.length} bytes)`);
        } catch (err) {
            warn(`shot: failed to store ${file}: ${err.message}`);
        }
    });
    shotWrites.set(cons.key, next);
}

// ── Console lifecycle ─────────────────────────────────────────────────────────
// Drop every trace of a console that has gone away: live state (which detaches
// its host socket + kicks its viewers) and its DB row.
function removeConsole(cons) {
    try { qDeleteConsole.run(cons.key); } catch {}
    for (const v of cons.viewers.values()) {
        cons.viewers.delete(v.id);
        try { v.ws.close(4002, 'console-removed'); } catch {}
    }
    if (cons.hostSock) { try { cons.hostSock.close(4003, 'console-removed'); } catch {} }
    cons.hostSock = null;
    cons.hostAlive = false;
    consoles.delete(cons.key);
    try {
        const shot = shotFileFor(cons.key);
        if (fs.existsSync(shot)) fs.unlinkSync(shot);
    } catch {}
}

// ── Viewer side ─────────────────────────────────────────────────────────────
const nextViewerId = (() => { let n = 0; return () => `v${++n}`; })();

function attachViewer(ws, consoleParam, user, ip) {
    const cons = resolveConsole(consoleParam);
    if (!cons) {
        logV(`viewer: rejected — unknown console "${consoleParam}"`);
        ws.send(JSON.stringify({ t: 'welcome', host: false, video: null, audio: null, error: 'unknown-console' }));
        const die = () => { try { ws.close(4004, 'unknown-console'); } catch {} };
        setTimeout(die, 300);
        return;
    }
    if (cons.viewers.size >= MAX_VIEWERS_PER_CONSOLE) {
        warn(`viewer: rejected — console "${cons.key}" full (${MAX_VIEWERS_PER_CONSOLE})`);
        try { ws.close(4001, 'console-full'); } catch {}
        return;
    }

    // One connection per client per console: a second tab/window from the same
    // person is bounced back to the homepage instead of forking their input.
    // Guests (no account) are deduped by IP since they all share the name.
    const dup = [...cons.viewers.values()].find((o) =>
        (user.id != null ? o.username === user.username : (o.userId == null && o.ip === ip)));
    if (dup) {
        if (dup.ws.readyState === 1) {
            log(`viewer: rejected — "${user.username}" already has a tab open on "${cons.key}"`);
            ws.send(JSON.stringify({ t: 'welcome', host: false, video: null, audio: null, error: 'duplicate-client' }));
            const die = () => { try { ws.close(4005, 'duplicate-client'); } catch {} };
            setTimeout(die, 300);
            return;
        }
        // The existing socket is half-dead (gone without a close) — drop it
        // and let this fresh connection take over instead of bouncing them.
        try { dup.ws.close(); } catch {}
        cons.viewers.delete(dup.id);
    }

    const v = {
        id: nextViewerId(),
        ws,
        username: user.username || 'Guest',
        userId: user.id,
        ip: ip || '',
        keys: new Set(),
        keysAt: 0,
        lastChat: 0,
        joinedAt: Date.now(),
    };
    cons.viewers.set(v.id, v);
    log(`viewer "${v.username}" (${v.id}) joined console "${cons.key}" from ${v.ip || '?'} (${cons.viewers.size} online)`);

    const motdText = (cons.motd || '').replace(/\$user|\{user\}/gi, v.username);
    if (motdText && motdText.trim()) {
        log(`motd: ${cons.key} -> chat <Console> ${motdText}`);
        broadcastJson(cons, { t: 'chat', from: 'Console', text: motdText, userId: null, motd: true });
    }

    send(v, {
        t: 'welcome',
        you: { id: v.id },
        console: cons.name,
        host: cons.hostAlive,
        video: cons.videoConfig,
        audio: cons.audioConfig,
        games: cons.games,
        current: cons.currentGame,
    });
    if (cons.lastKeyframe) { try { ws.send(cons.lastKeyframe); } catch {} }
    requestKeyframe(cons);
    broadcastRoster(cons);

    ws.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_TEXT_FRAME) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        handleViewerMsg(cons, v, msg);
    });

    ws.on('close', () => {
        cons.viewers.delete(v.id);
        log(`viewer "${v.username}" (${v.id}) left console "${cons.key}" (${cons.viewers.size} online)`);
        if (cons.vote) {
            cons.vote.yes.delete(v.id);
            cons.vote.no.delete(v.id);
            broadcastJson(cons, voteSnapshot(cons));
            tallyVote(cons);
        }
        if (cons.gameVote) {
            cons.gameVote.yes.delete(v.id);
            cons.gameVote.no.delete(v.id);
            broadcastJson(cons, gameVoteSnapshot(cons));
            tallyGameVote(cons);
        }
        cons.democracyVoters.delete(v.id);
        broadcastRoster(cons);
    });
    ws.on('error', () => {});
}

function handleViewerMsg(cons, v, msg) {
    switch (msg && msg.t) {
        case 'input': {
            const next = new Set();
            if (Array.isArray(msg.keys)) for (const k of msg.keys.slice(0, 16)) if (typeof k === 'string') next.add(k.slice(0, 32));
            if (msg.mouse) {
                if (msg.mouse.rel) {
                    v.mouse = { rel: true, dx: Math.round(+msg.mouse.dx || 0), dy: Math.round(+msg.mouse.dy || 0), click: !!msg.mouse.click, button: +msg.mouse.button || 0 };
                    if (msg.mouse.held === true) v.mouse.held = true;
                    else if (msg.mouse.held === false) v.mouse.held = false;
                } else {
                    v.mouse = { x: +msg.mouse.x || 0, y: +msg.mouse.y || 0, click: !!msg.mouse.click, button: +msg.mouse.button || 0 };
                }
                // Each physical click gets a fresh nonce so two identical clicks
                // at the same position are distinguishable by the host (without
                // this, click 2 looks identical to click 1 in the merge state).
                if (v.mouse.click) { v.clickNonce = (v.clickNonce || 0) + 1; v.mouse.nonce = v.clickNonce; }
            }
            const pressed = [...next].filter((k) => !v.keys.has(k));
            const released = [...v.keys].filter((k) => !next.has(k));
            v.keys = next;
            v.keysAt = Date.now();
            recordKeys(cons, v, pressed, released);
            if (pressed.length) log(`key: ${v.username} (${v.id}) pressed [${pressed.join(',')}] on "${cons.key}"`);
            if (released.length) log(`key: ${v.username} (${v.id}) released [${released.join(',')}] on "${cons.key}"`);
            // Low-latency path: a viewer changed its keys, so forward the merge to
            // the host on this tick-of-event-loop instead of waiting for the next
            // 30Hz poll. The merge functions dedupe identical states, so this is
            // cheap even under rapid key spam.
            if (cons.mode !== 'democracy') flushConsoleInput(cons, Date.now());
            break;
        }
        case 'chat': {
            const now = Date.now();
            if (now - v.lastChat < CHAT_MIN_GAP_MS) return;
            v.lastChat = now;
            const text = String(msg.text || '').slice(0, CHAT_MAX_LEN).trim();
            if (!text) return;
            log(`chat: ${cons.key} <${v.username}> ${text}`);
            broadcastJson(cons, { t: 'chat', from: v.username, text, userId: v.userId });
            break;
        }
        case 'needkey': requestKeyframe(cons); break;
        case 'hardkey': hardKeyframe(cons); break;
        case 'modevote': {
            const want = msg.mode === 'democracy' ? 'democracy' : 'anarchy';
            log(`vote: ${v.username} proposes ${want} mode on "${cons.key}"`);
            openVote(cons, v, want);
            break;
        }
        case 'votecast': castVote(cons, v, msg.yes === true); break;
        case 'gamevote': {
            const game = String(msg.game || '').slice(0, 48);
            log(`gamevote: ${v.username} proposes to launch "${game}" on "${cons.key}"`);
            openGameVote(cons, v, game);
            break;
        }
        case 'gamecast': castGameVote(cons, v, String(msg.game || '').slice(0, 48), msg.yes === true); break;
        default: break;
    }
}

// ── Fan-out ─────────────────────────────────────────────────────────────────
function send(v, obj) {
    if (v.ws.readyState === 1) { try { v.ws.send(JSON.stringify(obj)); } catch {} }
}
function broadcastJson(cons, obj) {
    const s = JSON.stringify(obj);
    for (const v of cons.viewers.values()) {
        if (v.ws.readyState === 1) { try { v.ws.send(s); } catch {} }
    }
}
function broadcastBinary(cons, buf) {
    for (const v of cons.viewers.values()) {
        if (v.ws.readyState !== 1) continue;
        if (v.ws.bufferedAmount > 2 * 1024 * 1024) continue;
        try { v.ws.send(buf); } catch {}
    }
}
function broadcastRoster(cons) {
    const users = [];
    for (const v of cons.viewers.values()) users.push({ id: v.id, name: v.username });
    broadcastJson(cons, { t: 'roster', count: users.length, users: users.slice(0, 60) });
}

// ── Mode votes (per console) ────────────────────────────────────────────────
const VOTE_MS = 20000;
const VOTE_COOLDOWN_MS = 15000;

function votesNeeded(cons) { return Math.floor(cons.viewers.size / 2) + 1; }

function voteSnapshot(cons) {
    const v = cons.vote;
    if (!v) return { t: 'vote', open: false };
    const naming = (ids) => [...ids].map((id) => cons.viewers.get(id)).filter(Boolean)
        .map((x) => ({ id: x.id, name: x.username }));
    return { t: 'vote', open: true, mode: v.mode, by: v.byName,
        yes: naming(v.yes), no: naming(v.no), needed: votesNeeded(cons), endsAt: v.endsAt || 0 };
}

function openVote(cons, v, want) {
    const now = Date.now();
    if (cons.vote) { if (cons.vote.mode === want) castVote(cons, v, true); return; }
    if (want === cons.mode) return;
    if (now < cons.voteCooldownUntil) { send(v, { t: 'notice', text: 'a vote just finished — give it a few seconds' }); return; }
    cons.vote = { mode: want, byName: v.username, byId: v.id, yes: new Set([v.id]), no: new Set(), endsAt: now + VOTE_MS };
    broadcastJson(cons, voteSnapshot(cons));
    tallyVote(cons);
}
function castVote(cons, v, yes) {
    if (!cons.vote) return;
    cons.vote.yes.delete(v.id);
    cons.vote.no.delete(v.id);
    (yes ? cons.vote.yes : cons.vote.no).add(v.id);
    logV(`vote: ${v.username} voted ${yes ? 'yes' : 'no'} (${cons.vote.yes.size} yes / ${cons.vote.no.size} no) on "${cons.key}"`);
    broadcastJson(cons, voteSnapshot(cons));
    tallyVote(cons);
}
function tallyVote(cons) {
    const vote = cons.vote;
    if (!vote) return;
    const need = votesNeeded(cons);
    const expired = Date.now() >= vote.endsAt;
    const passed = vote.yes.size >= need || (expired && vote.yes.size > vote.no.size);
    if (!passed && !expired) return;
    const decidedMode = vote.mode, by = vote.byName;
    cons.vote = null;
    cons.voteCooldownUntil = Date.now() + VOTE_COOLDOWN_MS;
    log(`vote: "${cons.key}" ${passed ? 'PASSED' : 'FAILED'} ${decidedMode} mode (proposed by ${by})`);
    broadcastJson(cons, { t: 'vote', open: false, passed, mode: decidedMode, by });
    if (passed) {
        cons.mode = decidedMode;
        cons.democracyBucket = new Map();
        cons.lastDemocracyResult = new Set();
        log(`mode: "${cons.key}" is now ${decidedMode}`);
        broadcastJson(cons, { t: 'mode', mode: decidedMode, by });
    }
}

// ── Game votes (per console, full-host consoles) ────────────────────────────
// Viewers pick a game from the advertised list, vote, and on a pass the relay
// tells the full host to launch it. Mirrors the mode-vote flow above.
function gameVoteSnapshot(cons) {
    const gv = cons.gameVote;
    if (!gv) return { t: 'gamevote', open: false };
    const naming = (ids) => [...ids].map((id) => cons.viewers.get(id)).filter(Boolean)
        .map((x) => ({ id: x.id, name: x.username }));
    return { t: 'gamevote', open: true, game: gv.game, by: gv.byName,
        yes: naming(gv.yes), no: naming(gv.no), needed: votesNeeded(cons), endsAt: gv.endsAt || 0 };
}

function openGameVote(cons, v, game) {
    const now = Date.now();
    if (!game || !cons.games.some((g) => g.key === game)) return;   // not an offered game
    if (cons.gameVote) return;                                      // a game vote is running
    if (game === cons.currentGame) { send(v, { t: 'notice', text: 'that game is already running' }); return; }
    if (cons.viewers.size > 1 && now < cons.gameVoteCooldownUntil) {
        const remaining = Math.ceil((cons.gameVoteCooldownUntil - now) / 1000);
        log(`gamevote: "${cons.key}" switching blocked by cooldown (${remaining}s) after ${v.username} proposed "${game}"`);
        broadcastJson(cons, { t: 'chat', from: 'Console', text: `Switching is on cooldown! ${remaining}s remain` });
        return;
    }
    cons.gameVote = { game, byName: v.username, byId: v.id, yes: new Set([v.id]), no: new Set(), endsAt: now + VOTE_MS };
    broadcastJson(cons, gameVoteSnapshot(cons));
    tallyGameVote(cons);
}
function castGameVote(cons, v, game, yes) {
    const gv = cons.gameVote;
    if (!gv || game !== gv.game) return;
    gv.yes.delete(v.id);
    gv.no.delete(v.id);
    (yes ? gv.yes : gv.no).add(v.id);
    logV(`gamevote: ${v.username} voted ${yes ? 'yes' : 'no'} (${gv.yes.size} yes / ${gv.no.size} no) on "${cons.key}"`);
    broadcastJson(cons, gameVoteSnapshot(cons));
    tallyGameVote(cons);
}
function tallyGameVote(cons) {
    const gv = cons.gameVote;
    if (!gv) return;
    const need = votesNeeded(cons);
    const expired = Date.now() >= gv.endsAt;
    let passed = gv.yes.size >= need || (expired && gv.yes.size > gv.no.size);
    // A timeout-only pass where the proposer is the sole "yes" while other
    // viewers are in the room: nobody else confirmed, so don't launch.
    if (expired && gv.yes.size === 1 && cons.viewers.size > 1) {
        passed = false;
        log(`gamevote: "${cons.key}" sole yes from ${gv.byName}, ${cons.viewers.size} viewers in room; not launching "${gv.game}"`);
    }
    if (!passed && !expired) return;
    const won = gv.game, by = gv.byName;
    cons.gameVote = null;
    cons.gameVoteCooldownUntil = Date.now() + VOTE_COOLDOWN_MS;
    log(`gamevote: "${cons.key}" ${passed ? 'PASSED' : 'FAILED'} launch of "${won}" (proposed by ${by})`);
    broadcastJson(cons, { t: 'gamevote', open: false, passed, game: won, by });
    if (passed) {
        cons.currentGame = won;
        log(`gamevote: asking host "${cons.key}" to launch "${won}"`);
        sendHost(cons, { t: 'launch', game: won });
        if (cons.games.length) broadcastJson(cons, { t: 'games', games: cons.games, current: cons.currentGame });
    }
}

// ── Controller merge (per console) ──────────────────────────────────────────
function mergeAnarchy(cons, active) {
    const out = new Set();
    const mouse = [];
    for (const v of active) {
        for (const k of v.keys) out.add(k);
        const m = v.mouse;
        // Clicks always forward; relative camera deltas forward as movement,
        // and so do button hold transitions. Zero-delta camera reports carry no
        // motion, so skip those unless they are a hold change.
        if (m && (m.click || (m.rel && ((m.dx || m.dy) || m.held !== undefined)))) mouse.push(m);
    }
    return { keys: out, mouse };
}
function mergeDemocracy(cons, active) {
    const now = Date.now();
    for (const v of active) {
        for (const k of v.keys) {
            if (!cons.democracyBucket.has(k)) cons.democracyBucket.set(k, new Set());
            cons.democracyBucket.get(k).add(v.id);
        }
        if (v.keys.size > 0) cons.democracyVoters.add(v.id);
    }
    if (now < cons.democracyUntil) return { keys: cons.lastDemocracyResult, mouse: [] };
    cons.democracyUntil = now + 400;
    const voters = cons.democracyVoters.size, out = new Set();
    if (voters > 0) {
        const threshold = Math.floor(voters / 2) + 1;
        for (const [k, who] of cons.democracyBucket) if (who.size >= threshold) out.add(k);
    }
    cons.democracyBucket = new Map();
    cons.democracyVoters = new Set();
    cons.lastDemocracyResult = out;
    return { keys: out, mouse: [] };
}

function flushConsoleInput(cons, now) {
    const active = [];
    for (const v of cons.viewers.values()) {
        if (now - v.keysAt > INPUT_STALE_MS) v.keys = new Set();
        active.push(v);
    }
    const merged = cons.mode === 'democracy' ? mergeDemocracy(cons, active) : mergeAnarchy(cons, active);
    const serialized = [...merged.keys].sort().join(',') + '|' +
        (merged.mouse.length ? merged.mouse.map((m) => m.rel ? `r${m.dx},${m.dy},${m.held === true ? 1 : m.held === false ? 0 : ''},${m.button}:${m.nonce || 0}` : `${m.x},${m.y},${m.button}:${m.nonce || 0}`).join(';') : '');
    // Consume clicks as soon as they're sent: a stored click:true would otherwise
    // be re-merged on every later input message (keys/keepalive) and re-trigger
    // mousedown+mouseup on the host, so one physical click becomes many.
    for (const v of active) if (v.mouse && v.mouse.click) v.mouse = null;
    if (serialized !== cons.lastSentKeys || merged.mouse.some((m) => m.click)) {
        cons.lastSentKeys = serialized;
        logV(`input: sending merged ${merged.keys.size} key(s) to host "${cons.key}"`);
        // Prefer the latest click so a follow-up camera delta never masks it.
        let fwdMouse = null;
        for (let i = merged.mouse.length - 1; i >= 0; i--) {
            if (merged.mouse[i].click) { fwdMouse = merged.mouse[i]; break; }
        }
        if (!fwdMouse && merged.mouse.length) fwdMouse = merged.mouse[merged.mouse.length - 1];
        sendHost(cons, { t: 'input', keys: [...merged.keys], mouse: fwdMouse });
        broadcastJson(cons, { t: 'held', keys: [...merged.keys] });
    }
}
// Forward input to the host immediately on arrival, so keystrokes don't queue
// up to a full 30Hz tick (~33ms) of extra latency. The tick below remains as a
// safety net: stale-key expiry, democracy settle windows, and recovery if a
// console wakes with no input message in flight.
setInterval(() => {
    const now = Date.now();
    for (const cons of consoles.values()) flushConsoleInput(cons, now);
}, Math.round(1000 / TICK_HZ));

// ── Watchdog (per console) + keyframe + stats ───────────────────────────────
setInterval(() => {
    for (const cons of consoles.values()) {
        if (!cons.hostAlive) { cons.lastVideoAt = Date.now(); continue; }
        const stalled = Date.now() - cons.lastVideoAt;
        if (stalled > 75000) {
            error(`[${cons.key}] no video for ${(stalled / 1000) | 0}s — exiting for restart`);
            process.exit(1);
        }
        if (stalled > 20000 && Date.now() - cons.reloadSentAt > 75000) {
            cons.reloadSentAt = Date.now();
            warn(`[${cons.key}] no video — reloading host page`);
            sendHost(cons, { t: 'reload' });
        }
    }
}, 5000);

setInterval(() => {
    for (const cons of consoles.values()) {
        if (cons.viewers.size > 0) requestKeyframe(cons);
        if (cons.vote) tallyVote(cons);
        if (cons.gameVote) tallyGameVote(cons);
    }
}, 2000);

// ── Console pruning ───────────────────────────────────────────────────────────
// Any console that has been DOWN (host disconnected / not registered) for more
// than 2 minutes is removed entirely: kicked from live state, dropped from the
// DB, and its thumbnail deleted. Consoles reappear automatically the moment a
// host re-registers, so this only keeps the grid from piling up with dead rows.
const PRUNE_AFTER_MS = 2 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const row of qListConsoles.all()) {
        const live = consoles.get(row.key);
        if (live && live.hostAlive) continue; // still up — skip
        const lastSeen = row.last_seen || row.updated_at || 0;
        if (!lastSeen || now - lastSeen < PRUNE_AFTER_MS) continue;
        const downForMin = Math.round((now - lastSeen) / 60000);
        log(`prune: console "${row.key}" down for ${downForMin} min — removing`);
        if (live) removeConsole(live);
        else try { qDeleteConsole.run(row.key); } catch {}
    }
}, 30000);

// ── Thumbnail refresh ─────────────────────────────────────────────────────────
// Every 5 minutes, ask every live host to JPEG-encode its current frame; handleShot
// stores it and flips the console's image URL to the new snapshot.
setInterval(() => {
    for (const cons of consoles.values()) {
        if (cons.hostAlive) requestShot(cons);
    }
}, 5 * 60 * 1000);

setInterval(() => {
    for (const cons of consoles.values()) {
        const secs = (Date.now() - cons.stats.since) / 1000;
        if (secs > 30) {
            log(`[${cons.key}] ${cons.viewers.size} viewer(s) | ${(cons.stats.frames / secs).toFixed(1)} fps | ` +
                `${(cons.stats.bytes / secs / 1024).toFixed(0)} KiB/s | host=${cons.hostAlive}`);
            cons.stats = { frames: 0, bytes: 0, since: Date.now() };
        }
    }
}, 30000);

server.listen(PORT, process.env.EMULATOR_BIND || '0.0.0.0', () => {
    log(`🕹 emulatorSHARE relay listening on ${process.env.EMULATOR_BIND || '0.0.0.0'}:${PORT}`);
    log(`   viewers: ws://…/stream?console=KEY   hosts: ws://…/host?token=…&console=KEY`);
    log(`   db: ${DB_PATH}   host token: ${HOST_TOKEN ? 'configured' : 'NOT SET (hosts refused)'}   log level: ${LOG_INFO}`);
    log(`   (set EMULATOR_LOG=verbose|info|warn|error to control log detail)`);
});
