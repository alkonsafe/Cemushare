// Duplicate-client rejection: 2nd tab same user+console gets bounced.
const { spawn } = require('child_process');
const fs = require('fs');
for (const f of fs.readdirSync('data')) if (f.startsWith('test-dup.db')) fs.rmSync('data/' + f, { force: true });
const WebSocket = require('ws');
const PORT = 8096;
const srv = spawn('node', ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: 'tok-t', RELAY_OWNER: 'boss', EMULATOR_DB: 'data/test-dup.db', EMULATOR_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await sleep(2200);
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '')); if (!cond) fails++; };

    await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'pw123456' }) });
    const lg = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'pw123456' }) })).json();
    const tok = lg.token;

    // host registers console dup
    const host = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=tok-t&console=dupbench`);
    await new Promise((res) => host.addEventListener('open', res, { once: true }));
    host.send(JSON.stringify({ t: 'register', console: { key: 'dupbench', name: 'Dup Bench', image: 'src', category: 'T', description: '' } }));
    await sleep(400);

    const open = (url) => new Promise((res) => { const w = new WebSocket(url); w.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.t === 'welcome') res(m); } catch {} }); });
    const w1 = await open(`ws://127.0.0.1:${PORT}/stream?console=dupbench&token=${tok}`);
    check('tab1 welcome ok', !w1.error, JSON.stringify(w1).slice(0, 80));
    const w2 = await open(`ws://127.0.0.1:${PORT}/stream?console=dupbench&token=${tok}`);
    check('tab2 rejected duplicate-client', w2.error === 'duplicate-client', JSON.stringify(w2).slice(0, 80));

    // different console: same user OK
    const host2 = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=tok-t&console=dupbench2`);
    await new Promise((res) => host2.addEventListener('open', res, { once: true }));
    host2.send(JSON.stringify({ t: 'register', console: { key: 'dupbench2', name: 'Dup Bench 2', image: 'src', category: 'T', description: '' } }));
    await sleep(400);
    const w3 = await open(`ws://127.0.0.1:${PORT}/stream?console=dupbench2&token=${tok}`);
    check('same user other console ok', !w3.error, JSON.stringify(w3).slice(0, 80));

    srv.kill('SIGKILL');
    await sleep(300);
    console.log(fails ? `\n${fails} FAILURES` : '\nALL DUP TESTS PASS');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); srv.kill('SIGKILL'); process.exit(1); });