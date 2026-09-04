# emulatorSHARE

Share **many emulators with many people at once.** Each console is a headless
Chromium running one emulator; its canvas + game audio are WebCodecs-encoded and
streamed to every connected viewer. Viewers never run the emulator — they get
pixels, and they press buttons into a shared input pile that feeds the host.

```
host (headless Chromium) ─ws /host─► [ relay server.js ] ─ws /stream─► viewers
host  ◄── merged input/controller ─────────► relay ◄─── buttons/mouse / chat
```

Consoles are **dynamic**: nothing is hardcoded. When a host boots, it connects
to `/host?token=…&console=<key>`, sends a `register` frame (name, image,
category, description), and the relay creates or updates that console in its
SQLite database. Viewers then discover it in the grid and connect via
`/stream?token=…&console=<key>`. Spin up a new game dir and it becomes a console.

## Stack

- **server.js** — the relay (`ws`), auth (username/password via scrypt), signed
  viewer tokens, and SQLite (`better-sqlite3`) for users, sessions, and the
  console registry. Per-console: viewer fan-out, key/mouse merge (anarchy or
  majority democracy), keyframe cache, watchdog, chat, and a live roster.
- **host/** — `host.js` (shared headless-Chromium runtime: viewport pinning,
  render shrink, audio capture, WebCodecs encode, input replay) and
  `serve-host.js` (loopback static server per console so the container's own
  Chromium can load the game, and nobody else can).
- **public/** — the viewer web app (login/register, console grid, stream viewer
  with WebCodecs decode, on-screen + keyboard controls, chat, player list).
- **consoles/** — each named folder is a console: `index.html` (loads
  `/ _shared/host.js` then the emulator bundle) plus `bin/` for the game
  binaries. `demo/` is a self-contained canvas console that tests the whole
  pipeline without a real ROM.

## Run it

```bash
npm install
cp .env.example .env            # set EMULATOR_HOST_TOKEN + EMULATOR_JWT_SECRET
node server.js                  # relay on :8090, serves public/ + API
```

Open http://localhost:8090, register, and log in.

### Add a console from this machine (standalone host launcher)

The relay alone doesn't run any games — each console is a headless Chromium.
Run `npm run host-console` on **any machine that has Chrome/Edge** to stream a
console in from there (you can even point it at a server on another computer):

```bash
# on your machine, streaming into a relay at ws://192.168.1.20:8090
npm run host-console -- --url ws://192.168.1.20:8090 \
    --token <EMULATOR_HOST_TOKEN> \
    --console mario64 --dir consoles/mario64 \
    --name "Super Mario 64" --category "Nintendo 64"
```

This boots a local static server for the console's host page + binaries, then
launches headless Chromium pointed at your server's `/host` WebSocket. The
console registers itself and starts streaming; viewers on the server see it the
moment it connects. Run `npm run host-console -- --help` for all options
(`--w --h --fps --bitrate --port --profile`), or `--interactive` to be prompted.
Set `CHROME_BIN` to a specific Chrome/Edge path if the auto-detector misses it.

> **⚠ Hosting on Windows is currently buggy and unsupported right now.** The
> headless host's software-GL emulator is heavily throttled/starved whenever any
> other GPU-heavy Chromium window is foregrounded (the viewer, Discord, etc.),
> causing game + audio stutter. It's a Windows-specific occlusion/contention
> quirk. Use Linux/Docker for reliable hosting; the viewer works fine anywhere.

For the server to accept remote hosts it must be reachable over the network
(it already binds `0.0.0.0`) and you must share `EMULATOR_HOST_TOKEN`.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

`docker compose` boots the relay and one Chromium host per key in
`EMULATOR_CONSOLE_KEYS` (default `demo`). Chromium profile dirs under
`/data/profile/<key>` are volume-mounted so emulator saves persist.

## Adding a console

1. Create `consoles/<key>/` with an `index.html` (host page) and `bin/`.
2. The host page must:
   - include `<canvas … data-host-canvas="1">` (the one to stream),
   - `<script src="/_shared/host.js"></script>` **before** the emulator bundle,
   - call `window.__hostStart()` when the game runtime is ready.
3. Set `EMULATOR_CONSOLE_KEYS=<key>` (and optionally
   `EMULATOR_META_<KEY>` = `Name|img.png|Category|Description`) and boot.

Drop a real emulator bundle (as an Emscripten/SDL build like `sm64.js`/`sm64.wasm`)
into `consoles/<key>/bin/` and reference it from `<key>/index.html`.

## Protocol

Media frames: `[kind:u8][timestamp:f64][payload]`, kinds `2`=video-keyframe,
`3`=video-delta, `5`=audio-chunk. Config `vconfig`/`aconfig`, roster, chat, input,
vote, mode, held, keyframe, and reload are JSON control messages on the same
sockets. See `server.js` and `test/protocol.test.js`.

## Test

```bash
npm test
```