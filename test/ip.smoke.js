// Verify clientIp: loopback + CF-Connecting-IP header → header IP used.
const { spawn } = require('child_process');
const fs = require('fs');
for (const f of fs.readdirSync('data')) if (f.startsWith('test-ip.db')) fs.rmSync('data/' + f, { force: true });
const PORT = 8098;
const srv = spawn('node', ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: 'tok-t', RELAY_OWNER: 'boss', EMULATOR_DB: 'data/test-ip.db', EMULATOR_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await sleep(2200);
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '')); if (!cond) fails++; };

    // 1) Register WITH a CF header (simulating cloudflare tunnel from loopback)
    const r1 = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ username: 'cfuser', password: 'pw123456' }),
    });
    check('register via CF header ok', r1.status === 200, String(r1.status));

    // 2) Register WITHOUT header (direct LAN client) → falls back to 127.0.0.1
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'directuser', password: 'pw123456' }),
    });
    check('register direct ok', r2.status === 200, String(r2.status));

    // 3) Ban the tunnel IP as the OWNER, then a login presenting that header ip
    // must 403, while the same socket without the header stays allowed.
    await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'pw123456' }),
    });
    const owner = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'pw123456' }),
    });
    const tok = (await owner.json()).token;
    check('owner login ok', owner.status === 200, String(owner.status));

    const banRes = await fetch(`http://127.0.0.1:${PORT}/api/admin/ban`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ kind: 'ip', value: '203.0.113.9' }),
    });
    check('owner bans tunnel ip', banRes.status === 200, String(banRes.status));
    const blocked = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ username: 'directuser', password: 'pw123456' }),
    });
    check('ip ban (real header ip) blocks login', blocked.status === 403, String(blocked.status));
    const bcBanned = await fetch(`http://127.0.0.1:${PORT}/api/bancheck`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    const bcBannedBody = await bcBanned.json();
    check('bancheck: banned ip reports banned (403)', bcBanned.status === 403 && bcBannedBody.banned === true && bcBannedBody.kind === 'ip', JSON.stringify(bcBannedBody));
    const bcClean = await fetch(`http://127.0.0.1:${PORT}/api/bancheck`);
    const bcCleanBody = await bcClean.json();
    check('bancheck: clean socket reports not banned', bcClean.status === 200 && bcCleanBody.banned === false, JSON.stringify(bcCleanBody));

    // User ban with a DELETED session: bancheck must still identify them via
    // the signed token (banning a user kills their sessions).
    await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'banme', password: 'pw123456' }) });
    const banme = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'banme', password: 'pw123456' }) })).json();
    await fetch(`http://127.0.0.1:${PORT}/api/admin/ban`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ kind: 'user', value: 'banme' }) });
    const bcUser = await fetch(`http://127.0.0.1:${PORT}/api/bancheck`, { headers: { Authorization: 'Bearer ' + banme.token } });
    const bcUserBody = await bcUser.json();
    check('bancheck: banned user w/ dead session identified via signed token', bcUser.status === 403 && bcUserBody.banned === true && bcUserBody.kind === 'user', JSON.stringify(bcUserBody));
    const direct = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'directuser', password: 'pw123456' }),
    });
    check('same socket w/o header (spoof blocked) ok', direct.status === 200, String(direct.status));

    srv.kill('SIGKILL');
    await sleep(300);
    console.log(fails ? `\n${fails} FAILURES` : '\nALL IP TESTS PASS');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); srv.kill('SIGKILL'); process.exit(1); });