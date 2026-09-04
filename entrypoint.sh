#!/usr/bin/env bash
# emulatorSHARE boot: the relay first, then one internal static server + one
# headless Chromium per configured console.
#
# A "console" is a chromium instance pointed at the console's own host page.
# On connect it registers itself with the relay (name, image, category...) and
# begins streaming its encoded canvas + audio. Viewers discover it through the
# SAME dynamic registration — spin up a new game dir and it becomes a console.
set -euo pipefail

: "${EMULATOR_HOST_TOKEN:?EMULATOR_HOST_TOKEN must be set}"
: "${EMULATOR_JWT_SECRET:?EMULATOR_JWT_SECRET must be set}"

EMULATOR_PORT="${EMULATOR_PORT:-8090}"
HOST_STATIC_PORT="${HOST_STATIC_PORT:-8091}"
PROFILE_ROOT="${EMULATOR_PROFILE_DIR:-/data/profile}"
CONSOLE_KEYS="${EMULATOR_CONSOLE_KEYS:-demo}"
FPS="${EMULATOR_FPS:-30}"
BITRATE="${EMULATOR_BITRATE:-1800000}"

mkdir -p "$PROFILE_ROOT" /app/data

# Move stale chromium profile locks aside (a redeploy changes the hostname, so
# chromium sees its old lock as owned by "another computer" and refuses to boot).
for key in $CONSOLE_KEYS; do
  dir="$PROFILE_ROOT/$key"
  mkdir -p "$dir"
  for lock in SingletonLock SingletonSocket SingletonCookie; do
    if [ -e "$dir/$lock" ] || [ -L "$dir/$lock" ]; then
      mv -f "$dir/$lock" "$dir/.stale-$lock" 2>/dev/null && echo "moved stale $lock for $key"
    fi
  done
done

# Start the relay.
node /app/server.js &
RELAY_PID=$!

wait_port() { # wait_port <port>
  for i in $(seq 1 50); do
    if node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

wait_port "$EMULATOR_PORT" || { echo "relay did not come up"; exit 1; }

# ── Launch one host per console ─────────────────────────────────────────────
i=0
HOST_PIDS=""
for key in $CONSOLE_KEYS; do
  port=$((HOST_STATIC_PORT + i))

  # Optional per-console metadata: EMULATOR_META_<KEY>="Name|img.png|Category|Desc"
  meta_env="EMULATOR_META_$(echo "$key" | tr '[:lower:]' '[:upper:]' | tr -cs 'A-Z0-9' '_')"
  meta="${!meta_env:-}"
  name=$key; image=""; category=""; desc=""
  if [ -n "$meta" ]; then
    IFS='|' read -r name image category desc <<< "$meta"
  fi

  # Internal static server serving THIS console's host page + binaries.
  CONSOLE_KEY="$key" CONSOLE_DIR="/app/consoles/$key" HOST_STATIC_PORT="$port" \
    node /app/host/serve-host.js &
  HOST_PIDS="$HOST_PIDS $!"
  wait_port "$port" || echo "warn: served host $key did not come up on :$port"

  PROFILE_DIR="$PROFILE_ROOT/$key"
  HOST_URL="http://127.0.0.1:${port}/?relay=ws://127.0.0.1:${EMULATOR_PORT}/host&token=${EMULATOR_HOST_TOKEN}"
  HOST_URL="${HOST_URL}&console=${key}&name=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$name" 2>/dev/null || echo "$name")"
  HOST_URL="${HOST_URL}&image=${image}&category=${category}&desc=${desc}&fps=${FPS}&bitrate=${BITRATE}&w=${EMULATOR_W:-480}&h=${EMULATOR_H:-270}"

  chromium \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --use-gl=angle \
    --use-angle=swiftshader \
    --enable-unsafe-swiftshader \
    --autoplay-policy=no-user-gesture-required \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --hide-scrollbars \
    --disable-gpu-vsync \
    --disable-frame-rate-limit \
    --window-size=${EMULATOR_W:-480},${EMULATOR_H:-270} \
    --user-data-dir="$PROFILE_DIR" \
    --enable-logging=stderr --v=0 \
    "$HOST_URL" &
  HOST_PIDS="$HOST_PIDS $!"
  echo "[entrypoint] launched console '$key' (host page :$port, relay :$EMULATOR_PORT)"
  i=$((i + 1))
done

# If we die, take every child with us.
trap 'kill $RELAY_PID $HOST_PIDS 2>/dev/null || true' EXIT
wait "$RELAY_PID"