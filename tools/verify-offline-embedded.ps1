param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 55,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$disabledOutput = Join-Path $root 'tmp\offline-embedded-disabled'
$enabledOutput = Join-Path $root 'tmp\offline-embedded-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$expectedDisabledFlashBytes = 1078743
$expectedDisabledRamBytes = 48440

function Get-ArduinoCliPath {
    $command = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

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
        [switch]$Diagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory

    $arguments = @('compile', '--fqbn', $fqbn)
    if ($Diagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property', 'compiler.cpp.extra_flags=-DENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS=1'
        )
    }
    $arguments += @('--output-dir', $OutputDirectory, $firmware)

    $output = @(& $script:arduinoCliPath @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }

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
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Read-OfflineDiagnosticReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 offline diagnostic session on $Port ==" -ForegroundColor Cyan
    $serial = [System.IO.Ports.SerialPort]::new($Port, 115200)
    $serial.ReadTimeout = 200
    $serial.WriteTimeout = 200
    $serial.DtrEnable = $true
    $serial.RtsEnable = $false

    $openDeadline = (Get-Date).AddSeconds(15)
    while (-not $serial.IsOpen) {
        try {
            $serial.Open()
        }
        catch {
            if ((Get-Date) -ge $openDeadline) {
                throw "Could not open $Port after the diagnostic upload: $($_.Exception.Message)"
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
                if ($line.Length -gt 0) {
                    Write-Host $line
                }

                if ($line -match '^\[OFFLINE_DIAG\]\s+(\{.*\})$') {
                    try {
                        $event = $Matches[1] | ConvertFrom-Json
                    }
                    catch {
                        throw "Invalid offline diagnostic JSON: $line"
                    }
                    $events.Add($event)
                    if ($event.type -eq 'summary') {
                        $summarySeen = $true
                    }
                }
            }
        }
    }
    finally {
        if ($serial.IsOpen) {
            $serial.Close()
        }
    }

    if ($SerialLogPath) {
        $resolvedLogPath = if ([System.IO.Path]::IsPathRooted($SerialLogPath)) {
            $SerialLogPath
        }
        else {
            Join-Path $root $SerialLogPath
        }
        $logDirectory = Split-Path -Parent $resolvedLogPath
        if ($logDirectory) {
            New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
        }
        [System.IO.File]::WriteAllText($resolvedLogPath, $raw.ToString())
        Write-Host "Saved diagnostic serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'The offline diagnostic serial log contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No offline diagnostic summary was received from $Port within $TimeoutSeconds seconds."
    }

    return @($events)
}

function Assert-DiagnosticReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $summary = @($Events | Where-Object type -eq 'summary')[-1]
    if (-not $summary.pass) {
        $failedChecks = @(
            $Events |
                Where-Object { $_.type -eq 'check' -and -not $_.pass } |
                ForEach-Object { $_.name }
        )
        throw "Offline diagnostic summary failed. Failed checks: $($failedChecks -join ', ')"
    }

    $start = @($Events | Where-Object type -eq 'start')[-1]
    if (-not $start.motorsLocked -or $start.core -ne 0 -or $start.priority -ne 0) {
        throw 'Diagnostic task did not report the required core-0, idle-priority motor lock.'
    }

    $memory = @($Events | Where-Object { $_.type -eq 'memory' -and $_.name -eq 'final' })[-1]
    if ($memory.internalFree -lt 96KB) { throw "Free internal heap is below 96 KiB: $($memory.internalFree)" }
    if ($memory.largestInternal -lt 64KB) { throw "Largest internal allocation is below 64 KiB: $($memory.largestInternal)" }
    if ($memory.psramFree -lt 5MB) { throw "Free PSRAM is below 5 MiB: $($memory.psramFree)" }
    if ($memory.stackHeadroom -lt 2KB) { throw "Diagnostic stack headroom is below 2 KiB: $($memory.stackHeadroom)" }

    $timing = @($Events | Where-Object type -eq 'timing')[-1]
    if ($timing.sensorScans -le 0 -or $timing.sensorMaxGapMs -ge 25) {
        throw "Sensor loop timing failed: scans=$($timing.sensorScans), maxGapMs=$($timing.sensorMaxGapMs)"
    }
    if ($timing.successfulPolls -le 0) {
        throw 'No successful HTTP polls were observed during embedded search.'
    }

    $threeSecondSearches = @(
        $Events | Where-Object { $_.type -eq 'search' -and $_.name -match '3000ms$' }
    )
    if ($threeSecondSearches.Count -ne 2) {
        throw "Expected two three-second searches, received $($threeSecondSearches.Count)."
    }
    foreach ($search in $threeSecondSearches) {
        if (-not $search.pass -or $search.elapsedMs -gt 3100) {
            throw "Three-second search $($search.name) exceeded its gate: $($search.elapsedMs) ms."
        }
    }

    Write-Host ((
        "Diagnostic resources: internal={0} bytes, largest={1} bytes, PSRAM={2} bytes, " +
        "stack={3} bytes, sensorGap={4} ms, polls={5}."
    ) -f
        $memory.internalFree,
        $memory.largestInternal,
        $memory.psramFree,
        $memory.stackHeadroom,
        $timing.sensorMaxGapMs,
        $timing.successfulPolls
    ) -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath

$disabled = Invoke-ArduinoCompile `
    -Label 'ESP32 USB-only production firmware compile' `
    -OutputDirectory $disabledOutput
if ($disabled.FlashBytes -ne $expectedDisabledFlashBytes -or
    $disabled.RamBytes -ne $expectedDisabledRamBytes) {
    throw (
        "Disabled diagnostic build changed the USB-only baseline. " +
        "Expected $expectedDisabledFlashBytes/$expectedDisabledRamBytes flash/RAM; " +
        "received $($disabled.FlashBytes)/$($disabled.RamBytes)."
    )
}

$enabled = Invoke-ArduinoCompile `
    -Label 'ESP32 offline embedded diagnostic firmware compile' `
    -OutputDirectory $enabledOutput `
    -Diagnostics
$applicationHeadroom = $maximumApplicationBytes - $enabled.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Diagnostic firmware has only $applicationHeadroom bytes of application-partition headroom."
}

Write-Host ((
    "Firmware metrics: production={0} flash/{1} RAM; diagnostic={2} flash/{3} RAM; " +
    "diagnostic app headroom={4} bytes."
) -f
    $disabled.FlashBytes,
    $disabled.RamBytes,
    $enabled.FlashBytes,
    $enabled.RamBytes,
    $applicationHeadroom
) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload offline embedded diagnostic firmware' `
            -Port $UploadPort `
            -InputDirectory $enabled.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-OfflineDiagnosticReport -Port $UploadPort -TimeoutSeconds $SerialTimeoutSeconds
        Assert-DiagnosticReport -Events $events
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

Write-Host "`nOffline embedded resource verification passed." -ForegroundColor Green
