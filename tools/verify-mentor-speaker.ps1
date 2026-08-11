param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 45,
    [string]$SerialLogPath = 'logs\mentor-speaker-firmware.log'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$outputDirectory = Join-Path $root 'tmp\mentor-speaker-production'
$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$expectedFlashBytes = 1894091
$expectedRamBytes = 58888

function Get-ArduinoCliPath {
    $command = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bundled = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    if (-not (Test-Path -LiteralPath $bundled)) {
        throw 'Arduino CLI was not found on PATH or in the Arduino IDE installation.'
    }
    return $bundled
}

function Reset-OutputDirectory {
    $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $resolvedOutput = [System.IO.Path]::GetFullPath($outputDirectory)
    if (-not $resolvedOutput.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove output outside the workspace: $resolvedOutput"
    }
    if (Test-Path -LiteralPath $resolvedOutput) {
        Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
}

$arduinoCli = Get-ArduinoCliPath
Reset-OutputDirectory

Write-Host "`n== ESP32 mentor speaker production compile ==" -ForegroundColor Cyan
$compileOutput = @(& $arduinoCli compile --fqbn $fqbn --output-dir $outputDirectory $firmware 2>&1)
$compileExit = $LASTEXITCODE
$compileOutput | ForEach-Object { Write-Host $_ }
if ($compileExit -ne 0) { throw "Firmware compile failed with exit code $compileExit." }

$compileText = $compileOutput -join "`n"
$flashMatch = [regex]::Match($compileText, 'Sketch uses\s+([0-9]+)\s+bytes')
$ramMatch = [regex]::Match($compileText, 'Global variables use\s+([0-9]+)\s+bytes')
if (-not $flashMatch.Success -or -not $ramMatch.Success) {
    throw 'Could not parse firmware flash/RAM usage.'
}
$flashBytes = [int]$flashMatch.Groups[1].Value
$ramBytes = [int]$ramMatch.Groups[1].Value
if ($flashBytes -ne $expectedFlashBytes -or $ramBytes -ne $expectedRamBytes) {
    throw "Production firmware baseline changed: $flashBytes/$ramBytes, expected $expectedFlashBytes/$expectedRamBytes."
}

if (-not $UploadPort) {
    Write-Host "Mentor speaker compile gate passed: $flashBytes flash / $ramBytes RAM." -ForegroundColor Green
    exit 0
}

Write-Host "`n== Upload production firmware to $UploadPort ==" -ForegroundColor Cyan
& $arduinoCli upload -p $UploadPort --fqbn $fqbn --input-dir $outputDirectory $firmware
if ($LASTEXITCODE -ne 0) { throw "Firmware upload failed with exit code $LASTEXITCODE." }

$serial = [System.IO.Ports.SerialPort]::new($UploadPort, 115200)
$serial.ReadTimeout = 200
$serial.DtrEnable = $true
$serial.RtsEnable = $false
$raw = [System.Text.StringBuilder]::new()
$initialized = $false
$connected = $false
try {
    $serial.Open()
    $deadline = (Get-Date).AddSeconds($SerialTimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not $connected) {
        $chunk = $serial.ReadExisting()
        if ($chunk.Length -eq 0) {
            Start-Sleep -Milliseconds 40
            continue
        }
        [void]$raw.Append($chunk)
        Write-Host -NoNewline $chunk
        if ($raw.ToString().Contains('[MENTOR_SPEAKER] initialized')) { $initialized = $true }
        if ($raw.ToString().Contains('[MENTOR_SPEAKER] connected board=main-board')) {
            # Authentication can occur only after PSRAM, I2S, and the speaker
            # task initialize. The one-shot boot line may precede COM opening.
            $initialized = $true
            $connected = $true
        }
    }
}
finally {
    if ($serial.IsOpen) { $serial.Close() }
    $serial.Dispose()
    $resolvedLog = if ([System.IO.Path]::IsPathRooted($SerialLogPath)) {
        [System.IO.Path]::GetFullPath($SerialLogPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $root $SerialLogPath))
    }
    $logDirectory = Split-Path -Parent $resolvedLog
    if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
    [System.IO.File]::WriteAllText($resolvedLog, $raw.ToString())
}

if (-not $initialized) { throw 'Firmware did not report mentor speaker initialization.' }
if (-not $connected) {
    throw 'Firmware initialized but did not authenticate with the mentor speaker server. Ensure the backend is running and tokens match.'
}

Write-Host "Mentor speaker firmware uploaded and authenticated successfully." -ForegroundColor Green
