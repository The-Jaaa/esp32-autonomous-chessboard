param(
    [ValidateSet('LedGallery', 'WhiteClearance', 'BlackClearance')]
    [string]$Fixture = 'LedGallery',
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 300,
    [string]$SerialLogPath = '',
    [switch]$ReuseCompiledFirmware
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-led-transfer-production'
$diagnosticOutput = Join-Path $root "tmp\offline-led-transfer-$($Fixture.ToLowerInvariant())"
$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$expectedProductionFlashBytes = 1083819
$expectedProductionRamBytes = 48768
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$fixtureValue = @{ LedGallery = 0; WhiteClearance = 1; BlackClearance = 2 }[$Fixture]

function Get-ArduinoCliPath {
    $command = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bundled = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    if (-not (Test-Path -LiteralPath $bundled)) {
        throw 'Arduino CLI was not found on PATH or in the Arduino IDE installation.'
    }
    $bundled
}

function Reset-OutputDirectory([string]$Path) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove output directory outside the workspace: $resolvedPath"
    }
    if (Test-Path -LiteralPath $resolvedPath) {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $resolvedPath | Out-Null
}

function Invoke-Compile([string]$Label, [string]$OutputDirectory, [bool]$Diagnostic) {
    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-OutputDirectory $OutputDirectory
    $arguments = @('compile', '--clean', '--fqbn', $fqbn)
    if ($Diagnostic) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            "compiler.cpp.extra_flags=-DENABLE_OFFLINE_LED_TRANSFER_PARITY_DIAGNOSTICS=1 -DOFFLINE_LED_TRANSFER_FIXTURE=$fixtureValue"
        )
    }
    $arguments += @('--output-dir', $OutputDirectory, $firmware)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @(& $script:arduinoCli @arguments 2>&1)
    $ErrorActionPreference = $previousPreference
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "$Label failed." }
    $text = $output -join "`n"
    $flash = [regex]::Match($text, 'Sketch uses\s+([0-9]+)\s+bytes')
    $ram = [regex]::Match($text, 'Global variables use\s+([0-9]+)\s+bytes')
    if (-not $flash.Success -or -not $ram.Success) {
        throw "Could not parse flash/RAM usage from $Label."
    }
    [pscustomobject]@{
        FlashBytes = [int]$flash.Groups[1].Value
        RamBytes = [int]$ram.Groups[1].Value
        OutputDirectory = $OutputDirectory
    }
}

function Invoke-Upload([string]$Label, [string]$InputDirectory) {
    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    & $script:arduinoCli upload -p $UploadPort --fqbn $fqbn --input-dir $InputDirectory $firmware
    if ($LASTEXITCODE -ne 0) { throw "$Label failed." }
}

