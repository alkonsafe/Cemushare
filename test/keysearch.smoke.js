// keysearch: user types c,o,r,(shift),n with breaks -> word "corn" matches.
const { spawn } = require('child_process');
const fs = require('fs');
for (const f of fs.readdirSync('data')) if (f.startsWith('test-ks.db')) fs.rmSync('data/' + f, { force: true });
const WebSocket = require('ws');
const PORT = 8095;
const srv = spawn('node', ['server.js'], {
    env: { ...process.env, EMULATOR_PORT: String(PORT), EMULATOR_HOST_TOKEN: 'tok-t', RELAY_OWNER: 'boss', EMULATOR_DB: 'data/test-ks.db', EMULATOR_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await sleep(2200);
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '')); if (!cond) fails++; };

    for (const u of ['boss', 'evilguywholikesnsfw']) {
        await fetch(`http://127.0.0.1:${PORT}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw123456' }) });
    }
    const boss = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'pw123456' }) })).json();
    const evil = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'evilguywholikesnsfw', password: 'pw123456' }) })).json();

    const host = new WebSocket(`ws://127.0.0.1:${PORT}/host?token=tok-t&console=ksbench`);
    await new Promise((res) => host.addEventListener('open', res, { once: true }));
    host.send(JSON.stringify({ t: 'register', console: { key: 'ksbench', name: 'KS Bench', image: 'src', category: 'T', description: '' } }));
    await sleep(400);

    const view = new WebSocket(`ws://127.0.0.1:${PORT}/stream?console=ksbench&token=${evil.token}`);
    await new Promise((res) => view.addEventListener('open', res, { once: true }));
    const send = (keys) => view.send(JSON.stringify({ t: 'input', keys }));

    // evil guy types: c o r <shift> n ... later types "corn" again via two-key overlaps
    const seq = [
        ['KeyC'], ['KeyC', 'KeyO'], ['KeyC', 'KeyO', 'KeyR'],
        ['KeyC', 'KeyO', 'KeyR', 'ShiftLeft'], ['KeyC', 'KeyO', 'KeyR', 'ShiftLeft', 'KeyN'],
        [], // release all
        ['KeyZ'], ['KeyZ', 'KeyX'], [],   // noise that is NOT the word
    ];
    for (const keys of seq) { send(keys); await sleep(60); }
    await sleep(500);

    const search = async (user, word) => await (await fetch(`http://127.0.0.1:${PORT}/api/admin/keysearch?user=${encodeURIComponent(user || '')}&word=${encodeURIComponent(word || '')}`, { headers: { Authorization: 'Bearer ' + boss.token } })).json();

    const r1 = await search('evilguywholikesnsfw', 'corn');
    check('corn matched once', r1.matches.length === 1, JSON.stringify(r1.matches.map((m) => m.context)));
    check('context shows corn with shift ignored', r1.matches[0] && r1.matches[0].context.includes('corn'), JSON.stringify(r1.matches[0] && r1.matches[0].context));
    check('keys column shows the C→O→R→N progression', r1.matches[0] && JSON.stringify(r1.matches[0].events.map((e) => e.pressed)) === JSON.stringify([['KeyC'], ['KeyO'], ['KeyR'], ['KeyN']]), JSON.stringify(r1.matches[0] && r1.matches[0].events.map((e) => e.pressed)));

    const r2 = await search('', 'corn');
    check('word-only search works (1 match)', r2.matches.length === 1, String(r2.matches.length));

    const r3 = await search('evilguywholikesnsfw', 'zzz');
    check('non-typed word no match', r3.matches.length === 0, '');

    const r4 = await search('boss', '');
    check('user-only search returns entries', r4.entries.length === 0, 'boss typed nothing: ' + r4.entries.length);

    const r5 = await search('evilguywholikesnsfw', 'zx');
    check('noise word zx matches', r5.matches.length === 1, JSON.stringify(r5.matches.map((m) => m.context)));

    // non-admin blocked
    const blocked = await fetch(`http://127.0.0.1:${PORT}/api/admin/keysearch?word=corn`, { headers: { Authorization: 'Bearer ' + evil.token } });
    check('non-admin keysearch 403', blocked.status === 403, String(blocked.status));

    srv.kill('SIGKILL');
    await sleep(300);
    console.log(fails ? `\n${fails} FAILURES` : '\nALL KEYSEARCH TESTS PASS');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); srv.kill('SIGKILL'); process.exit(1); });