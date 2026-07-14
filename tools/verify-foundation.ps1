param(
    [switch]$SkipFirmware
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$client = Join-Path $app 'client'
$firmware = Join-Path $root 'esp32_firmware'
$firmwareOutput = Join-Path $root 'tmp\foundation-firmware-check'

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
    Invoke-Checked 'Physical regressions' { npm run test:physical }
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
    $arduinoCli = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($arduinoCli) {
        $arduinoCliPath = $arduinoCli.Source
    }
    else {
        $arduinoCliPath = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    }

    if (-not (Test-Path $arduinoCliPath)) {
        throw 'Arduino CLI was not found on PATH or in the Arduino IDE installation.'
    }

    $fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=min_spiffs,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
    New-Item -ItemType Directory -Force -Path $firmwareOutput | Out-Null
    Invoke-Checked 'ESP32 OTA firmware compile' {
        & $arduinoCliPath compile --fqbn $fqbn --output-dir $firmwareOutput $firmware
    }
}

Write-Host "`nFoundation verification passed." -ForegroundColor Green
