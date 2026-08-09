param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 240,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-quiet-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-quiet-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$maximumHeartbeatElapsedMs = 1250
$expectedProductionFlashBytes = 1083819
$expectedProductionRamBytes = 48768

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
        [switch]$QuietMotionDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($QuietMotionDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property', 'compiler.cpp.extra_flags=-DENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS=1'
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

function Read-QuietMotionReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 guarded quiet-motion diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend, use the standard starting position, and keep hands clear while automatic homing runs.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White knight from g1 to f3.' -ForegroundColor Yellow
    Write-Host 'The gantry will execute one real quiet Black reply, verify it, commit internally, and freeze.' -ForegroundColor Yellow

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
                throw "Could not open $Port after diagnostic upload: $($_.Exception.Message)"
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
                if ($line -match '^\[OFFLINE_QUIET_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'quiet'
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
                        if ($source -eq 'quiet' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid quiet-motion diagnostic JSON: $line" }
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
        Write-Host "Saved quiet-motion diagnostic serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Quiet-motion diagnostic output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No quiet-motion summary was received from $Port within $TimeoutSeconds seconds."
    }
    return @($events)
}

function Assert-QuietMotionReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $quiet = @($Events | Where-Object diagnosticSource -eq 'quiet')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($quiet | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The guarded quiet-motion summary reported failure.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motor, magnet, or command-isolation checks failed.'
    }
    if (-not $summary.programCompiled -or -not $summary.orderedPrimitives -or
        -not $summary.finalOccupancyMatched -or -not $summary.opponentMoveCommitted -or
        $summary.retryExhausted -or $summary.recoveryRequired) {
        throw 'The quiet program did not execute, verify, and commit cleanly.'
    }
    if ($summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'Final physical occupancy differs from the committed quiet move.'
    }

    $failedChecks = @($quiet | Where-Object { $_.type -eq 'check' -and -not $_.pass })
    if ($failedChecks.Count -gt 0) {
        throw "Quiet-motion checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before homing.'
    }

    $homeResult = @($quiet | Where-Object {
        $_.type -eq 'hardware-result' -and $_.stage -eq 'home'
    })[-1]
    if (-not $homeResult -or -not $homeResult.success -or -not $homeResult.homed -or
        -not $homeResult.motorActivity -or -not $homeResult.magnetLow) {
        throw 'Bounded X/Y homing did not complete safely.'
    }

    $accepted = @($quiet | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'g1f3') {
        throw 'The physical acceptance move must be g1f3.'
    }

    $search = @($quiet | Where-Object type -eq 'search')[-1]
    if (-not $search -or -not $search.bestMove -or $search.depth -lt 1 -or
        $search.nodes -lt 1 -or $search.elapsedMs -gt 3100) {
        throw 'Offline search telemetry is missing or outside the deadline.'
    }
    if ($search.sensorScansDuringSearch -lt 1 -or
        $search.heartbeatAttemptsDuringSearch -lt 2) {
        throw 'Sensor scanning or heartbeat attempts stopped during search.'
    }

    $plan = @($quiet | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.phaseCount -ne 1 -or -not $plan.selectedMove) {
        throw 'The opponent response was not exactly one staged phase.'
    }
    $program = @($quiet | Where-Object type -eq 'quiet-program')[-1]
    if (-not $program -or $program.status -ne 'success' -or
        $program.move -ne $plan.selectedMove) {
        throw 'The staged phase did not compile into a quiet hardware program.'
    }
    $kinds = @($program.primitives | ForEach-Object kind)
    if ($kinds.Count -lt 5 -or $kinds[0] -ne 'travel' -or
        $kinds[1] -ne 'pickup' -or $kinds[-2] -ne 'drop' -or
        $kinds[-1] -ne 'verify' -or
        @($kinds[2..($kinds.Count - 3)] | Where-Object { $_ -ne 'drag' }).Count -gt 0) {
        throw "Unexpected primitive order: $($kinds -join ', ')"
    }
    $finalDropDrags = @($program.primitives | Where-Object {
        $_.kind -eq 'drag' -and $_.finalBoardDrop
    })
    if ($finalDropDrags.Count -ne 1) {
        throw 'Exactly one final board drag must receive overshoot.'
    }

    $motion = @($quiet | Where-Object {
        $_.type -eq 'hardware-result' -and $_.stage -eq 'quiet-move'
    })[-1]
    if (-not $motion -or -not $motion.success -or -not $motion.motorActivity -or
        -not $motion.magnetEverHigh -or -not $motion.magnetLow) {
        throw 'The real quiet hardware execution did not complete safely.'
    }
    $successReports = @($quiet | Where-Object {
        $_.type -eq 'phase-report' -and $_.success -eq $true
    })
    if ($successReports.Count -ne 1 -or $successReports[0].phaseIndex -ne 0 -or
        $successReports[0].attempt -gt 2) {
        throw 'The quiet phase did not produce one valid token-matched success report.'
    }

    if ($summary.sensorMaxGapMs -ge 25 -or $summary.searchSensorScans -lt 1 -or
        $summary.searchHeartbeatAttempts -lt 2 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs) {
        throw 'Sensor or heartbeat timing exceeded the accepted limits.'
    }
    if ($summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes) {
        throw 'Quiet-motion resource headroom is below the accepted threshold.'
    }
    if ($summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'The offline runtime worker did not remain low-priority on core 0.'
    }

    Write-Host ((
        'Quiet-motion diagnostic passed: human={0}, reply={1}, search={2} ms, sensorGap={3} ms.'
    ) -f $accepted.acceptedMove.uci, $plan.selectedMove,
        $search.elapsedMs, $summary.sensorMaxGapMs) -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath

$production = Invoke-ArduinoCompile `
    -Label 'ESP32 USB-only production firmware compile' `
    -OutputDirectory $productionOutput
if ($production.FlashBytes -ne $expectedProductionFlashBytes -or
    $production.RamBytes -ne $expectedProductionRamBytes) {
    throw (
        "Production firmware changed. Expected $expectedProductionFlashBytes/$expectedProductionRamBytes " +
        "flash/RAM; received $($production.FlashBytes)/$($production.RamBytes)."
    )
}

$diagnostic = Invoke-ArduinoCompile `
    -Label 'ESP32 guarded real quiet-motion diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -QuietMotionDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Quiet-motion diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host ((
    'Quiet-motion firmware metrics: production={0}/{1}, diagnostic={2}/{3}, headroom={4} bytes.'
) -f $production.FlashBytes, $production.RamBytes, $diagnostic.FlashBytes,
    $diagnostic.RamBytes, $applicationHeadroom) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload guarded quiet-motion diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-QuietMotionReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-QuietMotionReport -Events $events
    }
    finally {
        if ($diagnosticUploaded) {
            Invoke-ArduinoUpload `
                -Label 'Restore USB-only production firmware' `
                -Port $UploadPort `
                -InputDirectory $production.OutputDirectory
        }
    }
}

Write-Host "`nOffline quiet-motion verification passed." -ForegroundColor Green
