param(
    [switch]$SkipFirmware
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$client = Join-Path $app 'client'

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [scriptblock]$Command
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Push-Location $app
try {
    Invoke-Checked 'Backend syntax' { node --check server.js }
    Invoke-Checked 'Online physical and shared-settings regressions' { npm run test:online-foundation }
}
finally {
    Pop-Location
}

Push-Location $client
try {
    Invoke-Checked 'Client production build' { npm run build }
    Invoke-Checked 'Client lint' { npm run lint }
}
finally {
    Pop-Location
}

if (-not $SkipFirmware) {
    Invoke-Checked 'ESP32 mentor speaker production firmware build' {
        & (Join-Path $PSScriptRoot 'verify-mentor-speaker.ps1')
    }
}

Write-Host "`nFoundation verification passed." -ForegroundColor Green
