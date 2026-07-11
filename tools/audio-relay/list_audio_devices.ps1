$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $root
$ffmpeg = Join-Path $project "tools\ffmpeg\extract\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe"

if (!(Test-Path -LiteralPath $ffmpeg)) {
  throw "ffmpeg.exe not found at $ffmpeg"
}

& $ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1 | ForEach-Object {
  $_.ToString()
}

exit 0