function Read-ParityReport {
    Write-Host "`n== $Fixture LED/transfer diagnostic on $UploadPort ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend and keep the gantry idle. The parity diagnostic keeps motors locked and the magnet LOW.' -ForegroundColor Yellow
    if ($Fixture -eq 'LedGallery') {
        Write-Host 'Observe the fixed sideways text orientation, setup colors, move roles, result colors, and promotion glyphs.' -ForegroundColor Yellow
    } elseif ($Fixture -eq 'WhiteClearance') {
        Write-Host 'Observe planner-only h2-h4 clearance metadata for g1-f3. No physical transfer is executed.' -ForegroundColor Yellow
    } else {
        Write-Host 'Observe planner-only h7-h5 clearance metadata for g8-f6 after the supplied e4 position.' -ForegroundColor Yellow
    }

    $serial = [System.IO.Ports.SerialPort]::new($UploadPort, 115200)
    $serial.ReadTimeout = 200
    $serial.DtrEnable = $true
    $serial.RtsEnable = $false
    $serial.Open()
    $raw = [System.Text.StringBuilder]::new()
    $lineBuffer = ''
    $summary = $null
    $deadline = (Get-Date).AddSeconds($SerialTimeoutSeconds)
    try {
        while ((Get-Date) -lt $deadline -and -not $summary) {
            $chunk = $serial.ReadExisting()
            if (-not $chunk) { Start-Sleep -Milliseconds 40; continue }
            [void]$raw.Append($chunk)
            $lineBuffer += $chunk
            while ($lineBuffer.Contains("`n")) {
                $index = $lineBuffer.IndexOf("`n")
                $line = $lineBuffer.Substring(0, $index).Trim("`r")
                $lineBuffer = $lineBuffer.Substring($index + 1)
                if ($line) { Write-Host $line }
                if ($line -match '^\[OFFLINE_LED_TRANSFER_DIAG\]\s+(\{.*\})$') {
                    $event = $Matches[1] | ConvertFrom-Json
                    if ($event.type -eq 'summary') { $summary = $event }
                }
            }
        }
    }
    finally {
        $serial.Close()
        $serial.Dispose()
    }
    if ($SerialLogPath) {
        $path = [System.IO.Path]::GetFullPath((Join-Path $root $SerialLogPath))
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [System.IO.File]::WriteAllText($path, $raw.ToString())
    }
    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Diagnostic output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summary) { throw 'No LED transfer parity summary was received before timeout.' }
    if (-not $summary.pass -or -not $summary.motorsLocked -or -not $summary.magnetLow -or
        [int]$summary.frameSubmissions -le 0) {
        throw 'The parity summary reported a failed safety or frame-submission check.'
    }
    if ($Fixture -ne 'LedGallery' -and -not $summary.clearancePlanPassed) {
        throw 'The temporary-clearance planner fixture did not pass.'
    }
    $summary
}

$script:arduinoCli = Get-ArduinoCliPath
$productionBinary = Join-Path $productionOutput 'esp32_firmware.ino.bin'
$diagnosticBinary = Join-Path $diagnosticOutput 'esp32_firmware.ino.bin'
if ($ReuseCompiledFirmware) {
    if (-not (Test-Path -LiteralPath $productionBinary) -or
        -not (Test-Path -LiteralPath $diagnosticBinary)) {
        throw 'Reusable firmware outputs are missing; run one normal compile first.'
    }
    $production = [pscustomobject]@{
        FlashBytes = $expectedProductionFlashBytes
        RamBytes = $expectedProductionRamBytes
        OutputDirectory = $productionOutput
    }
    $diagnostic = [pscustomobject]@{
        FlashBytes = (Get-Item -LiteralPath $diagnosticBinary).Length
        RamBytes = 0
        OutputDirectory = $diagnosticOutput
    }
} else {
    $production = Invoke-Compile 'Production firmware' $productionOutput $false
    $diagnostic = Invoke-Compile "$Fixture LED/transfer parity firmware" $diagnosticOutput $true
}
if ($production.FlashBytes -ne $expectedProductionFlashBytes -or
    $production.RamBytes -ne $expectedProductionRamBytes) {
    throw "Production baseline changed: $($production.FlashBytes) flash / $($production.RamBytes) RAM."
}
if (($maximumApplicationBytes - $diagnostic.FlashBytes) -lt $minimumApplicationHeadroomBytes) {
    throw 'LED/transfer parity firmware has less than 512 KiB application headroom.'
}

if (-not $UploadPort) {
    Write-Host "Compile-only verification passed: production $($production.FlashBytes)/$($production.RamBytes), diagnostic $($diagnostic.FlashBytes)/$($diagnostic.RamBytes)." -ForegroundColor Green
    exit 0
}

try {
    Invoke-Upload "$Fixture parity upload" $diagnosticOutput
    $summary = Read-ParityReport
    Write-Host "LED/transfer parity hardware diagnostic passed for $Fixture." -ForegroundColor Green
}
finally {
    Invoke-Upload 'Restore production firmware' $productionOutput
}
