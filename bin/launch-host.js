#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// emulatorSHARE — standalone console HOST launcher.
//
// Run this on ANY machine with headless Chromium to stream a console into a
// running relay on another computer:
//
//   npm run host-console -- --url ws://my-server:8090 --token HOST_TOKEN \
//       --console mario64 --dir consoles/mario64
//
// Flow: this process boots a local static server for the console's host page
// + binaries, waits for it, then launches headless Chromium pointed at that
// page with `relay=<your relay ws url>/host`, `token=…`, `console=…`. The
// console registers itself with the relay the moment it connects. Viewers on
// the server then see and play it.
//
// There is no WebCodecs (video/audio encoding) in Node — that happens inside
// the Chromium this launches. This script is only the launcher / supervisor.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ── .env autoload ────────────────────────────────────────────────────────────
(function loadDotEnv() {
    const file = path.join(ROOT, '.env');
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

// ── CLI + env config ─────────────────────────────────────────────────────────
function arg(name, def, altEnv) {
    if (process.env[altEnv]) return process.env[altEnv];
    const i = process.argv.indexOf(name);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    return def;
}
function flag(name) { return process.argv.includes(name); }

const relayUrl  = arg('--url', process.env.EMULATOR_RELAY_URL || 'ws://127.0.0.1:8090', 'EMULATOR_RELAY_URL');
const hostToken = arg('--token', process.env.EMULATOR_HOST_TOKEN || '', 'EMULATOR_HOST_TOKEN');
const consoleKey = arg('--console', process.env.EMULATOR_CONSOLE || '', 'EMULATOR_CONSOLE');
const consoleDir = arg('--dir', process.env.EMULATOR_CONSOLE_DIR || '', 'EMULATOR_CONSOLE_DIR');
const name      = arg('--name', '', 'EMULATOR_META_NAME');
const image     = arg('--image', '', 'EMULATOR_META_IMAGE');
const category  = arg('--category', '', 'EMULATOR_META_CATEGORY');
const description = arg('--desc', '', 'EMULATOR_META_DESC');
const w         = Number(arg('--w', process.env.EMULATOR_W || '480', 'EMULATOR_W'));
const h         = Number(arg('--h', process.env.EMULATOR_H || '270', 'EMULATOR_H'));
const fps       = Number(arg('--fps', process.env.EMULATOR_FPS || '30', 'EMULATOR_FPS'));
const bitrate   = Number(arg('--bitrate', process.env.EMULATOR_BITRATE || '1800000', 'EMULATOR_BITRATE'));
const localPort = Number(arg('--port', '8091', 'HOST_STATIC_PORT'));
const profileDir = arg('--profile', path.join(ROOT, 'data', 'profiles'), 'EMULATOR_PROFILE_DIR');

function usage() {
    console.log(`
emulatorSHARE — standalone console host

Usage:
  npm run host-console -- --url <relay-ws-url> --token <HOST_TOKEN> [options]

Options:
  --url       <ws://ip:port>   Your server's relay websocket (this appends /host)
  --token     <HOST_TOKEN>      The server's EMULATOR_HOST_TOKEN
  --console   <key>            Console key to register (default: dir basename)
  --dir       <path>           Local console folder (default: consoles/<key>)
  --name | --image | --category | --desc
                              Console metadata shown in the viewer grid
  --w --h --fps --bitrate    Pixel size / frame rate / bitrate of the stream
  --port                      Local static-server port (default 8091)
  --profile                   Chromium profile dir (holds saves)
  --interactive                Prompt for anything missing instead of failing

Example:
  npm run host-console -- --url ws://192.168.1.20:8090 \\
      --token abc123 --console mario64 --dir consoles/mario64 \\
      --name "Super Mario 64" --category "Nintendo 64"
`);
}

// ── Find a usable headless-capable browser ──────────────────────────────────
function findChromium() {
    const env = process.env.CHROME_BIN || process.env.EMULATOR_CHROME;
    if (env && fs.existsSync(env)) return env;
    const candidates = (process.platform === 'win32')
        ? [ 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' ]
        : [ 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'msedge', 'microsoft-edge' ];
    if (process.platform === 'win32') {
        for (const c of candidates) if (fs.existsSync(c)) return c;
        // The commands might still resolve via PATH (Edge/Chrome install shortcuts).
        for (const c of ['chrome', 'msedge']) {
            const r = spawnSync(c, ['--version'], { shell: true, stdio: 'ignore' });
            if (r.status === 0 || r.error === undefined) return c;
        }
        // One last fallback: anywhere on PATH.
        const which = spawnSync('where', ['chrome'], { shell: true, stdio: ['ignore','pipe','ignore'] });
        if (which.status === 0) return which.stdout.toString().split(/\r?\n/)[0];
        return null;
    }
    for (const c of candidates) {
        const r = spawnSync('which', [c], { stdio: 'ignore' });
        if (r.status === 0) return c;
    }
    return null;
}

// ── Configure the console dir ────────────────────────────────────────────────
function resolveConsoleDir() {
    const key = consoleKey;
    if (consoleDir) return { key: key || path.basename(path.resolve(consoleDir)), dir: path.resolve(consoleDir) };
    const d = path.join(ROOT, 'consoles', key);
    return { key, dir: d };
}

// ── Boot the local static server for the console ─────────────────────────────
function startStaticServer(dir, key) {
    const child = spawn(process.execPath, [path.join(ROOT, 'host', 'serve-host.js')], {
        env: { ...process.env, HOST_STATIC_PORT: String(localPort), CONSOLE_KEY: key, CONSOLE_DIR: dir },
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    return child;
}

function waitFor(host, port) {
    return new Promise((resolve, reject) => {
        const net = require('net');
        let tries = 0;
        const t = setInterval(() => {
            const s = net.connect(port, host);
            s.once('connect', () => { s.destroy(); clearInterval(t); resolve(); });
            s.once('error', () => { if (++tries > 50) { clearInterval(t); reject(new Error('static server never came up')); } });
        }, 200);
        setTimeout(() => { clearInterval(t); }, 15000);
    });
}

function stopChildren(children) {
    for (const c of children) try { c.kill(); } catch {}
    process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    if (flag('--help') || flag('-h')) { usage(); process.exit(0); }
    if (!hostToken && flag('--interactive')) {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q, def) => new Promise((r) => rl.question(`${q}${def ? ` [${def}]` : ''}: `, (a) => r(a || def)));
        const u = await ask('Relay ws url', relayUrl);
        const t = await ask('Host token');
        const c = await ask('Console key', consoleKey);
        process.env.EMULATOR_RELAY_URL = u; process.env.EMULATOR_HOST_TOKEN = t; process.env.EMULATOR_CONSOLE = c;
        rl.close();
        return main();
    }
    if (!hostToken) { console.error('ERROR: --token (EMULATOR_HOST_TOKEN) is required. Use --interactive or pass --token.'); usage(); process.exit(1); }
    return main();
})();

async function main() {
    const relay = String(relayUrl).replace(/\/$/, '');
    // Document/accept both a bare base url and a full /host ws url.
    const relayWs = relay.endsWith('/host') ? relay : `${relay}/host`;

    const { key, dir } = resolveConsoleDir();
    if (!key) { console.error('ERROR: unknown console key. Pass --console <key> or --dir <path>.'); process.exit(1); }
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
        console.error(`ERROR: no index.html in console dir "${dir}".`);
        process.exit(1);
    }

    const chromium = findChromium();
    if (!chromium) {
        console.error('ERROR: could not find a headless-capable Chromium/Edge binary.');
        console.error('  Set CHROME_BIN=/path/to/chrome or install Chromium.');
        process.exit(1);
    }
    console.log(`[host] console key : ${key}`);
    console.log(`[host] console dir : ${dir}`);
    console.log(`[host] relay ws    : ${relayWs}`);
    console.log(`[host] chromium    : ${chromium}`);

    const stat = startStaticServer(dir, key);
    await waitFor('127.0.0.1', localPort).catch(() => {});
    fs.mkdirSync(profileDir, { recursive: true });

    const hostUrl =
        `http://127.0.0.1:${localPort}/?relay=${encodeURIComponent(relayWs)}` +
        `&token=${encodeURIComponent(hostToken)}` +
        `&console=${encodeURIComponent(key)}` +
        `&name=${encodeURIComponent(name || key)}` +
        `&image=${encodeURIComponent(image)}` +
        `&category=${encodeURIComponent(category)}` +
        `&desc=${encodeURIComponent(description)}` +
        `&fps=${fps}&bitrate=${bitrate}&w=${w}&h=${h}`;

    const browser = spawn(chromium, [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        // Disable native-window occlusion detection: without this, Windows
        // reports the headless host window as "occluded" when the viewer window
        // takes focus, which throttles rAF/MediaStream and slows the emulator
        // (game + audio stutter). This is the flag that actually stops that.
        '--disable-features=CalculateNativeWinOcclusion',
        '--hide-scrollbars',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        `--window-size=${w},${h}`,
        `--user-data-dir=${profileDir}`,
        '--enable-logging=stderr',
        '--v=0',
        hostUrl,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    console.log('[host] console running. Ctrl+C to stop.');
    console.log(`[host] stream available at ${relay.replace(/^ws/, 'http')}/ once two+ viewers join.`);

    browser.on('exit', (code) => {
        console.log(`[host] chromium exited (${code}).`);
        stopChildren([stat, browser]);
    });
    browser.on('error', (err) => { console.error('chromium error:', err.message); stopChildren([stat, browser]); });
    process.on('SIGINT', () => stopChildren([stat, browser]));
    process.on('SIGTERM', () => stopChildren([stat, browser]));
}