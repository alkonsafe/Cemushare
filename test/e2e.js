'use strict';
// Full end-to-end: boot the relay, run the real standalone host launcher with
// real Edge (headless + WebCodecs), then open a viewer and confirm it receives
// real encoded video/audio from the demo console. Requires Edge/Chrome.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8093, HOST_TOKEN = 'e2ehosttoken123456';
const sleep = (m) => new Promise((r) => setTimeout(r, m));

function hj(m, u) {
    return new Promise((res) => {
        const r = http.get({ host: '127.0.0.1', port: PORT, path: u, method: m }, (x) => {
            let o = ''; x.on('data', (c) => o += c); x.on('end', () => res(JSON.parse(o)));
        }); r.on('error', (e) => res({ err: String(e) }));
    });
}

(async () => {
    // 1. Relay
    const relay = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: HOST_TOKEN,
               EMULATOR_JWT_SECRET: 'e2esecret', EMULATOR_ALLOW_GUEST: '1',
               EMULATOR_DB: path.join(__dirname, 'data', 'e2e.db') },
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    await sleep(800);

    // 2. Standalone host launcher (demo console) using real Edge.
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const launcher = spawn(process.execPath, ['bin/launch-host.js',
        '--url', `ws://127.0.0.1:${PORT}`,
        '--token', HOST_TOKEN,
        '--console', 'demo',
        '--dir', path.join(ROOT, 'consoles', 'demo'),
        '--name', 'Demo Console', '--category', 'Demo',
        '--w', '480', '--h', '270', '--fps', '30',
    ], {
        env: { ...process.env, CHROME_BIN: edge, EMULATOR_PROFILE_DIR: path.join(__dirname, 'data', 'profile-e2e') },
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    // 3. Wait for the console to register + start streaming video.
    let ok = false;
    for (let i = 0; i < 120; i++) {
        await sleep(500);
        const grid = await hj('GET', '/api/consoles');
        const demo = (grid.consoles || []).find((c) => c.key === 'demo');
        if (demo && demo.online) { console.log('[e2e] demo console ONLINE with players', demo.players); ok = true; break; }
    }
    if (!ok) {
        console.log('[e2e] console never came online');
        relay.kill(); launcher.kill(); process.exit(1);
    }

    // 4. Viewer connects, should receive video config + binary frames + audio.
    const view = new WebSocket(`ws://127.0.0.1:${PORT}/stream?console=demo`);
    view.binaryType = 'arraybuffer';
    let gotVideoConfig = false, gotBinary = 0, gotAudio = 0;
    let welcome = null;
    view.on('message', (d, isBin) => {
        if (isBin) {
            const kind = new Uint8Array(d)[0];
            if (kind === 2 || kind === 3) gotBinary++;
            else if (kind === 5) gotAudio++;
        } else {
            const m = JSON.parse(d);
            if (m.t === 'welcome') welcome = m;
            if (m.t === 'vconfig') gotVideoConfig = true;
        }
    });
    await new Promise((r) => view.once('open', r));
    view.send(JSON.stringify({ t: 'needkey' }));

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(gotVideoConfig && gotBinary >= 5 && gotAudio >= 1)) {
        await sleep(200);
    }
    console.log('[e2e] welcome video cfg:', !!(welcome && welcome.video));
    console.log('[e2e] video config:', gotVideoConfig, 'binary frames:', gotBinary, 'audio:', gotAudio);

    view.close(); launcher.kill(); relay.kill();
    const pass = gotVideoConfig && gotBinary >= 5 && gotAudio >= 1;
    console.log(pass ? 'E2E PASS' : 'E2E FAIL');
    process.exit(pass ? 0 : 1);
})();