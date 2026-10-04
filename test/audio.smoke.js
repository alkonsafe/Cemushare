// /audio socket: audio client gets ACHUNK, stream viewer doesn't; aconfig fans out.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
for (const f of fs.readdirSync('data')) if (f.startsWith('test-aud.db')) fs.rmSync('data/' + f, { force: true });
const PORT = 8093;
const srv = spawn('node', ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: 'tok-t', EMULATOR_DB: 'data/test-aud.db', EMULATOR_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await sleep(2200);
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '')); if (!cond) fails++; };

    await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'aud', password: 'pw123456' }) });
    const login = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'aud', password: 'pw123456' }) })).json();
    const tok = login.token;

    const host = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=tok-t&console=audbench`);
    await new Promise((res) => host.addEventListener('open', res, { once: true }));
    host.send(JSON.stringify({ t: 'register', console: { key: 'audbench', name: 'Aud Bench', image: 'src', category: 'T', description: '' } }));
    await sleep(300);

    const frame = (kind, payload) => { const b = Buffer.alloc(9 + payload.length); b[0] = kind; b.writeDoubleLE(1234, 1); Buffer.from(payload).copy(b, 9); return b; };
    const openWs = (path) => new Promise((res) => {
        const w = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
        const bin = [], msgs = [];
        w.addEventListener('message', (e) => { if (typeof e.data === 'string') msgs.push(JSON.parse(e.data)); else bin.push(e.data.length); });
        w.addEventListener('error', () => {});
        w.addEventListener('open', () => res({ w, bin, msgs }));
        w.addEventListener('close', () => res({ w, bin, msgs, closed: true }));   // rejected sockets resolve here
    });

    const S = await openWs(`/stream?console=audbench&token=${tok}`);
    await sleep(300);
    const A = await openWs(`/audio?console=audbench&token=${tok}`);
    await sleep(300);

    // host sends one video frame + one audio chunk
    host.send(frame(2, Buffer.from('VIDKEY')));
    host.send(frame(5, Buffer.from('AUDIOCHUNK')));
    await sleep(400);

    check('audio ws got the ACHUNK', A.bin.length === 1, JSON.stringify(A.bin));
    check('stream ws got video but NOT the ACHUNK', S.bin.length === 1 && !S.bin.includes(19), JSON.stringify(S.bin));
    check('audio ws got a welcome with audio config slot', A.msgs.some((m) => m.t === 'welcome' && 'audio' in m), JSON.stringify(A.msgs.map((m) => m.t)));

    // aconfig from host fans out to both
    host.send(JSON.stringify({ t: 'aconfig', config: { codec: 'opus', sampleRate: 48000 } }));
    await sleep(300);
    check('audio ws got aconfig', A.msgs.some((m) => m.t === 'aconfig' && m.config && m.config.codec === 'opus'), JSON.stringify(A.msgs.map((m) => m.t)));

    // ── audiohost up-link: relay issues an id at register, host streams there ──
    const hostMsgs = [];
    host.addEventListener('message', (e) => { try { hostMsgs.push(JSON.parse(e.data)); } catch {} });
    host.send(JSON.stringify({ t: 'register', console: { key: 'audbench', name: 'Aud Bench', image: 'src', category: 'T', description: '' } }));
    await sleep(300);
    const audioidMsg = [...hostMsgs].reverse().find((m) => m.t === 'audioid');
    check('host got audioid at re-register', !!(audioidMsg && audioidMsg.id), JSON.stringify(hostMsgs.map((m) => m.t)));

    const AH = await openWs(`/audiohost?token=tok-t&id=${audioidMsg.id}`);
    await sleep(200);
    host.send(frame(2, Buffer.from('VIDKEY2')));
    AH.w.send(frame(5, Buffer.from('HOSTAUDIO')));
    await sleep(400);
    check('audio client received audio from the audiohost link', A.bin.includes(18), JSON.stringify(A.bin));
    check('stream viewer did NOT receive the audiohost chunk', !S.bin.includes(11), JSON.stringify(S.bin));

    // invalid id rejected
    const bad = await openWs(`/audiohost?token=tok-t&id=nope`);
    check('bad audiohost id rejected', bad.closed === true, 'closed=' + !!bad.closed);

    srv.kill('SIGKILL');
    await sleep(200);
    console.log(fails ? `\n${fails} FAILURES` : '\nALL AUDIO-WS TESTS PASS');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); srv.kill('SIGKILL'); process.exit(1); });