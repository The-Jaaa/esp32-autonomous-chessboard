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
    Invoke-Checked 'Physical and host-only offline regressions' { npm run test:foundation }
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
    Invoke-Checked 'ESP32 USB-only and offline resource diagnostic firmware builds' {
        & (Join-Path $PSScriptRoot 'verify-offline-embedded.ps1')
    }
    Invoke-Checked 'ESP32 offline ownership diagnostic firmware builds' {
        & (Join-Path $PSScriptRoot 'verify-offline-ownership.ps1')
    }
    Invoke-Checked 'ESP32 read-only offline runtime diagnostic firmware builds' {
        & (Join-Path $PSScriptRoot 'verify-offline-runtime.ps1')
    }
}

Write-Host "`nFoundation verification passed." -ForegroundColor Green
