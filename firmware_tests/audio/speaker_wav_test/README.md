# ESP32-S3 WAV Speaker Test

This sketch streams `/test.wav` from SPIFFS using small buffers. It does not use
the PSRAM-heavy MP3 decoder.

## Rewired PCB Mode

Use this after moving the speaker I2S lines to:

- DIN: GPIO11
- BCLK: GPIO10
- LRC: GPIO9

Board settings:

- Board: `ESP32S3 Dev Module`
- Flash Size: `16MB`
- PSRAM: `Disabled` or `OPI PSRAM`

## Important Partition Rule

The SPIFFS upload offset and image size must match the partition scheme used
when uploading the sketch.

### If Arduino IDE Uses Default Partition

Serial Monitor shows about `SPIFFS total bytes: 1318001`.

Use:

```powershell
$port = "COM9"
$sketch = "C:\Users\Thejaka\Desktop\ChessProject\firmware_tests\audio\speaker_wav_test"
$mkspiffs = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\mkspiffs\0.2.3\mkspiffs.exe"
$esptool = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\esptool_py\5.2.0\esptool.exe"

& $mkspiffs -c "$sketch\data" -p 256 -b 4096 -s 0x160000 "$sketch\spiffs.bin"
& $esptool --chip esp32s3 --port $port --baud 921600 write_flash 0x290000 "$sketch\spiffs.bin"
```

### If Arduino IDE Uses No OTA Partition

Serial Monitor should show about `SPIFFS total bytes: 1799921`.

Use:

```powershell
$port = "COM9"
$sketch = "C:\Users\Thejaka\Desktop\ChessProject\firmware_tests\audio\speaker_wav_test"
$mkspiffs = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\mkspiffs\0.2.3\mkspiffs.exe"
$esptool = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\esptool_py\5.2.0\esptool.exe"

& $mkspiffs -c "$sketch\data" -p 256 -b 4096 -s 0x1E0000 "$sketch\spiffs.bin"
& $esptool --chip esp32s3 --port $port --baud 921600 write_flash 0x210000 "$sketch\spiffs.bin"
```

## MP3 Note

The MP3 library needs PSRAM. On ESP32-S3 N16R8, PSRAM can conflict with the
original GPIO35/GPIO36/GPIO37 I2S routing. MP3 playback should use the rewired
safe mapping: LRC on GPIO9, BCLK on GPIO10, and DIN on GPIO11.
