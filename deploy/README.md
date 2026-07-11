# Deploy del server de ajedrez

El server (`server/`) es la **autoridad**: valida jugadas, lleva el reloj, declara
ganadores **y sirve el build del `web/`** (HTTP + WebSocket en el mismo puerto). Es un
proceso de larga vida. Como sirve el web él mismo, **no hace falta Vercel** ni ningún
hosting estático aparte.

---

## Recomendado: `npm run deploy` (Docker por SSH a la laptop)

Deploy en un comando a la **misma laptop que Luna Negra** (self-host Docker). Desde
la raíz del repo, en la PC de dev (Windows):

```powershell
npm run deploy
```

Qué hace (`deploy/deploy.ps1`, o `deploy/deploy.sh` con `npm run deploy:sh`):

1. Verifica que esté el WASM de Vexel (`game/bin/ajedrez.wasm`) — el build del web lo
   copia (`sync-game`) y está gitignoreado, así que tiene que viajar en el paquete.
2. Empaqueta el árbol con `tar` (sin `node_modules`, builds ni secretos).
3. Lo manda por `scp` a la laptop (alias SSH **`luna`**).
4. Reconstruye la imagen del `Dockerfile` y levanta el contenedor con
   `docker compose up -d --build --wait` en `~/ajedrez`. `--wait` usa el
   `HEALTHCHECK` como compuerta: si el server no queda *healthy*, el deploy **falla**.

Persistencia y secretos:

- **Rating ELO** → volumen Docker `ratings` (`/data/ratings.json`). Sobrevive a
  rebuilds/redeploys. No se pierde al actualizar el código.
- **`NGE_CONNECTION`** (secreto del escrow, para apuestas) → vive **solo** en
  `~/ajedrez/.env.docker` en la laptop. Nunca viaja en el paquete ni entra en la
  imagen. El primer deploy funciona sin él (apuestas apagadas, `caps.bets=false`);
  para habilitarlas creá el archivo (ver `.env.docker.example`) y redeployá.

Acceso:

- **LAN/local:** `http://192.168.3.25:8790` (el contenedor escucha en 8788 adentro,
  publicado en 8790 afuera para no chocar con Luna Negra, que usa 3000).
- **Público (por el túnel de Cloudflare de Luna):** el `cloudflared` de Luna ya corre
  en la laptop. Para exponer el ajedrez con dominio estable (ej.
  `ajedrez.naranja.fit`):
  1. En `docker-compose.yml` descomentá el bloque `networks:` (conecta el contenedor
     a la red `luna-negra_default` del stack de Luna) y redeployá.
  2. En el dashboard de **Cloudflare Zero Trust → Tunnels → (tu túnel) → Public
     Hostnames**, agregá `ajedrez.naranja.fit` → `http://ajedrez-server:8788`.
  Como es el mismo origen, el `wss://` se deriva solo — no hay que configurar URLs.

Logs en vivo:  `npm run deploy:logs`  (o `ssh luna "cd ajedrez && docker compose logs -f"`).

---

## Alternativa: VPS con systemd + Caddy (sin Docker)

> Este runbook aplica si querés exponerlo en otro VPS con TLS propio. Para jugar en tu
> propia máquina o en la LAN alcanza con `npm start` desde la raíz (ver README raíz).

> Este runbook aplica si querés exponerlo en internet con TLS. Para jugar en tu
> propia máquina o en la LAN alcanza con `npm start` desde la raíz (ver README raíz).

```
  navegador (https)
       │  HTTP + WebSocket (mismo origen)
       ▼
  https://TU-HOST   ◄── Caddy (TLS + WS upgrade)
       │  reverse_proxy
       ▼
  Node server :8787 (este VPS: sirve web/dist + WS)
```

## Requisitos en el VPS

