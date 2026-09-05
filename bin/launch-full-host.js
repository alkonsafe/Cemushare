#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// emulatorSHARE — FULL host (a whole Linux desktop, not a Chromium tab).
//
// Normal consoles stream a single WASM emulator running inside headless
// Chromium. This host instead spins up a REAL Linux desktop:
//
//   Xvfb         virtual X display (the "screen" viewers see)
//   xfwm4        a window manager so launched games get decorated windows
//   pulseaudio   a virtual audio server with a null sink (game audio + mic)
//
// and then encodes that desktop to the same wire format the relay already
// speaks, so all existing viewers work unchanged:
//
//   ffmpeg -f x11grab → libvpx (VP8) → IVF   video (keyframes inline, no desc)
//   ffmpeg -f pulse   → libopus (Opus)      → Ogg   audio
//
// The games available on this host are described by a games.json file; viewers
// vote on which one to launch. When a vote passes, the relay replies `launch`
// and we start that game's command on the virtual display. Input from viewers
// is replayed onto the display with xdotool (keys, mouse, clicks).
//
// Linux only — every tool this needs is a native Linux binary.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

// A silent death right after spawn is the worst kind to debug — make every
// crash loud: log the stack, then exit(1) so the shell/npm reports a failure.
process.on('uncaughtException', (err) => {
    console.error('[full] FATAL uncaught exception:', err);
    console.error(err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[full] FATAL unhandled rejection:', reason);
    if (reason && reason.stack) console.error(reason.stack);
    process.exit(1);
});

// ── .env autoload (same as launch-host.js) ─────────────────────────────────
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

// ── CLI + env config ────────────────────────────────────────────────────────
function arg(name, def, altEnv) {
    if (process.env[altEnv]) return process.env[altEnv];
    const i = process.argv.indexOf(name);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    return def;
}
function flag(name) { return process.argv.includes(name); }

const relayUrl   = arg('--url', process.env.EMULATOR_RELAY_URL || 'ws://127.0.0.1:8090', 'EMULATOR_RELAY_URL');
const hostToken  = arg('--token', process.env.EMULATOR_HOST_TOKEN || '', 'EMULATOR_HOST_TOKEN');
const consoleKey = arg('--console', process.env.EMULATOR_CONSOLE || '', 'EMULATOR_CONSOLE');
const name       = arg('--name', '', 'EMULATOR_META_NAME');
const image      = arg('--image', '', 'EMULATOR_META_IMAGE');
const category   = arg('--category', '', 'EMULATOR_META_CATEGORY');
const description = arg('--desc', '', 'EMULATOR_META_DESC');
const motd       = arg('--motd', '', 'EMULATOR_META_MOTD');
const gamesPath  = arg('--games', process.env.EMULATOR_GAMES_JSON || path.join(ROOT, 'games.json'), 'EMULATOR_GAMES_JSON');
const w          = Number(arg('--w', process.env.EMULATOR_W || '640', 'EMULATOR_W'));
const h          = Number(arg('--h', process.env.EMULATOR_H || '480', 'EMULATOR_H'));
const fps        = Number(arg('--fps', process.env.EMULATOR_FPS || '30', 'EMULATOR_FPS'));
const bitrate    = Number(arg('--bitrate', process.env.EMULATOR_BITRATE || '1800000', 'EMULATOR_BITRATE'));
const display    = Number(arg('--display', '99', 'EMULATOR_DISPLAY'));
const resX       = Number(arg('--resx', String(w), 'EMULATOR_RES_X'));
const resY       = Number(arg('--resy', String(h), 'EMULATOR_RES_Y'));
const videoCodec = arg('--video-codec', process.env.EMULATOR_VIDEO_CODEC || 'h264', 'EMULATOR_VIDEO_CODEC');
const videoCapturePath = arg('--vcapture', '', 'EMULATOR_VCAPTURE');

function usage() {
    console.log(`
emulatorSHARE — full host (a real Linux desktop)

Usage:
  npm run host-full -- --url <relay-ws-url> --token <HOST_TOKEN> --console <key> [options]

Options:
  --url       <ws://ip:port>   Your server's relay websocket (this appends /host)
  --token     <HOST_TOKEN>      The server's EMULATOR_HOST_TOKEN
  --console   <key>            Console key to register (e.g. "playground")
  --name | --image | --category | --desc
                               Console metadata shown in the viewer grid
  --motd                    Message the console posts to chat when someone joins
  --games     <path>          games.json describing the games viewers can launch
  --resx --resy              Virtual display resolution (default = --w x --h)
  --w --h --fps --bitrate    Pixel size / frame rate / bitrate of the stream
  --video-codec <h264|vp8>  Encoder for the video stream (default h264)
  --display   <N>            Xvfb display number (default 99)
  --vcapture  <file>         Tee exact raw video bytes (IVF or Annex-B) to a file for offline repro
  --check                   Verify required binaries + games.json and exit

Example:
  npm run host-full -- --url ws://192.168.1.20:8090 --token abc123 \\
      --console playground --name "Linux Playground" --games games.json
`);
}

// ── Toolbox ──────────────────────────────────────────────────────────────────
function bin(name) {
    const r = spawnSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout.toString().trim() : null;
}

const REQUIRED = ['Xvfb', 'xfwm4', 'pulseaudio', 'pactl', 'ffmpeg', 'xdotool'];
function checkTools() {
    const missing = REQUIRED.filter((t) => !bin(t));
    if (missing.length) {
        console.error('ERROR: missing required tools for full-host: ' + missing.join(', '));
        console.error('  Install with: sudo apt install xvfb xfwm4 pulseaudio ffmpeg xdotool');
        return false;
    }
    // The ffmpeg build must actually ship the encoders we rely on — if they are
    // missing both capture processes exit instantly (which looks like the host
    // "just closes" right after "starting video capture").
    const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString();
    const missingEnc = [];
    if (!enc.includes('libvpx')) missingEnc.push('libvpx (VP8 video)');
    if (!enc.includes('libopus')) missingEnc.push('libopus (Opus audio)');
    if (missingEnc.length) {
        console.error('ERROR: this ffmpeg build is missing encoders: ' + missingEnc.join(', '));
        console.error('  Install ffmpeg with libvpx + libopus (e.g. sudo apt install ffmpeg builds with both).');
        return false;
    }
    return true;
}

// ── games.json ───────────────────────────────────────────────────────────────
let GAMES = [];          // validated [{key, name, command[], cwd, env}]
function loadGames() {
    if (!fs.existsSync(gamesPath)) {
        console.error(`WARNING: no games.json at "${gamesPath}" — viewers can watch but not launch anything.`);
        console.error('  Create it like this:');
        console.error('  { "games": [ { "key": "dosbox", "name": "DOSBox", "command": ["/usr/bin/dosbox"] } ] }');
        return;
    }
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(gamesPath, 'utf8')); }
    catch (err) { console.error(`ERROR: games.json at "${gamesPath}" is not valid JSON: ${err.message}`); return; }
    const list = Array.isArray(cfg) ? cfg : cfg.games;
    if (!Array.isArray(list)) { console.error('ERROR: games.json must be an array or { "games": [...] }'); return; }
    GAMES = list.map((g, i) => {
        const key = String(g && g.key || ('game' + (i + 1))).trim().slice(0, 48);
        const cmd = (Array.isArray(g.command) ? g.command : [g.command]).filter((x) => typeof x === 'string' && x.length);
        return { key, name: String(g.name || key).slice(0, 64),
                 command: cmd, cwd: (g.cwd && String(g.cwd)) || null,
                 env: (g.env && typeof g.env === 'object') ? g.env : {} };
    }).filter((g) => g.command.length);
    console.log(`[full] loaded ${GAMES.length} game(s) from ${gamesPath}`);
    for (const g of GAMES) console.log(`[full]   - ${g.key}: ${g.name}`);
}
function sanitizeGames() { return GAMES.map((g) => ({ key: g.key, name: g.name })); }

