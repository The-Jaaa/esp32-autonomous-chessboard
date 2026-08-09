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
$productionOutput = Join-Path $root 'tmp\offline-en-passant-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-en-passant-enabled'

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
$expectedFinalFen = 'k7/3N4/1K6/8/8/3Pp3/8/8 w - - 0 2'

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
        [switch]$EnPassantDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($EnPassantDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            'compiler.cpp.extra_flags=-DENABLE_OFFLINE_EN_PASSANT_MOTION_DIAGNOSTICS=1'
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

function Read-EnPassantReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 guarded en passant diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend. Keep I4 and the e4-f4-g4-h4 route clear.' -ForegroundColor Yellow
    Write-Host 'Place Black king a8 and pawn d4.' -ForegroundColor Yellow
    Write-Host 'Place White king b6, knight d7, pawns d3 and e2.' -ForegroundColor Yellow
    Write-Host 'Leave every other board square empty and keep hands clear during homing.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White pawn e2-e4.' -ForegroundColor Yellow
    Write-Host 'Expected: White pawn e4-h4-I4, then Black pawn d4-e3 en passant.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_EN_PASSANT_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'enPassant'
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
                        if ($source -eq 'enPassant' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid en passant diagnostic JSON: $line" }
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
        Write-Host "Saved en passant diagnostic Serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'En passant output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No en passant summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-EnPassantReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $capture = @($Events | Where-Object diagnosticSource -eq 'enPassant')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($capture | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The guarded en passant summary reported failure.'
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
        throw 'The en passant phases did not execute, verify, and commit cleanly.'
    }
    if ($summary.selectedMove -ne 'd4e3' -or $summary.graveyardSlot -ne 'I4' -or
        $summary.committedFen -ne $expectedFinalFen -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'The final en passant move, graveyard slot, FEN, or occupancy is incorrect.'
    }

    $failedChecks = @($capture | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "En passant checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before homing.'
    }

    $accepted = @($capture | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'e2e4') {
        throw 'The physical acceptance move must be e2e4.'
    }
    $search = @($capture | Where-Object type -eq 'search')[-1]
    if (-not $search -or $search.bestMove -ne 'd4e3' -or
        $search.depth -lt 1 -or $search.nodes -lt 1 -or
        $search.elapsedMs -gt 3100 -or
        $search.sensorScansDuringSearch -lt 1) {
        throw 'Deterministic en passant search telemetry is missing or outside limits.'
    }

    $plan = @($capture | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.selectedMove -ne 'd4e3' -or
        $plan.strategy -ne 'capture-direct-after-removal' -or
        $plan.graveyardProposal -ne 'I4' -or $plan.phaseCount -ne 2 -or
        $plan.routeCost -ne 568.5) {
        throw 'The controlled d4e3/I4 en passant plan was not staged.'
    }

    $programs = @($capture | Where-Object type -eq 'capture-program')
    $removal = @($programs | Where-Object phaseKind -eq 'captured-removal')[-1]
    $attacker = @($programs | Where-Object phaseKind -eq 'attacker-final')[-1]
    if (-not $removal -or $removal.status -ne 'success' -or
        $removal.from -ne 'e4' -or $removal.to -ne 'I4' -or
        $removal.routeMode -ne 'graveyard-board-path' -or
        $removal.routeCost -ne 554.5 -or $removal.graveyardLabel -ne 'I4' -or
        $removal.graveyardX -ne 17600 -or $removal.graveyardY -ne -350 -or
        (@($removal.rawPath) -join ',') -ne 'e4,f4,g4,h4' -or
        (@($removal.compressedPath) -join ',') -ne 'e4,h4') {
        throw 'Captured removal differs from the accepted e4-h4-I4 route.'
    }
    $removalKinds = @($removal.primitives | ForEach-Object kind)
    if (($removalKinds -join ',') -ne
        'travel-board,pickup,drag-board,drag-coordinate,drop,verify' -or
        @($removal.primitives | Where-Object finalBoardDrop).Count -ne 0) {
        throw 'En passant removal primitive order or overshoot policy is incorrect.'
    }

    if (-not $attacker -or $attacker.status -ne 'success' -or
        $attacker.from -ne 'd4' -or $attacker.to -ne 'e3' -or
        $attacker.routeMode -ne 'board-direct' -or $attacker.routeCost -ne 14 -or
        (@($attacker.rawPath) -join ',') -ne 'd4,e3') {
        throw 'Attacker final differs from the accepted d4-e3 route.'
    }
    $attackerKinds = @($attacker.primitives | ForEach-Object kind)
    if (($attackerKinds -join ',') -ne
        'travel-board,pickup,drag-board,drop,verify' -or
        @($attacker.primitives | Where-Object finalBoardDrop).Count -ne 1) {
        throw 'En passant attacker primitive order or final-only overshoot is incorrect.'
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
        throw 'No execution event confirmed I4 Pending-to-Occupied.'
    }

    if ($summary.sensorMaxGapMs -ge 25 -or
        $summary.searchSensorScans -lt 1 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'En passant timing, resources, core, or priority are outside limits.'
    }

    Write-Host (
        "En passant diagnostic passed: human=e2e4, reply=d4e3, " +
        "captured=e4, graveyard=I4, sensorGap=$($summary.sensorMaxGapMs) ms."
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
    -Label 'ESP32 guarded en passant diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -EnPassantDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "En passant diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host (
    "En passant firmware metrics: production=$($production.FlashBytes)/" +
    "$($production.RamBytes), diagnostic=$($diagnostic.FlashBytes)/" +
    "$($diagnostic.RamBytes), headroom=$applicationHeadroom bytes."
) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload guarded en passant diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-EnPassantReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-EnPassantReport -Events $events
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

Write-Host "`nOffline en passant verification passed." -ForegroundColor Green
