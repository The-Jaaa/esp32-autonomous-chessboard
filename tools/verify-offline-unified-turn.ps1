param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 900,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-unified-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-unified-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$maximumHeartbeatElapsedMs = 1250
$expectedProductionFlashBytes = 1042543
$expectedProductionRamBytes = 47128

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
        [switch]$UnifiedDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($UnifiedDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            'compiler.cpp.extra_flags=-DENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS=1'
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
    [pscustomobject]@{
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

function Read-UnifiedTurnReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 unified three-turn diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend, power the gantry, and keep hands clear during bounded homing.' -ForegroundColor Yellow
    Write-Host 'Arrange the exact standard position and clear every Z/I transit and graveyard coordinate.' -ForegroundColor Yellow
    Write-Host 'Play g1-f3 first. After each robot reply, use the Serial legal-move list and play one legal quiet White move.' -ForegroundColor Yellow
    Write-Host 'The diagnostic stops after the third verified robot reply and production is then restored.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_UNIFIED_TURN_DIAG\]\s+(\{.*\})$') {
                    $source = 'unified'
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
                        if ($source -eq 'unified' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid unified diagnostic JSON: $line" }
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
        Write-Host "Saved unified diagnostic Serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Unified diagnostic output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No unified summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-UnifiedTurnReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $unified = @($Events | Where-Object diagnosticSource -eq 'unified')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($unified | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The unified three-turn summary reported failure.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motion, magnet, or command-isolation checks failed.'
    }
    if ($summary.humanMoveCount -ne 3 -or
        $summary.opponentMoveCount -ne 3 -or
        $summary.turnBoundaryCount -ne 3 -or
        $summary.searchCount -ne 3 -or
        -not $summary.humanTurnOpen) {
        throw 'The diagnostic did not complete exactly three full turns and reopen the final boundary.'
    }
    if (-not $summary.finalOccupancyMatched -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy -or
        $summary.retryExhausted -or $summary.recoveryRequired) {
        throw 'Final occupancy or transaction recovery state is incorrect.'
    }

    $failedChecks = @($unified | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "Unified checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before bounded homing.'
    }

    $turnReady = @($unified | Where-Object type -eq 'turn-ready')
    if ($turnReady.Count -ne 3 -or
        $turnReady[0].turn -ne 1 -or
        @($turnReady[0].legalMoves) -notcontains 'g1f3') {
        throw 'Serial did not publish all three turn boundaries or the required first move.'
    }
    $accepted = @($unified | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })
    if ($accepted.Count -ne 3 -or $accepted[0].acceptedMove.uci -ne 'g1f3') {
        throw 'Exactly three human moves were not accepted, or the first was not g1f3.'
    }

    $searches = @($unified | Where-Object type -eq 'search')
    if ($searches.Count -ne 3) { throw 'Exactly three engine searches were not observed.' }
    foreach ($search in $searches) {
        if (-not $search.bestMove -or $search.depth -lt 1 -or
            $search.nodes -lt 1 -or $search.elapsedMs -gt 3100 -or
            $search.sensorScansDuringSearch -lt 1) {
            throw 'An engine search was illegal, incomplete, or outside timing limits.'
        }
    }
    if ((@($searches | Measure-Object -Property heartbeatAttemptsDuringSearch -Sum).Sum) -lt 1) {
        throw 'No heartbeat attempt occurred across the three engine searches.'
    }

    $plans = @($unified | Where-Object type -eq 'plan')
    if ($plans.Count -ne 3) { throw 'Exactly three opponent motion plans were not staged.' }
    $compilers = @($unified | Where-Object type -eq 'compiler')
    if ($compilers.Count -lt 3 -or @($compilers | Where-Object status -ne 'success').Count -gt 0) {
        throw 'One or more unified compiler dispatches failed.'
    }
    $validCompilerKinds = @('quiet', 'lane', 'capture', 'castling', 'promotion')
    if (@($compilers | Where-Object { $validCompilerKinds -notcontains $_.compiler }).Count -gt 0) {
        throw 'Unified compiler telemetry contains an unknown compiler kind.'
    }

    $programs = @($unified | Where-Object type -eq 'unified-program')
    if ($programs.Count -ne $compilers.Count -or
        @($programs | Where-Object status -ne 'success').Count -gt 0) {
        throw 'Normalized primitive programs do not match compiler dispatches.'
    }
    foreach ($program in $programs) {
        $kinds = @($program.primitives | ForEach-Object kind)
        if ($kinds.Count -lt 5 -or $kinds[0] -ne 'travel-board' -or
            $kinds[1] -ne 'pickup' -or
            $kinds[-2] -ne 'drop' -or $kinds[-1] -ne 'verify') {
            throw 'A normalized motion program has an invalid primitive order.'
        }
    }

    $successfulReports = @($unified | Where-Object {
        $_.type -eq 'phase-report' -and $_.success -eq $true
    })
    if ($successfulReports.Count -ne $summary.verifiedPhaseCount) {
        throw 'Verified phase telemetry does not match the summary.'
    }
    $opened = @($unified | Where-Object {
        $_.type -eq 'execution' -and $_.event -eq 'human_turn_opened'
    })
    if ($opened.Count -ne 3) {
        throw 'The adapter did not reopen each exact stable human-turn boundary.'
    }

    if ($summary.sensorMaxGapMs -ge 25 -or
        $summary.searchSensorScans -lt 1 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs -or
        $summary.maximumSearchElapsedMs -gt 3100 -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Unified timing, resources, core, or priority are outside limits.'
    }

    Write-Host (
        "Unified diagnostic passed: turns=3, phases=$($summary.verifiedPhaseCount), " +
        "finalFen=$($summary.committedFen), sensorGap=$($summary.sensorMaxGapMs) ms."
    ) -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath

$production = Invoke-ArduinoCompile `
    -Label 'ESP32 USB-only production firmware compile' `
    -OutputDirectory $productionOutput
if ($production.FlashBytes -ne $expectedProductionFlashBytes -or
    $production.RamBytes -ne $expectedProductionRamBytes) {
    throw (
        "Production firmware changed. Expected $expectedProductionFlashBytes/" +
        "$expectedProductionRamBytes flash/RAM; received " +
        "$($production.FlashBytes)/$($production.RamBytes)."
    )
}

$diagnostic = Invoke-ArduinoCompile `
    -Label 'ESP32 guarded unified three-turn diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -UnifiedDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Unified diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host (
    "Unified firmware metrics: production=$($production.FlashBytes)/" +
    "$($production.RamBytes), diagnostic=$($diagnostic.FlashBytes)/" +
    "$($diagnostic.RamBytes), headroom=$applicationHeadroom bytes."
) -ForegroundColor Green

if ($UploadPort) {
    $restoreRequired = $false
    try {
        $restoreRequired = $true
        Invoke-ArduinoUpload `
            -Label 'Upload guarded unified three-turn diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $events = Read-UnifiedTurnReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-UnifiedTurnReport -Events $events
    }
    finally {
        if ($restoreRequired) {
            Invoke-ArduinoUpload `
                -Label 'Restore USB-only production firmware' `
                -Port $UploadPort `
                -InputDirectory $production.OutputDirectory
        }
    }
}

Write-Host "`nOffline unified three-turn verification passed." -ForegroundColor Green
