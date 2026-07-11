# Imagen del server autoritativo de ajedrez que ADEMÁS sirve el build del web.
# Un solo proceso: HTTP + WebSocket en el mismo puerto (deploy unificado), pensado
# para correr como contenedor detrás del Cloudflare Tunnel (mismo-origen → wss://).
#
# OJO: el WASM del tablero Vexel (game/bin/) está gitignoreado. Tiene que estar
# presente en el contexto de build (viene del working tree, no de `git clone`).

# ---------- Stage 1: build del web (genera web/dist) ----------
FROM node:22-slim AS webbuild
WORKDIR /app
# `nostr-game-protocol` es una dependencia git (github:...); `npm ci` la clona con
# git, que node:22-slim NO trae → sin esto el build rompe. (Mismo gotcha que Luna.)
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web/ ./web/
COPY game/ ./game/
# BUILD_ID (sha+timestamp que fija el deploy) se hornea en el bundle vía Vite define,
# para que el web sepa qué build es y detecte deploys nuevos (ver web/src/version.ts).
ARG BUILD_ID=""
RUN BUILD_ID="$BUILD_ID" npm --prefix web run build   # sync (game/bin+textures) + tsc + vite build

# ---------- Stage 2: runtime (server + web/dist) ----------
FROM node:22-slim AS runtime
WORKDIR /app
# git: server también depende de `nostr-game-protocol` por github: (npm ci lo clona).
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
# tsx es devDependency pero se necesita en runtime (el server corre con --import tsx),
# así que instalamos incluyendo dev.
COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci --include=dev
COPY server/ ./server/
COPY --from=webbuild /app/web/dist ./web/dist

# BUILD_ID también en runtime: el server lo reporta en GET /version (mismo valor que
# el horneado en el web, así una pestaña vieja detecta el deploy y recarga).
ARG BUILD_ID=""
ENV BUILD_ID=$BUILD_ID
ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# Corremos desde server/ para que `--import tsx` resuelva tsx (server/node_modules)
# igual que el script `npm start`. webDist se ubica por import.meta.url (→ /app/web/dist),
# así que no depende del CWD.
WORKDIR /app/server

# Healthcheck contra /health (el server responde {"ok":true,...}).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
