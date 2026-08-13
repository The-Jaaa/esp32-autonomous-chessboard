param(
    [string]$UploadPort = '',
    [switch]$SkipFirmware,
    [switch]$SkipNetworkPreflight
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$client = Join-Path $app 'client'
$secrets = Join-Path $root 'esp32_firmware\firmware_secrets.h'
$resultsDirectory = Join-Path $root 'logs'
$startedAt = Get-Date
$steps = [System.Collections.Generic.List[object]]::new()

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [scriptblock]$Command
    )

    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    $stepStartedAt = Get-Date
    try {
        $global:LASTEXITCODE = 0
        & $Command
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE."
        }
        $steps.Add([pscustomobject]@{
            label = $Label
            status = 'passed'
            elapsedSeconds = [math]::Round(((Get-Date) - $stepStartedAt).TotalSeconds, 2)
        })
    }
    catch {
        $steps.Add([pscustomobject]@{
            label = $Label
            status = 'failed'
            elapsedSeconds = [math]::Round(((Get-Date) - $stepStartedAt).TotalSeconds, 2)
            error = $_.Exception.Message
        })
        throw
    }
}

function Get-ActiveIpv4Address {
    $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
        Sort-Object RouteMetric, InterfaceMetric |
        Select-Object -First 1
    if (-not $route) { return $null }

    return Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |
        Where-Object { $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -First 1
}

function Assert-FirmwareNetworkMatchesHost {
    if (-not (Test-Path -LiteralPath $secrets)) {
        Write-Warning 'Private firmware secrets are absent; network preflight is compile-only.'
        return
    }

    $content = Get-Content -LiteralPath $secrets -Raw
    $serverMatch = [regex]::Match(
        $content,
        '#define\s+CHESS_SERVER_BASE_URL\s+"https?://([^:/"]+)(?::\d+)?"'
    )
    $audioMatch = [regex]::Match(
        $content,
        '#define\s+CHESS_AUDIO_SERVER_HOST\s+"([^"]+)"'
    )
    if (-not $serverMatch.Success -or -not $audioMatch.Success) {
        throw 'Could not read the HTTP and audio hosts from firmware_secrets.h.'
    }

    $activeIp = Get-ActiveIpv4Address
    if (-not $activeIp) { throw 'No active IPv4 default route was found.' }

    $serverHost = $serverMatch.Groups[1].Value
    $audioHost = $audioMatch.Groups[1].Value
    if ($serverHost -ne $audioHost) {
        throw "Firmware HTTP host '$serverHost' and audio host '$audioHost' differ."
    }

    $parsedIp = $null
    if ([System.Net.IPAddress]::TryParse($serverHost, [ref]$parsedIp) -and
        $serverHost -ne $activeIp) {
        throw "Firmware targets $serverHost, but the laptop's active IPv4 address is $activeIp. Update firmware_secrets.h and reflash before hardware acceptance."
    }

    Write-Host "Firmware network preflight passed: $serverHost matches $activeIp." -ForegroundColor Green
}

function Write-ResultFile {
    param([string]$Status, [string]$ErrorMessage = '')

    New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
    $stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
    $path = Join-Path $resultsDirectory "demo-baseline-$stamp.json"
    $result = [ordered]@{
        status = $Status
        startedAt = $startedAt.ToString('o')
        finishedAt = (Get-Date).ToString('o')
        elapsedSeconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
        branch = (& git -C $root branch --show-current).Trim()
        commit = (& git -C $root rev-parse HEAD).Trim()
        uploadPort = $UploadPort
        steps = $steps
    }
    if ($ErrorMessage) { $result.error = $ErrorMessage }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
    Write-Host "Demo verification result: $path"
}

try {
    if (-not $SkipNetworkPreflight) {
        Invoke-Checked 'Firmware network preflight' { Assert-FirmwareNetworkMatchesHost }
    }

    Push-Location $app
    try {
        Invoke-Checked 'Mentor regressions' { npm run test:mentor }
    }
    finally {
        Pop-Location
    }

    $foundationArgs = @()
    if ($SkipFirmware) { $foundationArgs += '-SkipFirmware' }
    Invoke-Checked 'Complete foundation verification' {
        & (Join-Path $PSScriptRoot 'verify-foundation.ps1') @foundationArgs
    }

    if ($UploadPort) {
        if ($SkipFirmware) {
            throw '-UploadPort cannot be combined with -SkipFirmware.'
        }
        Invoke-Checked "Production firmware upload and registration on $UploadPort" {
            & (Join-Path $PSScriptRoot 'verify-mentor-speaker.ps1') -UploadPort $UploadPort
        }
    }

    Write-ResultFile -Status 'passed'
    Write-Host "`nAutomated demo-baseline verification passed." -ForegroundColor Green
    Write-Host 'Complete the manual checklist in docs/demo-readiness.md before accepting the baseline.' -ForegroundColor Yellow
}
catch {
    Write-ResultFile -Status 'failed' -ErrorMessage $_.Exception.Message
    throw
}
