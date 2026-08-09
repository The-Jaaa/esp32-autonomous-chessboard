param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 180,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$disabledOutput = Join-Path $root 'tmp\offline-runtime-disabled'
$enabledOutput = Join-Path $root 'tmp\offline-runtime-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$maximumHeartbeatElapsedMs = 1250
$expectedDisabledFlashBytes = 1083819
$expectedDisabledRamBytes = 48768

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
        [switch]$RuntimeDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($RuntimeDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property', 'compiler.cpp.extra_flags=-DENABLE_OFFLINE_RUNTIME_DIAGNOSTICS=1'
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

function Read-RuntimeDiagnosticReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 read-only runtime diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Keep the backend stopped, place the standard starting position, then make one legal White move.' -ForegroundColor Yellow
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
                throw "Could not open $Port after runtime upload: $($_.Exception.Message)"
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

                $source = $null
                $json = $null
                if ($line -match '^\[OFFLINE_RUNTIME_DIAG\]\s+(\{.*\})$') {
                    $source = 'runtime'
                    $json = $Matches[1]
                }
                elseif ($line -match '^\[OWNERSHIP_DIAG\]\s+(\{.*\})$') {
                    $source = 'ownership'
                    $json = $Matches[1]
                }
                if ($json) {
                    try {
                        $event = $json | ConvertFrom-Json
                        $event | Add-Member -NotePropertyName diagnosticSource -NotePropertyValue $source
                        $events.Add($event)
                        if ($source -eq 'runtime' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid runtime diagnostic JSON: $line" }
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
        Write-Host "Saved runtime diagnostic serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Runtime diagnostic serial output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No runtime diagnostic summary was received from $Port within $TimeoutSeconds seconds."
    }
    return @($events)
}

function Assert-RuntimeDiagnosticReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $runtimeEvents = @($Events | Where-Object diagnosticSource -eq 'runtime')
    $ownershipEvents = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summaries = @($runtimeEvents | Where-Object type -eq 'summary')
    if ($summaries.Count -lt 1) { throw 'Runtime diagnostic summary is missing.' }
    $summary = $summaries[-1]
    if (-not $summary.pass) { throw 'Runtime diagnostic summary reported failure.' }
    if (-not $summary.motorsLocked -or -not $summary.magnetLow -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Runtime diagnostic did not remain motor-locked in the low-priority core-0 task.'
    }
    if ($summary.opponentMoveCommitted) {
        throw 'The read-only diagnostic committed the staged opponent move.'
    }

    $failedChecks = @($runtimeEvents | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "Runtime checks failed: $($failedChecks.name -join ', ')"
    }

    $offlineTransitions = @($ownershipEvents | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    })
    if ($offlineTransitions.Count -lt 1) {
        throw 'Ownership did not reach offline_idle during the runtime diagnostic.'
    }

    foreach ($requiredPhase in @('waiting_for_setup', 'human_turn', 'engine_search_needed', 'plan_ready')) {
        $matches = @($runtimeEvents | Where-Object {
            $_.type -eq 'runtime' -and $_.phase -eq $requiredPhase
        })
        if ($matches.Count -lt 1) { throw "Runtime phase '$requiredPhase' was not observed." }
    }

    $accepted = @($runtimeEvents | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })
    if ($accepted.Count -lt 1 -or -not $accepted[-1].acceptedMove.uci) {
        throw 'No verified human move was accepted by the offline coordinator.'
    }

    $searches = @($runtimeEvents | Where-Object type -eq 'search')
    if ($searches.Count -lt 1) { throw 'Offline engine search telemetry is missing.' }
    $search = $searches[-1]
    if (-not $search.bestMove -or $search.depth -lt 1 -or $search.nodes -lt 1) {
        throw 'Offline engine search did not return a completed legal candidate.'
    }
    if ($search.elapsedMs -gt 3100) {
        throw "Offline search exceeded 3,100 ms: $($search.elapsedMs) ms."
    }
    if ($search.sensorScansDuringSearch -lt 1 -or $search.heartbeatAttemptsDuringSearch -lt 2) {
        throw 'Sensor scanning or heartbeat attempts stopped during engine search.'
    }

    $plans = @($runtimeEvents | Where-Object type -eq 'plan')
    if ($plans.Count -lt 1) { throw 'Motion-plan telemetry is missing.' }
    $plan = $plans[-1]
    if (-not $plan.selectedMove -or $plan.phaseCount -lt 1) {
        throw 'The staged opponent move does not contain a usable motion plan.'
    }
    if ($plan.committedFen -ne $plan.beforeFen -or $plan.committedFen -eq $plan.previewAfterFen) {
        throw 'The opponent preview mutated the authoritative chess position.'
    }
    $phases = @($runtimeEvents | Where-Object type -eq 'phase')
    if ($phases.Count -ne $plan.phaseCount) {
        throw "Expected $($plan.phaseCount) phase records; received $($phases.Count)."
    }

    if ($summary.sensorMaxGapMs -ge 25 -or $summary.searchSensorScans -lt 1) {
        throw "Runtime sensor timing failed: gap=$($summary.sensorMaxGapMs) ms."
    }
    if ($summary.searchHeartbeatAttempts -lt 2 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs) {
        throw 'Runtime heartbeat timing or progress failed during search.'
    }
    if ($summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes) {
        throw 'Runtime diagnostic resource headroom is below the accepted threshold.'
    }

    Write-Host ((
        'Runtime diagnostic passed: move={0}, reply={1}, phases={2}, search={3} ms, sensorGap={4} ms.'
    ) -f $accepted[-1].acceptedMove.uci, $plan.selectedMove, $plan.phaseCount,
        $search.elapsedMs, $summary.sensorMaxGapMs) -ForegroundColor Green
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
    -Label 'ESP32 read-only offline runtime diagnostic compile' `
    -OutputDirectory $enabledOutput `
    -RuntimeDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $enabled.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Runtime diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host ((
    'Runtime firmware metrics: production={0}/{1}, diagnostic={2}/{3}, headroom={4} bytes.'
) -f $disabled.FlashBytes, $disabled.RamBytes, $enabled.FlashBytes,
    $enabled.RamBytes, $applicationHeadroom) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload read-only offline runtime diagnostic' `
            -Port $UploadPort `
            -InputDirectory $enabled.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-RuntimeDiagnosticReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-RuntimeDiagnosticReport -Events $events
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

Write-Host "`nOffline read-only runtime verification passed." -ForegroundColor Green
