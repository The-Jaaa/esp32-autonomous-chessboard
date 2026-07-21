param(
    [ValidateSet('DirectLane', 'LaneBoard')]
    [string]$Fixture = 'DirectLane',
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 360,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-lane-production'
$directOutput = Join-Path $root 'tmp\offline-lane-direct-enabled'
$laneBoardOutput = Join-Path $root 'tmp\offline-lane-board-enabled'
$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$expectedProductionFlashBytes = 1078743
$expectedProductionRamBytes = 48440
$fixtureNumber = if ($Fixture -eq 'LaneBoard') { 1 } else { 0 }
$expectedRouteMode = if ($Fixture -eq 'LaneBoard') { 'lane-board' } else { 'lane' }
$expectedRouteCost = if ($Fixture -eq 'LaneBoard') { 1366 } else { 1300 }
$expectedRawPath = if ($Fixture -eq 'LaneBoard') {
    'd5,a3,a2,b1,c1,d2,e3'
} else { 'd5,e3' }
$expectedCompressedPath = if ($Fixture -eq 'LaneBoard') {
    'd5,a3,a2,b1,c1,e3'
} else { 'd5,e3' }
$expectedFinalFen = if ($Fixture -eq 'LaneBoard') {
    'k7/8/8/8/pppppppp/2p1n1p1/4NNR1/4BKR1 w - - 2 2'
} else {
    'k7/8/8/8/pppppppp/4n3/4NNR1/4BKR1 w - - 2 2'
}

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
        [int]$LaneFixture = -1
    )
    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($LaneFixture -ge 0) {
        $flags = "-DENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS=1 -DOFFLINE_LANE_MOTION_FIXTURE=$LaneFixture"
        $arguments += @(
            '--library', $offlineCore,
            '--build-property', "compiler.cpp.extra_flags=$flags"
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

function Read-LaneMotionReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )
    Write-Host "`n== ESP32 guarded $Fixture lane-motion diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend and clear the Z3-Z5 corridor, including Z4.' -ForegroundColor Yellow
    Write-Host 'Place Black king a8, Black knight d5, and Black pawns a4 through h4.' -ForegroundColor Yellow
    Write-Host 'Place White king f1, bishop e1, knights e2/f2, and rooks g1/h2.' -ForegroundColor Yellow
    if ($Fixture -eq 'LaneBoard') {
        Write-Host 'Also place Black pawns c3 and g3.' -ForegroundColor Yellow
    } else {
        Write-Host 'Keep c3 and g3 empty.' -ForegroundColor Yellow
    }
    Write-Host 'Keep hands clear while bounded homing runs.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White rook h2-g2.' -ForegroundColor Yellow
    Write-Host 'The robot should move the Black knight d5 through Z5/Z3 and finish on e3.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_LANE_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'lane'; $json = $Matches[1]
                } elseif ($line -match '^\[OWNERSHIP_DIAG\]\s+(\{.*\})$') {
                    $source = 'ownership'; $json = $Matches[1]
                }
                if ($json) {
                    try {
                        $event = $json | ConvertFrom-Json
                        $event | Add-Member -NotePropertyName diagnosticSource -NotePropertyValue $source
                        $events.Add($event)
                        if ($source -eq 'lane' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    } catch { throw "Invalid lane-motion diagnostic JSON: $line" }
                }
            }
        }
    } finally {
        if ($serial.IsOpen) { $serial.Close() }
        $serial.Dispose()
    }

    if ($SerialLogPath) {
        $resolvedLogPath = if ([System.IO.Path]::IsPathRooted($SerialLogPath)) {
            [System.IO.Path]::GetFullPath($SerialLogPath)
        } else { [System.IO.Path]::GetFullPath((Join-Path $root $SerialLogPath)) }
        $directory = Split-Path -Parent $resolvedLogPath
        if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
        [System.IO.File]::WriteAllText($resolvedLogPath, $raw.ToString())
        Write-Host "Saved lane-motion diagnostic Serial log to $resolvedLogPath"
    }
    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Lane diagnostic output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No lane-motion summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-LaneMotionReport {
    param([Parameter(Mandatory)] [object[]]$Events)
    $lane = @($Events | Where-Object diagnosticSource -eq 'lane')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($lane | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass -or $summary.fixture -ne $Fixture) {
        throw 'The guarded lane-motion summary reported failure or the wrong fixture.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motor, magnet, or command-isolation checks failed.'
    }
    if (-not $summary.programCompiled -or -not $summary.orderedPrimitives -or
        -not $summary.sameSideLane -or -not $summary.finalOvershootOnly -or
        -not $summary.noGraveyardState -or $summary.verifiedPhaseCount -ne 1 -or
        -not $summary.finalOccupancyMatched -or -not $summary.opponentMoveCommitted -or
        $summary.retryExhausted -or $summary.recoveryRequired) {
        throw 'The lane phase did not compile, execute, verify, and commit cleanly.'
    }
    if ($summary.selectedMove -ne 'd5e3' -or $summary.routeMode -ne $expectedRouteMode -or
        $summary.committedFen -ne $expectedFinalFen -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'The final move, route mode, FEN, or occupancy is incorrect.'
    }
    $failedChecks = @($lane | Where-Object { $_.type -eq 'check' -and -not $_.pass })
    if ($failedChecks.Count -gt 0) {
        throw "Lane checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) { throw 'Ownership did not reach offline_idle before homing.' }

    $accepted = @($lane | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'h2g2') {
        throw 'The physical acceptance move must be h2g2.'
    }
    $search = @($lane | Where-Object type -eq 'search')[-1]
    if (-not $search -or $search.bestMove -ne 'd5e3' -or $search.mateIn -ne 1 -or
        $search.depth -lt 1 -or $search.nodes -lt 1 -or $search.elapsedMs -gt 3100 -or
        $search.sensorScansDuringSearch -lt 1) {
        throw 'Forced-mate search telemetry is missing or outside limits.'
    }
    $plan = @($lane | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.selectedMove -ne 'd5e3' -or $plan.strategy -ne 'quiet' -or
        $plan.phaseCount -ne 1 -or $plan.routeCost -ne $expectedRouteCost -or
        $plan.graveyardState -ne 'free') {
        throw 'The controlled d5e3 quiet lane plan was not staged.'
    }
    $program = @($lane | Where-Object type -eq 'lane-program')[-1]
    if (-not $program -or $program.status -ne 'success' -or
        $program.routeMode -ne $expectedRouteMode -or $program.routeCost -ne $expectedRouteCost -or
        (@($program.rawPath) -join ',') -ne $expectedRawPath -or
        (@($program.compressedPath) -join ',') -ne $expectedCompressedPath) {
        throw 'Lane program route metadata differs from the accepted fixture.'
    }
    $coordinates = @($program.targets | Where-Object { $_.role -eq 'lane' })
    if ($coordinates.Count -ne 2 -or $coordinates[0].label -ne 'Z5' -or
        $coordinates[1].label -ne 'Z3' -or $coordinates[0].lane -ne 'Z' -or
        $coordinates[1].lane -ne 'Z' -or $coordinates[0].x -ne 13300 -or
        $coordinates[0].y -ne 34450 -or $coordinates[1].x -ne 21300 -or
        $coordinates[1].y -ne 34450) {
        throw 'Lane coordinates are not the calibrated same-side Z5/Z3 pair.'
    }
    $kinds = @($program.primitives | ForEach-Object kind)
    $expectedKinds = if ($Fixture -eq 'LaneBoard') {
        'travel-board,pickup,drag-coordinate,drag-coordinate,drag-board,drag-board,drag-board,drag-board,drag-board,drop,verify'
    } else {
        'travel-board,pickup,drag-coordinate,drag-coordinate,drag-board,drop,verify'
    }
    if (($kinds -join ',') -ne $expectedKinds -or
        @($program.primitives | Where-Object finalBoardDrop).Count -ne 1) {
        throw 'Lane primitive order or final-only overshoot policy is incorrect.'
    }
    $hardware = @($lane | Where-Object {
        $_.type -eq 'hardware-result' -and $_.stage -eq 'lane-transfer'
    })[-1]
    if (-not $hardware -or -not $hardware.success -or -not $hardware.motorActivity -or
        -not $hardware.magnetEverHigh -or -not $hardware.magnetLow) {
        throw 'Real lane hardware execution did not complete safely.'
    }
    if ($summary.sensorMaxGapMs -ge 25 -or $summary.searchSensorScans -lt 1 -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Lane timing, resources, core, or priority are outside accepted limits.'
    }
    Write-Host "$Fixture lane-motion hardware diagnostic passed." -ForegroundColor Green
}

$script:arduinoCliPath = Get-ArduinoCliPath
$production = Invoke-ArduinoCompile -Label 'ESP32 USB-only production firmware compile' -OutputDirectory $productionOutput
if ($production.FlashBytes -ne $expectedProductionFlashBytes -or
    $production.RamBytes -ne $expectedProductionRamBytes) {
    throw "Production firmware changed: expected $expectedProductionFlashBytes/$expectedProductionRamBytes, received $($production.FlashBytes)/$($production.RamBytes)."
}
$direct = Invoke-ArduinoCompile -Label 'ESP32 DirectLane diagnostic compile' -OutputDirectory $directOutput -LaneFixture 0
$laneBoard = Invoke-ArduinoCompile -Label 'ESP32 LaneBoard diagnostic compile' -OutputDirectory $laneBoardOutput -LaneFixture 1
foreach ($diagnostic in @($direct, $laneBoard)) {
    $headroom = $maximumApplicationBytes - $diagnostic.FlashBytes
    if ($headroom -lt $minimumApplicationHeadroomBytes) {
        throw "Lane diagnostics leave only $headroom bytes of application headroom."
    }
}
Write-Host "Lane firmware metrics: production=$($production.FlashBytes)/$($production.RamBytes), direct=$($direct.FlashBytes)/$($direct.RamBytes), lane-board=$($laneBoard.FlashBytes)/$($laneBoard.RamBytes)." -ForegroundColor Green

if ($UploadPort) {
    $selected = if ($fixtureNumber -eq 1) { $laneBoard } else { $direct }
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload -Label "Upload guarded $Fixture lane diagnostic" -Port $UploadPort -InputDirectory $selected.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-LaneMotionReport -Port $UploadPort -TimeoutSeconds $SerialTimeoutSeconds
        Assert-LaneMotionReport -Events $events
    } finally {
        if ($diagnosticUploaded) {
            Invoke-ArduinoUpload -Label 'Restore USB-only production firmware' -Port $UploadPort -InputDirectory $production.OutputDirectory
        }
    }
}

Write-Host "`nOffline lane-motion verification passed." -ForegroundColor Green
