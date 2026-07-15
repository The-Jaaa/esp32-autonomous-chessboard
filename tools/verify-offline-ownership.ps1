param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 35,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$disabledOutput = Join-Path $root 'tmp\offline-ownership-disabled'
$enabledOutput = Join-Path $root 'tmp\offline-ownership-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$maximumHeartbeatElapsedMs = 1250
$expectedDisabledFlashBytes = 1042543
$expectedDisabledRamBytes = 47128

function Get-ArduinoCliPath {
    $command = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $bundled = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    if (-not (Test-Path -LiteralPath $bundled)) {
        throw 'Arduino CLI was not found on PATH or in the Arduino IDE installation.'
    }
    return $bundled
}

function Reset-WorkspaceOutputDirectory {
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

function Invoke-ArduinoCompile {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$OutputDirectory,
        [switch]$OwnershipDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($OwnershipDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property', 'compiler.cpp.extra_flags=-DENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS=1'
        )
    }
    $arguments += @('--output-dir', $OutputDirectory, $firmware)

    $output = @(& $script:arduinoCliPath @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }

    $text = $output -join "`n"
    $flashMatch = [regex]::Match($text, 'Sketch uses\s+([0-9]+)\s+bytes')
    $ramMatch = [regex]::Match($text, 'Global variables use\s+([0-9]+)\s+bytes')
    if (-not $flashMatch.Success -or -not $ramMatch.Success) {
        throw "Could not parse flash/RAM usage from $Label output."
    }

    return [pscustomobject]@{
        FlashBytes = [int]$flashMatch.Groups[1].Value
        RamBytes = [int]$ramMatch.Groups[1].Value
        OutputDirectory = $OutputDirectory
    }
}

function Invoke-ArduinoUpload {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [string]$InputDirectory
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    & $script:arduinoCliPath upload -p $Port --fqbn $fqbn --input-dir $InputDirectory $firmware
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Read-OwnershipDiagnosticReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 ownership diagnostic session on $Port ==" -ForegroundColor Cyan
    $serial = [System.IO.Ports.SerialPort]::new($Port, 115200)
    $serial.ReadTimeout = 200
    $serial.WriteTimeout = 200
    $serial.DtrEnable = $true
    $serial.RtsEnable = $false

    $openDeadline = (Get-Date).AddSeconds(15)
    while (-not $serial.IsOpen) {
        try { $serial.Open() }
        catch {
            if ((Get-Date) -ge $openDeadline) {
                throw "Could not open $Port after ownership upload: $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds 250
        }
    }

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
                if ($line -match '^\[OWNERSHIP_DIAG\]\s+(\{.*\})$') {
                    try {
                        $event = $Matches[1] | ConvertFrom-Json
                        $events.Add($event)
                        if ($event.type -eq 'summary') { $summarySeen = $true }
                    }
                    catch { throw "Invalid ownership diagnostic JSON: $line" }
                }
            }
        }
    }
    finally {
        if ($serial.IsOpen) { $serial.Close() }
        $serial.Dispose()
    }

    if ($SerialLogPath) {
        $resolvedLogPath = if ([System.IO.Path]::IsPathRooted($SerialLogPath)) {
            [System.IO.Path]::GetFullPath($SerialLogPath)
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $root $SerialLogPath))
        }
        $directory = Split-Path -Parent $resolvedLogPath
        if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
        [System.IO.File]::WriteAllText($resolvedLogPath, $raw.ToString())
        Write-Host "Saved ownership diagnostic serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Ownership diagnostic serial output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No ownership diagnostic summary was received from $Port within $TimeoutSeconds seconds."
    }
    return @($events)
}

function Assert-OwnershipDiagnosticReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $summaries = @($Events | Where-Object type -eq 'summary')
    if ($summaries.Count -lt 1) { throw 'Ownership diagnostic summary event is missing.' }
    $summary = $summaries[-1]
    if (-not $summary.pass) { throw 'Ownership diagnostic summary reported failure.' }

    $starts = @($Events | Where-Object type -eq 'start')
    $safety = if ($starts.Count -gt 0) { $starts[-1] } else { $summary }
    if (-not $safety.motorsLocked -or $safety.core -ne 0 -or $safety.priority -ne 1) {
        throw 'Ownership diagnostics did not run motor-locked in the priority-1 core-0 network task.'
    }

    $online = @($Events | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'online_owned'
    })
    if ($online.Count -lt 1) { throw 'The live heartbeat never established online ownership.' }

    $syntheticChecks = @($Events | Where-Object {
        $_.type -eq 'check' -and $_.name -eq 'synthetic-ownership-transitions'
    })
    if ($syntheticChecks.Count -lt 1) { throw 'Embedded synthetic ownership check is missing.' }
    $synthetic = $syntheticChecks[-1]
    if (-not $synthetic.pass) { throw 'Embedded synthetic ownership transitions failed.' }

    $timings = @($Events | Where-Object type -eq 'timing')
    if ($timings.Count -lt 1) { throw 'Ownership sensor timing event is missing.' }
    $timing = $timings[-1]
    if ($timing.sensorScans -le 0 -or $timing.sensorMaxGapMs -ge 25) {
        throw "Ownership sensor timing failed: scans=$($timing.sensorScans), gap=$($timing.sensorMaxGapMs) ms."
    }
    if ($timing.successfulHeartbeats -lt 2) {
        throw "Expected at least two successful live heartbeats; received $($timing.successfulHeartbeats)."
    }
    if ($null -eq $timing.heartbeatMaxElapsedMs -or
        $timing.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs) {
        throw (
            "Ownership heartbeat timeout exceeded: max=$($timing.heartbeatMaxElapsedMs) ms, " +
            "limit=$maximumHeartbeatElapsedMs ms."
        )
    }

    Write-Host ((
        'Ownership diagnostic passed: scans={0}, sensorGap={1} ms, heartbeats={2}, heartbeatMax={3} ms.'
    ) -f $timing.sensorScans, $timing.sensorMaxGapMs, $timing.successfulHeartbeats,
        $timing.heartbeatMaxElapsedMs) -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath

$disabled = Invoke-ArduinoCompile `
    -Label 'ESP32 USB-only production firmware compile' `
    -OutputDirectory $disabledOutput
if ($disabled.FlashBytes -ne $expectedDisabledFlashBytes -or
    $disabled.RamBytes -ne $expectedDisabledRamBytes) {
    throw (
        "Production firmware changed. Expected $expectedDisabledFlashBytes/$expectedDisabledRamBytes " +
        "flash/RAM; received $($disabled.FlashBytes)/$($disabled.RamBytes)."
    )
}

$enabled = Invoke-ArduinoCompile `
    -Label 'ESP32 offline ownership diagnostic firmware compile' `
    -OutputDirectory $enabledOutput `
    -OwnershipDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $enabled.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Ownership diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host ((
    'Ownership firmware metrics: production={0}/{1}, diagnostic={2}/{3}, headroom={4} bytes.'
) -f $disabled.FlashBytes, $disabled.RamBytes, $enabled.FlashBytes,
    $enabled.RamBytes, $applicationHeadroom) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload offline ownership diagnostic firmware' `
            -Port $UploadPort `
            -InputDirectory $enabled.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-OwnershipDiagnosticReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-OwnershipDiagnosticReport -Events $events
    }
    finally {
        if ($diagnosticUploaded) {
            Invoke-ArduinoUpload `
                -Label 'Restore USB-only production firmware' `
                -Port $UploadPort `
                -InputDirectory $disabled.OutputDirectory
        }
    }
}

Write-Host "`nOffline ownership verification passed." -ForegroundColor Green
