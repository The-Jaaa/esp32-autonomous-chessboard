param(
  [int]$Port = 8001
)

$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
$librespot = Join-Path $project "tools\librespot\bin\librespot.exe"

if (!(Test-Path -LiteralPath $librespot)) {
  throw "librespot.exe not found. Run tools\setup-librespot.ps1 first."
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (!$isAdmin) { throw "Run this script from an Administrator PowerShell window." }

$rules = @(
  "UoM Chessboard Spotify discovery",
  "UoM Chessboard audio stream"
)
$rules | ForEach-Object {
  Get-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

New-NetFirewallRule `
  -DisplayName $rules[0] `
  -Direction Inbound `
  -Action Allow `
  -Profile Private `
  -Program $librespot | Out-Null

New-NetFirewallRule `
  -DisplayName $rules[1] `
  -Direction Inbound `
  -Action Allow `
  -Profile Private `
  -Protocol TCP `
  -LocalPort $Port | Out-Null

Write-Host "Private-network firewall rules created for librespot and TCP $Port."