// ── Runtime dir (X11 + pulse share this) ────────────────────────────────────
function makeRuntimeDir() {
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), `es-full-${consoleKey || 'host'}-`));
    try { fs.chmodSync(rt, 0o700); } catch {}
    return rt;
}

const displayStr = `:${display}`;
let RUNTIME_DIR = null;   // set in main(); children need it to reach OUR pulse server
function childEnv(extra) {
    const env = { ...process.env, DISPLAY: displayStr };
    if (RUNTIME_DIR) {
        // Points every child (ffmpeg, games) at the pulse server we started,
        // not whatever default audio server happens to be running on the box.
        env.XDG_RUNTIME_DIR = RUNTIME_DIR;
        env.PULSE_SERVER = `unix:${path.join(RUNTIME_DIR, 'pulse/native')}`;
    }
    return Object.assign(env, extra || {});
}

// ── Process plumbing ──────────────────────────────────────────────────────────
const children = [];
function track(child) { children.push(child); return child; }
// A spawn that fails to start (ENOENT/EACCES) fires an `error` event; with no
// listener that is an uncaught exception that kills the whole host. Always
// attach one so a broken child can never take the host down with it.
function onSpawnError(label) {
    return (err) => console.error(`[full] ${label}: failed to start — ${err.message}`);
}
// Plain kill for non-detached children (Xvfb/xfwm4/pulse/ffmpeg) — negative-pid
// kills would signal our own process group.
function tryKill(child, sig = 'SIGTERM') {
    if (!child || !child.pid) return;
    try { child.kill(sig); } catch {}
}
// Games are spawned detached into their own process group so we can reap the
// whole tree (the game + every process it spawns) with one group signal.
function killGameTree(child, sig) {
    if (!child || !child.pid) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}
