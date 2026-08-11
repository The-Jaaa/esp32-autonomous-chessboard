param(
  [int]$Port = 8001,
  [string]$HostAddress = "0.0.0.0",
  [string]$PublicHost = ""
)

$ErrorActionPreference = "Stop"

$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ffmpeg = Join-Path $project "tools\ffmpeg\extract\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe"
$librespot = Join-Path $project "tools\librespot\bin\librespot.exe"
$relay = Join-Path $PSScriptRoot "live_audio_relay.js"
$envFile = Join-Path $project "app\.env"

if (!(Test-Path -LiteralPath $ffmpeg)) { throw "ffmpeg.exe not found at $ffmpeg" }
if (!(Test-Path -LiteralPath $librespot)) {
  throw "librespot.exe not found. Run tools\setup-librespot.ps1 first."
}
if (!(Test-Path -LiteralPath $relay)) { throw "Relay script not found at $relay" }

if (!$env:ESP32_AUDIO_TOKEN -and (Test-Path -LiteralPath $envFile)) {
  $tokenLine = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match '^\s*ESP32_AUDIO_TOKEN\s*=' } |
    Select-Object -First 1
  if ($tokenLine) { $env:ESP32_AUDIO_TOKEN = ($tokenLine -split '=', 2)[1].Trim() }
}
if (!$env:ESP32_AUDIO_TOKEN) {
  throw "ESP32_AUDIO_TOKEN is required in app\.env or the current environment."
}

$env:CHESS_PROJECT_ROOT = $project
$env:FFMPEG_PATH = $ffmpeg
$env:LIBRESPOT_PATH = $librespot
$env:SPOTIFY_RELAY_HOST = $HostAddress
$env:SPOTIFY_RELAY_PORT = [string]$Port
if ($PublicHost) { $env:SPOTIFY_RELAY_PUBLIC_HOST = $PublicHost }

Write-Host "Starting UoM Chessboard Spotify Connect relay."
Write-Host "HTTP port: $Port"
Write-Host "Press Ctrl+C to stop."
node $relay
