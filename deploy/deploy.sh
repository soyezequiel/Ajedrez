#!/usr/bin/env bash
# Deploy del server de ajedrez a la laptop (self-host Docker, mismo host que Luna Negra).
# Equivalente unix de deploy.ps1. Uso desde la raíz del repo:
#   bash deploy/deploy.sh        (o: npm run deploy:sh)
#
# Empaqueta el árbol, lo manda por scp a `luna` y reconstruye la imagen del
# Dockerfile allá con docker compose. El secreto NGE_CONNECTION vive solo en
# ~/ajedrez/.env.docker en la laptop; el rating ELO en un volumen Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$(mktemp -t ajedrez-update.XXXXXX.tgz)"
REMOTE_HOST="luna"
REMOTE_DIR="ajedrez"

# Build-id para el version-poll del cliente (sha+timestamp): único en cada deploy,
# así una pestaña vieja detecta el cambio y recarga sola (ver web/src/version.ts).
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
BUILD_ID="${SHA}-$(date +%s)"

# El WASM de Vexel (game/bin) está gitignoreado pero el build del web lo necesita.
echo '-> Verificando el WASM de Vexel (game/bin)...'
if [ ! -f "$ROOT/game/bin/ajedrez.wasm" ]; then
  echo "Falta game/bin/ajedrez.wasm (sync-game lo copia al build del web). Compila el cliente Vexel antes de deployar." >&2
  exit 1
fi

echo '-> Empaquetando codigo (sin node_modules, builds ni secretos)...'
# NO excluimos `bin`: el WASM de Vexel en game/bin DEBE viajar. `data` = server/data
# (ratings de dev); .env/.env.docker quedan afuera (secretos).
tar czf "$PKG" -C "$ROOT" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.claude \
  --exclude=scratchpad \
  --exclude=dist \
  --exclude=data \
  --exclude=.env \
  --exclude=.env.docker \
  .

echo '-> Enviando a la laptop...'
scp "$PKG" "${REMOTE_HOST}:ajedrez-update.tgz"

echo '-> Reconstruyendo en la laptop (la primera vez tarda)...'
ssh "$REMOTE_HOST" "mkdir -p ~/$REMOTE_DIR \
  && rm -rf ~/$REMOTE_DIR/server ~/$REMOTE_DIR/web ~/$REMOTE_DIR/game \
  && tar xzf ~/ajedrez-update.tgz -C ~/$REMOTE_DIR \
  && touch ~/$REMOTE_DIR/.env.docker \
  && cd ~/$REMOTE_DIR && BUILD_ID='$BUILD_ID' docker compose build \
  && (docker rm -f ajedrez ajedrez-server 2>/dev/null || true) \
  && BUILD_ID='$BUILD_ID' docker compose up -d --wait \
  && rm ~/ajedrez-update.tgz"

rm -f "$PKG"
echo ''
echo '== Listo: contenedor ajedrez-server corriendo y healthy en la laptop =='
echo '   LAN/local: http://192.168.3.25:8790/health'