function stopAll() {
    if (gameChild) killGameTree(gameChild, 'SIGKILL');
    for (const c of children) tryKill(c, 'SIGKILL');
    process.exit(0);
}

// ── 1) Start Xvfb (virtual display) ──────────────────────────────────────────
function startXvfb(rt) {
    const screen = `${resX || w}x${resY || h}x24`;
    const xvfb = track(spawn('Xvfb', [displayStr, '-screen', '0', screen, '-nolisten', 'tcp'],
        { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    xvfb.on('error', onSpawnError('Xvfb'));
    xvfb.stdout.on('data', () => {});
    xvfb.stderr.on('data', (d) => process.stderr.write(d));
    return xvfb;
}
function waitForDisplay(timeoutMs = 15000, graceMs = 400) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const t = setInterval(() => {
            // Poll with xdotool (already required) — it only succeeds once Xvfb
            // accepts real X clients.
            const r = spawnSync('xdotool', ['getdisplaygeometry'], { env: childEnv(), stdio: 'ignore' });
            if (r.status === 0) { clearInterval(t); setTimeout(resolve, graceMs); }
            else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('Xvfb never came up')); }
        }, 200);
    });
}

// ── 2) Start pulseaudio + null sink (game audio source) ──────────────────────
let pulse = null;
let sinkName = 'fullsink';
function startPulse(rt) {
    const pulseEnv = { ...process.env, XDG_RUNTIME_DIR: rt };
    pulse = track(spawn('pulseaudio',
        ['--daemonize=no', '--disallow-exit', '--exit-idle-time=-1'],
        { env: pulseEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
    pulse.on('error', onSpawnError('pulseaudio'));
    pulse.stderr.on('data', () => {});
    pulse.stdout.on('data', () => {});
    return new Promise((resolve) => {
        let tries = 0;
        const t = setInterval(() => {
            const r = spawnSync('pactl', ['info'], { env: pulseEnv, stdio: 'ignore' });
            if (r.status === 0) { clearInterval(t); resolve(); }
            else if (++tries > 60) { clearInterval(t); resolve(); }
        }, 250);
    });
}
function setupNullSink(rt) {
    const pulseEnv = { ...process.env, XDG_RUNTIME_DIR: rt };
    spawnSync('pactl', ['load-module', 'module-null-sink', `sink_name=${sinkName}`, 'sink_properties=device.description=FullHostSink'],
        { env: pulseEnv, stdio: 'ignore' });
    spawnSync('pactl', ['set-default-sink', sinkName], { env: pulseEnv, stdio: 'ignore' });
    const src = spawnSync('pactl', ['list', 'short', 'sources'], { env: pulseEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    log('pulse sources:\n' + src.stdout.toString().trim() || '(none)');
}

// ── 3) Start xfwm4 (window manager) ──────────────────────────────────────────
function startWm() {
    const wm = track(spawn('xfwm4', [], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    wm.on('error', onSpawnError('xfwm4'));
    wm.stderr.on('data', () => {});
    wm.stdout.on('data', () => {});
    return wm;
}

// ── 4 + 5) ffmpeg capture → IVF (video) / Ogg (audio) ────────────────────────
const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5, SNAP: 6 };

let ws = null, wsReady = false, videoProc = null, audioProc = null, videoSplitter = null;
let lastKeyTs = 0;               // monotonic µs stamps (Date.now can jump)
function ts() { lastKeyTs = Math.max(lastKeyTs + 1, Date.now() * 1000); return lastKeyTs; }

function frame(kind, time, payload) {
    const out = Buffer.alloc(9 + payload.length);
    out[0] = kind;
    out.writeDoubleLE(time, 1);
    Buffer.from(payload).copy(out, 9);
    return out;
}
function sendMedia(kind, time, payload) {
    if (!payload.length) return;   // decoder chokes on empty buffers
    if (!wsReady || !ws || (ws.bufferedAmount || 0) > 4 * 1024 * 1024) return;
    try { ws.send(frame(kind, time, payload)); } catch {}
}

// -- IVF reader (video) -------------------------------------------------------
// Optional --vcapture <file>: tee raw ffmpeg stdout (exact IVF bytes the relay
// sees) to a file so a bad frame can be replayed offline through the repro.
const vcap = (() => {
    const fs = require('fs');
    const { Transform } = require('stream');
    if (!videoCapturePath) return null;
    const dest = fs.createWriteStream(videoCapturePath);
    dest.on('error', () => {});
    const t = new Transform({
        transform(chunk, enc, cb) {
            dest.write(chunk);
            cb(null, chunk);
        },
    });
    return t;
})();
function handleVideoChunk(d) {
    if (videoCodec === 'h264') {
        if (!videoSplitter) videoSplitter = makeAnnexBSplitter((au, key) => sendMedia(key ? KIND.VKEY : KIND.VDELTA, ts(), au));
        videoSplitter.push(d);
    } else {
        parseIvf(d);
    }
    if (vcap) vcap.write(d);
}
function parseIvf(chunk) {
    // Keeps a growing buffer; pulls IVF frames out as they complete.
    parseIvf.buf = Buffer.concat([parseIvf.buf || Buffer.alloc(0), chunk]);
    const buf = parseIvf.buf;
    if (!parseIvf.header && buf.length >= 32) {
        // "DKIF" + version(2) + header_size(2) + fourcc(4) + w(2) + h(2) ...
        parseIvf.header = { w: buf.readUInt16LE(12), h: buf.readUInt16LE(14) };
    }
    if (parseIvf.header) {
        let off = 32;
        while (buf.length - off >= 12) {
            const size = buf.readUInt32LE(off);
            if (buf.length - off - 12 < size) break;
            const payload = buf.slice(off + 12, off + 12 + size);
            off += 12 + size;
            if (!payload.length) continue;   // libvpx realtime can emit 0-byte packets
            // VP8 first byte: bit 0 = 0 → keyframe. IVF has no keyframe flag.
            const isKey = (payload[0] & 1) === 0;
            sendMedia(isKey ? KIND.VKEY : KIND.VDELTA, ts(), payload);
        }
        parseIvf.buf = buf.slice(off);
    }
}

// -- Ogg reader --------------------------------------------------------
function parseOgg(chunk) {
    parseOgg.buf = Buffer.concat([parseOgg.buf || Buffer.alloc(0), chunk]);
    const buf = parseOgg.buf;
    let off = 0;
    while (buf.length - off >= 27 && buf.toString('latin1', off, off + 4) === 'OggS') {
        const nsegs = buf[off + 26];
        const segTable = buf.slice(off + 27, off + 27 + nsegs);
        let plen = 0;
        for (let i = 0; i < nsegs; i++) plen += segTable[i];
        if (buf.length - off - 27 - nsegs < plen) break;      // page not complete yet
        const granule = buf.readBigUInt64LE(off + 6);
        let pos = off + 27 + nsegs;
        const segments = [];
        for (let i = 0; i < nsegs; i++) {
            const len = segTable[i];
            segments.push(buf.slice(pos, pos + len));
            pos += len;
        }
        // Assemble lacing values into opus packets (packet ends when a lacing < 255).
        let packet = parseOgg.carry || [];
        const packets = [];
        for (let i = 0; i < segments.length; i++) {
            const len = segTable[i];
            packet.push(segments[i]);
            if (len < 255) { packets.push({ data: Buffer.concat(packet), granule }); packet = []; }
        }
        parseOgg.carry = packet.length ? packet : null;        // continues on next page
        parseOgg.page = (parseOgg.page || 0) + 1;
        for (const p of packets) onOggPacket(p, granule);
        off = pos;
    }
    parseOgg.buf = buf.slice(off);
}

let skipPackets = 2;   // OpusHead + OpusTags
function onOggPacket(p, granule) {
    if (!p.data.length) return;
    logV(`ogg: packet ${p.data.length} bytes granule=${granule} (page=${parseOgg.page})`);
    if (skipPackets > 0) { skipPackets--; return; }
    // Opus packets are self-contained audio frames — feed them raw.
    const time = ts();
    sendMedia(KIND.ACHUNK, time, p.data);
}

function handleAudioChunk(d) { parseOgg(d); }

// ── ffmpeg capture processes ─────────────────────────────────────────────────
// -- Annex-B / H.264 access-unit splitter --------------------------------------
// Parses raw Annex-B into access units delimited by Access Unit Delimiters
// (NAL type 9). -preset ultrafast turns on sliced threading, so several slice
// NALs make up one picture; splitting on AUD groups them correctly regardless
// of how many slices x264 emits per frame. SPS/PPS ride inline with the IDR, so
// the decoder needs no out-of-band description.
function nalType(nal) { return nal.length ? (nal[0] & 0x1f) : 0; }

function makeAnnexBSplitter(onAccessUnit) {
    const splitter = {
        buf: Buffer.alloc(0),
        pending: [],
        hasIDR: false,
        hasVCL: false,
    };
    function findStart(from) {
        const b = splitter.buf;
        for (let i = from; i + 3 < b.length; i++) {
            if (b[i] === 0 && b[i + 1] === 0) {
                if (b[i + 2] === 1) return { idx: i, end: i + 3 };
                if (b[i + 2] === 0 && b[i + 3] === 1) return { idx: i, end: i + 4 };
            }
        }
        return -1;
    }
    function emitNal(nal) {
        if (!nal.length) return;
        const t = nalType(nal);
        if (t === 9 && splitter.hasVCL) flush();
        splitter.pending.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]));
        if (t === 5) splitter.hasIDR = true;
        if (t === 1 || t === 5) splitter.hasVCL = true;
    }
    function flush() {
        if (!splitter.pending.length) return;
        const au = Buffer.concat(splitter.pending);
        const key = splitter.hasIDR;
        splitter.pending = [];
        splitter.hasIDR = false;
        splitter.hasVCL = false;
        onAccessUnit(au, key);
    }
    splitter.push = (chunk) => {
        splitter.buf = splitter.buf.length ? Buffer.concat([splitter.buf, chunk]) : chunk;
        let start = findStart(0);
        if (start < 0) return;
        let next;
        while ((next = findStart(start.end)) !== -1) {
            emitNal(splitter.buf.subarray(start.end, next.idx));
            start = next;
        }
        splitter.buf = splitter.buf.subarray(start.idx);
    };
    splitter.reset = () => { splitter.buf = Buffer.alloc(0); splitter.pending = []; splitter.hasIDR = false; splitter.hasVCL = false; };
    return splitter;
}

function spawnVideo() {
    if (videoCodec === 'h264') {
        const videoArgs = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'x11grab', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', displayStr,
            '-an',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-x264-params', 'aud=1', '-profile:v', 'baseline', '-level', '3.1',
            '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
            '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate),
            '-f', 'h264', 'pipe:1',
        ];
        videoProc = track(spawn('ffmpeg', videoArgs, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
        videoProc.on('error', onSpawnError('video ffmpeg'));
        videoProc.stderr.on('data', (d) => process.stderr.write('[video ffmpeg] ' + d));
        videoProc.stdout.on('data', handleVideoChunk);
        videoProc.on('exit', (code) => { if (wsReady) console.log(`[full] video ffmpeg exited (${code})`); });
        console.log(`[full] video capture up (pid=${videoProc.pid}, ${w}x${h}@${fps} → libx264 baseline → Annex-B)${vcap ? ` — tee→${videoCapturePath}` : ''}`);
    } else {
        const videoArgs = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'x11grab', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', displayStr,
            '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6', '-threads', '1',
            '-b:v', String(bitrate), '-g', String(fps), '-keyint_min', String(fps),
            '-f', 'ivf', 'pipe:1',
        ];
        videoProc = track(spawn('ffmpeg', videoArgs, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
        videoProc.on('error', onSpawnError('video ffmpeg'));
        videoProc.stdout.on('data', handleVideoChunk);
        videoProc.stderr.on('data', (d) => process.stderr.write('[video ffmpeg] ' + d));
        videoProc.on('exit', (code) => { if (wsReady) console.log(`[full] video ffmpeg exited (${code})`); });
        console.log(`[full] video capture up (pid=${videoProc.pid}, ${w}x${h}@${fps} → libvpx/vp8 → IVF)${vcap ? ` — tee→${videoCapturePath}` : ''}`);
    }
}
function spawnAudio() {
    const audioArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'pulse', '-i', `${sinkName}.monitor`,
        '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', '-frame_duration', '20',
        '-f', 'ogg', 'pipe:1',
    ];
    audioProc = track(spawn('ffmpeg', audioArgs, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    audioProc.on('error', onSpawnError('audio ffmpeg'));
    audioProc.stdout.on('data', handleAudioChunk);
    audioProc.stderr.on('data', (d) => process.stderr.write('[audio ffmpeg] ' + d));
    audioProc.on('exit', (code) => { if (wsReady) console.log(`[full] audio ffmpeg exited (${code})`); });
    console.log(`[full] audio capture up (pid=${audioProc.pid}, fullsink.monitor → libopus → ogg)`);
}
function startCaptures() {
    stopCaptures();
    spawnVideo();
    spawnAudio();
}
// A fresh ffmpeg instance always opens with a brand-new keyframe, so restarting
// the video encoder is the dirt-simple way to honor the relay's urgent `hardkey`
// request (a viewer hit a decode error and wants an instant resync). Routine
// `keyframe`/`needkey` requests are no-ops - the `-g fps` config already emits a
// natural intra frame every second. Restarting is throttled because the moment a
// restart happens the encoder rebuilds its quantum buffers (~100-200ms gap).
let lastKeyframeRestartAt = 0;
const KEYFRAME_RESTART_MS = 3000;
function restartVideo() {
    const now = Date.now();
    if (now - lastKeyframeRestartAt < KEYFRAME_RESTART_MS) return;   // natural -g GOPs cover the rest
    lastKeyframeRestartAt = now;
    if (videoProc) {
        try { videoProc.stdout.removeAllListeners('data'); } catch {}
        tryKill(videoProc, 'SIGKILL');
        videoProc = null;
        parseIvf.buf = null; parseIvf.header = null;
        if (videoSplitter) { videoSplitter.reset(); }
    }
    log('forced fresh keyframe — restarting video encoder');
    spawnVideo();
}
function stopCaptures() {
    if (videoProc) { try { videoProc.stdout.removeAllListeners('data'); } catch {} tryKill(videoProc, 'SIGKILL'); videoProc = null; }
    if (audioProc) { try { audioProc.stdout.removeAllListeners('data'); } catch {} tryKill(audioProc, 'SIGKILL'); audioProc = null; }
    parseIvf.buf = null; parseIvf.header = null;
    if (videoSplitter) { videoSplitter.reset(); }
    parseOgg.buf = null; parseOgg.carry = null; parseOgg.page = 0; skipPackets = 2;
}

// ── Snapshots (SNAP frame = JPEG bytes) ──────────────────────────────────────
function takeSnapshot() {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'x11grab', '-video_size', `${w}x${h}`, '-i', displayStr, '-frames:v', '1',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'],
        { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('error', onSpawnError('snapshot ffmpeg'));
    let jpeg = Buffer.alloc(0);
    proc.stdout.on('data', (d) => { jpeg = Buffer.concat([jpeg, d]); });
    proc.stdout.on('end', () => { if (jpeg.length) sendMedia(KIND.SNAP, ts(), jpeg); });
}

// ── Input → xdotool ───────────────────────────────────────────────────────────
const DOM2XDOTOOL = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Space: 'space', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace',
    ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R',
    ControlLeft: 'Control_L', ControlRight: 'Control_R',
    AltLeft: 'Alt_L', AltRight: 'Alt_R',
    MetaLeft: 'Super_L', MetaRight: 'Super_R',
    KeyX: 'x', KeyC: 'c', KeyZ: 'z', KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
    KeyQ: 'q', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u', KeyI: 'i',
    KeyO: 'o', KeyP: 'p', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
    KeyB: 'b', KeyN: 'n', KeyM: 'm',
};
function domToXdotool(code) {
    if (DOM2XDOTOOL[code]) return DOM2XDOTOOL[code];
    const m = /^Key([A-Z])$/.exec(code);        if (m) return m[1].toLowerCase();
    const d = /^Digit([0-9])$/.exec(code);      if (d) return d[1];
    const f = /^F([0-9]{1,2})$/.exec(code);     if (f) return code;
    const np = /^Numpad([0-9])$/.exec(code);    if (np) return 'KP_' + np[1];
    return code.replace(/^Key/, '').replace(/^Digit/, '');
}
function xd(args) { try { spawnSync('xdotool', args, { env: childEnv(), stdio: 'ignore' }); } catch {} }

// Fire-and-forget xdotool call: never let a failed spawn take the host down.
function fireXdotool(args, delayMs) {
    const run = () => {
        const c = spawn('xdotool', args, { env: childEnv(), stdio: 'ignore' });
        c.on('error', () => {});
        c.unref();
    };
    if (delayMs) setTimeout(run, delayMs); else run();
}

const heldKeys = new Set();
function applyInput(keys, mouse) {
    const desired = new Set((keys || []).map((k) => domToXdotool(k)).filter(Boolean));
    for (const k of [...heldKeys]) {
        if (!desired.has(k)) { fireXdotool(['keyup', k]); heldKeys.delete(k); }
    }
    for (const k of [...desired]) {
        if (!heldKeys.has(k)) { fireXdotool(['keydown', k]); heldKeys.add(k); }
    }
    if (mouse) {
        // Viewer coords are in stream pixel space (0..w, 0..h). If the virtual
        // display is bigger than the captured region, scale into display space.
        const dispW = resX || w, dispH = resY || h;
        const x = Math.max(0, Math.min(dispW - 1, Math.round(mouse.x * dispW / w)));
        const y = Math.max(0, Math.min(dispH - 1, Math.round(mouse.y * dispH / h)));
        fireXdotool(['mousemove', String(x), String(y)]);
        if (mouse.click) {
            const btn = String(mouse.button || 1);
            fireXdotool(['mousedown', btn]);
            fireXdotool(['mouseup', btn], 60);
        }
    }
}
function releaseAll() { applyInput([], null); }

// ── Game lifecycle ────────────────────────────────────────────────────────────
let gameChild = null, currentGameKey = null;
function broadcastState() {
    const g = GAMES.find((x) => x.key === currentGameKey);
    if (wsReady) ws.send(JSON.stringify({ t: 'gamestate', state: { game: currentGameKey, name: g ? g.name : null } }));
}
function launchGame(key) {
    const g = GAMES.find((x) => x.key === key);
    if (!g) { console.error(`[full] unknown game "${key}"`); return; }
    killGame();
    console.log(`[full] launching game "${g.name}" (${g.command.join(' ')})`);
    try {
        gameChild = spawn(g.command[0], g.command.slice(1), {
            cwd: g.cwd || undefined,
            env: childEnv(g.env),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        gameChild.stderr.on('data', () => {});
        gameChild.stdout.on('data', () => {});
        currentGameKey = key;
        broadcastState();
        gameChild.on('error', (err) => {
            // e.g. ENOENT — the game binary isn't installed. This must NOT kill
            // the host: log it, clear state, keep the desktop streaming.
            console.error(`[full] failed to launch game "${g.name}": ${err.message}`);
            console.error(`[full]   command was: ${g.command.join(' ')} — check games.json paths`);
            if (currentGameKey === key) { currentGameKey = null; gameChild = null; }
            broadcastState();
        });
        gameChild.on('exit', () => { console.log(`[full] game "${g.name}" exited`); if (currentGameKey === key) { currentGameKey = null; killGameTree(gameChild, 'SIGKILL'); gameChild = null; broadcastState(); } });
    } catch (err) {
        console.error(`[full] failed to launch game: ${err.message}`);
        currentGameKey = null; broadcastState();
    }
}
function killGame() {
    if (gameChild) { killGameTree(gameChild, 'SIGTERM'); gameChild = null; }
    currentGameKey = null;
}

// ── Logging ──────────────────────────────────────────────────────────────────
const LOG = process.env.EMULATOR_LOG || 'info';
function logAt(level, ...a) { if (({ verbose: 0, info: 1 }[level] || 1) < ({ verbose: 0, info: 1 }[LOG] || 1)) return; console.log('[full]', ...a); }
const log  = (...a) => logAt('info', ...a);
const logV = (...a) => logAt('verbose', ...a);

// ── Relay link ───────────────────────────────────────────────────────────────
function connect() {
    let url = relayUrl.replace(/\/$/, '');
    if (!url.endsWith('/host')) url += '/host';
    url += (url.includes('?') ? '&' : '?') + `console=${encodeURIComponent(consoleKey)}`;
    if (hostToken) url += `&token=${encodeURIComponent(hostToken)}`;

    ws = new WebSocket(url);
    ws.onopen = () => {
        wsReady = true;
        log('relay connected — registering');
        ws.send(JSON.stringify({
            t: 'register',
            console: { key: consoleKey, name: name || consoleKey, image: image || null,
                       category: category || null, description: description || null,
                       motd: (motd || '').replace(/\\n/gi, '\n').replace(/\\t/gi, '\t') || null,
                       games: sanitizeGames() },
        }));
        ws.send(JSON.stringify({ t: 'vconfig', config: { codec: videoCodec === 'vp8' ? 'vp8' : 'avc1.42001f', codedWidth: w, codedHeight: h } }));
        ws.send(JSON.stringify({ t: 'aconfig', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } }));
        if (currentGameKey) {
            const g = GAMES.find((x) => x.key === currentGameKey);
            ws.send(JSON.stringify({ t: 'gamestate', state: { game: currentGameKey, name: g ? g.name : null } }));
        }
        startCaptures();
    };
    ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.t) {
            case 'input': applyInput(msg.keys, msg.mouse); break;
            case 'keyframe': break;                          // routine - natural -g keyframes every second suffice
            case 'hardkey': restartVideo(); break;           // urgent - a viewer hit a decode error, force fresh GOP
            case 'snapshot': takeSnapshot(); break;
            case 'reload': log('relay asked for a reload — restarting capture'); startCaptures(); break;
            case 'launch': launchGame(msg.game); break;
            default: break;
        }
    };
    ws.onclose = () => {
        wsReady = false; releaseAll(); stopCaptures();
        console.log('[full] relay disconnected — retrying in 1s');
        setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (flag('--help') || flag('-h')) { usage(); process.exit(0); }
    if (process.platform !== 'linux') {
        console.error('ERROR: full-host requires Linux (Xvfb/xfwm4/pulseaudio/ffmpeg/xdotool).');
        process.exit(1);
    }
    if (!consoleKey) { console.error('ERROR: --console <key> is required.'); usage(); process.exit(1); }
    if (!hostToken) { console.error('ERROR: --token (EMULATOR_HOST_TOKEN) is required.'); usage(); process.exit(1); }
    if (flag('--check')) {
        const ok = checkTools();
        loadGames();
        process.exit(ok ? 0 : 1);
    }
    if (!checkTools()) process.exit(1);
    loadGames();

    console.log(`[full] console key: ${consoleKey}`);
    console.log(`[full] relay ws    : ${relayUrl}`);
    console.log(`[full] display     : ${displayStr} (${resX || w}x${resY || h})`);
    console.log(`[full] stream      : ${w}x${h}@${fps}, ${(bitrate / 1000) | 0} kbps video + 128k opus`);

    const rt = makeRuntimeDir();
    RUNTIME_DIR = rt;
    startXvfb(rt);
    await waitForDisplay().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
    console.log(`[full] virtual display ${displayStr} is up`);

    await startPulse(rt);
    setupNullSink(rt);
    console.log(`[full] pulseaudio ready (null sink "${sinkName}")`);

    startWm();
    await new Promise((r) => setTimeout(r, 800));
    console.log('[full] window manager up');

    connect();
    console.log('[full] running. Ctrl+C to stop.');
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
process.on('exit', stopAll);

main();