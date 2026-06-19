# Deploy del server de ajedrez en un VPS

El server (`server/`) es la **autoridad**: valida jugadas, lleva el reloj, declara
ganadores y habla server-to-server con Luna Negra (guarda la API key `ln_sk_…`).
Es un proceso WebSocket de larga vida → **no entra en Vercel** (que solo sirve el
`web/` estático). Por eso va en un VPS.

> **Por qué hace falta esto:** en producción el web de Vercel (`https`) abre un
> WebSocket. Si ese WS apunta a `ws://localhost:8787` (el default) o a un server
> que no existe, cuando Luna Negra abre el juego con `?lnToken=` el shell se saltea
> el login y queda esperando el `authed` que nunca llega → **pantalla en blanco**.
> Desplegar el server con `wss://` arregla eso.

```
Luna Negra (moon21)  ──abre con ?lnToken──►  web en Vercel (https)
                                                   │  WebSocket
                                                   ▼
                                   wss://TU-HOST   ◄── Caddy (TLS + WS upgrade)
                                                   │  reverse_proxy
                                                   ▼
                                   Node server :8787 (este VPS)
                                                   │  server-to-server (Bearer ln_sk_…)
                                                   ▼
                                          moon21.vercel.app (Luna Negra API)
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
# desde tu máquina (o git clone en el VPS):
rsync -av --exclude node_modules --exclude .env ./server /opt/ajedrez/
```

### 2. Instalar dependencias

```bash
cd /opt/ajedrez/server
npm ci          # instala también tsx (devDependency) para correr en prod
```

### 3. Crear el `.env` con las credenciales reales

`server/.env` **no** se commitea (está gitignoreado). Crealo en el VPS con los
mismos valores que tu `.env` local:

```bash
cat > /opt/ajedrez/server/.env <<'EOF'
LUNA_API_KEY=ln_sk_...              # la API key real (SOLO vive en el server)
LUNA_GAME_ID=cmql3lhb300o9lg04xsopxa9s
LUNA_WEBHOOK_SECRET=...
LUNA_BASE_URL=https://moon21.vercel.app
PORT=8787
PUBLIC_WEB_URL=https://TU-WEB.vercel.app   # para armar los inviteUrl de las salas
EOF
chmod 600 /opt/ajedrez/server/.env
```

Verificá que las credenciales funcionan **antes** de exponer nada:

```bash
npm run verify:luna     # debe dar "LIVE OK" contra moon21
```

### 4. Levantar el server como servicio

```bash
sudo useradd -r -s /usr/sbin/nologin ajedrez   # usuario sin login (si no existe)
sudo chown -R ajedrez /opt/ajedrez
sudo cp deploy/ajedrez-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ajedrez-server
journalctl -u ajedrez-server -f     # deberías ver: "server en :8787 · Luna Negra LIVE"
```

Probalo local en el VPS: `curl localhost:8787/health` → `{"ok":true,"lunaLive":true,...}`

### 5. Reverse proxy con TLS (Caddy)

```bash
# editá deploy/Caddyfile y poné tu hostname real en vez de 203-0-113-7.sslip.io
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Probá desde **afuera** del VPS que el WSS responde:

```bash
curl https://TU-HOST/health      # mismo JSON, ahora por https
```

### 6. Apuntar el web de Vercel al server

En el proyecto de Vercel del `web/`, agregá la variable de entorno:

```
VITE_WS_URL = wss://TU-HOST
```

…y hacé **Redeploy** (Vite hornea la URL en build; sin redeploy sigue con
`ws://localhost:8787`). Para verificar qué quedó horneado:

```bash
# en el build: debe aparecer wss://TU-HOST, NO ws://localhost
grep -o "wss\?://[^\"']*" web/dist/assets/*.js
```

### 7. Verificar end-to-end desde Luna Negra

Abrí el juego desde moon21. Ahora debería:
1. Conectar el WS (`wss://TU-HOST`).
2. Canjear el `lnToken` → `GET /api/v1/session` → identidad real (`source: "luna-negra"`).
3. Mostrar el home en vez de pantalla en blanco.

En los logs del server (`journalctl -u ajedrez-server -f`) vas a ver la conexión.

---

## Notas

- **Webhook de Luna Negra:** hoy el webhook del proveedor apunta a otra app
  (`tetras.vercel.app`), no a `https://TU-HOST/webhook`. No bloquea: los depósitos
  de apuestas se detectan igual por **polling** (`pollDeposits`, cada 3s). El
  webhook es solo una optimización; decisión pendiente para M6.
- **Origen del WS:** el `WebSocketServer` hoy acepta cualquier origen. Para
  endurecer, más adelante conviene un allowlist de `Origin` (tu dominio de Vercel)
  en `wss.on("connection")`.
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
