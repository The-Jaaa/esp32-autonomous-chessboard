# ESP32-S3 Speaker Test

This sketch plays `data/test.mp3` through the two MAX98357A I2S speaker amps.

## Pins

- DIN: GPIO11
- BCLK: GPIO10
- LRC/LRCLK: GPIO9

## Arduino IDE Setup

Install this library:

- `ESP32-audioI2S` by schreibfaul1

Recommended board settings for the ESP32-S3 N16R8 DevKit:

- Board: `ESP32S3 Dev Module`
- Flash Size: `16MB`
- PSRAM: `OPI PSRAM`
- USB CDC On Boot: either setting is fine for standalone playback
- Partition Scheme:
  - For this small test MP3, any `16M Flash` partition with at least about `1.2 MB` data/filesystem space is enough.
  - For full songs later, use a larger filesystem partition such as the Gemini 3M app + 9M filesystem layout.

`test.mp3` is about 862 KB, so avoid tiny/minimal filesystem partitions.

## Upload Order

1. Select `Custom` partition scheme if available. This folder includes `partitions.csv` with a 3M app + 9M filesystem layout.
2. Upload `speaker_test.ino`.
3. Upload the sketch `data` folder/filesystem image as LittleFS.
4. Unplug USB from the PC.
5. Power the PCB externally.
6. Wait 5 seconds; the MP3 should loop.

The sketch tries `LittleFS` first, then `SPIFFS`, so either filesystem can work
as long as `/test.mp3` is present.

### Manual LittleFS Upload On COM11

After uploading the sketch, run this from PowerShell while the ESP is connected
over USB:

```powershell
& "C:\Users\Thejaka\Desktop\ChessProject\firmware_tests\audio\speaker_test\upload_littlefs_com9.ps1"
```

This creates a LittleFS image from `data\test.mp3` and writes it to offset
`0x610000`, matching this folder's `partitions.csv`.

## LittleFS vs SPIFFS

LittleFS is not required to make MP3 audio work. The important part is that the
filesystem used by the upload tool matches the filesystem mounted by the code.
LittleFS is a good default for the final project, but SPIFFS is fine for this
small MP3 test.

## Why These Pins

The original schematic routes I2S audio through GPIO35, GPIO36, and GPIO37.
On ESP32-S3 N16R8 modules, those pins can conflict with Octal PSRAM. The
rewired GPIO9/GPIO10/GPIO11 mapping keeps PSRAM available for the MP3 decoder.
