param(
    [string]$UploadPort = '',
    [int]$SerialTimeoutSeconds = 420,
    [string]$SerialLogPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root 'esp32_firmware'
$offlineCore = Join-Path $root 'offline_core'
$productionOutput = Join-Path $root 'tmp\offline-promotion-production'
$diagnosticOutput = Join-Path $root 'tmp\offline-promotion-enabled'

$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$maximumApplicationBytes = 3145728
$minimumApplicationHeadroomBytes = 512KB
$minimumInternalHeapBytes = 96KB
$minimumLargestInternalBlockBytes = 64KB
$minimumFreePsramBytes = 5MB
$minimumStackHeadroomBytes = 2KB
$maximumHeartbeatElapsedMs = 1250
$expectedProductionFlashBytes = 1079947
$expectedProductionRamBytes = 48456
$expectedFinalFen = '4k3/8/8/8/8/8/5K2/q7 w - - 0 2'

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
        [switch]$PromotionDiagnostics
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-WorkspaceOutputDirectory -Path $OutputDirectory
    $arguments = @('compile', '--fqbn', $fqbn)
    if ($PromotionDiagnostics) {
        $arguments += @(
            '--library', $offlineCore,
            '--build-property',
            'compiler.cpp.extra_flags=-DENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS=1'
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

function Read-PromotionReport {
    param(
        [Parameter(Mandatory)] [string]$Port,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    Write-Host "`n== ESP32 guarded promotion diagnostic on $Port ==" -ForegroundColor Cyan
    Write-Host 'Stop the backend and power the gantry. Keep hands clear during homing.' -ForegroundColor Yellow
    Write-Host 'Place Black king e8, Black pawn a2, and White king e1. Clear every other square.' -ForegroundColor Yellow
    Write-Host 'Keep a Black queen off-board and ready for the replacement prompt.' -ForegroundColor Yellow
    Write-Host 'After Human Turn appears, move the White king e1-f2.' -ForegroundColor Yellow
    Write-Host 'After the robot places the pawn on a1, remove it and place the Black queen on a1.' -ForegroundColor Yellow

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
                if ($line -match '^\[OFFLINE_PROMOTION_MOTION_DIAG\]\s+(\{.*\})$') {
                    $source = 'promotion'
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
                        if ($source -eq 'promotion' -and $event.type -eq 'summary') {
                            $summarySeen = $true
                        }
                    }
                    catch { throw "Invalid promotion diagnostic JSON: $line" }
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
        Write-Host "Saved promotion diagnostic Serial log to $resolvedLogPath"
    }

    if ($raw.ToString() -match '(Guru Meditation|watchdog|Brownout)') {
        throw 'Promotion output contains a crash, watchdog, or brownout report.'
    }
    if (-not $summarySeen) {
        throw "No promotion summary was received from $Port within $TimeoutSeconds seconds."
    }
    @($events)
}

function Assert-PromotionReport {
    param([Parameter(Mandatory)] [object[]]$Events)

    $promotion = @($Events | Where-Object diagnosticSource -eq 'promotion')
    $ownership = @($Events | Where-Object diagnosticSource -eq 'ownership')
    $summary = @($promotion | Where-Object type -eq 'summary')[-1]
    if (-not $summary -or -not $summary.pass) {
        throw 'The guarded promotion summary reported failure.'
    }
    if (-not $summary.homeSucceeded -or -not $summary.realMotionEnabled -or
        -not $summary.motorActivity -or -not $summary.magnetEverHigh -or
        -not $summary.magnetLow -or -not $summary.commandConsumptionBlocked) {
        throw 'Homing, motor, magnet, or command-isolation checks failed.'
    }
    if (-not $summary.programCompiled -or -not $summary.orderedPrimitives -or
        -not $summary.finalOvershootEnabled -or
        $summary.verifiedPhaseCount -ne 1 -or
        -not $summary.pawnPlacementVerified -or
        -not $summary.liftObserved -or -not $summary.replacementObserved -or
        -not $summary.identityConfirmed -or
        -not $summary.noMotionDuringReplacement -or
        -not $summary.finalOccupancyMatched -or
        -not $summary.opponentMoveCommitted -or
        $summary.retryExhausted -or $summary.recoveryRequired -or
        $summary.replacementTimedOut) {
        throw 'The promotion motion or replacement transaction did not complete cleanly.'
    }
    if ($summary.selectedMove -ne 'a2a1q' -or
        $summary.requestedPromotion -ne 'q' -or
        $summary.requestedPiece -ne 'queen' -or
        $summary.promotionSquare -ne 'a1' -or
        $summary.committedFen -ne $expectedFinalFen -or
        $summary.actualOccupancy -ne $summary.expectedOccupancy) {
        throw 'The selected promotion, final FEN, or final occupancy is incorrect.'
    }

    $failedChecks = @($promotion | Where-Object {
        $_.type -eq 'check' -and -not $_.pass
    })
    if ($failedChecks.Count -gt 0) {
        throw "Promotion checks failed: $($failedChecks.name -join ', ')"
    }
    if (@($ownership | Where-Object {
        $_.type -eq 'transition' -and $_.to -eq 'offline_idle'
    }).Count -lt 1) {
        throw 'Ownership did not reach offline_idle before homing.'
    }

    $accepted = @($promotion | Where-Object {
        $_.type -eq 'runtime' -and $_.event -eq 'human_move_accepted'
    })[-1]
    if (-not $accepted -or $accepted.acceptedMove.uci -ne 'e1f2') {
        throw 'The physical acceptance move must be e1f2.'
    }
    $search = @($promotion | Where-Object type -eq 'search')[-1]
    if (-not $search -or $search.bestMove -ne 'a2a1q' -or
        $search.depth -lt 1 -or $search.nodes -lt 1 -or
        $search.elapsedMs -gt 3100 -or $search.sensorScansDuringSearch -lt 1) {
        throw 'Deterministic promotion search telemetry is missing or outside limits.'
    }
    $plan = @($promotion | Where-Object type -eq 'plan')[-1]
    if (-not $plan -or $plan.selectedMove -ne 'a2a1q' -or
        $plan.strategy -ne 'quiet' -or $plan.routeCost -ne 0 -or
        $plan.phaseCount -ne 1) {
        throw 'The controlled a2a1q promotion plan was not staged.'
    }

    $program = @($promotion | Where-Object type -eq 'promotion-program')[-1]
    if (-not $program -or $program.status -ne 'success' -or
        $program.move -ne 'a2a1q' -or $program.phaseKind -ne 'quiet-transfer' -or
        $program.from -ne 'a2' -or $program.to -ne 'a1' -or
        $program.routeMode -ne 'direct' -or $program.routeCost -ne 0) {
        throw 'The promotion compiler did not produce the accepted direct a2-a1 program.'
    }
    $primitiveKinds = @($program.primitives | ForEach-Object kind)
    if (($primitiveKinds -join ',') -ne 'travel-board,pickup,drag-board,drop,verify' -or
        @($program.primitives | Where-Object finalBoardDrop).Count -ne 1) {
        throw 'Promotion primitive order or final-only overshoot is incorrect.'
    }

    $prompt = @($promotion | Where-Object type -eq 'promotion-required')[-1]
    if (-not $prompt -or $prompt.color -ne 'black' -or
        $prompt.piece -ne 'queen' -or $prompt.square -ne 'a1') {
        throw 'The Black queen replacement prompt was not emitted.'
    }
    $replacementEvents = @($promotion | Where-Object type -eq 'promotion-replacement')
    foreach ($required in @('pawn_lifted', 'replacement_ready', 'confirmed')) {
        if (@($replacementEvents | Where-Object event -eq $required).Count -lt 1) {
            throw "Promotion replacement event '$required' was not observed."
        }
    }
    if (@($promotion | Where-Object {
        $_.type -eq 'phase-report' -and $_.success -eq $true -and $_.phaseIndex -eq 0
    }).Count -ne 1) {
        throw 'The promotion transaction did not produce one successful phase report.'
    }

    if ($summary.sensorMaxGapMs -ge 25 -or
        $summary.searchSensorScans -lt 1 -or
        $summary.heartbeatMaxElapsedMs -gt $maximumHeartbeatElapsedMs -or
        $summary.internalFree -lt $minimumInternalHeapBytes -or
        $summary.largestInternal -lt $minimumLargestInternalBlockBytes -or
        $summary.psramFree -lt $minimumFreePsramBytes -or
        $summary.stackHeadroom -lt $minimumStackHeadroomBytes -or
        $summary.core -ne 0 -or $summary.priority -ne 0) {
        throw 'Promotion timing, resources, core, or priority are outside limits.'
    }

    Write-Host (
        "Promotion diagnostic passed: human=e1f2, reply=a2a1q, " +
        "replacement=black queen a1, sensorGap=$($summary.sensorMaxGapMs) ms."
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
    -Label 'ESP32 guarded promotion diagnostic compile' `
    -OutputDirectory $diagnosticOutput `
    -PromotionDiagnostics
$applicationHeadroom = $maximumApplicationBytes - $diagnostic.FlashBytes
if ($applicationHeadroom -lt $minimumApplicationHeadroomBytes) {
    throw "Promotion diagnostics leave only $applicationHeadroom bytes of app headroom."
}

Write-Host (
    "Promotion firmware metrics: production=$($production.FlashBytes)/" +
    "$($production.RamBytes), diagnostic=$($diagnostic.FlashBytes)/" +
    "$($diagnostic.RamBytes), headroom=$applicationHeadroom bytes."
) -ForegroundColor Green

if ($UploadPort) {
    $diagnosticUploaded = $false
    try {
        Invoke-ArduinoUpload `
            -Label 'Upload guarded promotion diagnostic' `
            -Port $UploadPort `
            -InputDirectory $diagnostic.OutputDirectory
        $diagnosticUploaded = $true
        $events = Read-PromotionReport `
            -Port $UploadPort `
            -TimeoutSeconds $SerialTimeoutSeconds
        Assert-PromotionReport -Events $events
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

Write-Host "`nOffline promotion verification passed." -ForegroundColor Green
