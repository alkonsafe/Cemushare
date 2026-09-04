'use strict';
// emulatorSHARE protocol test: verify a host registering creates a console and
// that viewers receive the host's video/audio fan-out. Runs headless — the host
// here is a fake Node socket speaking the same framing the real headless
// Chromium host sends, so the relay path is exercised without WebCodecs.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.EMULATOR_PORT || 8097);
const HOST_TOKEN = 'test-host-token-000000000000';
const DB = path.join(__dirname, 'data', 'protocol-test.db');

const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_DB: DB,
           EMULATOR_HOST_TOKEN: HOST_TOKEN, EMULATOR_JWT_SECRET: 'test-secret',
           EMULATOR_ALLOW_GUEST: '1' },
    stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
    if (!cond) failed++;
}

function httpJson(method, url, body) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url,
            headers: data ? { 'Content-Type': 'application/json' } : {} }, (res) => {
            let out = ''; res.on('data', (c) => out += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
        });
        r.on('error', (e) => resolve({ status: 0, body: { error: String(e) } }));
        if (data) r.write(data);
        r.end();
    });
}

// Fake binary media frame: [kind:u8][ts:f64][payload]
const KIND = { VEY: 2, VDELTA: 3, ACHUNK: 5 };
function mediaFrame(kind, payload) {
    const out = new Uint8Array(9 + payload.length);
    out[0] = kind;
    new DataView(out.buffer).setFloat64(1, 1000, true);
    out.set(payload, 9);
    return out;
}

async function main() {
    await sleep(600);
    try {
        // Login a user for the viewer token.
        await httpJson('POST', '/api/register', { username: 'bob', password: 'secret123' });
        const { body: login } = await httpJson('POST', '/api/login', { username: 'bob', password: 'secret123' });
        check('viewer login returns token', !!login.token);

        // Host connects + registers a console.
        const host = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=${HOST_TOKEN}&console=mario64`);
        await new Promise((res, rej) => { host.once('open', res); host.once('error', rej); });
        host.binaryType = 'arraybuffer';

        const hostMsgs = [];
        host.on('message', (d, isBin) => hostMsgs.push(isBin ? 'binary' : JSON.parse(d)));

        host.send(JSON.stringify({ t: 'register', console: {
            key: 'mario64', name: 'Super Mario 64', image: 'mario64.png',
            category: 'Nintendo 64', description: 'test' } }));

        // Wait for `registered` ack.
        for (let i = 0; i < 20 && !hostMsgs.find((m) => m.t === 'registered'); i++) await sleep(50);
        check('host receives registered ack', hostMsgs.some((m) => m.t === 'registered'));

        // Host pushes config + one fake keyframe.
        host.send(JSON.stringify({ t: 'vconfig', config: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } }));
        host.send(JSON.stringify({ t: 'aconfig', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } }));
        host.send(mediaFrame(KIND.VEY, new Uint8Array([1, 2, 3, 4])));

        // Console now visible in the grid.
        const grid = await httpJson('GET', '/api/consoles');
        check('console appears in grid', Array.isArray(grid.body.consoles) && grid.body.consoles.some((c) => c.name === 'Super Mario 64'));

        // Viewer connects to that console.
        const view = new WebSocket(`ws://127.0.0.1:${PORT}/stream?token=${encodeURIComponent(login.token)}&console=mario64`);
        view.binaryType = 'arraybuffer';
        const viewMsgs = [];
        const viewBin = [];
        view.on('message', (d, isBin) => { if (isBin) viewBin.push(d); else viewMsgs.push(JSON.parse(d)); });
        await new Promise((res, rej) => { view.once('open', res); view.once('error', rej); });

        for (let i = 0; i < 30; i++) {
            await sleep(60);
            if (viewMsgs.find((m) => m.t === 'welcome' && m.video)) break;
        }
        const welcome = viewMsgs.find((m) => m.t === 'welcome');
        check('viewer welcome carries video config', !!(welcome && welcome.video));
        check('viewer welcome carries audio config', !!(welcome && welcome.audio));
        check('viewer gets binary video frames', viewBin.length >= 1 && viewBin[0] instanceof ArrayBuffer);

        // Viewer sends input; server relays merged keys to the host. Ignore the
        // spurious initial empty `input` sent when the host (re)registered.
        const seenInput = new Promise((res) => {
            const t = setInterval(() => {
                const m = hostMsgs.find((x) => x.t === 'input' && x.keys.length > 0);
                if (m) { clearInterval(t); res(m); }
            }, 50);
            setTimeout(() => { clearInterval(t); res(null); }, 3000);
        });
        view.send(JSON.stringify({ t: 'input', keys: ['ArrowUp', 'KeyX'] }));
        const inputMsg = await seenInput;
        check('host receives merged input from viewer', !!inputMsg && inputMsg.keys.includes('ArrowUp'));

        // Viewers count updates on the grid.
        const grid2 = await httpJson('GET', '/api/consoles');
        const m = grid2.body.consoles.find((c) => c.name === 'Super Mario 64');
        check('player count reflected in grid', m && m.players === 1);

        host.close(); view.close();
    } finally {
        child.kill();
        process.exit(failed ? 1 : 0);
    }
}

main();
