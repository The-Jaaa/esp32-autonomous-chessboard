param(
  [string]$Device = "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{39F03D20-FBE1-44F4-8E9C-B133CD54BC16}",
  [int]$Port = 8001
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $root
$ffmpeg = Join-Path $project "tools\ffmpeg\extract\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe"
$relay = Join-Path $PSScriptRoot "live_audio_relay.js"

if (!(Test-Path -LiteralPath $ffmpeg)) {
  throw "ffmpeg.exe not found at $ffmpeg"
}

if (!(Test-Path -LiteralPath $relay)) {
  throw "Relay script not found at $relay"
}

$env:FFMPEG_PATH = $ffmpeg
$env:AUDIO_DEVICE = $Device
$env:RELAY_PORT = [string]$Port

Write-Host "Starting live audio relay."
Write-Host "Device: $Device"
Write-Host "URL: http://0.0.0.0:$Port/live.mp3"
Write-Host "Press Ctrl+C to stop."

node $relay
