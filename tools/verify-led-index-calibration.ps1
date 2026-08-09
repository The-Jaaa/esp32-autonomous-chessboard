param(
    [ValidateSet('Compile', 'Upload', 'Restore')]
    [string]$Action = 'Compile',
    [string]$Port = 'COM11'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$productionSketch = Join-Path $root 'esp32_firmware'
$calibrationSketch = Join-Path $root 'tests_and_misc\esp32_led_index_calibration'
$productionOutput = Join-Path $root 'tmp\led-index-production'
$calibrationOutput = Join-Path $root 'tmp\led-index-calibration'
$fqbn = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1'
$expectedProductionFlash = 1083819
$expectedProductionRam = 48768

function Get-ArduinoCliPath {
    $command = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $bundled = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    if (-not (Test-Path -LiteralPath $bundled)) {
        throw 'Arduino CLI was not found on PATH or in the Arduino IDE installation.'
    }
    return $bundled
}

function Reset-OutputDirectory {
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

function Invoke-Compile {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$Sketch,
        [Parameter(Mandatory)] [string]$OutputDirectory
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    Reset-OutputDirectory -Path $OutputDirectory
    $output = @(& $script:arduinoCli compile --fqbn $fqbn --output-dir $OutputDirectory $Sketch 2>&1)
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }

    $text = $output -join "`n"
    $flash = [regex]::Match($text, 'Sketch uses\s+([0-9]+)\s+bytes')
    $ram = [regex]::Match($text, 'Global variables use\s+([0-9]+)\s+bytes')
    if (-not $flash.Success -or -not $ram.Success) {
        throw "Could not parse firmware metrics for $Label."
    }
    return [pscustomobject]@{
        FlashBytes = [int]$flash.Groups[1].Value
        RamBytes = [int]$ram.Groups[1].Value
        OutputDirectory = $OutputDirectory
    }
}

function Invoke-Upload {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$InputDirectory,
        [Parameter(Mandatory)] [string]$Sketch
    )

    Write-Host "`n== $Label on $Port ==" -ForegroundColor Cyan
    & $script:arduinoCli upload -p $Port --fqbn $fqbn --input-dir $InputDirectory $Sketch
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

$script:arduinoCli = Get-ArduinoCliPath
$production = Invoke-Compile `
    -Label 'Compile production firmware' `
    -Sketch $productionSketch `
    -OutputDirectory $productionOutput
if ($production.FlashBytes -ne $expectedProductionFlash -or
    $production.RamBytes -ne $expectedProductionRam) {
    throw "Production baseline changed: $($production.FlashBytes)/$($production.RamBytes)."
}

$calibration = Invoke-Compile `
    -Label 'Compile LED index calibration firmware' `
    -Sketch $calibrationSketch `
    -OutputDirectory $calibrationOutput

Write-Host (
    "Firmware metrics: production=$($production.FlashBytes)/$($production.RamBytes), " +
    "calibration=$($calibration.FlashBytes)/$($calibration.RamBytes)."
) -ForegroundColor Green

if ($Action -eq 'Upload') {
    Invoke-Upload `
        -Label 'Upload LED index calibration firmware' `
        -InputDirectory $calibration.OutputDirectory `
        -Sketch $calibrationSketch
    Write-Host 'Calibration firmware is active. Run this script with -Action Restore when mapping is complete.' -ForegroundColor Yellow
} elseif ($Action -eq 'Restore') {
    Invoke-Upload `
        -Label 'Restore production firmware' `
        -InputDirectory $production.OutputDirectory `
        -Sketch $productionSketch
}

Write-Host 'LED index calibration verification completed.' -ForegroundColor Green
