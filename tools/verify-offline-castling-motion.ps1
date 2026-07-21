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
$productionOutput = Join-Path $root 'tmp\offline-castling-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-castling-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$maximumHeartbeatElapsedMs = 1250
$expectedProductionFlashBytes = 1078743
$expectedProductionRamBytes = 48440
$expectedFinalFen = '5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2'

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
        [switch]$CastlingDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($CastlingDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            'compiler.cpp.extra_flags=-DENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS=1'
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

function Read-CastlingReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 guarded castling diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend and enable gantry power.' -ForegroundColor Yellow
    Write-Host 'Place Black king e8 and rook h8.' -ForegroundColor Yellow
    Write-Host 'Place White king f1, rooks e1/g1, and pawns a2/e2/g2.' -ForegroundColor Yellow
    Write-Host 'Leave every other board square empty and keep hands clear during homing.' -ForegroundColor Yellow
    Write-Host 'Keep g7 and the complete e8-g8/h8-g7-f8 route clear.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White pawn a2-a3.' -ForegroundColor Yellow
    Write-Host 'Expected: Black king e8-g8, then Black rook h8-g7-f8.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_CASTLING_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'castling'
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
                        if ($source -eq 'castling' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid castling diagnostic JSON: $line" }
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
        Write-Host "Saved castling diagnostic Serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Castling output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No castling summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-CastlingReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $castling = @($Events | Where-Object diagnosticSource -eq 'castling')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($castling | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The guarded castling summary reported failure.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motor, magnet, or command-isolation checks failed.'
    }
    if (-not $summary.programsCompiled -or -not $summary.orderedPrimitives -or
        -not $summary.kingOvershootEnabled -or
        -not $summary.rookOvershootEnabled -or
        $summary.verifiedPhaseCount -ne 2 -or
        -not $summary.finalOccupancyMatched -or
        -not $summary.opponentMoveCommitted -or
        $summary.retryExhausted -or $summary.recoveryRequired) {
        throw 'The king and rook phases did not execute, verify, and commit cleanly.'
    }
    if ($summary.selectedMove -ne 'e8g8' -or
        $summary.committedFen -ne $expectedFinalFen -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'The final castling move, FEN, or occupancy is incorrect.'
    }

    $failedChecks = @($castling | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "Castling checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before homing.'
    }

    $accepted = @($castling | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'a2a3') {
        throw 'The physical acceptance move must be a2a3.'
    }
    $search = @($castling | Where-Object type -eq 'search')[-1]
    if (-not $search -or $search.bestMove -ne 'e8g8' -or
        $search.depth -lt 1 -or $search.nodes -lt 1 -or
        $search.elapsedMs -gt 3100) {
        throw 'Deterministic castling search telemetry is missing or outside limits.'
    }

    $plan = @($castling | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.selectedMove -ne 'e8g8' -or
        $plan.strategy -ne 'castle-board' -or $plan.phaseCount -ne 2 -or
        $plan.routeCost -ne 68) {
        throw 'The controlled e8g8 castle-board plan was not staged.'
    }

    $programs = @($castling | Where-Object type -eq 'castling-program')
    $king = @($programs | Where-Object phaseKind -eq 'castle-king')[-1]
    $rook = @($programs | Where-Object phaseKind -eq 'castle-rook')[-1]
    if (-not $king -or $king.status -ne 'success' -or
        $king.from -ne 'e8' -or $king.to -ne 'g8' -or
        $king.routeMode -ne 'board-line' -or $king.routeCost -ne 20 -or
        (@($king.rawPath) -join ',') -ne 'e8,f8,g8' -or
        (@($king.compressedPath) -join ',') -ne 'e8,g8') {
        throw 'CastleKing differs from the accepted e8-f8-g8 route.'
    }
    $kingKinds = @($king.primitives | ForEach-Object kind)
    if (($kingKinds -join ',') -ne
        'travel-board,pickup,drag-board,drop,verify' -or
        @($king.primitives | Where-Object finalBoardDrop).Count -ne 1) {
        throw 'CastleKing primitive order or overshoot policy is incorrect.'
    }

    if (-not $rook -or $rook.status -ne 'success' -or
        $rook.from -ne 'h8' -or $rook.to -ne 'f8' -or
        $rook.routeMode -ne 'board-buffered' -or $rook.routeCost -ne 48 -or
        (@($rook.rawPath) -join ',') -ne 'h8,g7,f8') {
        throw 'CastleRook differs from the accepted h8-g7-f8 route.'
    }
    $rookKinds = @($rook.primitives | ForEach-Object kind)
    if (($rookKinds -join ',') -ne
        'travel-board,pickup,drag-board,drag-board,drop,verify' -or
        @($rook.primitives | Where-Object finalBoardDrop).Count -ne 1 -or
        @($rook.primitives | Select-Object -Skip 2 -First 1 | Where-Object finalBoardDrop).Count -ne 0) {
        throw 'CastleRook primitive order or final-only overshoot is incorrect.'
    }

    $successReports = @($castling | Where-Object {
        $_.type -eq 'phase-report' -and $_.success -eq $true
    })
    if ($successReports.Count -ne 2 -or
        (@($successReports | ForEach-Object phaseIndex) -join ',') -ne '0,1') {
        throw 'The transaction did not produce two ordered token-matched reports.'
    }
    if ($summary.sensorMaxGapMs -ge 25 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Castling timing, resources, core, or priority are outside limits.'
    }

    Write-Host (
        "Castling diagnostic passed: human=a2a3, reply=e8g8, " +
        "king=e8-g8, rook=h8-g7-f8, sensorGap=$($summary.sensorMaxGapMs) ms."
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
    -Label 'ESP32 guarded castling diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -CastlingDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Castling diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host (
    "Castling firmware metrics: production=$($production.FlashBytes)/" +
    "$($production.RamBytes), diagnostic=$($diagnostic.FlashBytes)/" +
    "$($diagnostic.RamBytes), headroom=$applicationHeadroom bytes."
) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload guarded castling diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-CastlingReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-CastlingReport -Events $events
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

Write-Host "`nOffline castling verification passed." -ForegroundColor Green
