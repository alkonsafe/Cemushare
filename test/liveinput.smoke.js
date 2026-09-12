// wheel forwarding + liveinput broadcasts
const { spawn } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
for (const f of fs.readdirSync('data')) if (f.startsWith('test-live.db')) fs.rmSync('data/' + f, { force: true });
const PORT = 8094;
const srv = spawn('node', ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: 'tok-t', EMULATOR_DB: 'data/test-live.db', EMULATOR_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await sleep(2200);
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '')); if (!cond) fails++; };

    await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'pw123456' }) });
    const a = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'pw123456' }) })).json();
    await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bobby', password: 'pw123456' }) });
    const b = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bobby', password: 'pw123456' }) })).json();

    const host = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=tok-t&console=livebench`);
    await new Promise((res) => host.addEventListener('open', res, { once: true }));
    host.send(JSON.stringify({ t: 'register', console: { key: 'livebench', name: 'Live Bench', image: 'src', category: 'T', description: '' } }));
    const hostMouse = [];
    host.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.t === 'input' && m.mouse) hostMouse.push(m.mouse); } catch {} });
    await sleep(400);

    const open = (tok) => new Promise((res) => {
        const w = new WebSocket(`ws://127.0.0.1:${PORT}/stream?console=livebench&token=${tok}`);
        const msgs = [];
        w.addEventListener('message', (e) => { try { msgs.push(JSON.parse(e.data)); } catch {} });
        w.addEventListener('open', () => res({ ws: w, msgs }));
    });
    const A = await open(a.token);
    const B = await open(b.token);
    await sleep(400);

    // alice holds W → bobby sees liveinput held=[KeyW]
    A.ws.send(JSON.stringify({ t: 'input', keys: ['KeyW'] }));
    await sleep(300);
    let li = B.msgs.filter((m) => m.t === 'liveinput');
    check('liveinput held broadcast', li.some((m) => m.name === 'alice' && m.held.includes('KeyW')), JSON.stringify(li.map((m) => m.held)));

    // alice holds a camera mouse button → bobby sees M1
    A.ws.send(JSON.stringify({ t: 'input', keys: ['KeyW'], mouse: { dx: 0, dy: 0, rel: true, held: true, button: 1 } }));
    await sleep(300);
    li = B.msgs.filter((m) => m.t === 'liveinput');
    check('liveinput shows held mouse button', li.some((m) => m.name === 'alice' && m.held.includes('M1')), JSON.stringify(li.map((m) => m.held)));

    // release everything → liveinput with held: []
    A.ws.send(JSON.stringify({ t: 'input', keys: [], mouse: { dx: 0, dy: 0, rel: true, held: false, button: 1 } }));
    await sleep(300);
    li = B.msgs.filter((m) => m.t === 'liveinput');
    check('liveinput clears on release', li.some((m) => m.name === 'alice' && m.held.length === 0), JSON.stringify(li.map((m) => m.held)));

    // wheel → host receives wheel clicks (not consumed by dedupe, twice works)
    A.ws.send(JSON.stringify({ t: 'input', keys: [], mouse: { dx: 0, dy: 0, rel: true, wheel: 1 } }));
    await sleep(200);
    A.ws.send(JSON.stringify({ t: 'input', keys: [], mouse: { dx: 0, dy: 0, rel: true, wheel: -1 } }));
    await sleep(300);
    const wheels = hostMouse.filter((m) => m.wheel);
    check('host got wheel up+down', wheels.some((m) => m.wheel === 1) && wheels.some((m) => m.wheel === -1), JSON.stringify(wheels));

    // alice leaves → bobby gets a clearing liveinput
    A.ws.close();
    await sleep(300);
    li = B.msgs.filter((m) => m.t === 'liveinput');
    check('liveinput cleared on leave', li.some((m) => m.name === 'alice' && m.held.length === 0), 'yes');

    srv.kill('SIGKILL');
    await sleep(200);
    console.log(fails ? `\n${fails} FAILURES` : '\nALL LIVE-INPUT/WHEEL TESTS PASS');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); srv.kill('SIGKILL'); process.exit(1); });