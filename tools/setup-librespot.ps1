param(
  [switch]$InstallPrerequisites,
  [switch]$ForceRebuild
)

$ErrorActionPreference = "Stop"
$version = "v0.8.0"
$expectedRevision = "d36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d"
$project = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $project "tools\librespot"
$source = Join-Path $toolRoot "src"
$binary = Join-Path $toolRoot "bin\librespot.exe"

function Test-VsCppTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (!(Test-Path -LiteralPath $vswhere)) { return $false }
  $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return [bool]$installation
}

if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
  if (!$InstallPrerequisites) {
    throw "Rust is missing. Re-run with -InstallPrerequisites, or install rustup and Visual Studio C++ Build Tools manually."
  }
  winget install --exact --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path -LiteralPath $cargoBin) { $env:Path = "$cargoBin;$env:Path" }
}

if (!(Test-VsCppTools)) {
  if (!$InstallPrerequisites) {
    throw "Visual Studio C++ Build Tools are missing. Re-run with -InstallPrerequisites."
  }
  winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
}

if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo is still unavailable. Open a new terminal after prerequisite installation and run this script again."
}

New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $toolRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict $toolRoot to the current Windows user." }

if ($ForceRebuild -and (Test-Path -LiteralPath $source)) {
  $resolvedProject = [System.IO.Path]::GetFullPath($project).TrimEnd('\') + '\'
  $resolvedSource = [System.IO.Path]::GetFullPath($source)
  if (!$resolvedSource.StartsWith($resolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove librespot source outside the project: $resolvedSource"
  }
  Remove-Item -LiteralPath $source -Recurse -Force
}
if (!(Test-Path -LiteralPath (Join-Path $source ".git"))) {
  git clone --depth 1 --branch $version https://github.com/librespot-org/librespot.git $source
}

Push-Location $source
try {
  $tag = git describe --tags --exact-match
  if ($tag -ne $version) { throw "Expected librespot $version, found $tag." }
  $revision = git rev-parse HEAD
  if ($revision -ne $expectedRevision) {
    throw "Expected librespot revision $expectedRevision, found $revision."
  }
  cargo build --locked --release --no-default-features --features "native-tls with-libmdns"
  New-Item -ItemType Directory -Path (Split-Path -Parent $binary) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source "target\release\librespot.exe") -Destination $binary -Force
} finally {
  Pop-Location
}

& $binary --version
Write-Host "librespot $version ($expectedRevision) is ready at $binary"
