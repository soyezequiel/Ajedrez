# Deploy del server de ajedrez a la laptop (self-host Docker, mismo host que Luna Negra).
#
# Uso (Windows, desde la raíz del repo):  npm run deploy
#   equivale a:  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
#
# Empaqueta el árbol de trabajo (sin node_modules/builds/secretos), lo manda por
# scp a la laptop (alias SSH `luna`) y reconstruye la imagen del Dockerfile allá,
# levantando el contenedor con docker compose. NO usa pipes (PowerShell los corrompe):
# empaqueta a un archivo, lo copia y reconstruye por SSH.
#
# El secreto NGE_CONNECTION vive SOLO en ~/ajedrez/.env.docker en la laptop (nunca
# viaja en el paquete). El rating ELO persiste en un volumen Docker (sobrevive redeploys).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pkg  = Join-Path $env:TEMP 'ajedrez-update.tgz'

# Host (alias en ~/.ssh/config) y carpeta destino en la laptop (~/ajedrez).
$RemoteHost = 'luna'
$RemoteDir  = 'ajedrez'

# Identificador de build para el version-poll del cliente (ver web/src/version.ts).
# Se calcula ACA (la laptop no tiene el .git, se excluye del paquete). SHA + timestamp:
# único en cada deploy aunque no haya commit nuevo, así una pestaña con la versión
# vieja abierta detecta el cambio y recarga sola.
$sha = git -C $root rev-parse --short HEAD
if ($LASTEXITCODE -ne 0 -or -not $sha) { $sha = 'nogit' }
$buildId = "$sha-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"

# El WASM de Vexel (game/bin) está gitignoreado pero el build del web lo copia
# (sync-game). Si falta, el build en la laptop rompe → cortamos acá con un mensaje claro.
Write-Host '-> Verificando el WASM de Vexel (game/bin, necesario para el build del web)...'
if (-not (Test-Path (Join-Path $root 'game\bin\ajedrez.wasm'))) {
  throw "Falta game/bin/ajedrez.wasm. El build del web lo necesita (sync-game). Compila el cliente Vexel antes de deployar."
}

Write-Host '-> Empaquetando codigo (sin node_modules, builds ni secretos)...'
# Excludes con semantica bsdtar (tar.exe de Windows): `--exclude=NAME` matchea el
# componente NAME en CUALQUIER nivel (verificado en el deploy de Luna Negra). Por
# eso NO excluimos `bin`: el WASM de Vexel en game/bin DEBE viajar. `data` se come
# server/data (ratings de dev); .env/.env.docker quedan afuera (secretos). El
# .env.docker.example SI viaja (no matchea `.env` exacto) → documenta la config.
tar.exe czf $pkg -C $root `
  --exclude=node_modules `
  --exclude=.git `
  --exclude=.claude `
  --exclude=scratchpad `
  --exclude=dist `
  --exclude=data `
  --exclude=.env `
  --exclude=.env.docker `
  .
if ($LASTEXITCODE -ne 0) { throw "tar fallo (exit $LASTEXITCODE): no se empaqueto el codigo." }

Write-Host '-> Enviando a la laptop...'
scp $pkg "${RemoteHost}:ajedrez-update.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp fallo (exit $LASTEXITCODE): el paquete no llego a la laptop." }

Write-Host '-> Reconstruyendo en la laptop (la primera vez tarda: npm ci + build del web)...'
# `rm -rf server web game` antes de extraer: `tar xzf` extrae ENCIMA y NO borra
# archivos que ya no estan en el paquete; una copia vieja de un fuente borrado/
# renombrado rompe el build. El .tgz SIEMPRE trae esos dirs completos. Los DATOS no
# se tocan: el rating vive en un volumen Docker y .env.docker es top-level (fuera de
# esos dirs). `touch .env.docker`: garantiza que el env_file exista (compose falla si
# no) sin pisar uno real. `--wait`: usa el HEALTHCHECK del Dockerfile como compuerta
# (si el server no queda healthy, docker compose devuelve != 0 y el deploy falla).
$remote = @(
  "mkdir -p ~/$RemoteDir",
  "rm -rf ~/$RemoteDir/server ~/$RemoteDir/web ~/$RemoteDir/game",
  "tar xzf ~/ajedrez-update.tgz -C ~/$RemoteDir",
  "touch ~/$RemoteDir/.env.docker",
  # Buildeamos ANTES de bajar el contenedor viejo (sin downtime durante el build).
  "cd ~/$RemoteDir && BUILD_ID='$buildId' docker compose build",
  # Sacamos posibles contenedores viejos que retienen el nombre `ajedrez` (el túnel
  # rutea a ese nombre) o el puerto 8790 (deploy anterior `ajedrez-server`). `|| true`:
  # no existir es OK.
  # Los parentesis son importantes: sin agrupar este `|| true`, el shell puede
  # convertir en exitoso un fallo anterior del build y continuar con la imagen vieja.
  "(docker rm -f ajedrez ajedrez-server 2>/dev/null || true)",
  # Recambio rápido: el `up` recrea el contenedor con la imagen recién buildeada.
  "cd ~/$RemoteDir && BUILD_ID='$buildId' docker compose up -d --wait",
  "rm ~/ajedrez-update.tgz"
) -join ' && '
ssh $RemoteHost $remote
if ($LASTEXITCODE -ne 0) { throw "El deploy remoto fallo (exit $LASTEXITCODE): revisa la salida de arriba. El server NO se actualizo (o no quedo healthy)." }

Remove-Item $pkg -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '== Listo: contenedor ajedrez-server corriendo y healthy en la laptop =='
Write-Host '   LAN/local: http://192.168.3.25:8790/health'
Write-Host '   Publico:   configura el Public Hostname del tunel Cloudflare (ver deploy/README.md).'