- **Node ≥ 20.12** (usamos `process.loadEnvFile()`). Recomendado Node 22/24.
- **Caddy** (TLS automático). Alternativa: nginx + certbot (ver al final).
- Puertos **80 y 443** abiertos en el firewall (Caddy los necesita para el cert).
- Un **hostname** que resuelva a la IP pública del VPS (para el cert TLS):
  - **sslip.io** (cero config): `<IP>.sslip.io` (ej. `203-0-113-7.sslip.io`).
  - **DuckDNS**: subdominio gratis apuntando a la IP.
  - **Dominio propio**: registro A `api-ajedrez.tudominio.com → IP`.

## Pasos

### 1. Copiar el código al VPS

```bash
sudo mkdir -p /opt/ajedrez
sudo chown $USER /opt/ajedrez
# desde tu máquina (o git clone en el VPS): necesitás server/, web/ y game/
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./server ./web ./game ./package.json /opt/ajedrez/
```

### 2. Instalar dependencias y buildear el web

```bash
cd /opt/ajedrez
npm run install:all       # deps de server/ y web/
npm run build             # genera web/dist (el server lo va a servir)
```

### 3. Crear el `.env`

`server/.env` **no** se commitea (está gitignoreado). Crealo en el VPS:

```bash
cat > /opt/ajedrez/server/.env <<'EOF'
PORT=8787
EOF
chmod 600 /opt/ajedrez/server/.env
```

### 4. Levantar el server como servicio

```bash
sudo useradd -r -s /usr/sbin/nologin ajedrez   # usuario sin login (si no existe)
sudo chown -R ajedrez /opt/ajedrez
sudo cp deploy/ajedrez-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ajedrez-server
journalctl -u ajedrez-server -f     # deberías ver: "http://localhost:8787 · sirviendo web/dist"
```

Probalo local en el VPS: `curl localhost:8787/health` → `{"ok":true,"rooms":0}`

### 5. Reverse proxy con TLS (Caddy)

```bash
# editá deploy/Caddyfile y poné tu hostname real en vez de 203-0-113-7.sslip.io
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Probá desde **afuera** del VPS que responde por https:

```bash
curl https://TU-HOST/health      # mismo JSON, ahora por https
```

### 6. Verificar end-to-end

Abrí `https://TU-HOST` en el navegador. El server sirve el web y el WebSocket se
deriva del mismo origen (`wss://TU-HOST`) automáticamente — no hay que configurar
ninguna URL. Debería pedirte un nombre y mostrar el home; en los logs del server
(`journalctl -u ajedrez-server -f`) vas a ver la conexión.

> **Actualizar el web:** cuando cambies el código, en el VPS corré `git pull`
> (o re-`rsync`), `npm run build` y `sudo systemctl restart ajedrez-server`.

---

## Notas

- **Origen del WS:** el `WebSocketServer` hoy acepta cualquier origen. Como el web
  se sirve mismo-origen esto casi no importa, pero para endurecer conviene un
  allowlist de `Origin` (tu dominio) en `wss.on("connection")`.
- **Estado en memoria:** las salas viven en RAM (`RoomManager`). Un restart del
  server tira las partidas en curso. Aceptable para empezar; persistencia = trabajo
  futuro.

## Alternativa: build a JS en vez de tsx

Si preferís no depender de `tsx` en runtime:

```bash
cd /opt/ajedrez/server
npm ci && npm run build          # genera dist/
# y en el systemd unit, cambiá ExecStart por:
#   ExecStart=/usr/bin/env node dist/index.js
```

## Alternativa: nginx + certbot (en vez de Caddy)

```nginx
server {
    listen 443 ssl;
    server_name TU-HOST;
    # ssl_certificate / ssl_certificate_key los pone certbot

    location / {
        proxy_pass http://localhost:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # <-- imprescindible para WebSocket
        proxy_set_header Connection "upgrade";          # <--
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;                       # WS de larga vida
    }
}
```

`sudo certbot --nginx -d TU-HOST` para el cert.
