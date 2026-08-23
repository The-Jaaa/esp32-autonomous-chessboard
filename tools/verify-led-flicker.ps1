param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 210,
    [string]$SerialLogPath = 'logs\led-core-comparison.log'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$diagnosticSketch = Join-Path $root 'firmware_tests\hardware\esp32_led_flicker_diag'
$productionOutput = Join-Path $root 'tmp\led-flicker-production'
$diagnosticOutput = Join-Path $root 'tmp\led-flicker-diagnostic'
$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$expectedProductionFlash = 1083819
$expectedProductionRam = 48768
$expectedPhases = @(
    'dense-core1-round1',
    'dense-core0-round1',
    'dense-core0-round2',
    'dense-core1-round2'
)

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
    param([Parameter(Mandatory)] [string]$Path)

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

function Invoke-Compile {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$Sketch,
        [Parameter(Mandatory)] [string]$OutputDirectory
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-OutputDirectory -Path $OutputDirectory
    $output = @(& $script:arduinoCliPath compile --fqbn $fqbn --output-dir $OutputDirectory $Sketch 2>&1)
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }

    $text = $output -join "`n"
    $flashMatch = [regex]::Match($text, 'Sketch uses\s+([0-9]+)\s+bytes')
    $ramMatch = [regex]::Match($text, 'Global variables use\s+([0-9]+)\s+bytes')
    if (-not $flashMatch.Success -or -not $ramMatch.Success) {
        throw "Could not parse flash/RAM usage from $Label."
    }
    return [pscustomobject]@{
        FlashBytes = [int]$flashMatch.Groups[1].Value
        RamBytes = [int]$ramMatch.Groups[1].Value
        OutputDirectory = $OutputDirectory
    }
}

function Invoke-Upload {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [string]$InputDirectory,
        [Parameter(Mandatory)] [string]$Sketch
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    & $script:arduinoCliPath upload -p $Port --fqbn $fqbn --input-dir $InputDirectory $Sketch
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Read-Diagnostic {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== LED core comparison on $Port ==" -ForegroundColor Cyan
    Write-Host 'All 64 squares should remain in a blue/orange checkerboard.' -ForegroundColor Yellow
    Write-Host 'Bend the data wire equally in every phase and report any color corruption.' -ForegroundColor Yellow

    $serial = [System.IO.Ports.SerialPort]::new($Port, 115200)
    $serial.ReadTimeout = 200
    $serial.DtrEnable = $true
    $serial.RtsEnable = $false
    $serial.Open()

    $raw = [System.Text.StringBuilder]::new()
    $lineBuffer = ''
    $events = [System.Collections.Generic.List[object]]::new()
    $summarySeen = $false
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    try {
        while ((Get-Date) -lt $deadline -and -not $summarySeen) {
            $chunk = $serial.ReadExisting()
            if ($chunk.Length -eq 0) {
                Start-Sleep -Milliseconds 40
                continue
            }
            [void]$raw.Append($chunk)
            $lineBuffer += $chunk
            while ($lineBuffer.Contains("`n")) {
                $newline = $lineBuffer.IndexOf("`n")
                $line = $lineBuffer.Substring(0, $newline).Trim("`r")
                $lineBuffer = $lineBuffer.Substring($newline + 1)
                if ($line.Length -gt 0) { Write-Host $line }
                if ($line -match '^\[LED_CORE_COMPARE\]\s+(\{.*\})$') {
                    try {
                        $event = $Matches[1] | ConvertFrom-Json
                        $events.Add($event)
                        if ($event.type -eq 'summary') { $summarySeen = $true }
                    }
                    catch { throw "Invalid LED diagnostic JSON: $line" }
                }
            }
        }
    }
    finally {
        if ($serial.IsOpen) { $serial.Close() }
        $serial.Dispose()
    }

    $resolvedLog = if ([System.IO.Path]::IsPathRooted($SerialLogPath)) {
        [System.IO.Path]::GetFullPath($SerialLogPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $root $SerialLogPath))
    }
    $logDirectory = Split-Path -Parent $resolvedLog
    if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
    [System.IO.File]::WriteAllText($resolvedLog, $raw.ToString())
    Write-Host "Saved LED diagnostic log to $resolvedLog"

    if (-not $summarySeen) {
        throw "No LED diagnostic summary was received within $TimeoutSeconds seconds."
    }
    return @($events)
}

function Assert-Diagnostic {
    param([Parameter(Mandatory)] [object[]]$Events)

    foreach ($phase in $expectedPhases) {
        $starts = @($Events | Where-Object { $_.type -eq 'phase-start' -and $_.id -eq $phase })
        $ends = @($Events | Where-Object { $_.type -eq 'phase-end' -and $_.id -eq $phase })
        if ($starts.Count -ne 1 -or $ends.Count -ne 1) {
            throw "Phase $phase did not start and end exactly once."
        }
        $expectedCore = if ($phase -match 'core0') { 0 } else { 1 }
        if ($starts[0].core -ne $expectedCore -or $ends[0].core -ne $expectedCore) {
            throw "Phase $phase ran on an unexpected core."
        }
        if ($ends[0].refreshMs -ne 100 -or $ends[0].showCount -lt 295 -or
            $ends[0].showCount -gt 305) {
            throw "Phase $phase did not maintain the expected 100 ms transmission rate."
        }
    }

    $summary = @($Events | Where-Object type -eq 'summary')[-1]
    if (-not $summary.pass -or -not $summary.visualResultRequired -or
        -not $summary.safetyOutputsLow) {
        throw 'The LED diagnostic safety or completion summary failed.'
    }
    Write-Host 'Automated LED core-comparison checks passed; visual phase results are still required.' -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath
$production = Invoke-Compile `
    -Label 'Compile production firmware for restoration' `
    -Sketch $firmware `
    -OutputDirectory $productionOutput
if ($production.FlashBytes -ne $expectedProductionFlash -or
    $production.RamBytes -ne $expectedProductionRam) {
    throw (
        "Production firmware changed. Expected $expectedProductionFlash/$expectedProductionRam " +
        "flash/RAM; received $($production.FlashBytes)/$($production.RamBytes)."
    )
}

$diagnostic = Invoke-Compile `
    -Label 'Compile standalone LED core comparison' `
    -Sketch $diagnosticSketch `
    -OutputDirectory $diagnosticOutput

Write-Host ((
    'Firmware metrics: production={0}/{1}, LED comparison={2}/{3} flash/RAM.'
) -f $production.FlashBytes, $production.RamBytes,
    $diagnostic.FlashBytes, $diagnostic.RamBytes) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-Upload `
            -Label 'Upload standalone LED core comparison' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory `
            -Sketch $diagnosticSketch
        $diagnosticUploaded = $true
        Start-Sleep -Seconds 2
        $events = Read-Diagnostic -Port $UploadPort -TimeoutSeconds $SerialTimeoutSeconds
        Assert-Diagnostic -Events $events
    }
    finally {
        if ($diagnosticUploaded) {
            Invoke-Upload `
                -Label 'Restore production firmware' `
                -Port $UploadPort `
                -InputDirectory $production.OutputDirectory `
                -Sketch $firmware
        }
    }
}

Write-Host 'LED core comparison verification completed.' -ForegroundColor Green
