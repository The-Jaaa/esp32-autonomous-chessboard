param(
  [string]$Port = "COM11"
)

$ErrorActionPreference = "Stop"

$Sketch = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Sketch "data"
$Image = Join-Path $Sketch "littlefs.bin"

$MkLittleFs = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\tools\mklittlefs\4.0.2-db0513a\mklittlefs.exe"
$EspTool = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\tools\esptool_py\5.2.0\esptool.exe"

if (!(Test-Path -LiteralPath $MkLittleFs)) {
  throw "mklittlefs.exe not found at $MkLittleFs"
}

if (!(Test-Path -LiteralPath $EspTool)) {
  throw "esptool.exe not found at $EspTool"
}

if (!(Test-Path -LiteralPath (Join-Path $DataDir "test.mp3"))) {
  throw "Missing $DataDir\test.mp3"
}

# Matches this sketch folder's partitions.csv:
# app0 0x10000..0x310000, app1 0x310000..0x610000, filesystem at 0x610000 size 9M.
& $MkLittleFs -c $DataDir -p 256 -b 4096 -s 0x900000 $Image
if ($LASTEXITCODE -ne 0) {
  throw "mklittlefs failed with exit code $LASTEXITCODE"
}

& $EspTool --chip esp32s3 --port $Port --baud 921600 write_flash 0x610000 $Image
if ($LASTEXITCODE -ne 0) {
  throw "esptool failed with exit code $LASTEXITCODE. Check that $Port is correct, the ESP is connected, and Serial Monitor is closed."
}

Write-Host "Uploaded LittleFS image to $Port at offset 0x610000."
