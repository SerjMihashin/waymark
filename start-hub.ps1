# Waymark Hub — запуск
# Подключение: http://localhost:3747/mcp
#
# Через Podman (рекомендуется):
#   podman compose up -d
#
# Напрямую (dev):
#   .\start-hub.ps1 [-Build]

param(
    [switch]$Build,
    [switch]$Podman
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot

Set-Location $ProjectDir

if ($Podman) {
    Write-Host "Starting via Podman..." -ForegroundColor Cyan
    podman compose up -d
    Write-Host "Connect Claude to: http://localhost:3747/mcp" -ForegroundColor Green
    exit 0
}

if ($Build) {
    Write-Host "Building..." -ForegroundColor Cyan
    npm run build
}

# Проверяем что порт свободен
$portInUse = Get-NetTCPConnection -LocalPort 3747 -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host "Port 3747 already in use. Hub may already be running." -ForegroundColor Yellow
    Write-Host "Connect Claude to: http://localhost:3747/mcp" -ForegroundColor Green
    exit 0
}

Write-Host "Starting Waymark Hub on http://localhost:3747/mcp" -ForegroundColor Green
node dist/server.js --http
