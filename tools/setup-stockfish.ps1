$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'stockfish-version.json') -Raw | ConvertFrom-Json
$taskTool = Join-Path $PSScriptRoot 'stockfish'
New-Item -ItemType Directory -Force -Path $taskTool | Out-Null
$taskArchive = Join-Path $taskTool $taskManifest.asset
if (-not (Test-Path -LiteralPath $taskArchive)) { Invoke-WebRequest $taskManifest.url -OutFile $taskArchive }
$taskHash = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash
if ($taskHash -ne $taskManifest.sha256) { throw 'Stockfish archive checksum mismatch; remove the archive and rerun setup.' }
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskTool -Force
$taskExecutable = Join-Path $taskTool $taskManifest.executable
$taskSmoke = @('uci', 'compiler', 'quit') | & $taskExecutable
if ($LASTEXITCODE -ne 0 -or ($taskSmoke -join "`n") -notmatch 'id name Stockfish 19') { throw 'Native Stockfish 19 smoke test failed.' }
$taskSmoke | Select-String 'id name|Compilation architecture|Compilation settings|uciok'
Write-Host "Verified Stockfish 19 installed at $taskExecutable"
