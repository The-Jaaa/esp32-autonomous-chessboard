param(
  [string]$Port = "COM11",
  [int]$Baud = 115200,
  [int]$Seconds = 60,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

$serial = [System.IO.Ports.SerialPort]::new($Port, $Baud)
$serial.ReadTimeout = 200
$serial.WriteTimeout = 200
$serial.DtrEnable = $false
$serial.RtsEnable = $false

$lines = New-Object System.Collections.Generic.List[string]
$start = Get-Date

try {
  $serial.Open()
  Write-Host "Reading $Port at $Baud baud for $Seconds seconds. Close Arduino Serial Monitor first."

  while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
    try {
      $text = $serial.ReadExisting()
      if ($text.Length -gt 0) {
        $text -split "`r?`n" | ForEach-Object {
          if ($_.Length -gt 0) {
            $stamp = Get-Date -Format "HH:mm:ss.fff"
            $line = "[$stamp] $_"
            $lines.Add($line)
            Write-Host $line
          }
        }
      }
    } catch [TimeoutException] {
      # Keep polling until the time limit expires.
    }
    Start-Sleep -Milliseconds 50
  }
} finally {
  if ($serial.IsOpen) {
    $serial.Close()
  }
}

if ($LogPath.Length -gt 0) {
  $lines | Set-Content -LiteralPath $LogPath -Encoding UTF8
  Write-Host "Saved serial log to $LogPath"
}
