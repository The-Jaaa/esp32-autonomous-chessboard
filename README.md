# Autonomous Chessboard

An ESP32-S3 powered autonomous chessboard where a human plays on a physical board and the opposing side is played by a chess engine. The board uses Hall-effect sensors to detect pieces, an addressable LED grid to guide moves, a CoreXY gantry with an electromagnet to move pieces, and a companion web app for engine/game coordination.

## Project Status

This is a working student prototype. The main subsystems are being tested and integrated:

- 64-square Hall-effect sensor matrix, multiplexed to ESP32-S3 inputs
- 256 addressable LEDs arranged as 4 LEDs per square
- CoreXY gantry driven by two NEMA17 stepper motors
- Electromagnet piece dragging with magnetic chess pieces
- MAX98357A I2S speaker output
- WiFi link between ESP32-S3 firmware and the companion server
- Stockfish-backed web app with physical-board state handling

## Repository Layout

```text
app/                 Node/Express backend and React frontend
esp32_firmware/      Main ESP32-S3 board firmware
esp32_ota_led/       OTA/LED/sensor test sketch
hardware/            Schematics, PCB exports, and Gerber files
tests_and_misc/      Hardware diagnostic sketches
New folder/          Experimental ESP32 audio/WiFi sketches
tools/audio-relay/   Local audio relay scripts for WiFi speaker tests
docs_and_media/      Project notes and selected media assets
docs/                Public setup and publication notes
```

Some folder names still reflect the prototype phase and may be reorganized later. Raw handoff/scratch notes are kept local and are not intended for the public repository.

## Hardware Summary

- MCU: ESP32-S3 N16R8 development board
- Sensors: 64 Hall-effect sensors through multiplexers
- Lighting: WS2812-compatible LED grid, 256 LEDs total
- Motion: CoreXY gantry with two NEMA17 steppers
- Piece movement: electromagnet and magnetic chess pieces
- Audio: MAX98357A I2S amplifiers
- Safe I2S pins used during testing:
  - DIN: GPIO11
  - BCLK: GPIO10
  - LRC: GPIO9

## Software Summary

- Backend: Node.js, Express, Socket.IO
- Frontend: React/Vite
- Chess logic: chess.js and Stockfish
- Firmware: Arduino ESP32 core for ESP32-S3
- Audio test library: ESP32-audioI2S

## Running The Companion App

Backend:

```powershell
cd app
npm install
Copy-Item .env.example .env
npm run dev
```

Frontend:

```powershell
cd app/client
npm install
npm run dev
```

Set your own values in `app/.env`. Do not commit real API keys.

## Firmware Notes

Before uploading WiFi-enabled sketches, replace placeholder values such as:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
```

For local HTTP audio streaming tests, start a server on the PC and set the ESP stream URL to your PC's current LAN IP.

## Public Repo Notes

This repository intentionally ignores:

- WiFi credentials and `.env` secrets
- downloaded songs and audio captures
- Node dependency folders
- generated firmware binaries
- temporary files and logs
- portable FFmpeg binaries

Keep copyrighted music out of the repo. Use short self-generated tones or document how to provide your own local test audio instead.
