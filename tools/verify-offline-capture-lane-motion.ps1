param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 300,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-capture-lane-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-capture-lane-enabled'

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
$expectedFinalFen = 'k7/8/8/8/pppppppp/4n3/4NNR1/4BKR1 w - - 0 2'

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
        [switch]$CaptureLaneDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($CaptureLaneDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            'compiler.cpp.extra_flags=-DENABLE_OFFLINE_CAPTURE_LANE_MOTION_DIAGNOSTICS=1'
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

function Read-CaptureLaneReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 guarded capture-with-lane diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend. Keep Z2 empty and the Z3-Z5 corridor, including Z4, clear.' -ForegroundColor Yellow
    Write-Host 'Place Black king a8, knight d5, and pawns a4-h4.' -ForegroundColor Yellow
    Write-Host 'Place White pawn e3, king f1, bishop e1, knights e2/f2, and rooks g1/h2.' -ForegroundColor Yellow
    Write-Host 'Leave every other board square empty and keep hands clear during homing.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White rook h2-g2.' -ForegroundColor Yellow
    Write-Host 'Expected: pawn e3-d2-a2-Z2, then knight d5-Z5-Z3-e3.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_CAPTURE_LANE_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'captureLane'
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
                        if ($source -eq 'captureLane' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid capture-lane diagnostic JSON: $line" }
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
        if ($directory) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
        [System.IO.File]::WriteAllText($resolvedLogPath, $raw.ToString())
        Write-Host "Saved capture-lane diagnostic Serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Capture-lane output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No capture-lane summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-CaptureLaneReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $capture = @($Events | Where-Object diagnosticSource -eq 'captureLane')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($capture | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The guarded capture-lane summary reported failure.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motor, magnet, or command-isolation checks failed.'
    }
    if (-not $summary.programsCompiled -or -not $summary.orderedPrimitives -or
        -not $summary.graveyardTransitionObserved -or
        -not $summary.graveyardOvershootDisabled -or
        -not $summary.attackerOvershootEnabled -or
        $summary.verifiedPhaseCount -ne 2 -or
        -not $summary.finalOccupancyMatched -or
        -not $summary.opponentMoveCommitted -or
        $summary.retryExhausted -or $summary.recoveryRequired) {
        throw 'The capture-lane phases did not execute, verify, and commit cleanly.'
    }
    if ($summary.selectedMove -ne 'd5e3' -or $summary.graveyardSlot -ne 'Z2' -or
        $summary.committedFen -ne $expectedFinalFen -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'The final move, graveyard slot, FEN, or occupancy is incorrect.'
    }

    $failedChecks = @($capture | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "Capture-lane checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before homing.'
    }

    $accepted = @($capture | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'h2g2') {
        throw 'The physical acceptance move must be h2g2.'
    }
    $search = @($capture | Where-Object type -eq 'search')[-1]
    if (-not $search -or $search.bestMove -ne 'd5e3' -or
        $search.mateIn -ne 1 -or $search.depth -lt 1 -or
        $search.nodes -lt 1 -or $search.elapsedMs -gt 3100 -or
        $search.sensorScansDuringSearch -lt 1) {
        throw 'Forced-mate capture search telemetry is missing or outside limits.'
    }

    $plan = @($capture | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.selectedMove -ne 'd5e3' -or
        $plan.strategy -ne 'capture-direct-after-removal' -or
        $plan.graveyardProposal -ne 'Z2' -or $plan.phaseCount -ne 2 -or
        $plan.routeCost -ne 1952) {
        throw 'The controlled d5e3/Z2 capture-lane plan was not staged.'
    }

    $programs = @($capture | Where-Object type -eq 'capture-program')
    $removal = @($programs | Where-Object phaseKind -eq 'captured-removal')[-1]
    $attacker = @($programs | Where-Object phaseKind -eq 'attacker-final')[-1]
    if (-not $removal -or $removal.status -ne 'success' -or
        $removal.from -ne 'e3' -or $removal.to -ne 'Z2' -or
        $removal.routeMode -ne 'graveyard-board-path' -or
        $removal.routeCost -ne 652 -or $removal.graveyardLabel -ne 'Z2' -or
        $removal.graveyardX -ne 24800 -or $removal.graveyardY -ne 34450 -or
        (@($removal.rawPath) -join ',') -ne 'e3,d2,c2,b2,a2' -or
        (@($removal.compressedPath) -join ',') -ne 'e3,d2,a2') {
        throw 'Captured removal differs from the accepted e3-d2-a2-Z2 route.'
    }
    $removalKinds = @($removal.primitives | ForEach-Object kind)
    if (($removalKinds -join ',') -ne
        'travel-board,pickup,drag-board,drag-board,drag-coordinate,drop,verify' -or
        @($removal.primitives | Where-Object finalBoardDrop).Count -ne 0) {
        throw 'Captured removal primitive order or overshoot policy is incorrect.'
    }

    if (-not $attacker -or $attacker.status -ne 'success' -or
        $attacker.from -ne 'd5' -or $attacker.to -ne 'e3' -or
        $attacker.routeMode -ne 'lane' -or $attacker.routeCost -ne 1300 -or
        (@($attacker.rawPath) -join ',') -ne 'd5,e3') {
        throw 'Attacker final differs from the accepted d5-Z5-Z3-e3 route.'
    }
    $coordinateTargets = @($attacker.routeTargets | Where-Object role -eq 'lane')
    if ($coordinateTargets.Count -ne 2 -or
        $coordinateTargets[0].label -ne 'Z5' -or
        $coordinateTargets[0].x -ne 13300 -or
        $coordinateTargets[0].y -ne 34450 -or
        $coordinateTargets[1].label -ne 'Z3' -or
        $coordinateTargets[1].x -ne 21300 -or
        $coordinateTargets[1].y -ne 34450) {
        throw 'Attacker lane coordinates are not the calibrated Z5/Z3 pair.'
    }
    $attackerKinds = @($attacker.primitives | ForEach-Object kind)
    if (($attackerKinds -join ',') -ne
        'travel-board,pickup,drag-coordinate,drag-coordinate,drag-board,drop,verify' -or
        @($attacker.primitives | Where-Object finalBoardDrop).Count -ne 1) {
        throw 'Attacker lane primitive order or final-only overshoot is incorrect.'
    }

    $successReports = @($capture | Where-Object {
        $_.type -eq 'phase-report' -and $_.success -eq $true
    })
    if ($successReports.Count -ne 2 -or
        (@($successReports | ForEach-Object phaseIndex) -join ',') -ne '0,1') {
        throw 'The transaction did not produce two ordered token-matched reports.'
    }
    if (@($capture | Where-Object {
        $_.type -eq 'execution' -and
        $_.PSObject.Properties.Name -contains 'graveyardStateAfter' -and
        $_.graveyardStateAfter -eq 'occupied'
    }).Count -lt 1) {
        throw 'No execution event confirmed Z2 Pending-to-Occupied.'
    }

    if ($summary.sensorMaxGapMs -ge 25 -or
        $summary.searchSensorScans -lt 1 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Capture-lane timing, resources, core, or priority are outside limits.'
    }

    Write-Host (
        "Capture-lane diagnostic passed: human=h2g2, reply=d5e3, " +
        "graveyard=Z2, sensorGap=$($summary.sensorMaxGapMs) ms."
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
    -Label 'ESP32 guarded capture-with-lane diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -CaptureLaneDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Capture-lane diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host (
    "Capture-lane firmware metrics: production=$($production.FlashBytes)/" +
    "$($production.RamBytes), diagnostic=$($diagnostic.FlashBytes)/" +
    "$($diagnostic.RamBytes), headroom=$applicationHeadroom bytes."
) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload guarded capture-with-lane diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-CaptureLaneReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-CaptureLaneReport -Events $events
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

Write-Host "`nOffline capture-lane verification passed." -ForegroundColor Green
