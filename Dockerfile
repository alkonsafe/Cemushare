# emulatorSHARE — one container, one relay, N headless-Chromium hosts.
#
# The relay (server.js) does auth + SQLite + per-console media fan-out.
# Each console is a headless Chromium running its own host page; the entrypoint
# spawns one per configured console key. Chromium provides WebGL (SwiftShader)
# and the WebCodecs encoder — no GPU needed.

FROM node:18-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        tini \
    && apt-get clean

WORKDIR /app

# Dependencies first so code edits don't re-run npm install (and so better-sqlite3
# compiles its native binding against the same node major).
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

# The relay, the shared host runtime, the frontend, and every console's host page.
COPY server.js /app/server.js
COPY host/ /app/host/
COPY public/ /app/public/
COPY consoles/ /app/consoles/

ENV EMULATOR_PORT=8090 \
    EMULATOR_DB=/app/data/emulatorshare.db \
    HOST_STATIC_PORT=8091 \
    EMULATOR_CONSOLE_KEYS=demo \
    CHROME_DEVEL_SANDBOX=

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]