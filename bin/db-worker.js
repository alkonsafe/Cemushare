'use strict';
// DB worker thread — ALL better-sqlite3 access lives here so the synchronous
// driver never blocks the relay's event loop. The main thread talks to us via
// {id, op, stmt, params} RPC frames; every reply is {id, ok, result|error}.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = workerData.dbPath;
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

// Migrations for DBs created before these columns existed.
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'discord_id')) {
    db.exec('ALTER TABLE users ADD COLUMN discord_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id) WHERE discord_id IS NOT NULL');
if (!userCols.some((c) => c.name === 'last_ip')) {
    db.exec('ALTER TABLE users ADD COLUMN last_ip TEXT');
}

const SQL = {
    userByName:          'SELECT * FROM users WHERE username = ?',
    userById:            'SELECT * FROM users WHERE id = ?',
    userByDiscord:       'SELECT * FROM users WHERE discord_id = ?',
    createUser:          'INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)',
    createDiscordUser:   'INSERT INTO users (username, password_hash, created_at, discord_id) VALUES (?,?,?,?)',
    setUserIp:           'UPDATE users SET last_ip = ? WHERE id = ?',
    insertSession:       'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    deleteSession:       'DELETE FROM sessions WHERE expires_at <= ?',
    findSession:         'SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
    deleteSessionsByUser:'DELETE FROM sessions WHERE user_id = ?',
    upsertConsole: `
      INSERT INTO consoles (key, name, image, category, description, created_at, updated_at, last_seen)
      VALUES (@key, @name, @image, @category, @description, @created_at, @updated_at, @last_seen)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        image = excluded.image,
        category = excluded.category,
        description = excluded.description,
        updated_at = excluded.updated_at,
        last_seen = excluded.last_seen
    `,
    touchConsole:        'UPDATE consoles SET last_seen = ? WHERE key = ?',
    listConsoles:        'SELECT * FROM consoles ORDER BY updated_at DESC',
    deleteConsole:       'DELETE FROM consoles WHERE key = ?',
    setImage:            'UPDATE consoles SET image = ?, updated_at = ? WHERE key = ?',
    countUsers:          'SELECT COUNT(*) AS n FROM users',
    listUsers:           'SELECT id, username, created_at, discord_id, last_ip FROM users ORDER BY id DESC LIMIT 500',
    getAdmin:            'SELECT username FROM admins WHERE username = ?',
    listAdmins:          'SELECT username, added_at FROM admins ORDER BY added_at',
    addAdmin:            'INSERT OR IGNORE INTO admins (username, added_at) VALUES (?,?)',
    delAdmin:            'DELETE FROM admins WHERE username = ?',
    listBans:            'SELECT kind, value, reason, added_at FROM bans ORDER BY added_at DESC',
    getBan:              'SELECT kind, value FROM bans WHERE kind = ? AND value = ?',
    addBan:              'INSERT OR REPLACE INTO bans (kind, value, reason, added_at) VALUES (?,?,?,?)',
    delBan:              'DELETE FROM bans WHERE kind = ? AND value = ?',
    bannedUsers:         "SELECT value FROM bans WHERE kind = 'user'",
};
const stmts = {};
for (const [name, sql] of Object.entries(SQL)) stmts[name] = db.prepare(sql);

parentPort.on('message', (msg) => {
    const { id, op, stmt, params } = msg || {};
    try {
        const s = stmts[stmt];
        if (!s) throw new Error(`unknown statement: ${stmt}`);
        // Arrays spread positionally; a bare object is one named-parameter arg.
        const args = Array.isArray(params) ? params : [params];
        let result;
        if (op === 'get') result = s.get(...args) ?? null;
        else if (op === 'all') result = s.all(...args);
        else if (op === 'run') {
            const r = s.run(...args);
            result = { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        } else throw new Error(`unknown op: ${op}`);
        parentPort.postMessage({ id, ok: true, result });
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
});