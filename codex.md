# Codex Handoff Notes

Last updated: 2026-07-04

## Project Overview

This folder is an autonomous physical chessboard project. It combines:

- A React/Vite client in `app/client`
- A Node/Express + Socket.IO backend in `app/server.js`
- ESP32-S3 firmware in `esp32_firmware/esp32_firmware.ino`
- Hardware schematic/PCB/Gerber files in `hardware`
- Handoff/proposal/media files in `docs_and_media`
- Older firmware test sketches in `tests_and_misc`

The system goal is a physical chess robot: hall sensors detect pieces, a CoreXY gantry with an electromagnet moves pieces, LEDs provide board feedback, and the web app provides game state, engine evaluation, diagnostics, and Gemini voice coaching.

## What I Changed

### Board Square Sizing And Cutoff Fix

The chessboard could render tall/squished or expand until the bottom was clipped. The cause was a rectangular flex slot being passed to `react-chessboard`; the library fills its parent with `width: 100%` and `height: 100%`, so a non-square parent can distort or clip the board.

Changed files:

- `app/client/src/index.css`
- `app/client/src/components/GameBoard.jsx`
- Rebuilt `app/client/dist` with `npm run build`

Implementation:

- Added a `ResizeObserver` in `GameBoard.jsx` to measure the board slot.
- Set the rendered board stage size to `min(slot width, slot height)`.
- Made the eval bar use the same measured height as the square board.
- Added `.chessboard-stage` as the square parent for `<Chessboard>`.
- Moved the game-over overlay inside `.chessboard-stage` so it covers only the square board.
- Hardened `.app-container` with viewport-based width/flex basis so the whole app does not shrink-wrap to the content.
- Removed the previous inline `height: 100%; width: 100%` board shell behavior that caused rectangular sizing.

Browser verification confirmed:

- Screenshot-sized viewport `2048x1273`: app width `1400px`; board `873x873`; footer inside app.
- Default in-app viewport `1280x720`: board `375x375`; footer inside app.
- Board remained square and stayed inside `.board-wrapper` in both checks.

### Move Log Fixed Height

The move log on the main board screen was visually growing as more moves wrapped onto extra lines. It looked squished at first and then expanded.

Changed files:

- `app/client/src/index.css`
- `app/client/src/components/GameBoard.jsx`
- Rebuilt `app/client/dist` with `npm run build`

Implementation:

- Added `.board-footer` as a stable bottom section of the board column.
- Changed `.move-history` to a fixed `150px` height with matching `min-height` and `max-height`.
- Made `.move-history` a flex column with `overflow: hidden`.
- Added `.move-history-header` for the fixed header/buttons row.
- Added `.move-list-scroll` so only the move list scrolls internally.
- Moved the `<ul id="moveList">` into the new `.move-list-scroll` wrapper.

Browser verification confirmed:

- `.move-history` computed height: `150px`
- min-height: `150px`
- max-height: `150px`
- overflow: `hidden`
- inner `.move-list-scroll` overflow-y: `auto`

### Gemini Live Stable Voice Mentor Integration

Changed files:

- `app/server.js`
- `app/client/src/components/LiveMentor.jsx`
- `app/client/src/components/GameBoard.jsx`
- Rebuilt `app/client/dist` with `npm run build`

Implementation:

- Normalized Gemini model constants in `server.js`:
  - Live mentor: `gemini-3.1-flash-live-preview`
  - One-shot advice text: `gemini-3.5-flash`
  - One-shot TTS: `gemini-3.1-flash-tts-preview`
- Fixed Gemini Live message shapes:
  - Browser mic chunks now call `session.sendRealtimeInput({ audio: { mimeType: 'audio/pcm;rate=16000', data } })`.
  - Chess move/context events now call `session.sendRealtimeInput({ text })` instead of sending an array.
  - Session shutdown now sends `audioStreamEnd: true` before closing.
- Added Live input/output transcription plumbing:
  - Backend emits `live-mentor-user-transcript` for input transcription.
  - Backend emits `live-mentor-transcript` for output/model transcript text.
  - Backend emits `live-mentor-audio` with `{ data, mimeType, sampleRate }` for browser fallback playback.
- Improved Live Mentor chess context:
  - `LiveMentor.jsx` now sends move SAN, FEN, PGN, side to move, game phase, previous evaluation, current Stockfish evaluation, and best move when available.
  - Initial engine context is warmed when mentor mode starts, so the first move can include an eval delta if Stockfish responds in time.
- Fixed browser audio handling:
  - Live Gemini output is treated as 24 kHz raw PCM and converted into an `AudioBuffer`; it no longer uses `decodeAudioData` on raw PCM.
  - Browser fallback playback now works while the backend still forwards raw PCM bytes to ESP32 TCP audio clients on port `3001`.
  - Mic capture uses echo cancellation/noise suppression and routes through a silent gain node to avoid local mic monitor echo.
- Fixed `LiveMentor.jsx` chess.js compatibility:
  - Replaced `game.game_over()` with `game.isGameOver()`.
  - Updated the mentor board to use `react-chessboard` v5 `options`.
- Fixed `Coach Me` compatibility:
  - `/api/advice` now generates text with `gemini-3.5-flash`, then synthesizes speech with Gemini 3.1 TTS.
  - If TTS returns raw PCM, the backend wraps it as WAV before returning it to the browser.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- `GET /api/evaluate` returned Stockfish success with a best move/evaluation.
- `POST /api/advice` returned `success: true`, `mimeType: audio/wav`, one audio chunk, and spoken advice text.
- Socket.IO Live smoke test connected, emitted `start-live-mentor`, received `live-mentor-ready`, then stopped the session.
- Browser smoke test confirmed `http://localhost:3000/mentor` renders with the mentor heading, Start Mentor button, board area, and audio canvas, with no browser console errors.
- Browser regression check confirmed the main board is still square at `375x375` in the default viewport and `.move-history` remains fixed at `150px`.

### Difficulty And Personality Revamp

Changed files:

- `app/server.js`
- `app/package.json`
- `app/package-lock.json`
- `app/client/src/components/GameBoard.jsx`
- Rebuilt `app/client/dist` with `npm run build`

Implementation:

- Added backend dependency `chess.js` so `server.js` can generate legal moves from FEN.
- Added `POST /api/engine-move` for normal game opponent move selection.
- The new endpoint accepts:
  - `fen`
  - `level`
  - `profile`
- The new endpoint returns:
  - `success`
  - `move`
  - `san`
  - `difficultyLabel`
  - `profile`
  - `selectionStyle`
  - `candidateCount`
- Kept `GET /api/evaluate` unchanged for the eval bar, Coach Me, and Live Mentor context.
- Normal mode no longer always plays `bestMoveRef.current`.
- `GameBoard.jsx` now calls `/api/engine-move` for Black's reply, applies the returned legal UCI move, then refreshes evaluation with `/api/evaluate`.
- Added an `Opponent Style` selector near the Difficulty slider.
- Available profiles:
  - `Balanced`
  - `Aggressive`
  - `Defensive`
  - `Trickster`
  - `Chaotic`
  - `Solid`
- Updated the difficulty label from depth-only wording to level wording, such as `Complete Beginner (Level 1)`.

Difficulty behavior:

- Levels `1-2`: mostly legal but weak human-like moves. These levels often choose random, pawn-heavy, early queen, repeated-piece, and other beginner-looking moves.
- Levels `3-5`: casual candidate selection. The backend evaluates a small sampled candidate set and usually chooses okay or mediocre moves with some mistakes.
- Levels `6-8`: intermediate candidate selection. The backend evaluates more candidates and usually chooses near-top moves with occasional inaccuracies.
- Levels `9-11`: advanced candidate selection. The backend mostly chooses top candidates.
- Levels `12-15`: expert mode. The backend preserves strong Stockfish behavior and returns the Stockfish best move at the selected level/depth.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- `POST /api/engine-move` at Level 1 returned varied legal beginner-style moves across profiles.
- Repeated Level 1 / Chaotic calls returned 8 unique moves out of 10 calls from the tested opening FEN.
- Levels 3, 8, and 11 returned legal moves with the expected selection styles:
  - `casual-candidate-mistakes`
  - `intermediate-near-top`
  - `advanced-top-candidate`
- Level 15 / Chaotic returned the same move as `/api/evaluate` depth 15, preserving Expert strength.
- Browser check confirmed the profile selector renders with all six profiles, the board remains `375x375`, and `.move-history` remains fixed at `150px`.
- Browser play test confirmed the client path works: at Level 1 / Balanced, White played `e4` and Black replied `a5`, with no browser console errors.

### Physical Board Gameplay Integration - 2026-07-04

Changed files:

- `app/server.js`
- `app/client/src/components/GameBoard.jsx`
- `esp32_firmware/esp32_firmware.ino`
- Rebuilt `app/client/dist` with `npm run build`

Implementation:

- Added a backend physical-board session controller beside the normal virtual game.
- Added structured JSON endpoints:
  - `POST /api/physical/start`
  - `POST /api/physical/snapshot`
  - `GET /api/physical/poll`
  - `POST /api/physical/job-result`
  - `GET /api/physical/status`
- Kept old diagnostic endpoints such as `/api/command`, `/api/poll`, and `/api/esp-move`.
- Physical sessions require the default chess starting position for v1 piece identity tracking.
- Physical square mapping is now a measured raw-index table in `app/server.js`, not standard chess order:
  - `63 = a8`
  - `62 = a7`
  - `56 = a1`
  - `55 = b1`
  - `0 = h8`
  - `1 = h7`
  - Raw ESP indexes remain sensor/LED/gantry indexes; backend helpers `indexToSquare()` and `squareToIndex()` translate them for chess logic.
- Physical setup supports two modes:
  - Full Starting Set: original behavior; all 32 starting pieces must be detected.
  - Partial Starting Set: detected pieces on normal starting squares become a custom starting FEN. Both kings are required, missing optional pieces are allowed, and occupied non-start squares are still treated as extras.
- Gantry diagnostics now mirror `/api/command` requests into the active `/api/physical/poll` JSON queue, so the current firmware can receive home, square, XY, drag-speed, and magnet diagnostic commands.
- The Gantry Diagnostics panel includes `Add XY as Graveyard Slot`, which appends the current X/Y diagnostic coordinates into the Graveyard Slots box.
- The Gantry Diagnostics square field accepts chess notation such as `A1`/`G4` and converts it to the raw physical index; raw numeric indexes `0-63` still work for low-level testing.
- During `robot_busy`, backend snapshots now auto-complete the pending robot move if live occupancy exactly matches the expected post-move board. This lets manual black-move testing or robot moves without `/api/physical/job-result` recover cleanly instead of leaving the next white lift misclassified.
- If the board is out of sync on White's turn because a black/engine piece is not detected after its move, the backend now enters recoverable `sync_warning` instead of a hard `error`. It highlights affected squares in yellow and returns to `ready` automatically once occupancy matches the current FEN.
- Firmware support for diagnostic JSON commands compiles, but OTA upload from Codex failed with `No response from device`; use USB upload if OTA remains unavailable.
- Backend receives debounced 64-square occupancy snapshots from the ESP32.
- During setup, backend compares occupancy against the default 32 occupied starting squares and queues LED feedback:
  - green: correct
  - red: missing expected piece
  - yellow: unexpected occupied square
- During player turns, backend infers a lifted white source square from occupancy, computes legal moves with `chess.js`, and queues LED feedback:
  - blue: selected source
  - green: quiet legal move
  - red: capture
  - purple: special move or promotion
- Human moves from the physical board update the backend game, emit Socket.IO state to the app, refresh the app board, and then request a black reply from `/api/engine-move`.
- Robot replies are queued as high-level move jobs through `/api/physical/poll`; the backend applies the engine move only after `/api/physical/job-result` reports success and the final occupancy matches the expected board.
- Capture jobs include source/target, captured square, a nearby empty staging square when available, and the next configured graveyard slot.
- If a capture has no configured graveyard slot or no staging square, the backend enters a recoverable physical error state instead of issuing a risky movement job.
- Castling and en passant are represented in the robot command payload with rook/captured-square metadata.
- Promotion defaults to queen, matching the current app behavior.
- `GameBoard.jsx` now has a Physical Board panel with setup/recalibration, status, current missing/extra squares, robot error/busy state, and graveyard slot text entry.
- When physical mode is active, browser drag/click moves are blocked so the real board remains authoritative.
- The firmware was replaced with a WiFi JSON polling implementation that scans/debounces sensors, posts snapshots, polls commands, applies LEDs, homes the gantry, executes robot jobs, posts job results, uses fast travel/slow drag motion profiles, and nudges after drops when target detection fails.
- Added WiFi OTA support to the active firmware:
  - includes `ArduinoOTA`
  - hostname defaults to `chessboard-esp32`
  - optional `OTA_PASSWORD` constant is available
  - OTA starts after WiFi connects
  - `networkTask` calls `ArduinoOTA.handle()`
  - OTA upload disables the magnet and interrupts motion so the board does not keep dragging a piece during firmware upload

Firmware caveats:

- `esp32_firmware/esp32_firmware.ino` now expects ArduinoJson and ArduinoOTA support to be installed in the Arduino environment.
- WiFi constants at the top of the firmware are placeholders: `WIFI_SSID`, `WIFI_PASSWORD`, and `SERVER_BASE_URL`.
- Fill those constants before uploading to hardware. Optional OTA constants are `OTA_HOSTNAME` and `OTA_PASSWORD`.
- First upload still needs USB serial unless an OTA-enabled sketch is already running on the ESP32. After that, the board should appear as `chessboard-esp32` on the network in Arduino IDE / ArduinoOTA-compatible upload tools.
- The firmware accepts high-level robot jobs, but the path planner is still first-pass. Captures use a selected staging square and graveyard slot, but advanced collision avoidance for every knight-like or crowded-board route still needs physical tuning.
- The user reported the ESP32-S3 WiFi brownout issue is fixed, so this pass assumes WiFi is usable. Older brownout notes below are historical diagnostics, not the current integration assumption.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- Software simulation of the physical protocol passed:
  - started physical setup
  - posted default setup occupancy
  - reached `ready`
  - lifted `e2`
  - received legal targets `e2e3,e2e4`
  - completed physical `e2e4`
  - queued a robot black reply through `/api/physical/poll`
  - posted robot success to `/api/physical/job-result`
  - final backend history preserved both moves, for example `e4 b6`
  - final board sync reported zero missing and zero extra squares
- Chrome/Playwright smoke test using local Chrome passed:
  - Physical Board panel rendered
  - Start Physical Game button rendered
  - no browser console errors
  - board remained square at about `374x374`
  - move log remained fixed at `150px`
- Arduino CLI bundled with Arduino IDE was found at `C:\Users\Thejaka\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`.
- Installed ArduinoJson `7.4.3` with Arduino CLI because it was missing from the local Arduino library set.
- Firmware compile passed with `arduino-cli compile --fqbn esp32:esp32:esp32s3 esp32_firmware`.
- Firmware compile size: `1089137` bytes, `83%` of program storage, and `51228` bytes, `15%` of dynamic memory.
- Hardware OTA upload/bench tests were not run in this pass.

### ESP32-S3 Speaker And WiFi Diagnostics - 2026-07-04

Context:

- Target board is the ESP32-S3 N16R8 devkit with two USB-C ports and 44 pins.
- Speaker hardware uses two MAX98357A I2S amp boards in mono-style output.
- The working speaker test setup is under `New folder/speaker_test`.
- The ESP can be connected to USB for serial while also receiving regulated `5V` on `VIN`; this made live serial monitoring possible during powered tests.

Working speaker setup:

- Safe I2S pins after rewiring:
  - `LRC/LRCLK`: GPIO 9
  - `BCLK`: GPIO 10
  - `DIN/DOUT`: GPIO 11
- Do not use the original GPIO 35 / 36 / 37 audio routing on the ESP32-S3 N16R8. Those pins conflict with the module's OPI PSRAM/memory use, which caused MP3 buffer/OOM failures.
- `speaker_test.ino` uses:
  - `ESP32-audioI2S` by schreibfaul1
  - LittleFS first, SPIFFS fallback
  - `audio.forceMono(true)`
  - `audio.setOutput48KHz(false)`
  - `RUN_CPU_MHZ = 160`
  - `DECODE_ONLY_DIAG = false`
  - `START_VOLUME = 20` in the latest working test
- Arduino IDE settings used for the working MP3 test:
  - Board: `ESP32S3 Dev Module`
  - Port: `COM9`
  - Flash Size: `16MB`
  - PSRAM: `OPI PSRAM`
  - Partition Scheme: `Custom`
  - Custom partition file gives two `3M` app partitions and a `9M` filesystem at offset `0x610000`
- Uploading a new song does not require re-uploading the sketch. Replace `New folder/speaker_test/data/test.mp3`, then run:

```powershell
& "C:\Users\Thejaka\Desktop\ChessProject\New folder\speaker_test\upload_littlefs_com9.ps1"
```

Speaker test results:

- MP3 playback now works on both speakers.
- Songs tested successfully after the pin and CPU fixes included:
  - `Queen - We Will Rock You [Lyrics].mp3`
  - `Sonic Journey - Trust Fall (ft. Rachel Leycroft).mp3`
  - `DILU Beats - Dase Durin (Kelawara Nathi Adare) Official Music Video.mp3`
  - `Api Aye Hamuwela - Uvindu Ayshcharya Lyrics Video.mp3`
- The speaker issue had two root causes:
  - GPIO 35 / 36 / 37 conflicted with OPI PSRAM, causing MP3 memory/buffer failures.
  - The ESP devkit's 3.3V rail is weak under sudden high-current events. Running local MP3 playback at `160 MHz` made the speaker tests stable, even at volume `20`.
- The MAX98357A amps and speakers were not the final fault once the I2S pins were moved and the ESP CPU was reduced.

MAX98357A wiring notes from schematic checks:

- Speaker amp `GAIN` pins on the PCB are tied through `100k` resistors to `BUCK-CLEAN`/VIN.
- This corresponds to the lower-gain MAX98357A setting used during successful testing.
- `SD/MODE` was not intentionally driven in the schematic checks; do not tie it to GND for these tests unless intentionally disabling the amp.

Diagnostic files created or used:

- `New folder/speaker_test/speaker_test.ino`: current MP3 speaker test.
- `New folder/speaker_test/upload_littlefs_com9.ps1`: creates and flashes LittleFS to COM9 at `0x610000`.
- `New folder/read_serial_com9.ps1`: reads COM9 directly from PowerShell. Close Arduino Serial Monitor before running it because only one process can own COM9.
- `tests_and_misc/esp32_s3_power_psram_diag/esp32_s3_power_psram_diag.ino`: proved the ESP/PSRAM baseline could run.
- `tests_and_misc/esp32_s3_littlefs_read_diag/esp32_s3_littlefs_read_diag.ino`: repeatedly read `/test.mp3` from LittleFS without reset.
- `tests_and_misc/esp32_s3_i2s_no_file_diag/esp32_s3_i2s_no_file_diag.ino`: proved basic I2S output on GPIO 9/10/11 could run.
- `New folder/wifi_speaker_interference_test/wifi_speaker_interference_test.ino`: attempted local audio playback while enabling WiFi scan stress, but reset occurred during WiFi startup before meaningful speaker interference testing.
- `New folder/esp32_s3_wifi_boot_diag/esp32_s3_wifi_boot_diag.ino`: minimal WiFi-only diagnostic.
- `New folder/esp32_s3_non_wifi_stress_diag/esp32_s3_non_wifi_stress_diag.ino`: non-WiFi stress test.

WiFi brownout finding:

- WiFi startup currently fails on this ESP32-S3 devkit.
- Minimal WiFi-only sketch resets at:

```text
[WIFI-BOOT] mode(WIFI_STA) begin
E BOD: Brownout detector was triggered
```

- This reproduced with:
  - ESP removed from the PCB
  - speakers and amps disconnected
  - external regulated `5V` applied to `VIN`
  - USB connected for serial
  - CPU at `160 MHz`
  - PSRAM disabled
- Measured rails during the failure:
  - `5V/VIN` stayed steady, around `4.97V`
  - `3V3` dropped to around `2.3V`
- Conclusion: the board's 5V input is fine, but the devkit's 3.3V regulator/power path collapses when the WiFi/RF section powers up.

Non-WiFi stress result:

- `esp32_s3_non_wifi_stress_diag` ran stably with:
  - CPU at `240 MHz`
  - OPI PSRAM enabled
  - repeated 5 MB PSRAM fill/verify
  - internal heap testing
  - flash reads
- The serial capture showed it continuing past 240 seconds with no brownout.
- This confirms the devkit can handle CPU, flash, and PSRAM load. The unstable load is specifically WiFi/RF startup.

Current implication for future streaming work:

- Local MP3 playback is working with the current speaker test setup.
- WiFi audio streaming is blocked on this devkit until the 3.3V rail issue is fixed.
- Next hardware options:
  - replace the ESP32-S3 N16R8 devkit, or
  - power the ESP module from a known-good external 3.3V regulator rated with enough current and wired so it does not fight the onboard regulator.
- Do not spend more time trying to solve the WiFi reset in application code. It occurs in a minimal WiFi-only sketch before audio, filesystems, or the PCB are involved.

## Important Files And Entry Points

### Backend

`app/server.js`

Main responsibilities:

- Serves the built React app from `app/client/dist`
- Receives ESP32 moves at `POST /api/esp-move`
- Broadcasts physical board moves to the frontend with Socket.IO event `esp-move`
- Accepts frontend gantry commands at `POST /api/command`
- Lets ESP32 poll queued commands at `GET /api/poll`
- Owns physical-board session state at `/api/physical/start`, `/api/physical/snapshot`, `/api/physical/poll`, `/api/physical/job-result`, and `/api/physical/status`
- Emits physical-board Socket.IO events: `physical-status`, `physical-board`, `physical-move`, and `physical-error`
- Runs local npm Stockfish via UCI for evaluation at `GET /api/evaluate`
- Selects normal-mode opponent moves with difficulty/personality behavior at `POST /api/engine-move`
- Calls Gemini for one-shot coach advice at `POST /api/advice`
- Opens a TCP audio server on port `3001` for ESP32 speaker audio
- Manages Gemini Live mentor sessions over Socket.IO

### Main Client

`app/client/src/components/GameBoard.jsx`

Main responsibilities:

- Holds authoritative chess state in `gameRef`
- Shows the board with `react-chessboard`
- Evaluates positions through `/api/evaluate`
- Makes engine replies through `/api/engine-move` using the selected difficulty level and opponent profile
- Handles undo/redo
- Calls `/api/advice` for "Coach Me"
- Receives ESP32 physical moves via Socket.IO
- Provides the Physical Board panel for setup, status, graveyard slots, and physical-mode board syncing
- Sends gantry diagnostic commands to `/api/command`

### Live Mentor Client

`app/client/src/components/LiveMentor.jsx`

Main responsibilities:

- Starts/stops Gemini Live mentor mode
- Streams microphone PCM audio to the backend
- Sends move/FEN events to Gemini Live
- Displays transcript/log messages
- Visualizes returned audio
- Syncs ESP32 moves from the physical board

### Firmware

`esp32_firmware/esp32_firmware.ino`

Main responsibilities:

- WiFi connection for physical-board JSON polling
- WiFi OTA updates through ArduinoOTA after the first USB upload
- Polling `http://<server-ip>:3000/api/physical/poll`
- Posting debounced occupancy snapshots to `/api/physical/snapshot`
- Posting robot movement results to `/api/physical/job-result`
- CoreXY movement
- Homing
- Electromagnet control
- 64-square hall sensor scan through 4 multiplexers
- 256 LED updates through Adafruit NeoPixel
- Fast travel / slow drag motion profiles
- Drop verification and nudge recovery when a target square is not detected

## Things I Found Out

- The project root is not currently a Git repository.
- `app/.env` exists and contains `GEMINI_API_KEY` and `PORT`.
- The active backend uses the npm `stockfish` package at `app/node_modules/stockfish/bin/stockfish-18-lite-single.js`.
- The backend also uses `chess.js` to generate legal candidate moves for `/api/engine-move`.
- Older notes or binaries may still mention Reckless, but `app/server.js` currently evaluates positions through Stockfish.
- The React production build is served by the Node server from `app/client/dist`.
- If source files under `app/client/src` are changed, run `npm run build` in `app/client` before expecting `localhost:3000` to reflect those changes.
- The Vite dev server proxies `/api` and `/socket.io` to `localhost:3000` if running the client in dev mode.
- `node_modules` already exists under both `app` and `app/client`.
- The hardware handoff PDF says the current phase is networking/API/game logic and warns that firmware timing loops must stay non-blocking.

## Hardware And Firmware Cautions

The ESP32 main loop is timing-sensitive because it scans multiplexers, updates LEDs, and drives stepper control. The handoff document specifically warns:

- Do not put blocking networking calls in the main hardware loop.
- Keep network/API work on a separate FreeRTOS task/core where possible.
- Be careful with `delay()` in timing-critical areas.
- Do not break CoreXY stepping timing.

Current firmware already uses FreeRTOS tasks for:

- `networkTask`

The firmware currently contains placeholder WiFi/server constants that must be filled before upload:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `SERVER_BASE_URL`

Avoid committing or sharing real credentials if this project is later put under version control.

## Pin Mapping Note

There may be mismatches between `hardware/schematic.docx` and the current firmware pin mappings. The active firmware currently uses:

- Motor A step/dir: GPIO 42 / GPIO 41
- Motor B step/dir: GPIO 39 / GPIO 40
- Magnet: GPIO 38
- Limit Y/X: GPIO 47 / GPIO 48
- MUX SIG pins: GPIO 4, 5, 6, 7
- MUX address pins S0-S3: GPIO 18, 17, 16, 15
- LED data: GPIO 8
- The active physical-board firmware does not currently include I2S speaker playback.

Latest speaker diagnostics supersede the old I2S audio pins for future speaker work. Use GPIO 10 / 9 / 11 for BCLK / LRC / DIN, and avoid GPIO 35 / 36 / 37 on the ESP32-S3 N16R8 because those pins break OPI PSRAM-dependent MP3 playback.

Before changing firmware or PCB assumptions, verify against the actual wired hardware.

## Build And Run Notes

Backend:

```powershell
cd C:\Users\Thejaka\Desktop\ChessProject\app
npm start
```

Client production build:

```powershell
cd C:\Users\Thejaka\Desktop\ChessProject\app\client
npm run build
```

Client dev server, if wanted:

```powershell
cd C:\Users\Thejaka\Desktop\ChessProject\app\client
npm run dev
```

The app was seen running at:

```text
http://localhost:3000
```

## 2026-07-05 Physical Board Logging And Safe Motion Update

Changed files:

- `app/server.js`
- `app/client/src/components/GameBoard.jsx`
- `esp32_firmware/esp32_firmware.ino`
- `codex.md`

Backend physical logging:

- Added structured physical-board logging with live Socket.IO event `physical-log`.
- Added `GET /api/physical/logs?limit=200`.
- Runtime JSONL files are written under `app/logs/physical-board-YYYY-MM-DD.jsonl`.
- Each log entry includes timestamp, severity level, phase, event type, FEN, move history, pending robot job summary, expected/actual occupied indexes, missing/extra indexes and squares, command id, message, and optional details.
- Important logged events now include setup start, calibration updates, setup ready, command queued, piece lifted, move cancelled, accepted human move, robot thinking, robot job queued, robot job result, robot result mismatch, robot move committed, sync warning, sync restored, and hard errors.

Robot mismatch behavior:

- `/api/physical/job-result` no longer turns a successful robot move with bad final occupancy into a hard red error.
- If the robot reports success but sensors do not match the expected post-move board, the backend now commits the intended robot move, enters `sync_warning`, queues yellow mismatch LEDs, emits `physical-board`, logs the full diff, and returns HTTP 200 with `{ success: false, recoverable: true }`.
- Red error state is still used for unrecoverable conditions such as a failed robot command, illegal pending robot move, or invalid command id.
- This specifically targets the issue where a black robot move physically happened but the app only showed a laptop-side error such as "Robot move completed but final occupancy did not match the expected board."

Safe motion planner:

- Robot move commands now include a `plan` array while preserving the older direct fields (`fromIndex`, `toIndex`, capture metadata, castling metadata, `verify`) for compatibility.
- Plan steps are explicit segments: `travel`, `pickup`, `drag`, `drop`, and `verify`.
- Direct drag is used for short/simple clear moves such as normal pawn moves.
- Knights, castling, captures, and crowded/longer routes prefer off-board lane routing when lane coordinates exist.
- Captures use a staged flow: move attacker to a staging coordinate/square, remove captured piece to a graveyard coordinate, then move attacker onto the capture square.
- If no usable `Z`/`I` lane labels exist, the command can still fall back to the older direct/staging behavior.

Graveyard and lane labels:

- Graveyard labels `Z1-Z8` mean the a-side off-board lane.
- Graveyard labels `I1-I8` mean the h-side off-board lane.
- These labels are metadata only; there are still no sensors or LEDs on graveyard locations.
- The existing text box still accepts `Label: x,y`.
- The Gantry Diagnostics "Add XY as Graveyard Slot" helper now auto-labels new entries as `Z1-Z8` first, then `I1-I8`.

Client UI:

- Added a Physical Log panel in `GameBoard.jsx`.
- The panel loads recent events from `/api/physical/logs?limit=120` and appends live `physical-log` Socket.IO events.
- Rows show severity, timestamp, message, event type, command id, and missing/extra square summaries when available.
- Fixed physical socket cleanup to unregister `physical-move`, `physical-error`, and `physical-log` listeners on component cleanup.

Firmware:

- `esp32_firmware.ino` now prefers command `plan[]` when present.
- The firmware step interpreter executes `travel` with magnet off and fast motion, `pickup` with magnet on, `drag` with magnet on and slow motion, `drop` with magnet off, and `verify` with sensor checks/nudge attempts.
- Older robot commands without `plan[]` still use the previous `executeRobotMove` fallback.
- Firmware JSON buffers for poll/command parsing were increased to handle larger planned move commands.

Verification completed:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- Arduino CLI compile for `esp32:esp32:esp32s3` passed; sketch used 1,091,761 bytes, about 83% of 1,310,720 bytes, and global variables used 51,228 bytes, about 15% of dynamic memory.
- Backend simulation passed: started physical mode, submitted full setup occupancy, simulated `e2e4`, let backend queue a black robot move, posted a deliberately mismatched robot job result, and confirmed response `{ success: false, recoverable: true }`, state `sync_warning`, and logs containing the exact missing square.
- The simulated test JSONL file was deleted afterward so the next real run starts with clean runtime logs.
- Temporary test server was stopped after verification; ports `3000` and `3001` were confirmed free.

Operational notes:

- After these source changes, upload the updated firmware before expecting the ESP32 to use `plan[]`. Without the new upload, the backend still sends fallback fields, but the ESP32 will not use lane plans.
- For real graveyard routing, configure coordinates with labels such as `Z1: x,y` and `I1: x,y`; generic labels like `Captured 1` still work as graveyard targets but do not help lane routing.
- Recovery remains pause-first. The backend does not attempt multi-piece automatic recovery after a mismatch; it highlights/logs the diff and waits for the board to be restored or centered.

## 2026-07-05 Physical Board Robot Failure Follow-Up

Observed runtime log:

- Real game history before the failure was `1. c4 d5 2. d4`.
- Backend queued black robot move `e7e6`.
- Firmware returned `success: false` with `Motion plan source square did not become empty.`
- Sensor snapshot also showed `d5` missing, while `e7` was still occupied and `e6` was not occupied.
- The physical session had `graveyardSlotCount: 0`, so no `Z/I` lane coordinates were available for safer routing.

Fixes added:

- Robot job failures from `/api/physical/job-result` with occupancy now become recoverable `sync_warning` states instead of red terminal errors.
- The pending robot job is preserved after recoverable failure.
- Added `POST /api/physical/retry-robot`; it only requeues the pending robot command if the board currently matches the pre-robot game position.
- Added a `Retry Robot Move` button in the Physical Board panel when a pending robot job is paused in `sync_warning`.
- Late job results for already-completed robot moves are accepted as `robot_job_result_late` instead of warning as unexpected.
- Direct robot drags are now stricter: short moves are no longer automatically considered safe if occupied squares are adjacent to the drag corridor.
- If a direct route is unsafe and no `Z/I` lane waypoint exists, the backend refuses to create that risky robot move instead of forcing the drag.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- Ports `3000` and `3001` were left free after checks.

Notes:

- Configure real `Z1-Z8` and/or `I1-I8` lane coordinates before expecting crowded robot moves such as knight moves, castling, or pawn moves near occupied squares to route safely.
- A short backend simulation was run while the ESP client was connected; those simulated 12:41 UTC log entries were removed from `app/logs/physical-board-2026-07-05.jsonl`, leaving the real 12:32 failure entries intact.

## 2026-07-05 Z-Lane Graveyard Defaults

Observed runtime log:

- Later games failed before any robot command was sent because the backend refused unsafe direct routes such as `e7e6` and `b7b6`.
- The physical session state showed `graveyardSlotCount: 0`, meaning no lane coordinates were included when `POST /api/physical/start` ran.
- The user-provided Z-side coordinates were valid `x,y` values for the app/firmware command format, even though the firmware's internal square table stores board-square constants as `{Y, X}`.

Changes:

- `GameBoard.jsx` now pre-fills the Graveyard Slots textbox with:

```text
Z1: 29300,34450
Z2: 24800,34450
Z3: 21300,34450
Z4: 17300,34450
Z5: 13300,34450
Z6: 9300,34450
Z7: 5300,34450
Z8: 1300,34450
I8: 1500,-600
I7: 5500,-600
I6: 9500,-600
I5: 13700,-600
I4: 17600,-600
I3: 21600,-600
I2: 25600,-600
I1: 29600,-600
```

- The client parser normalizes pasted labels `Captured 1` through `Captured 8` to `Z1` through `Z8`.
- The backend `normalizeGraveyardSlots` does the same normalization, so old pasted text still becomes usable Z-lane metadata.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.

## 2026-07-06 I-Side Graveyard Defaults Added

Change:

- Added default h-side lane/graveyard coordinates in both backend and UI defaults:

```text
I8: 1500,-600
I7: 5500,-600
I6: 9500,-600
I5: 13700,-600
I4: 17600,-600
I3: 21600,-600
I2: 25600,-600
I1: 29600,-600
```

- Backend `normalizeGraveyardSlots([])` now falls back to all 16 configured slots: `Z1-Z8` plus `I8-I1`.
- The Physical Board Graveyard Slots textbox now pre-fills the same 16-slot set.
- Existing tests and helper imports can still use `DEFAULT_Z_GRAVEYARD_SLOTS` when they specifically need Z-only behavior.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- A parser smoke check confirmed `Captured 1: 29300,34450` becomes `Z1` with `x=29300`, `y=34450`.

## 2026-07-05 Physical Planner Lane Safety Fix

Observed runtime log:

- A later game started with Z-side lane slots configured and `graveyardSlotCount: 8`.
- After `1. f4`, the engine selected black move `e7e6`.
- The planner routed the pawn through the Z lane because direct routing had been made too strict.
- That route went from `e7` toward `Z7`, crossing occupied rank-7 squares `d7`, `c7`, `b7`, and `a7`.
- The resulting sensor state showed `d7` missing and `a6` extra, matching the user's report that the robot unexpectedly dragged the wrong pawn toward the Z side.

Fixes added:

- Simple non-capturing pawn pushes now stay direct when the chess path is clear. This covers normal one- and two-square pawn moves such as `e7e6`, `b7b6`, and `e7e5`.
- Lane routing now checks that the path from the source square to the lane edge is clear before using a `Z` or `I` coordinate.
- Lane routing also checks that the re-entry path from the lane edge to the target square is clear.
- Capture staging uses a lane only if the exit path is clear, and board staging is only allowed when the direct staging path is safe.
- If the engine's first move cannot be physically planned safely, the backend now tries other legal replies and logs `robot_move_fallback` instead of immediately erroring.
- Physical move command logs now include a compact plan summary, so future logs reveal the exact route labels/squares instead of only `planStepCount`.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.

Operational note:

- Restarting the backend applies this planner fix and resets the current physical session. Recalibrate before the next test game.

## 2026-07-05 Planner Dry-Run Validation

Additional safety work:

- Added server-side default Z-lane slots in `app/server.js`, matching the UI defaults. This prevents stale browsers or empty request bodies from starting physical mode with `graveyardSlotCount: 0`.
- Added `POST /api/physical/plan-preview` for no-motion inspection of a single legal move plan from a supplied FEN.
- Added `POST /api/physical/planner-check` for no-motion inspection of every legal move from a supplied FEN.
- These endpoints do not queue ESP commands and do not move the gantry.
- `server.js` now starts listeners only when run directly, so backend planner helpers can be imported by tests without binding ports `3000` or `3001`.
- Added `npm run test:physical-planner`, implemented in `app/scripts/physical-planner-regression.js`.

Dry-run results after the lane-safety fix:

- From the post-`1. f4` black-to-move FEN, `e7e6`, `e7e5`, and `b7b6` planned as direct moves, not Z-lane moves.
- From the normal black starting position, all 16 black pawn replies planned as direct moves.
- From the same position, the 4 black knight replies were blocked because only Z-side lanes exist and their exit paths are occupied. This is expected; the backend can fall back to a routable pawn move instead of forcing a knight through pieces.
- Planner dry-run reported `graveyardSlotCount: 8` even when no graveyard slots were supplied, proving backend defaults are active.

Verification:

- `node --check app/server.js` passed.
- `npm run build` in `app/client` passed.
- `npm run test:physical-planner` passed. It checks that `e7e6`, `e7e5`, and `b7b6` are direct after `1. f4`, that `g8h6` is blocked with only Z-side lanes, that all 16 black opening pawn replies are direct, and that the 4 black opening knight replies are blocked instead of forced through pieces.
- Backend was restarted after the changes and responded on `localhost:3000`.

## 2026-07-05 No-Legal-Move Lift Recovery

Observed runtime issue:

- User lifted the rook on `h1` while it had no legal moves.
- Backend treated that as a hard `error` with message `The piece on h1 has no legal moves.`
- After the rook was placed back, the physical session stayed stuck because hard-error phases do not process restore snapshots.

Fix:

- `processReadySnapshot` now treats lifting one of the player's pieces with zero legal moves as a recoverable `sync_warning`, not a hard error.
- The warning message tells the user to put the piece back on its source square.
- When the piece is restored and occupancy matches the expected board, `processSyncWarningSnapshot` clears the warning and returns to `ready`.
- Added `npm run test:physical-state`, implemented in `app/scripts/physical-state-regression.js`.
- Added combined `npm run test:physical` to run both planner and state-machine physical regressions.
- Test imports disable JSONL log writes with `PHYSICAL_LOG_DISABLE=1`, so regression runs do not pollute real physical-board logs.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.

## 2026-07-05 Short Quiet Move Routing Fix

Observed runtime log:

- In the 13:19-13:22 UTC physical-board logs, the planner routed `a8a7` as `a8 -> Z8 -> Z7 -> a7`, then later routed `a7a8` as `a7 -> Z7 -> Z8 -> a8`.
- After the human move `Bxc6+`, the engine/planner considered `d8d7` but failed with `No safe route from d8 to d7. Direct path is unsafe and the configured Z/I lane path is blocked.`
- These came from the same planner rule: one-square quiet moves by pieces other than pawns still ran through the broad corridor-nearby-piece check. That check rejected adjacent moves if neighboring pieces were near the source or target, then lane routing was attempted even when a short direct drag was the least risky motion.

Fix:

- Added `isShortQuietMove` in `app/server.js`.
- Non-capturing, non-castling, non-en-passant one-square moves now stay direct after the chess path itself is confirmed clear.
- This keeps short moves such as `a8a7`, `a7a8`, and `d8d7` from being routed through `Z8/Z7`.
- Longer non-pawn moves still use the corridor safety check, and captures/knights/castling keep their existing conservative handling.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- Added planner regression cases proving `a8a7`, `a7a8`, and `d8d7` produce direct plans.
- Restarted the backend on ports `3000` and `3001`.
- Live `POST /api/physical/plan-preview` now returns direct 5-step plans for:
  - `d8d7` from `rnbqkbnr/4ppp1/p1B5/3p3p/1P1QP3/B1P2N2/P2P1PPP/RN2K2R b KQk - 0 9`
  - `a8a7` from `rnbqkbnr/2p1pppp/p7/1p1p4/3QP3/2P5/PP1P1PPP/RNB1KBNR b KQkq - 1 4`
- `a7a8` from `1nbqkbnr/r1p1ppp1/p6p/1p1p4/1P1QP3/B1P5/P2P1PPP/RN2KBNR b KQk - 1 6`

## 2026-07-05 Capture Planning And Robot Commit Fix

Observed runtime log:

- At high difficulty, the robot captured `dxe4` and `exf3`.
- Both commands used a 17-step `capture-lane` route:
  - move the attacking pawn off-board into the Z lane,
  - move the captured white piece to the graveyard,
  - move the attacking pawn back onto the capture square.
- This was unnecessarily slow for adjacent pawn captures, because the captured piece could be removed first and the attacker could then move directly onto the now-empty target square.
- A second issue came from binary occupancy sensors: while the attacker was staged off-board and the captured piece was still on the target, the board occupancy already looked identical to the final capture position. The backend could commit the move from a mid-motion snapshot before the ESP32 job-result arrived, then the rest of the physical capture looked like board disturbance and could leave yellow sync-warning LEDs.
- The app also only showed the engine move after robot completion/commit, not when the engine move was chosen.

Fixes:

- `buildCaptureMotionPlan` now tries a remove-first capture route before attacker staging:
  - remove the captured piece from the target square to the configured `Z/I` graveyard,
  - then move the attacker from source to target.
- If remove-first cannot safely route the attacker, the planner still falls back to the older staging route.
- Robot moves are now applied to the software game and emitted to the app as soon as the command is planned, before the hardware job is queued for ESP32 polling.
- Robot jobs now finalize only from `/api/physical/job-result`; mid-motion snapshots during `robot_busy` update occupancy/status but cannot commit the move.
- If a robot job fails after the app has shown the planned move, the backend rolls the game back to the pre-robot FEN before entering the recoverable sync-warning/retry path.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- Added planner regression checks for efficient remove-first captures:
  - `d5e4` from `rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2`
  - `e4f3` from `rnbqkbnr/ppp1pppp/8/8/4pP2/5Q2/PPPP2PP/RNB1KBNR b KQkq - 1 3`
- Added state regression coverage proving a mid-capture binary occupancy match does not clear `pendingRobotJob` or leave `robot_busy`.
- Restarted the backend on ports `3000` and `3001`.
- Live `POST /api/physical/plan-preview` now returns `capture-remove-first-direct` and 11-step plans for both `d5e4` and `e4f3`; neither plan stages the attacking pawn in the graveyard first.

## 2026-07-05 Physical Promotions Disabled

Reason:

- The physical board currently has no extra pieces for promotion.
- To avoid asking the user to replace pawns or creating an impossible physical state, promotion is disabled in physical-board mode.

Behavior:

- Normal virtual chess remains unchanged.
- Physical-board legal move generation now removes all promotion moves.
- A pawn on the 7th rank with only promotion moves is treated like a piece with no legal physical moves; lifting it enters recoverable `sync_warning` and asks the user to put it back.
- Robot reply selection cannot choose promotion moves in physical mode.
- `POST /api/physical/plan-preview` and `POST /api/physical/planner-check` also filter promotion moves.
- `buildRobotMoveCommand` has a safety guard that rejects promotion moves even if a caller bypasses the endpoint filters.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- Added planner regression coverage proving promotion moves are not successfully plannable.
- Added state regression coverage proving a promotion-only pawn lift is recoverable as a no-legal-move lift.
- Restarted the backend on ports `3000` and `3001`.
- Live `POST /api/physical/plan-preview` rejects `g7g8q` from `4k3/6P1/8/8/8/8/8/4K3 w - - 0 1` as unavailable after physical filtering.

## 2026-07-05 Physical Game Over And Expert Rerank Fix

Observed runtime log:

- A later high-difficulty physical game appeared to end like a draw/stalemate because the app did not show a clear game result and the robot stopped moving.
- The final logged FEN was `k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36`.
- That position was not a chess stalemate. Black had legal knight moves from `g8`, but every legal move was physically blocked with the currently configured Z-only lane:
  - `g8h6`
  - `g8f6`
  - `g8e7`
- Earlier in the same game, max difficulty often chose weak-looking fallback moves because the Stockfish preferred move was physically unroutable and the backend selected the first routable legal move from chess.js order, not the strongest routable move.

Fixes:

- Added `gameResultMessage` so physical mode reports specific game-over states:
  - checkmate winner,
  - draw by stalemate,
  - draw by threefold repetition,
  - draw by insufficient material,
  - generic draw.
- Human and robot physical move completion now use that message instead of generic `Game over.`
- Added `game_over` physical logs with the exact result message.
- Expert physical mode now plans all legal physical candidates, filters to routable commands, scores the routable set with Stockfish, and chooses the strongest routable move.
- If the Stockfish best move is blocked but another move is physically routable, the fallback is now engine-ranked instead of first-legal-order.
- If no legal move has a physical route, the backend still stops with a physical route error. This is distinct from chess draw/stalemate.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- Added state regression coverage for a real stalemate move (`Qg6`) and confirmed physical mode reports `Draw by stalemate.`
- Restarted the backend on ports `3000` and `3001`.
- Live `POST /api/physical/planner-check` for the final logged FEN confirmed `routableCount: 0` and `blockedCount: 3`, proving that end position was a physical route block rather than a chess draw.

Operational note:

- With only Z-side graveyard/lane slots configured, some g/h-side knight routes can remain impossible in crowded positions.
- Adding I-side lane/graveyard coordinates would give the planner a right-side escape lane and reduce weak fallbacks or route-block stops at high difficulty.

## 2026-07-05 Direct Quiet Move Planner Fix

Reason:

- The previous physical planner was too conservative for quiet moves.
- It hard-blocked every knight move from direct routing, then tried to use Z/I lanes.
- It also rejected clear long rook/bishop/queen moves when unrelated pieces were inside a broad rectangle around the route.
- This caused legal quiet moves like `g8h6`, `g8f6`, and `g8e7` to fail as "no safe route" even though the robot could move the piece directly.
- It also made rooks prefer graveyard/lane routing even when the actual rank/file path was open.

Fix:

- Quiet knight moves can now route directly when the destination is empty.
- Quiet sliding moves now require the actual chess path to be clear, but no longer fail because nearby off-path squares are occupied.
- Captures still use the safer remove-first capture planner.
- Castling still uses the castle planner.
- Lane routing is now reserved for quiet moves whose actual direct route is not valid, instead of being forced by over-broad crowding checks.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- Added planner regression coverage for:
  - opening `g8h6` direct,
  - final logged position replies `g8h6`, `g8f6`, and `g8e7` direct,
  - clear rook lane `a1a8` direct,
  - existing efficient capture, promotion-disabled, and state regressions.

## 2026-07-06 Physical Pathfinding, Graveyard, LEDs, And Expert Strength

Reason:

- Later physical logs had many max-difficulty fallbacks and robot mismatches.
- The main issue was physical routing, not Stockfish randomness: non-pawn moves were still effectively one center-to-center drag, and many engine-preferred captures failed because the graveyard lane route was too limited.
- Stale legal-move LEDs could remain visible briefly after the backend had already accepted the physical move.

Backend behavior:

- Added buffered A* board pathfinding for physical robot moves.
- Non-pawn quiet moves now produce square-by-square drag waypoints instead of blindly dragging directly through the board.
- Occupied squares are blocked, diagonal corner-cutting through two occupied neighboring squares is rejected, and crowded adjacent squares carry a large path cost.
- If buffered routing cannot find a path, the planner retries relaxed occupied-only board routing before using Z/I lane routing.
- `buildRobotMoveCommand` now includes route metadata: `routeMode`, `pathSquares`, `routeCost`, and `blockedReason`.
- Captures remove the captured piece first, route it to a robot graveyard slot, then route the attacker to the capture square.
- Robot graveyard slots are software-tracked and no longer reused once occupied.
- Graveyard filling is middle-out: `Z4, Z5, Z3, Z6, Z2, Z7, Z1, Z8`, with the same pattern for `I` slots.
- Human-captured pieces are not tracked or guided to graveyard; the robot owns the configured graveyard slots.
- Physical state now includes `gameStatus` with check, checkmate, draw, result text, winner, and king-square details.
- Check LEDs flash the checked king. Checkmate highlights the losing king red and winning king green. Draw/stalemate pulses both kings with the draw color.
- LED commands now replace stale pending LED commands, and `/api/physical/snapshot` returns `immediateCommands` so ESP32 can clear/update LEDs without waiting for the next poll.

Expert strength:

- Normal virtual Expert remains Stockfish-best.
- Physical Expert first uses Stockfish's preferred move if that move is routable.
- If the preferred move is blocked, all routable physical candidates are rescored at the selected Expert level depth, not capped at depth 8.
- Physical Expert ignores personality randomness during fallback; route cost is only a tie-break when engine scores are effectively equal.
- Fallback logs now include selected score, score depth, route mode, route cost, preferred failure, and planning failures.

Firmware:

- `esp32_firmware.ino` now parses `immediateCommands` returned by `/api/physical/snapshot`.
- LED commands in snapshot responses are applied immediately.
- Existing multi-step plan execution, fast travel, slow drag, drop verification, and nudge behavior remain unchanged.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- Planner regression now covers:
  - blocked boxed-in opening knight path,
  - final logged `g8` knight replies as board paths,
  - long rook board path,
  - diagonal corner-cut avoidance,
  - remove-first capture routing,
  - middle-out graveyard reservation,
  - full graveyard rejection,
  - promotion-disabled behavior.
- State regression now covers:
  - no-legal-move lift recovery,
  - move-cancel recovery,
  - mid-capture occupancy not prematurely completing robot job,
  - promotion-only pawn lift recovery,
  - stalemate draw status,
  - game-over LED command emission.

## 2026-07-06 Physical Motion Follow-Up: Faster Paths, Castling, Capture Preview, And LED Animations

Reason:

- Real-board testing showed buffered A* was still too cautious and sometimes chose wide detours around nearby pieces.
- Robot board paths were executed as one drag stop per square, which made long straight moves unnecessarily slow.
- Human castling failed because the backend only accepted castling after king and rook were already in final positions; moving the king first left the session stuck in `piece_lifted`.
- LED states could remain stale after accepted human moves or show only a partial calibration state.
- Checkmate/draw/stalemate LEDs were too static.

Backend behavior:

- Clear rank/file/diagonal chess-line routes are now preferred before A* pathfinding.
- Same-file and same-rank path generation was fixed so vertical/horizontal paths include their target squares.
- Buffered A* still blocks occupied squares and diagonal corner-cutting, but nearby occupied squares are now a softer cost instead of a hard rejection.
- A* output is compressed into straight-line drag segments. For example, `a1 -> a2 -> a3 -> a4` is sent as one drag to `a4`; direction changes remain separate waypoints.
- Robot command/log/preview metadata now includes `rawPathSquares` and `compressedPathSquares` in addition to `pathSquares`.
- Captures now prefer staged-first choreography: move attacker near the captured piece, move the captured piece to the robot graveyard, then move attacker onto the capture square.
- Remove-first capture routing remains as fallback if no staged-first route is safe.
- This supersedes older notes in this file that described remove-first capture routing as the default behavior.
- Capture commands include `capturePreview` metadata, and the backend queues a `robot-path-preview` LED command before the robot move.
- Robot castling now tries normal board routing first and falls back to Z/I lane routing only if needed.

Human castling:

- Added `pendingCastleMove` physical state.
- When the human moves the king two squares for castling, the backend enters `castle_pending_rook` instead of misreading the position as incomplete.
- LEDs/app state highlight the rook source and rook destination.
- Castling is committed only when king and rook final occupancy matches the legal castling move.
- Returning the king to the source square cancels pending castling and clears LEDs.

LED and firmware behavior:

- `esp32_firmware.ino` now clears the NeoPixel strip before applying every non-overlay LED command.
- This should fix stale legal-move lights and partial recalibration light states.
- Kept `Adafruit_NeoPixel`; it is sufficient for current animations and avoids a risky library switch.
- Added non-blocking `celebrate-checkmate`, `celebrate-draw`, and `celebrate-stalemate` animations.
- Checkmate animates the board with multiple colors, flashes the losing king red, and pulses the winning king green/blue.
- Draw/stalemate pulse both kings and use calmer yellow/purple board-wide animation.
- Snapshot `immediateCommands` behavior remains intact, so LEDs can update without waiting for `/api/physical/poll`.

Difficulty notes:

- No randomness was added to levels 12-15.
- Stockfish calls still use `go depth N`, not `go movetime`; level 15 is depth 15, not a fixed seconds-long think.
- Normal virtual Expert remains Stockfish-best.
- Physical Expert first tries Stockfish's preferred move if it is physically routable.
- If the preferred move is physically blocked, the backend scores all routable candidates at the selected expert depth and uses route cost only as a near-tie breaker.
- Weak-looking Expert physical moves should be checked in logs as physical-route fallbacks, not assumed to be difficulty randomness.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- `where.exe arduino-cli` did not find Arduino CLI, so firmware compile/upload was not verified from the shell. Use Arduino IDE or OTA upload for `esp32_firmware.ino`.
- Planner regression now covers compressed long rook routing, shorter safe `g8f6` routing, staged-first captures, middle-out graveyard reservation, full-graveyard rejection, blocked boxed-in opening knights, and promotion-disabled behavior.
- State regression now covers human castling pending-rook flow, castling cancellation, stalemate celebration LED command, no-legal-move lift recovery, mid-capture occupancy handling, and promotion-only lift recovery.

## 2026-07-07 Physical Capture Routing, Castling Recovery, And LED Timing

Reason:

- Real games showed capture routes still doing unnecessary staged moves, sometimes dragging pieces through crowded areas before the captured piece was removed.
- The backend could plan from stale expected occupancy after sensors already disagreed with the software board.
- Human move LEDs were clearing too late because robot planning happened before the snapshot response could return immediate LED feedback.
- Robot castling failures needed phase-level diagnostics so a failed king or rook phase is recoverable instead of blindly retrying the full castle.
- The I-side graveyard row was configured at `y=-600`; the board setup now uses `y=-350`.

Backend behavior:

- Captures now try `capture-direct-after-removal` first: remove the captured piece to a robot graveyard slot, then route the attacker to the capture square without staging.
- `capture-stage-first-board` is now a fallback only when direct-after-removal is unsafe.
- Graveyard selection now scores all free `Z/I` robot slots by route length, crowding risk, and middle-out preference instead of taking the first free slot.
- Robot planning now checks latest stable sensor occupancy against expected board occupancy. If they differ, the backend enters `sync_warning` and logs `robot_planning_stale_snapshot` instead of planning from stale state.
- Physical routing still blocks occupied squares, but diagonal movement between two occupied corner-adjacent squares is now allowed.
- Capture logs now include strategy, rejected strategy reasons, route score, graveyard candidates, snapshot age, and occupancy-diff status.
- Human move acceptance now queues `human-move-confirm` immediately and schedules the robot reply afterward, so legal-move LEDs clear and the destination square blinks before engine planning starts.
- Robot castling motion steps are tagged as `castle-king` and `castle-rook`; failed job results include the failed phase and step.
- If a castling job fails after a partial move, retry remains blocked until the board is restored to the pre-robot position.

LED and firmware behavior:

- Added `human-move-confirm` LED handling: the accepted destination square blinks twice quickly, then the board clears.
- Added capture runway motion steps:
  - capturer blue and captured piece red first,
  - optional green runway for attacker staging,
  - red/purple runway for captured-piece graveyard removal,
  - green/blue runway for attacker final path.
- `esp32_firmware.ino` handles `led-capture-start` and `led-runway` both as normal LED commands and as sequenced motion-plan steps.
- Existing `Adafruit_NeoPixel` behavior, snapshot `immediateCommands`, game-over animations, fast travel, slow drag, drop verification, and nudge recovery remain in place.

Graveyard coordinates:

- Default I-side robot graveyard slots are now:
  - `I8: 1500,-350`
  - `I7: 5500,-350`
  - `I6: 9500,-350`
  - `I5: 13700,-350`
  - `I4: 17600,-350`
  - `I3: 21600,-350`
  - `I2: 25600,-350`
  - `I1: 29600,-350`
- The same `-350` defaults were updated in the backend and the GameBoard graveyard setup text.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical-planner` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- `where.exe arduino-cli` did not find Arduino CLI, so firmware compile/upload was not verified from the shell. Use Arduino IDE or OTA upload for `esp32_firmware.ino`.
- Planner regression now covers direct-after-removal capture, staged-first fallback, diagonal movement between occupied corner-adjacent squares, runway/capture metadata, middle-out graveyard reservation, and full-graveyard rejection.
- State regression now covers stale sensor occupancy blocking robot planning and partial robot castling failure entering a recoverable sync warning.

## 2026-07-07 Capture Start LED Timing

Change:

- The capture-start LED moment now holds for `1000ms` instead of the previous short flash.
- Backend capture motion plans include `holdMs: 1000` on `led-capture-start`.
- `esp32_firmware.ino` now honors `holdMs` for capture-start commands and defaults to `1000ms` if the field is missing.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical-planner` passed.
- Firmware compile/upload was not verified from the shell because `arduino-cli` is not installed; upload the updated sketch through Arduino IDE or OTA.

## 2026-07-08 Rook Capture Route Fix

Log finding:

- Today's final physical log ended on robot `Rxh4` (`h5h4`) after the human move `Rxh4`.
- The planner selected `capture-direct-after-removal` and chose `I8` for the captured rook.
- The captured-piece route was `h4 -> h8 -> I8`, which crossed `h5`, the attacking rook's source square.
- Firmware failed during `captured-removal` step 7 with `Motion plan source square did not become empty.`
- The failed job result's occupancy matched the intended final board shape (`h5` empty, `h4` occupied), but because the firmware reported failure the backend correctly rolled back to a recoverable sync warning. Binary sensors cannot prove which rook identity is on `h4`, so failed job results should not be auto-committed from occupancy alone.

Fix:

- Direct captured-piece removal no longer treats the attacker's source square as ignorable.
- Staged-first capture planning may treat the original attacker source as clear only after the attacker has actually moved to a staging square.
- Graveyard slot reservation now happens only after the final selected capture strategy is chosen. Previously, comparing direct and staged removal candidates could accidentally reserve an unused slot.
- Added a planner regression for the logged `h5xh4` pattern: captured-piece removal must not drag through `h5`.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical-planner` passed.
- `npm run test:physical` passed.

## 2026-07-08 Physical Undo Turn

Summary:

- Added physical-mode `Undo Turn` as a backend-authoritative undo workflow.
- Normal virtual undo/redo remains client-side and unchanged.
- Physical redo is disabled for v1.

Backend behavior:

- `physicalSession.moveLog` now stores structured physical moves with before/after FEN, side, UCI/SAN, source/target, captured square/piece, castling rook move, en-passant captured square, robot graveyard slot, and verification status.
- `physicalSession.pendingUndo` tracks active undo workflows.
- New endpoint: `POST /api/physical/undo-turn`.
- Undo is allowed only when physical mode is active, phase is `ready` or `game_over`, no robot job is pending, a move-log entry exists, and sensor occupancy matches the current backend board.
- If the latest move is robot + previous move is human, undo reverses both as one turn. If the latest move is human-only, undo reverses just that move.
- Robot non-capture undo moves the piece from `to` back to `from`.
- Robot capture undo moves the attacker back, restores the captured piece from its recorded robot graveyard slot, and frees that graveyard slot.
- Human non-capture undo uses the robot to move the human piece back when a safe route exists.
- If a human move cannot be safely routed back by the robot, such as an opening knight surrounded by starting pawns, undo enters `undo_waiting_human_restore`, highlights the current square and restore square, and waits for the user to put the piece back.
- Human capture undo uses the robot to move the human piece back when safe, then enters `undo_waiting_human_restore` and asks the user to place the captured piece back on the highlighted square. If the human piece itself cannot be routed back safely, the same manual restore fallback handles both the moved piece and the captured piece.
- If a completed undo step leaves an unrelated square missing, for example a robot-restored captured piece is later bumped or not detected while undoing the human reply, the backend now commits the completed undo step and enters `undo_waiting_human_restore` for board restoration instead of retrying the already-completed robot job.
- Castling undo builds reverse king/rook motion steps. En-passant undo follows the same captured-piece restore policy as other captures.

Client behavior:

- In physical mode, the Move Log Undo button calls `POST /api/physical/undo-turn` and is labeled `Undo Turn`.
- In physical mode, Redo is disabled.
- Physical undo busy phases use the same UI disable path as robot movement.

LED behavior:

- Undo starts by clearing stale LEDs.
- Robot undo motion uses existing motion-plan LED/runway support where the command includes it.
- Human captured-piece restore highlights the restore square until sensors match the target undo position.
- Manual human-move restore highlights the piece's current square and its original square until sensors match the target undo position.
- Residual board restore after undo highlights missing/extra squares until sensors match the target undo position.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- State regression now covers full-turn undo, blocked opening-knight manual restore, robot-capture graveyard restore, human-capture manual restore, residual board-restore mismatch handling, and stale-board undo rejection.
- No firmware upload is required for this pass.

## 2026-07-09 Physical Move Log, Centering, And Endgame LEDs

Summary:

- Physical mode Move Log now renders backend `physicalMoveLog` entries, so moves remain visible even when the app applies authoritative FEN snapshots.
- Firmware now applies a `250` step drag overshoot only for final drops onto real board squares.
- Graveyard, Z/I lane, and other off-board coordinate drops are not overshot.
- A post-robot/post-undo settle guard prevents one missing piece from being treated as an intentional lift until a clean snapshot confirms the board is centered.
- Checkmate/draw/stalemate animations now blink king squares fully off/on and use stable surrounding-square halos.

Implementation notes:

- `GameBoard.jsx` renders physical move entries from `physicalState.physicalMoveLog`; virtual mode still renders local chess.js `history`.
- `server.js` adds `postRobotSettleGuard`; robot move and final undo completion arm it and queue a forced `request-snapshot`.
- If the guard sees exactly one missing piece, the backend enters `sync_warning` with yellow restore/center LEDs instead of `piece_lifted` legal-move LEDs.
- A clean snapshot clears the settle guard and restores normal fast lift detection.
- `esp32_firmware.ino` adds `DRAG_OVERSHOOT_STEPS = 250` and applies it only when a `drag` to a board-square `index` is immediately followed by `drop`.
- Firmware fallback board-square moves also use the same overshoot; `movePieceToCoordinate` graveyard/off-board drops remain exact.
- Endgame animation halos are calculated from physical square coordinates, so they follow the actual LED/sensor layout rather than chess notation order.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- `npm run lint` in `app/client` passed with existing warnings only.
- `where.exe arduino-cli` still did not find Arduino CLI, so firmware compile/upload was not verified from the shell. Upload `esp32_firmware.ino` through Arduino IDE or OTA for the overshoot and endgame LED changes.
- State regression now covers post-robot one-piece missing detection entering `sync_warning` instead of legal-move LEDs.

## 2026-07-09 ESP32 OTA Upload Verification

Summary:

- WiFi OTA now works after one USB seed upload using an OTA-capable partition scheme.
- The firmware still advertises as `chessboard-esp32.local` on OTA port `3232`.
- The board IP during verification was `10.235.181.231`, and the laptop/server IP was `10.235.181.127`.
- Arduino CLI sees the board as a network port with `auth_upload=no`, `board=esp32s3`, and `port=3232`.

Firmware/build notes:

- `esp32_firmware.ino` now starts and services `ArduinoOTA` from the main `loop()` instead of only from the HTTP network task.
- The HTTP network task still handles snapshots, polling, and job results, but no longer owns `ArduinoOTA.handle()`.
- OTA requires an OTA-capable partition table. The verified FQBN used `PartitionScheme=min_spiffs`.
- The previous `app3M_fat9M_16MB` partition has a larger app area, but it is not the right choice for OTA because it does not provide the normal dual OTA app slots.

Verified commands:

```powershell
$cli = "C:\Users\Thejaka\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$fqbn = "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=min_spiffs,PSRAM=opi,UploadMode=default,UploadSpeed=921600,LoopCore=1,EventsCore=1"
$sketch = "C:\Users\Thejaka\Desktop\ChessProject\esp32_firmware"
$out = "C:\Users\Thejaka\Desktop\ChessProject\build\esp32_firmware_ota_min_spiffs"
New-Item -ItemType Directory -Force -Path $out | Out-Null
& $cli compile --fqbn $fqbn --output-dir $out $sketch
& $cli upload --fqbn $fqbn --port COM11 --protocol serial --input-dir $out $sketch
```

Working OTA upload command:

```powershell
$script = "C:\Users\Thejaka\AppData\Local\Arduino15\packages\esp32\hardware\esp32\3.3.8\tools\espota.py"
$bin = "C:\Users\Thejaka\Desktop\ChessProject\build\esp32_firmware_ota_min_spiffs\esp32_firmware.ino.bin"
python $script -i 10.235.181.231 -I 10.235.181.127 -p 3232 -P 3233 -f $bin -d -r -t 30
```

Important Windows note:

- `espota.exe` is blocked by existing Windows Firewall inbound rules on this machine.
- The same OTA upload succeeds through `espota.py` because `python.exe` has an inbound allow rule.
- If OTA fails later with `No response from device`, first check whether the ESP IP changed and whether Windows Firewall is blocking the uploader process.

Verification:

- OTA-capable compile passed: `Sketch uses 1095735 bytes (55%) of program storage space. Maximum is 1966080 bytes.`
- USB seed upload on `COM11` passed with hash verification.
- OTA upload through `espota.py` reached 100% and returned `Result attempt 1: 'OK'` / `Success`.
- After OTA reboot, `/api/physical/status` showed `phase: idle` and fresh `lastSnapshotAt` updates.

## 2026-07-09 Robot Castling Rook Route Fix

Log finding:

- Today's robot castling failure was black `O-O` (`e8g8`).
- The old plan moved the king `e8 -> g8`, then planned the rook from the original pre-castle board.
- Because the rook planner did not simulate the king already occupying `g8`, it compressed the rook route to a direct `h8 -> f8` drag, which crossed through the king on `g8`.
- The final sensor mismatch showed `g8` missing after the robot reported success, matching the observed king disturbance.

Fix:

- `buildCastleMotionPlan` now plans the king first, then creates a temporary board with the king on its castled destination before planning the rook.
- The rook phase now treats the castled king square as occupied and cannot route through it.
- Added a lane-to-board fallback route for blocked same-rank lane entry:
  - the piece exits to the same-rank Z/I lane slot,
  - travels along the off-board lane,
  - re-enters on a clear edge square,
  - then uses normal board pathfinding to reach the target.
- Lane-to-board routing rejects occupied re-entry squares and avoids transit through robot-owned occupied graveyard slots.
- For the logged black castling shape, the expected rook route is now `h8 -> I8 -> I6 -> h6 -> g5 -> e7 -> f8`, instead of dragging through `g8`.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical-planner` passed.
- `npm run test:physical` passed.
- Planner regression now covers the logged `e8g8` castling case and asserts the rook route does not include `g8` or occupied `h7`.

## 2026-07-09 Physical Redo Turn

Summary:

- Physical mode now supports the Move Log `Redo` button.
- Redo is backend-authoritative like undo; the player does not need to manually repeat the same move when the robot can safely replay it.
- Redo replays the latest undone turn in original order:
  - if undo removed `human move -> robot reply`, redo replays the human move first, then the robot reply;
  - if undo removed only one human move, redo replays that move.
- Normal virtual-mode redo remains unchanged.

Backend behavior:

- `physicalSession.redoStack` stores completed undo turn groups.
- `physicalSession.pendingRedo` tracks the active redo workflow.
- New endpoint: `POST /api/physical/redo-turn`.
- Redo is allowed only when physical mode is active, phase is `ready` or `game_over`, no robot job/undo/redo is pending, and sensor occupancy matches the current backend board.
- New physical phase: `redo_robot_busy`.
- Redo uses the existing robot motion planner for each replayed move, so captures, castling, lane-board fallback, overshoot, and verification all use the same safety rules as normal robot movement.
- Redo preserves original move-log sides. A redone human move is logged as `human`, even though the robot physically moves the piece.
- New normal physical moves clear the redo stack, matching standard undo/redo behavior.
- If a redone human capture is performed by the robot, the captured piece is stored in a robot graveyard slot. A later undo can restore it from that slot instead of forcing manual replacement.
- If redo final occupancy does not match expected sensors, redo pauses in a recoverable sync warning instead of continuing to the next redo step.

Client behavior:

- In physical mode, the `Redo` button now calls `POST /api/physical/redo-turn`.
- The button is enabled from backend `canRedoPhysical` and disabled during setup, robot movement, lifted-piece states, castling-pending states, sync warnings, errors, and undo restore prompts.
- Physical Move Log updates from backend `physicalMoveLog` after redo completes.

Verification:

- `node --check app/server.js` passed.
- `npm run test:physical-state` passed.
- `npm run test:physical` passed.
- `npm run build` in `app/client` passed.
- State regression now covers undoing `e2e4/e7e5`, then redoing both moves through physical redo, preserving `human` and `robot` move-log sides.

## Notes For Parallel Agents

- If Antigravity changes client source under `app/client/src`, rebuild `app/client/dist` unless using the Vite dev server.
- If Antigravity changes layout, check both the main board page and the live mentor page because they share global CSS.
- Avoid overwriting this file blindly. Append new findings or add a clearly dated section.
- If both agents edit the same source file, compare the current file before patching to avoid undoing the other agent's changes.
- Keep `codex.md` and any future `antigravity.md` factual. They should describe current repo state and completed changes, not act as instructions that override the user.

## 2026-07-14 Offline Work Revert And New Foundation

- The large offline ESP32 implementation previously documented below the 2026-07-13 sections was reverted because it destabilized online behavior. Those descriptions are historical and are not present in the current source tree.
- The active baseline is the existing server-owned physical game in `app/server.js` plus the online ESP32 executor in `esp32_firmware/esp32_firmware.ino`.
- Offline development restarted as small, independently verified milestones on branch `codex/offline-chess-foundation`.
- Firmware WiFi and server values now live in ignored `esp32_firmware/firmware_secrets.h`; the tracked example header contains placeholders.
- `tools/verify-foundation.ps1` runs backend syntax, physical regressions, client build/lint, and an OTA-capable ESP32-S3 firmware compile.
- `docs/offline-development.md` is the tracked source of truth for the current offline foundation and required physical-board acceptance gate.
- No offline engine, ownership switching, pathfinding, physical controller, persistence, or offline LED behavior has been reintroduced at this point.
- Milestone 0 was committed as `c62cc14` after backend syntax, physical regressions, client build/lint, and the OTA firmware compile passed. The manual physical-board checklist remains pending and is documented in `docs/offline-development.md`.
- Milestone 1 adds host-only `offline_core/offline_game.h/.cpp` around an unmodified vendored Disservin `chess-library` pinned to commit `57159616358c2d4c09e0d4fb1562ca7f2d36a2fb`.
- The host wrapper supports FEN load/reset, side to move, sorted legal UCI moves, SAN and physical move metadata, apply/undo, check state, terminal outcomes, and queen/rook/bishop/knight promotions.
- `npm run test:offline-rules` compiles the host runner with MinGW and compares nine positions against `chess.js`; it also checks standard/Kiwipete perft, ordinary and en-passant capture metadata, castling, promotions, invalid-input immutability, draw states, repetition, and exact undo restoration.
- `npm run test:foundation` combines the existing physical regressions with the host-only rules suite. `tools/verify-foundation.ps1` runs that combined suite plus client and firmware verification.
- The firmware, backend, and client do not include or reference `offline_core`; the firmware binary remains 1,095,735 bytes flash and 51,856 bytes static RAM.
- The full online physical-board acceptance gate passed on 2026-07-14: 33 robot jobs reported success, capture/graveyard movement and castling worked, undo/redo replay completed, and the final event was a replayed White checkmate.
- Two transient robot occupancy mismatches and two centering prompts were resolved during play; there were no error-level events or unresolved mismatch at the end.
- Undo of human capture `Rxf5` correctly paused in `undo_waiting_human_restore` and requested the captured black pawn on `f5`. The user restored it and undo completed, but the reason for the pause was not communicated clearly enough on the board. Voice/LED/status guidance for manual captured-piece restoration is explicitly deferred.

## 2026-07-14 Host-Only Physical Move Interpreter

- Added portable `offline_core/offline_physical.h/.cpp`; it is compiled only by host regressions and is not referenced by the backend, client, or ESP32 firmware.
- Physical mapping matches the online board exactly: `0=h8`, `1=h7`, `56=a1`, and `63=a8`.
- The controller accepts stable 64-square occupancy snapshots and supports human White or Black.
- Hardware-neutral phases cover ready, opponent wait, lifted piece, pending capture, pending castling rook, pending promotion, and recoverable sync warning.
- Results expose abstract events, legal targets, highlight roles, missing/extra occupancy differences, and accepted move metadata.
- Quiet moves, cancellation, ordinary captures, en passant, king-first castling, and explicit Q/R/B/N promotions are implemented.
- Promotions never infer piece identity from binary occupancy; `confirmPromotion(q/r/b/n)` is required before the rules position changes.
- Wrong-color lifts, no-legal-move lifts, illegal destinations, multi-piece disturbances, and movement during opponent wait enter `sync_warning` until the committed occupancy is restored.
- Duplicate stable snapshots are idempotent and cannot apply a move twice.
- Extended `OfflineGame` with read-only legal-move description, piece lookup, and occupied-square access; no engine/search behavior was added.
- Added `tests_and_misc/offline_physical_host.cpp`, `app/scripts/offline-physical-regression.js`, and `npm run test:offline-physical`; the suite is included in `npm run test:foundation`.
- Regressions cover all 64 mapping entries, both human colors, quiet/capture/special moves, cancellation/recovery, explicit promotions, check/checkmate outcomes, FEN, and move metadata.
- Full `tools/verify-foundation.ps1` passed. Existing online planner/state regressions passed unchanged, client build passed, lint retained eight existing warnings, and firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.
- Still deferred: setup calibration, engine search, opponent robot moves, pathfinding, graveyards, persistence, ownership switching, LED rendering, and ESP32 integration.

## 2026-07-14 Host-Only Deterministic Offline Engine

- Created branch `codex/offline-engine-foundation` from host physical interpreter commit `236cbd8`.
- Added `offline_core/offline_engine.h/.cpp`; it remains host-only and is not referenced by the backend, client, or ESP32 firmware.
- `OfflineEngine::searchFen` accepts FEN plus limits and returns the selected legal UCI move, score/mate distance, completed depth, nodes, elapsed time, principal variation, ranked root candidates, game outcome, and stop reason.
- Default limits are a hard 3,000 ms deadline and maximum depth 12. The last fully completed iterative-deepening result is retained if time expires.
- Search is deterministic with no opening book or randomness. Future controlled variation can build on the root candidates without replacing the search core.
- Search uses negamax alpha-beta, tactical quiescence, deterministic move ordering, killer/history heuristics, and a Zobrist transposition table.
- The transposition table is exactly 4,096 entries x 16 bytes = 64 KiB, protected by compile-time size assertions.
- Evaluation includes material, pawn placement/advancement, piece centralization and mobility, bishop pair, advanced rooks, and basic king safety.
- Mate scores prefer faster wins and delay unavoidable losses. Internal draw handling preserves checkmate precedence at the fifty-move boundary.
- Principal variations are tracked directly during search rather than reconstructed from collision-prone transposition entries.
- Added `tests_and_misc/offline_engine_host.cpp`, `app/scripts/offline-engine-regression.js`, and `npm run test:offline-engine`; the suite is included in `npm run test:foundation`.
- Engine regressions cover invalid/terminal positions, both colors, move legality, deterministic fixed-depth results, checks, captures, castling, en passant, promotions, mate in one/two, forced-loss delay, transposition parity, node limits, and hard timeout behavior.
- Host benchmark at 3,000 ms from the starting position completed depth 7 at about 8 million nodes and chose `b1c3`. Root moves use full-window searches so candidate scores are comparable for future controlled variation. This is not an ESP32 performance claim.
- Still deferred: engine-to-physical coordination, setup calibration, pathfinding/graveyards in C++, ownership switching, persistence, LEDs, robot execution, ESP32 linking, opening book, and near-best random variation.

## 2026-07-14 Host-Only Offline Turn Coordinator

- Created branch `codex/offline-turn-coordinator` from engine foundation commit `8a0e4ff`.
- Added portable `offline_core/offline_coordinator.h/.cpp`; it remains host-only and is not referenced by the backend, client, or ESP32 firmware.
- The coordinator connects physical human-move interpretation to engine requests without running the up-to-three-second search inside snapshot processing.
- Engine requests contain a generation, authoritative FEN, and configured limits. Stale results are rejected; an invalid current result creates a fresh generation for the same position.
- Legal engine results become `OpponentMovePlan` records containing search telemetry, move metadata, pre/post FEN, pre/post occupancy, and expected game status.
- Opponent moves are transactional: staging and execution do not modify `OfflineGame`; exact final sensor occupancy is required before commit.
- Exact pre-move occupancy makes the same move retryable, while ambiguous occupancy enters recoverable `sync_warning`. Recovery accepts either exact restoration or exact completion without rerunning search.
- Opponent promotions wait for an explicit Q/R/B/N identity confirmation matching the engine move before commit and before reopening the human turn.
- `OfflinePhysicalController` remains the single rules authority. It gained only legal opponent preview and exact-occupancy verified commit methods.
- Added `tests_and_misc/offline_coordinator_host.cpp`, `app/scripts/offline-coordinator-regression.js`, and `npm run test:offline-coordinator`; the suite is included in `npm run test:foundation`.
- Coordinator regressions cover Human White/Black, split-phase engine handoff, stale/illegal search results, special moves, promotions, retries, synchronization recovery, duplicate reports, terminal draws, checkmate, and threefold repetition.
- Full `tools/verify-foundation.ps1` passed after integration. Backend syntax, all online/offline regressions, and client build passed; lint retained the same eight warnings. Firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.
- Firmware linking, motors, pathfinding, graveyards, LEDs, offline boot switching, persistence, and reconnect ownership remain deferred.

## 2026-07-14 Host-Only Offline Integration And Soak Tests

- Created branch `codex/offline-integration-soak` from coordinator commit `e95175c`.
- Added a test-only host simulator that exercises `OfflineGame`, `OfflinePhysicalController`, `OfflineEngine`, and `OfflineTurnCoordinator` together without linking any offline code into firmware.
- The simulator alternates Human White/Black, selects deterministic legal human moves, runs the real engine with a 2,000-node limit, and converts every human move into realistic occupancy snapshots.
- A separate rules instance verifies exact FEN, occupancy, side, metadata, and outcome after every committed move. Staged opponent moves must leave authority unchanged until verified.
- Deterministic fault injection covers stale search generations, ambiguous opponent occupancy, pre-position retry, post-position completion, cancelled human lifts, wrong-piece restoration, and duplicate reports.
- Added `npm run test:offline-integration` for 12 games x 120 plies and included it in `npm run test:foundation`.
- Added `npm run test:offline-soak` for 100 games x 200 plies as an explicit milestone/debugging gate.
- Quick acceptance passed with 719 plies, 138 captures, 5 castling moves, 3 en-passant moves, and 7 promotions.
- Extended soak passed with 7,952 plies, 1,257 captures, 42 castling moves, 4 en-passant moves, 54 promotions, 96 checkmates, and 2 repetition draws.
- No coordinator defect was found and no host-only production source required modification.
- The next milestone is the host-only physical route-planner boundary. Firmware linking remains deferred until that milestone is independently accepted.

## 2026-07-14 Host-Only Board Route Planner

- Created branch `codex/offline-route-foundation` from integration/soak commit `2b0c9dc`.
- Added portable `offline_core/offline_route.h/.cpp`; it remains host-only and is not referenced by the backend, client, ESP32 firmware, physical interpreter, or turn coordinator.
- The planner accepts source/target squares, expected occupancy, optional sensed occupancy, ignored squares, and the verified direct-pawn-route option.
- Results contain status/blocked reason, route mode, cost, raw square path, and compressed drag waypoints.
- Behavior matches the current online JavaScript planner: occupancy OR merge, source/target/ignored clearing, clear chess-line preference, buffered then relaxed A*, 10/14 step costs, 10-point occupied-neighbor penalty, allowed diagonal corner-adjacent passage, deterministic JavaScript tie order, and same-direction waypoint compression.
- Added a quiet `MoveInfo` convenience method. Captures, castling, en passant, and promotions are rejected because their physical choreography is intentionally deferred.
- Exported the existing `buildBoardTransferPlan` only through the server test module boundary; no online runtime behavior changed.
- Added `tests_and_misc/offline_route_host.cpp`, `app/scripts/offline-route-regression.js`, and `npm run test:offline-route`; the suite is included in `npm run test:foundation`.
- Exact parity passed for 16 shared fixtures, including sensed occupancy merging and deterministic reruns. C++ route invariants also passed across 256 deterministic randomized safety cases.
- `npm run test:offline-soak` and the complete `npm run test:foundation` passed with all earlier behavior unchanged.
- `tools/verify-foundation.ps1` passed: client build succeeded, lint retained the same eight existing warnings, and firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.
- Board-only failure returns `NoBoardPath`. Z/I lanes, graveyards, capture/castling choreography, LEDs, firmware motion commands, and coordinator integration remain deferred to later isolated milestones.

## 2026-07-14 Host-Only Z/I Lane And Graveyard Routing

- Created branch `codex/offline-lane-graveyard-foundation` from board-route commit `4d2c732`.
- Added portable `offline_core/offline_external_route.h/.cpp`; it remains host-only and is not connected to backend runtime, client, firmware, the physical interpreter, or the turn coordinator.
- Added the current Z1-Z8 and I1-I8 coordinates, slot normalization, square/coordinate targets, board-first transfers, forced lane routing, lane-board re-entry, and graveyard-removal previews.
- Transfer decisions and costs match the online JavaScript planner, including preferred/opposite lane selection, occupied-slot handling, sensed occupancy, and blocked-transit behavior.
- Graveyard scoring matches online path cost, crowding x12, middle-out rank order, I-side 0.5 offset, candidate ordering, and failure details.
- Added explicit support for a piece already on its edge exit square; it moves directly to the external graveyard coordinate with a zero-length board path.
- Offline planning is transaction-safe: preview does not reserve a slot. Pure reserve/release helpers are called only after future hardware verification and are idempotent.
- Added `npm run test:offline-external-route` and included it in `npm run test:foundation`.
- Exact C++/JavaScript parity passed across 22 fixtures. The accepted board-route suite and 100-game/7,952-ply soak also remained green.
- Final `tools/verify-foundation.ps1` passed; client lint retained the same eight warnings and firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.
- Complete capture/castling choreography, coordinator integration, LEDs, motor commands, firmware linking, persistence, and online/offline switching remain deferred.

## 2026-07-14 Host-Only Capture And Castling Choreography

- Created branch `codex/offline-motion-choreography` from external-route commit `7e46155`.
- Added portable `offline_core/offline_motion.h/.cpp`; it remains host-only and is not referenced by backend runtime, client, firmware, the physical interpreter, or the turn coordinator.
- `OfflineMotionPlanner::planMove` validates a legal UCI move and returns deterministic abstract phases, route metadata, strategy/rejection details, proposed graveyard slot, and exact occupancy before and after every phase.
- Quiet moves reuse the external transfer planner. Captures preserve online direct-removal, stage-first, remove-first board/lane, and final board-staging order. En passant uses the actual captured-pawn square.
- Graveyard selection remains transactional: planning proposes a slot and never mutates occupied-slot state.
- Castling plans king first and rook second against the intermediate occupancy for White/Black kingside/queenside moves, including lane-board rook recovery.
- Illegal moves and promotions are rejected without mutating the game. Promotion motion remains deferred.
- Fixed the online deepest capture fallback to use and reserve `fallbackRemoval` consistently instead of referencing undefined `removal`; added a direct regression for that latent branch.
- Added `npm run test:offline-motion` and included it in `npm run test:foundation`.
- Exact C++/JavaScript parity passed across 20 fixtures, including sensed occupancy, direct/staged/fallback captures, capture lane routing, en passant, full/blocked graveyards, all castling directions, crowded rook lane re-entry, phase occupancy, deterministic repetition, and immutable inputs.
- The 100-game/7,952-ply soak, complete foundation suite, client build, and `tools/verify-foundation.ps1` passed. Lint retained the same eight warnings.
- Firmware remains unchanged at 1,095,735 bytes flash and 51,856 bytes static RAM.
- Next milestone: host-only coordinator-to-motion execution transactions and pending/verified graveyard state. Motors, LEDs, firmware integration, persistence, promotions, and online/offline switching remain deferred.

## 2026-07-14 Host-Only Motion Execution Transactions

- Created branch `codex/offline-motion-execution` from motion choreography commit `4568927`.
- Connected `OfflineTurnCoordinator` to `OfflineMotionPlanner`; the physical controller remains the sole authoritative owner of rules state.
- Added stable-sensor validation before planning, ranked root candidate routing, strongest-routable fallback, and deterministic route-cost tie-breaking within five centipawns. Mate rank always wins over route convenience.
- Added `MotionExecutionTransaction` with transaction/generation IDs, preferred and selected moves, engine score, fallback reason, complete phase plan, rejected candidates, verified-phase progress, and graveyard state.
- Added phase reports and recovery behavior. Only a successful report matching the exact expected phase occupancy advances; stale/out-of-order reports are rejected, duplicates are idempotent, unchanged failures retry, and ambiguous occupancy enters recoverable sync warning.
- Added transactional graveyard states: selected captures are `Pending`, verified captured removals become `Occupied`, and restored captured pieces require explicit unsensored-slot release confirmation before retry.
- Preserved `completeOpponentExecution` as an atomic compatibility adapter. Chess FEN/history never changes during intermediate phases and commits only after final verification.
- Opponent promotions now stop explicitly in `OpponentMotionBlocked` with `UnsupportedPromotion`; human promotion support remains unchanged. Promotion choreography is the next milestone.
- Added `npm run test:offline-motion-execution` and included it in `npm run test:foundation`.
- Updated coordinator and integration regressions for physical routing. The soak records clean deferred opponent-promotion stops instead of treating them as generic failures.
- Acceptance passed: 100 games, 6,429 committed plies, 1,110 captures, 32 castlings, 7 en-passant moves, 17 completed human promotions, and 16 explicit deferred opponent-promotion stops.
- `npm run test:foundation` and `tools/verify-foundation.ps1` passed. Client build passed, lint retained eight existing warnings, and firmware remained 1,095,735 bytes flash / 51,856 bytes static RAM.
- Backend runtime, client, and firmware contain no references to the host-only coordinator or motion layer.
- Still deferred: opponent promotion choreography, firmware phase-report integration, motors, LEDs, persistence, undo/redo motion transactions, and automatic online/offline ownership switching.

## 2026-07-14 Client Lint Cleanup

- Created branch `codex/client-lint-cleanup` from motion-execution commit `2ca9d5e`.
- Split the socket context object and `useSocket` hook into dedicated modules so `SocketContext.jsx` exports only `SocketProvider` and satisfies React Fast Refresh boundaries.
- Stabilized Live Mentor microphone, playback, visualization, logging, and move-context callbacks with complete dependencies.
- Live Mentor now keeps the latest socket and chess game in refs, allowing one stable socket-listener subscription instead of resubscribing after every move.
- Moved stateless PCM, engine-context, and game-phase helpers outside the component. Unmount cleanup now has complete dependencies, and expected disconnect/illegal-move catches no longer declare unused variables.
- Reordered Game Board drop/click callbacks, stabilized checked-king lookup, and removed the mutable `gameRef.current.history().length` memo dependency because `fen` is the position-change signal.
- Cached-engine fallback and redo replay failures now log their stale/corrupt move details instead of being silently swallowed.
- Client `npm run lint` passes with zero warnings and zero errors; `npm run build` passes.
- Complete `npm run test:foundation` passes with all online physical and host-only offline regressions unchanged.
- Browser smoke checks passed for page rendering, click-to-move, engine reply, virtual undo/redo, drag-to-move, and Live Mentor route loading with no browser errors.
- Live Gemini/microphone start-stop was not exercised because API access and microphone permission are conditional external checks.
- Backend, firmware, and `offline_core` were not changed. The next offline milestone remains opponent promotion choreography.

## 2026-07-14 Host-Only Opponent Promotion Choreography

- Created branch `codex/offline-promotion-choreography` from lint-clean commit `4dbcd20`.
- Legal White/Black Q/R/B/N promotions now pass through `OfflineMotionPlanner`; quiet promotions reuse quiet transfer and capture promotions reuse captured-removal plus attacker-final choreography.
- `UnsupportedPromotion` remains in the public motion status enum for compatibility but is no longer returned for a legal, routable promotion.
- Promotion candidates now participate in normal strongest-routable engine selection and deterministic route-cost tie-breaking.
- After all pawn-motion phases verify, the coordinator enters `OpponentPromotionPending`; FEN, side, history, and outcome remain unchanged until identity confirmation.
- Added `processOpponentPromotionSnapshot`: an empty target means replacement in progress, exact expected occupancy is confirmation-ready, and unrelated changes enter recoverable sync warning.
- Added occupancy-aware `confirmOpponentPromotion(piece, occupancy)`. It commits only for exact expected occupancy and the engine-selected Q/R/B/N identity. The trusted one-argument compatibility form remains.
- Capture-promotion graveyard slots still transition `Pending -> Occupied` after verified removal and remain occupied while piece replacement is pending.
- Atomic completion now enters promotion pending instead of bypassing identity confirmation; stale and duplicate phase/snapshot/confirmation reports remain idempotent.
- Regressions cover all four identities for both colors, quiet and capture promotion, blocked routes, replacement recovery, wrong identity/occupancy, graveyard state, atomic completion, and promotion check/checkmate/stalemate outcomes.
- The integration simulator now completes opponent promotion transactions instead of stopping at `OpponentMotionBlocked`; forced scenarios exercise Q/R/B/N.
- The deterministic 100-game soak passed 6,758 plies, 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and 45 opponent promotions with no unresolved transaction.
- `npm run test:foundation` and `tools/verify-foundation.ps1` passed. Client lint has zero warnings/errors, client build passed, and firmware remains exactly 1,095,735 bytes flash / 51,856 bytes static RAM.
- No backend runtime, client, or firmware source was changed or linked to this host-only work.
- Still deferred: firmware phase-report integration, physical promotion prompts through LEDs/voice, motors, persistence, promotion undo/redo, and automatic online/offline ownership switching.

## 2026-07-14 USB-Only Firmware Baseline

- Confirmed the final OTA-capable baseline before removal: 1,095,735 bytes flash and 51,856 bytes static RAM with `min_spiffs`.
- Removed `ArduinoOTA`, mDNS, UDP, OTA configuration/state/callbacks, and OTA interruption branches from polling, motion, and homing.
- WiFi HTTP snapshots, polling, commands, and robot job results are unchanged; OTA was not used by those features.
- Magnet GPIO setup now drives LOW before serial startup delay or other firmware initialization.
- Firmware verification now uses `PartitionScheme=app3M_fat9M_16MB`, shown in Arduino IDE as `16M Flash (3MB APP/9.9MB FATFS)`.
- The new USB-only baseline is exactly 1,042,543 bytes flash and 47,128 bytes static RAM, with a maximum application size of 3,145,728 bytes.
- All future uploads use the USB COM port. Upload only while the gantry is idle and the electromagnet is off.
- Uploaded the USB-only image to the ESP32-S3 on COM11. The board booted, posted a sensor snapshot to the backend, and consumed a queued magnet-off diagnostic command. A physical move was not rerun because the board was not calibrated/filled during this check; automated planner/state regressions passed.

## 2026-07-14 Embedded Offline Resource Gate

- Continued on branch `codex/offline-embedded-resource-gate`; the OTA removal is isolated in commit `14ad7ba`.
- Added `ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS`, default `0`. The disabled production build remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM.
- Added an Arduino library boundary under `offline_core/src/` that links rules, engine, physical interpreter, coordinator, board/external routing, and motion choreography only when diagnostics are enabled. Host builds remain on their existing source path.
- Added the embedded-only `CHESS_EMBEDDED_PSRAM_TABLES` path to the pinned chess library. The 819,200-byte rook table and 41,984-byte bishop table are allocated and initialized in PSRAM after `setup()` verifies PSRAM.
- Also moved the 32,768-byte squares-between table to explicit PSRAM initialization. Its upstream eager initializer used a 32 KiB stack temporary and caused an early ESP32-S3 stack failure; the embedded path now initializes it without that temporary while the host path is unchanged.
- Added a one-shot idle-priority diagnostic task on core 0. The sensor/hardware loop stays on core 1 and HTTP polling stays active at higher priority on core 0.
- Diagnostic firmware rejects all queued motion, guards the executor itself, and continuously drives the magnet LOW. It still scans sensors, posts snapshots, polls the backend, and applies non-motion commands.
- Structured diagnostic output uses `[OFFLINE_DIAG]` JSON through the USB serial/JTAG console. It covers rules, engine, physical snapshots, coordinator transactions, routes, graveyard selection, capture, en passant, castling, and all promotion plumbing.
- Added `tools/verify-offline-embedded.ps1`. It compiles both variants, enforces the exact production baseline, checks diagnostic app headroom, optionally uploads/parses the physical report, and restores production firmware in a `finally` block.
- `tools/verify-foundation.ps1` now verifies both firmware variants in addition to backend, host regressions, client build, and zero-warning lint.
- Final diagnostic compile: 1,240,207 bytes flash / 51,248 bytes static RAM, leaving 1,905,521 bytes of the 3 MiB app partition free.
- Final guarded COM11 diagnostic passed with 150,824 bytes free internal heap, a 139,252-byte largest internal block, 7,431,636 bytes free PSRAM, 22,412 bytes task-stack headroom, a 2 ms maximum sensor gap across 4,826 scans, and 49 successful HTTP polls during search.
- Three-second ESP32 searches completed in 3,000 ms (opening, depth 4, 17,216 nodes) and 3,005 ms (middlegame, depth 1, 18,624 nodes). The 250 ms middlegame case returned a legal deterministic fallback before completing depth 1, which is valid deadline behavior.
- The 100-game soak passed 6,758 plies, 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and all injected recoveries.
- `npm run test:foundation`, client build/lint, and the complete foundation verifier pass. The USB-only production image was restored to the board after diagnostics.
- Still deferred: runtime offline ownership, boot-time server detection, actual offline sensor/game loop, motor phase adapter, offline LEDs/prompts, persistence/reconnect handoff, and offline undo/redo.

## 2026-07-15 Offline Runtime Ownership Diagnostics

- Created branch `codex/offline-runtime-ownership` from resource-gate commit `f32f587` after the USB-only online baseline completed a full physical game with 12 verified robot replies, checkmate, and no motion/synchronization errors.
- Added portable `OfflineOwnershipManager` states: `BootProbe`, `OnlineOwned`, `OnlinePaused`, `OfflineIdle`, `ReconnectPending`, and `RecoveryRequired`.
- Defaults are a 10-second boot probe, one-second heartbeat and HTTP read/connect timeout, three failures to declare outage, and two successes to reconnect. Idle adoption also requires the remote heartbeat to report `safeToSwitch`. Tests cover flapping, timer wraparound, in-flight motion, same-session resume, identity/generation rejection, remote transition safety, idle hot restart, and next-turn offline handoff signaling.
- Added read-only `GET /api/physical/heartbeat` with protocol version, process-unique server ID, physical-session generation, phase, session-active state, and transition safety. Generation increments only when a new physical game starts.
- Added independent `ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS=0`. The enabled build scans sensors and probes heartbeats but cannot consume or execute movement, continuously holds the magnet LOW, emits `[OWNERSHIP_DIAG]` JSON, and shows ownership status on the board corners.
- Added `tools/verify-offline-ownership.ps1`; it verifies both builds, telemetry, motor lock, task placement, heartbeat latency, sensor timing, and synthetic state transitions, then restores production in `finally`. The full foundation verifier includes its compile gate.
- Live testing exposed two issues and added regressions: an idle backend hot restart was initially treated like an active-game identity mismatch, and ESP32 HTTP connect establishment ignored the read timeout. Idle restart now requires two new-server heartbeats, active games remain locked to their original identity, and `setConnectTimeout(1000)` is enforced separately.
- Real outage test passed: three failed probes took about 1,003 ms each and entered `OfflineIdle`; backend restart then produced `ReconnectPending -> OnlineOwned` after two successes.
- Ownership diagnostic compile is 1,037,391 bytes flash / 47,200 bytes static RAM with 2,108,337 bytes app headroom. Its final COM11 run recorded 2,409 sensor scans, a 10 ms maximum sensor gap, and 42 ms maximum live heartbeat time.
- Resource diagnostic compile with the ownership smoke is 1,244,715 bytes flash / 51,248 bytes static RAM with 1,901,013 bytes app headroom.
- Embedded resource diagnostics were rerun with the ownership smoke: 151,308 bytes internal heap, 139,252-byte largest block, 7,433,348 bytes free PSRAM, 22,396 bytes stack headroom, 2 ms maximum sensor gap, and 50 successful polls. All checks passed.
- The 100-game soak, `npm run test:foundation`, client build/zero-warning lint, `tools/verify-foundation.ps1`, ownership hardware verifier, and resource hardware verifier passed.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM and was restored to COM11 after every diagnostic run.
- Offline gameplay is still disabled. Next milestone: read-only wiring from stable sensor snapshots into the offline coordinator, producing engine/motion plans without moving pieces.

## 2026-07-15 Embedded Read-Only Offline Runtime Diagnostics

- Created branch `codex/offline-readonly-runtime` from ownership commit `5219e5a`.
- Added portable `OfflineReadOnlyRuntime` with setup, human-turn, split engine-search, frozen plan, synchronization, handoff, game-over, and error states.
- Exact standard occupancy must remain stable for 500 ms before the default Human White session arms. Setup differences, duplicate snapshots, lift cancellation, stale sensor state, and synchronization recovery are deterministic and host-tested.
- The runtime commits one verified human move, requests the accepted three-second/depth-12 engine search, and stages the strongest routable opponent motion plan through `OfflineTurnCoordinator`.
- It freezes at `PlanReady`. Opponent execution cannot begin, no phase can verify, no graveyard proposal becomes occupied, and FEN/history/side remain exactly at the post-human position.
- Added `ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS=0`, mutually exclusive with ownership/resource diagnostics. The enabled build links the full offline core, initializes chess tables in PSRAM, consumes synchronized full-board sensor snapshots, and keeps heartbeat activity alive during search.
- Sensor scanning remains on core 1. Ownership heartbeat runs on core 0 priority 1; runtime/search runs on core 0 priority 0.
- Runtime diagnostics block normal command polling and every motion boundary, continuously force the magnet LOW, and emit structured `[OFFLINE_RUNTIME_DIAG]` setup, move, search, route, phase, timing, resource, and safety telemetry.
- Added `npm run test:offline-runtime`, included it in `test:foundation`, and added `tools/verify-offline-runtime.ps1`. The USB verifier restores production firmware in `finally` even after failure or timeout.
- Host runtime regressions, the complete foundation suite, 100-game/6,758-ply soak, client build, and zero-warning lint passed.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM. Runtime diagnostic is 1,256,919 / 51,536 with 1,888,809 bytes app headroom. Resource diagnostic with runtime smoke is 1,260,343 / 51,248. Ownership diagnostic is 1,037,847 / 47,232.
- The updated COM11 resource diagnostic passed with the runtime preview, 151,468 bytes free internal heap, 139,252-byte largest block, 7,433,348 bytes free PSRAM, 22,208 bytes stack headroom, 2 ms maximum sensor gap, and 49 successful HTTP polls.
- The shared ownership diagnostic passed on COM11 with 2,408 sensor scans, 11 ms maximum sensor gap, two successful heartbeats, and 44 ms maximum heartbeat latency.
- The final guarded COM11 runtime run accepted physical `g2g4`, searched exactly 3,000 ms to depth 3/18,688 nodes, selected `d7d5`, and emitted one complete quiet-transfer phase while leaving the opponent move uncommitted.
- A transient sensed-occupancy mismatch after search correctly entered `SyncWarning`, then reused the same result and reached `PlanReady` when occupancy stabilized. This exercised real recovery rather than failing the diagnostic.
- Runtime hardware metrics: 1,501 sensor scans and three heartbeat attempts during search, 2 ms maximum sensor gap, 133,340 bytes free internal heap, 106,484-byte largest block, 7,430,464 bytes free PSRAM, and 26,704 bytes stack headroom.
- Every safety/resource check passed: plan frozen, motors unchanged, magnet LOW, search deadline met, and `opponentMoveCommitted=false`. Production firmware was restored automatically.
- The read-only runtime milestone is accepted. Next milestone: motor-locked simulated phase execution. Real motors, gameplay LEDs, persistence, handoff transfer, offline undo/redo, and production switching remain deferred.

## 2026-07-15 Motor-Locked Offline Phase Execution Adapter

- Created branch `codex/offline-phase-execution-adapter` from read-only runtime commit `3df26bc`.
- Added portable `offline_core/offline_phase_execution.h/.cpp` between `OfflineReadOnlyRuntime` and future hardware execution.
- Each issued request carries transaction ID, phase index, and attempt number. Reports cannot skip/reorder phases; stale attempts are rejected, accepted duplicates are idempotent, and unchanged failures retry with a new attempt token.
- Exact successful after-occupancy advances one phase. Ambiguous occupancy enters recoverable warning, and after-occupancy without an explicit success report does not verify a failed phase.
- Coordinator authority is unchanged: FEN/history commit only after the final phase, capture slots remain `Pending -> Occupied`, restored graveyard pieces require explicit release confirmation, and Q/R/B/N promotions require matching occupancy and identity.
- Added narrow friend access from the adapter to the read-only runtime. Existing public coordinator access stays const, and `PlanReady` remains frozen unless execution is explicitly activated.
- Added `npm run test:offline-phase-execution` and included it in `test:foundation`. Regressions cover quiet moves, retries/tokens, mismatch recovery, captures/graveyards, en passant, all castling directions, promotions, game over, deterministic repetition, and the unchanged preview boundary.
- Added default-off, mutually exclusive `ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS` and linked the adapter through the Arduino library only for relevant diagnostics.
- The ESP32 phase diagnostic accepts one real human move, searches/plans the reply, injects one exact unchanged failure, verifies the incremented retry, simulates all remaining phase reports, commits internally, compares real versus synthetic occupancy, and freezes.
- Synthetic occupancy never reaches the sensor mailbox or ownership safety. Polling, homing, queueing, and execution remain blocked; motors stay unchanged and the magnet is forced LOW.
- Added `[OFFLINE_PHASE_DIAG]` token/report/retry/graveyard/promotion/FEN/resource telemetry and `tools/verify-offline-phase-execution.ps1`. The verifier can upload over USB, parse the run, and always restore production in `finally`.
- Updated the embedded resource diagnostic with an adapter transaction smoke and added the phase compile gate to `tools/verify-foundation.ps1`.
- Dedicated regressions, the complete foundation verifier, client build, zero-warning lint, and the 100-game/6,758-ply soak pass.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Phase diagnostics compile at 1,286,427 / 51,536 with 1,859,301 bytes app headroom. Resource diagnostics compile at 1,282,727 / 51,248.
- The guarded COM11 run passed with physical `g1f3` and simulated reply `d7d5`. Search completed in 3,011 ms at depth 4/19,392 nodes; phase attempt 1 failed unchanged as designed, attempt 2 succeeded, and the exact previewed FEN committed internally while the real board remained unchanged.
- Hardware safety/resource results: motors unchanged, magnet LOW, commands blocked, 2 ms maximum sensor gap, 1,506 search-time sensor scans, three heartbeat attempts, 131,136 bytes free internal heap, 106,484-byte largest block, 7,430,464 bytes free PSRAM, and 17,528 bytes stack headroom. All assertions passed and production firmware was restored automatically.
- Next milestone: guarded real-motion mapping for one quiet phase only. Captures, multi-phase physical execution, gameplay LEDs, persistence, state handoff, offline undo/redo, and production switching remain deferred.

## 2026-07-15 Guarded Real Quiet-Move Diagnostic

- Created branch `codex/offline-quiet-motion-diagnostic` from phase-adapter commit `a7c2b75`.
- Added portable `OfflineQuietMotionCompiler`. It accepts one ordinary board-only `QuietTransfer` and emits `Travel`, `Pickup`, compressed `Drag`, `Drop`, and `Verify` primitives.
- Only the final on-board drag is marked for the existing 250-step compensation. Intermediate compressed waypoints, lanes, external coordinates, and graveyards never receive overshoot.
- The compiler rejects captures, en passant, castling, promotions, Z/I routes, graveyard state, malformed paths, occupied routes, and incorrect occupancy checkpoints. Inputs remain immutable and repeated compilation is deterministic.
- Added `npm run test:offline-quiet-motion` and included it in `test:foundation`. Regressions cover pawn moves, long lines, multi-segment board routes, raw mapping, deterministic compilation, retry limits, stale/duplicate reports, and every deferred move type.
- Added default-off, mutually exclusive `ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS` and `tools/verify-offline-quiet-motion.ps1`.
- Diagnostic homing is separate from the unbounded online function: each axis has a 20-second approach timeout, debounced switch validation, bounded release checks, active sensor scans, magnet LOW, and logical-zero assignment only after both axes pass.
- Core 0 owns runtime/search/planning; core 1 alone executes guarded home or quiet-program mailbox jobs. HTTP movement, diagnostics movement, normal queue execution, and normal homing remain blocked.
- Magnet HIGH is authorized only during pickup/drag. Every success, failure, timeout, task exit, and outside-loop path forces LOW. Final occupancy must exactly match before phase success can commit the opponent move; no nudge is used.
- One unchanged-board failure can retry with the adapter's incremented token. A second failure or any ambiguous occupancy freezes safely.
- Added a diagnostic-only USB JSON mutex after a successful physical run exposed interleaved ownership-heartbeat and quiet-summary output. Production excludes this lock.
- Automated acceptance passes: focused regression, full foundation suite, 100-game/6,758-ply soak, client build, zero-warning lint, and all firmware compile gates.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Final quiet diagnostics compile at 1,305,695 / 51,952 with 1,840,033 bytes app headroom.
- Guarded COM11 acceptance passed: bounded home, physical `g1f3`, 3,003 ms depth-4/19,392-node search, robot `d7d5`, exact sensor verification, FEN commit, and automatic production restore.
- A preceding physical run exercised the one-retry rule: unchanged attempt 1 produced an incremented token and attempt 2 succeeded. The final verifier run completed on attempt 1.
- Final hardware metrics: 5 ms maximum sensor gap, 1,502 search-time sensor scans, three search-time heartbeat attempts, 130,544 bytes free internal heap, 104,436-byte largest block, 7,430,496 bytes free PSRAM, and 16,808 bytes stack headroom. Magnet was LOW at completion.
- Full Serial evidence is retained locally at `tmp/offline-quiet-motion-hardware-2026-07-15.log`; production firmware is currently restored on COM11.
- Still deferred: captures, castling, en passant, promotions, Z/I lanes, graveyards, gameplay LEDs, persistence, reconnect transfer, offline undo/redo, and production automatic switching.

## 2026-07-15 Guarded Real Offline Capture Diagnostic

- Created branch `codex/offline-capture-motion-diagnostic` from accepted quiet-motion commit `48e3c10`.
- Added portable `OfflineCaptureMotionCompiler` for the controlled `CapturedRemoval -> AttackerFinal` transaction. Removal emits board travel, pickup, compressed board drag, external-coordinate drag, drop, and verify; attacker final reuses the accepted board-only quiet compiler.
- Graveyard/off-board motion never receives overshoot. Exactly the attacker final board drag receives the existing 250-step compensation.
- Compiler guards exact occupancy transitions, route/path metadata, finite coordinates, phase kind, pending/occupied graveyard state, and matching slot key. It rejects staging, en passant, castling, promotion, attacker lane routing, malformed routes, and unsupported phases.
- The legal fixture is White king `e1`, White rook `e2`, Black king `a8`, and Black pawn `d5`. Human `e2e4` (`Re4`) produces deterministic engine reply `d5e4`, rook removal `e4 -> h4 -> I4` at `(17600, -350)`, pawn final `d5 -> e4`, and FEN `k7/8/8/8/4p3/8/8/4K3 w - - 0 2`.
- The original planned black king on `e8` was corrected to `a8`: the rook on `e2` already attacks `e8`, so the original White-to-move FEN was illegal. The correction leaves the capture choreography unchanged.
- Added `ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS=0`, mutually exclusive with every prior firmware diagnostic. It reuses bounded homing, sensor mailbox, heartbeat, PSRAM rules/engine, planner, phase adapter, speed profiles, and guarded core-1 execution.
- Normal polling/movement and unbounded homing remain blocked. Magnet HIGH is authorized only during compiled pickup/drag and is forced LOW after all success, failure, timeout, abort, and exit paths.
- Runtime execution requires exact `d5e4`, direct-after-removal, I4, and two phases. I4 changes `Pending -> Occupied` only after verified removal; chess state commits only after verified attacker final. Each phase permits at most one unchanged-board retry. Ambiguous occupancy freezes in synchronization warning; no nudge is used.
- Added `npm run test:offline-capture-motion`, included it in `test:foundation`, and added `tools/verify-offline-capture-motion.ps1` with optional USB upload, Serial validation, and production restoration in `finally`.
- Automated gates pass: focused capture tests, full foundation suite, 100-game/6,758-ply soak, client build, zero-warning lint, and every firmware compile configuration.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Final capture diagnostics compile at 1,315,931 / 52,032 with 1,829,797 bytes app headroom.
- Physical USB acceptance passed on COM11: bounded home, physical `e2e4`, 3,000 ms depth-7/45,824-node search, deterministic `d5e4`, real rook removal through `e4 -> h4 -> I4`, real pawn transfer `d5 -> e4`, two verified phase tokens, exact final occupancy/FEN commit, and magnet LOW.
- Final hardware metrics: 5 ms maximum sensor gap, 1,501 search-time sensor scans, three search-time heartbeat attempts, 138,884 bytes free internal heap, 86,004-byte largest internal block, 7,430,464 bytes free PSRAM, and 19,464 bytes stack headroom. Production firmware was automatically restored and Serial evidence is at `tmp/offline-capture-motion-hardware-2026-07-15.log`.
- Two preliminary mechanically successful runs exposed diagnostic-only retained plan/state/update copies. Their lifetimes were narrowed before resource measurement, resolving the heap thresholds without changing production behavior. A strict-mode log parser assumption found after the final run was also fixed by checking optional event fields before access; the saved passing telemetry validates cleanly.
- Still deferred: generalized/staged captures, en passant, castling, promotions, arbitrary lane transit, gameplay LEDs, graveyard persistence, reconnect transfer, offline undo/redo, and production switching.

## 2026-07-15 Guarded Real Offline Staged-Capture Diagnostic

- Created branch `codex/offline-staged-capture-motion-diagnostic` from accepted direct-capture commit `93c185a`.
- Extended `OfflineCaptureMotionCompiler` for board-only `AttackerStage` and staged `AttackerFinal`, while preserving direct capture behavior.
- Staging and attacker-final drops use the existing final board-square overshoot. Captured removal and I4 remain exact, with no off-board overshoot.
- Added the exact fixture `k7/8/8/8/8/8/1NPPbP2/2B2n1K w - - 0 1`: human `b2d1`, deterministic engine `e2d1`, strategy `capture-stage-first-board`, staging `e1`, and I4 `(17600, -350)`.
- Expected phases are bishop `e2 -> e1`, knight `d1 -> e2 -> f3 -> g4 -> h4 -> I4` with compressed board waypoints `d1 -> g4 -> h4`, then bishop `e1 -> d1`.
- Final FEN is `k7/8/8/8/8/8/2PP1P2/2Bb1n1K w - - 0 2`.
- Added host coverage for exact planning, compilation, primitive order, phase occupancy, retries, stale/duplicate tokens, ambiguous recovery, transactional `Pending -> Occupied` graveyard state, and FEN immutability until final verification.
- Added default-off `ENABLE_OFFLINE_STAGED_CAPTURE_MOTION_DIAGNOSTICS` and `tools/verify-offline-staged-capture-motion.ps1`. The diagnostic reuses accepted bounded homing, sensors, heartbeat, engine, coordinator, phase adapter, guarded execution, and production restoration.
- Direct and staged focused regressions pass. The complete host foundation suite and 100-game/6,758-ply soak pass.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Staged diagnostics compile at 1,316,795 / 52,032 with 1,828,933 bytes app headroom; the existing direct diagnostic still compiles at 1,316,631 / 52,032.
- Physical COM11 acceptance passed on 2026-07-16: bounded home, physical `b2d1`, 3,004 ms depth-5/32,832-node search, deterministic `e2d1`, real bishop staging `e2 -> e1`, real knight removal `d1 -> g4 -> h4 -> I4`, and real bishop final `e1 -> d1`.
- All three phase tokens verified on attempt one. I4 changed `Pending -> Occupied`, exact occupancy matched, final FEN `k7/8/8/8/8/8/2PP1P2/2Bb1n1K w - - 0 2` committed, and the magnet ended LOW.
- Hardware metrics: 5 ms maximum sensor gap, 1,502 search-time sensor scans, three search-time heartbeat attempts, 143,436 bytes free internal heap, 81,908-byte largest internal block, 7,432,264 bytes free PSRAM, and 18,416 bytes stack headroom.
- Every verifier assertion passed. Production firmware was restored automatically and Serial evidence is at `tmp/offline-staged-capture-motion-hardware-2026-07-16.log`.
- The staged-capture milestone is accepted. Next: arbitrary active-piece Z/I lane motion. En passant, castling, promotions, gameplay LEDs, persistence, reconnect transfer, offline undo/redo, and production switching remain deferred.

## 2026-07-16 Guarded Real Offline Z/I Lane-Motion Diagnostic

- Created branch `codex/offline-lane-motion-diagnostic` from accepted staged-capture commit `de482de`.
- Added portable `OfflineLaneMotionCompiler` for `Lane` and `LaneBoard` transfers. It emits `TravelBoard`, `Pickup`, `DragCoordinate`, `DragBoard`, `Drop`, and `Verify`.
- Quiet transfers are supported now. Ordinary `AttackerStage` and `AttackerFinal` lane phases are validated for future capture reuse.
- Only the final board destination receives the existing 250-step overshoot. External coordinates, lane entry points, and intermediate board waypoints do not.
- The compiler rejects captured removal, castling, en passant, promotion, graveyard phases, malformed paths, non-finite coordinates, mixed Z/I segments, occupied targets, and incorrect occupancy transitions.
- Corrected direct-lane safety in both C++ and the online JavaScript parity reference: exit and entry must form a complete same-side Z/Z or I/I pair. A direct Z-to-I segment is never allowed to cross the board.
- Added deterministic fixtures:
  - DirectLane: human `h2g2`, engine `d5e3#`, route `d5 -> Z5 -> Z3 -> e3`, mode/cost `lane / 1300`.
  - LaneBoard: human `h2g2`, engine `d5e3#`, external `Z5 -> Z3`, then compressed board route `a3 -> a2 -> b1 -> c1 -> e3`, mode/cost `lane-board / 1366`.
- Added `npm run test:offline-lane-motion`, included it in `test:foundation`, and added C++/JavaScript parity coverage for the same-side route rule.
- Added default-off `ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS`, fixture selection, guarded motion execution, structured `[OFFLINE_LANE_MOTION_DIAG]` telemetry, and `tools/verify-offline-lane-motion.ps1`.
- Normal command motion, normal homing, gameplay LEDs, and nudge recovery remain blocked. Exact before/final occupancy is mandatory, magnet authorization is limited to pickup/drag, and one unchanged-board retry is allowed.
- Automated acceptance passes: focused lane tests, external-route parity, online physical planner regressions, motion/capture regressions, complete foundation suite, client build, zero-warning lint, and the 100-game/6,758-ply soak.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. DirectLane compiles at 1,310,195 / 52,000 and LaneBoard at 1,310,239 / 52,000.
- Every prior firmware diagnostic compile gate remains green.
- Physical COM11 acceptance passed for both fixtures on 2026-07-16.
- DirectLane executed `d5 -> Z5 -> Z3 -> e3`, matched exact occupancy, committed checkmate, required no retry/recovery, and ended with the magnet LOW. Metrics: 5 ms maximum sensor gap, 134,148 bytes free internal heap, 106,484-byte largest block, 7,432,264 bytes free PSRAM, and 15,488 bytes stack headroom.
- LaneBoard executed `d5 -> Z5 -> Z3 -> a3 -> a2 -> b1 -> c1 -> e3` with exact `lane-board / 1366` metadata. Only the final `e3` drag received overshoot. Exact occupancy/FEN committed without retry/recovery and the magnet ended LOW. Metrics: 5 ms maximum sensor gap, 130,888 bytes free internal heap, 102,388-byte largest block, 7,432,264 bytes free PSRAM, and 15,488 bytes stack headroom.
- Every route, primitive, same-side-lane, occupancy, resource, and safety assertion passed. Serial evidence is at `tmp/offline-lane-direct-hardware-2026-07-16.log` and `tmp/offline-lane-board-hardware-2026-07-16.log`.
- Production firmware was restored automatically after both runs and COM11 remains healthy. The lane-motion milestone is accepted.
- Still deferred: generalized capture-attacker lane execution, en passant, castling, promotions, gameplay LEDs, continuous offline play, persistence, reconnect transfer, offline undo/redo, and production automatic switching.

## 2026-07-16 Guarded Real Offline Capture With Lane Routing

- Created branch `codex/offline-capture-lane-motion-diagnostic` from accepted lane-motion commit `6cd62b9`.
- Extended `OfflineCaptureMotionCompiler` so ordinary `AttackerStage` and `AttackerFinal` phases can consume accepted `Lane` and `LaneBoard` routes through `OfflineLaneMotionCompiler`.
- Existing direct and staged board-only capture output remains unchanged. Capture programs now retain route targets for diagnostics and guarded execution.
- Converted lane phases use the existing capture primitive representation: `TravelBoard`, `Pickup`, `DragCoordinate`, `DragBoard`, `Drop`, and `Verify`.
- Only the final board-square drag receives the 250-step overshoot. Graveyard drops, Z/I coordinates, lane entry points, and intermediate board waypoints never overshoot.
- Added exact host fixture:
  - initial FEN `k7/8/8/3n4/pppppppp/4P3/4NN1R/4BKR1 w - - 0 1`;
  - human `h2g2` (`Rhg2`);
  - engine `d5e3` (`Nxe3#`);
  - `capture-direct-after-removal`, total cost `1952`;
  - pawn removal `e3 -> d2 -> a2 -> Z2`, cost `652`, Z2 `(24800, 34450)`;
  - knight final `d5 -> Z5 -> Z3 -> e3`, cost `1300`;
  - final FEN `k7/8/8/8/pppppppp/4n3/4NNR1/4BKR1 w - - 0 2`.
- Added `npm run test:offline-capture-lane-motion` and included it in `test:foundation`.
- Host regressions cover the exact transaction, checkmate, primitive order, Z2 `Pending -> Occupied`, immutable chess state before final verification, stale/duplicate/out-of-order reports, one retry, third-attempt refusal, partial occupancy, stranded attacker recovery, malformed lane routes, and synthetic Lane/LaneBoard attacker stage/final requests.
- Added default-off `ENABLE_OFFLINE_CAPTURE_LANE_MOTION_DIAGNOSTICS` and `tools/verify-offline-capture-lane-motion.ps1`.
- The diagnostic reuses bounded homing, ownership heartbeat, engine/coordinator planning, sensor mailbox, guarded capture executor, phase tokens, resource telemetry, and automatic production restoration.
- Automated acceptance passes the focused and legacy capture/lane suites, complete foundation verifier, 100-game/6,758-ply soak, client build, zero-warning lint, and every firmware compile gate.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. The capture-lane diagnostic compiles at 1,328,463 / 52,048 with 1,817,265 bytes app headroom.
- Physical COM11 acceptance passed:
  - bounded homing succeeded;
  - setup recovered from a temporarily undetected `g4` pawn;
  - physical `h2g2` was accepted;
  - engine selected `d5e3#` in 71 ms at depth 1 / 600 nodes;
  - robot moved the pawn `e3 -> d2 -> a2 -> Z2`;
  - Z2 changed `Pending -> Occupied`;
  - robot moved the knight `d5 -> Z5 -> Z3 -> e3`;
  - both phase tokens verified on attempt one;
  - exact occupancy and checkmate FEN committed;
  - magnet ended LOW and production firmware restored automatically.
- Hardware metrics: 5 ms maximum sensor gap, 37 search-time sensor scans, 143,388 bytes free internal heap, 83,956-byte largest internal block, 7,432,264 bytes free PSRAM, and 18,384 bytes stack headroom.
- Serial evidence is at `tmp/offline-capture-lane-motion-hardware-2026-07-16.log`.
- Firmware verifier scripts must run sequentially; parallel `arduino-cli` runs can mix cached objects built with different diagnostic flags.
- The capture-with-lane milestone is accepted. Next: guarded real en passant.
- Still deferred: castling, promotion replacement, gameplay LEDs, continuous offline play, persistence, reconnect transfer, offline undo/redo, and production automatic switching.

## 2026-07-16 Guarded Real Offline En Passant Diagnostic

- Created branch `codex/offline-en-passant-motion-diagnostic` from accepted capture-lane commit `d0a33d3`.
- Extended `OfflineCaptureMotionCompiler` and `OfflineLaneMotionCompiler` to accept legal, non-promotion en passant metadata.
- Captured removal now uses `MoveInfo::capturedSquare`, while attacker final moves from `MoveInfo::from` to the empty `MoveInfo::to` destination.
- En passant attacker stage/final supports board, `Lane`, and `LaneBoard` routes. Ordinary capture output remains unchanged.
- Added strict pawn-geometry, UCI, captured-square, occupancy, route, and graveyard validation. Castling, promotion, malformed metadata, and invalid transitions remain rejected.
- Only the attacking pawn's final board drop receives 250-step overshoot. I4, graveyard travel, lane coordinates, and intermediate board waypoints never overshoot.
- Added exact fixture:
  - initial FEN `k7/3N4/1K6/8/3p4/3P4/4P3/8 w - - 0 1`;
  - human `e2e4`;
  - only legal Black move `d4e3` (`dxe3 e.p.`);
  - victim `e4 -> h4 -> I4`, cost `554.5`, I4 `(17600, -350)`;
  - attacker `d4 -> e3`, cost `14`;
  - total cost `568.5`;
  - final FEN `k7/3N4/1K6/8/8/3Pp3/8/8 w - - 0 2`.
- Added `npm run test:offline-en-passant-motion`, included it in `test:foundation`, and added default-off `ENABLE_OFFLINE_EN_PASSANT_MOTION_DIAGNOSTICS`.
- Added `tools/verify-offline-en-passant-motion.ps1` with guarded COM11 execution, telemetry validation, and production restoration in `finally`.
- Host regressions cover direct, staged, Lane, and LaneBoard en passant; exact phase occupancy; I4 `Pending -> Occupied`; retries; token handling; partial removal; stranded attacker; malformed metadata; and FEN immutability before final verification.
- Automated acceptance passes the focused and legacy capture/lane suites, complete foundation verifier, 100-game/6,758-ply soak, client build, zero-warning lint, and all firmware compile gates.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. The diagnostic compiles at 1,328,979 / 52,048 with 1,816,749 bytes app headroom.
- Physical COM11 acceptance passed on 2026-07-17: bounded homing succeeded, the fixture stabilized, and physical `e2e4` was accepted.
- The engine selected the only legal reply `d4e3` after a 3,001 ms depth-9 / 37,056-node search.
- The robot moved the victim `e4 -> h4 -> I4` without off-board overshoot, changed I4 `Pending -> Occupied`, then moved the attacker `d4 -> e3` with final board overshoot.
- Both phases verified on attempt one. Exact occupancy matched, FEN `k7/3N4/1K6/8/8/3Pp3/8/8 w - - 0 2` committed, and the magnet ended LOW.
- Hardware metrics: 4 ms maximum sensor gap, 1,501 search-time sensor scans, three search-time heartbeat attempts, 143,916 bytes free internal heap, 75,764-byte largest internal block, 7,432,264 bytes free PSRAM, and 19,576 bytes stack headroom.
- Every verifier assertion passed and production firmware restored automatically. Serial evidence is at `tmp/offline-en-passant-motion-hardware-2026-07-17-rerun.log`.
- Preliminary safe failures were a stale fixture setup timeout and a bounded X-home timeout while gantry power was off. Neither moved a chess piece; both left the magnet LOW and restored production.
- The en-passant milestone is accepted. Castling is next. Promotion replacement, gameplay LEDs, continuous offline play, persistence, reconnect transfer, offline undo/redo, and production switching remain deferred.

## 2026-07-17 Guarded Real Offline Castling Diagnostic

- Created branch `codex/offline-castling-motion-diagnostic` from accepted en-passant commit `35f51cd`.
- Added portable `OfflineCastlingMotionCompiler` for ordered `CastleKing` and `CastleRook` phases using existing board, `Lane`, and `LaneBoard` primitives.
- Both king and rook receive 250-step compensation only on their final board drops. External and intermediate route points never overshoot.
- Castling is transactional: king verification opens the rook phase, each phase has an independent two-attempt limit, and FEN/history commit only after both phases verify.
- Corrected rook-phase planning to ignore stale sensed occupancy at the king's original square. Expected post-king occupancy remains authoritative; unrelated sensed obstructions are still respected. Applied the same narrow correction to the online JavaScript parity reference.
- Added exact fixture: initial FEN `4k2r/8/8/8/8/8/P3P1P1/4RKR1 w k - 0 1`, human `a2a3`, engine `e8g8` (`O-O#`), king `e8 -> g8`, rook `h8 -> g7 -> f8`, total cost `68`, final FEN `5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2`.
- Added `npm run test:offline-castling-motion`, included it in `test:foundation`, and covered all four castling directions, board/Lane/LaneBoard routes, retries, report ordering, ambiguous recovery, malformed metadata, and state immutability.
- Added default-off `ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS` and `tools/verify-offline-castling-motion.ps1` with guarded COM11 execution and production restoration in `finally`.
- Automated gates passed: focused and parity regressions, 100-game/6,838-ply soak, full foundation verifier, client build, zero-warning lint, and every firmware compile gate.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Castling diagnostics compile at 1,326,527 / 52,048 with 1,819,201 bytes app headroom.
- Physical COM11 acceptance passed: bounded home, physical `a2a3`, 9 ms depth-1/17-node search, real king `e8 -> g8`, real rook `h8 -> g7 -> f8`, two verified phase tokens, exact final occupancy/checkmate FEN, and magnet LOW.
- Hardware metrics: 5 ms maximum sensor gap, 130,704 bytes free internal heap, 106,484-byte largest internal block, 7,432,264 bytes free PSRAM, 15,520 bytes stack headroom, and 80 heartbeat attempts.
- Production firmware restored automatically. Serial evidence is at `tmp/offline-castling-motion/hardware-acceptance.log`.
- The castling milestone is accepted. Next special-move hardware gate: manual Q/R/B/N promotion replacement. Gameplay LEDs, continuous offline play, persistence, reconnect transfer, offline undo/redo, and production switching remain deferred.

## 2026-07-17 Guarded Real Offline Promotion Replacement Diagnostic

- Created branch `codex/offline-promotion-motion-diagnostic` from accepted castling commit `069cb93`.
- Added portable `OfflinePromotionMotionCompiler` for legal White/Black Q/R/B/N quiet and capture promotions. It preserves five-character promotion UCI/metadata while reusing accepted quiet, capture, Lane, and LaneBoard compilation.
- Only the pawn's final board drop receives the existing 250-step compensation. Graveyard drops, external coordinates, and intermediate waypoints never overshoot.
- Added `OfflinePromotionReplacementGate`: promotion remains uncommitted until the target sensor observes occupied -> empty -> occupied and the requested identity is confirmed. Confirmation before lift, wrong identity, and unrelated board changes are rejected/recoverable.
- Added exact fixture: initial FEN `4k3/8/8/8/8/8/p7/4K3 w - - 0 1`, human `e1f2`, engine `a2a1q`, direct `a2 -> a1`, manual Black queen replacement, final FEN `4k3/8/8/8/8/8/5K2/q7 w - - 0 2`.
- Added `npm run test:offline-promotion-motion`, included it in `test:foundation`, and added host coverage for both colors, Q/R/B/N, quiet/capture promotions, board/Lane/LaneBoard routes, graveyard transactions, retries, tokens, disturbances, replacement ordering, and FEN immutability before confirmation.
- Added default-off `ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS` and `tools/verify-offline-promotion-motion.ps1` with compile-only and guarded COM11 modes, 180-second replacement timeout, Serial validation, and production restoration in `finally`.
- Automated gates pass: focused tests, full foundation verifier, 100-game/6,838-ply soak, client build, zero-warning lint, and every firmware compile gate.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. Promotion diagnostics compile at 1,346,019 / 52,048 with 1,799,709 bytes app headroom.
- Physical COM11 acceptance passed: bounded home, recovered setup from an off-center `a2` pawn, physical `e1f2`, 3,000 ms depth-7/43,072-node search, deterministic `a2a1q`, real pawn `a2 -> a1`, observed empty-then-occupied replacement, automatic `q` confirmation, and exact final FEN commit.
- Motion verified on attempt one. No motion occurred during replacement, maximum sensor gap was 4 ms, all resource thresholds passed, the magnet ended LOW, and production firmware restored automatically.
- Hardware metrics: 133,164 bytes free internal heap, 114,676-byte largest internal block, 7,430,496 bytes free PSRAM, and 18,404 bytes stack headroom. Serial evidence is at ignored `logs/offline-promotion-motion-acceptance.log`.
- The promotion-replacement hardware gate is accepted. Human physical promotion, online promotion, gameplay LEDs, continuous offline play, persistence, reconnect transfer, offline undo/redo, and production switching remain deferred.

## 2026-07-17 Guarded Unified Three-Turn Offline Gameplay Diagnostic

- Created branch `codex/offline-unified-turn-diagnostic` from accepted promotion commit `e421b21`.
- Added portable `OfflineUnifiedMotionCompiler`, dispatching promotion, castling, capture/en-passant, lane, and quiet phases into one normalized `CaptureMotionProgram` representation.
- Preserved phase tokens, exact occupancy checkpoints, route/graveyard metadata, final-board-only 250-step compensation, deterministic output, and the two-attempt phase limit.
- Added `OfflinePhaseExecutionAdapter::openNextHumanTurn`: exact committed occupancy reopens `HumanTurn`; mismatch remains frozen with a diff; duplicates are idempotent; game over cannot reopen. Firmware enforces 500 ms stability before calling it.
- Added host coverage for all compiler families, normalized primitives, three Human White turns, three Human Black boundaries, retries, duplicate/mismatched boundaries, game over, promotion non-commit before replacement, and graveyard occupancy retained across consecutive captures.
- Added `npm run test:offline-unified-turn` and included it in `test:foundation`.
- Added default-off `ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS`, standard starting FEN, Human White, three-second/depth-12 searches, persistent graveyard state, accepted promotion replacement, guarded phase execution, and `[OFFLINE_UNIFIED_TURN_DIAG]` telemetry.
- The diagnostic blocks normal HTTP/diagnostic motion and gameplay LEDs, uses bounded homing, verifies every phase before/after state, permits only one exact-before retry, forces magnet LOW on every exit/error, and freezes after reopening the third verified human-turn boundary.
- Added `tools/verify-offline-unified-turn.ps1`; compile-only and optional COM11 modes validate Serial transactions/resources and restore production in `finally`.
- Automated gates pass: focused unified regression, 100-game/6,838-ply soak, complete foundation suite/verifier, client build, zero-warning lint, every prior firmware compile gate, and unified production/diagnostic builds.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes RAM. After captured-removal verification hardening, unified diagnostics compile at 1,362,855 / 52,048 with 1,782,873 bytes app headroom.
- Guarded COM11 runs verified bounded homing, standard setup, three accepted human moves/searches, two complete robot commits/turn boundaries, route fallback, magnet shutdown, and automatic production restoration. The third planned reply `f8d6` caught on a torn board sticker twice; safety correctly refused the commit and the user accepted this as an external mechanical defect. The strict third-reply counter therefore remains incomplete rather than a clean hardware pass.
- An exploratory `e2e4 d5xe4` capture exposed premature graveyard confirmation when the pawn paused at `h5` before `I5`. Captured-removal success now requires 500 ms of continuously stable expected occupancy before the slot becomes occupied; quiet moves and no-overshoot graveyard behavior are unchanged. Evidence is in ignored `logs/offline-unified-turn-acceptance*.log` files, and production is restored.
- Still deferred: standalone gameplay feedback and human-promotion selection, continuous full-game operation, persistence, reconnect transfer, offline undo/redo, and production automatic switching.

## 2026-07-17 LED Data-Signal Diagnostic

- Created branch `codex/led-flicker-diagnostic` from accepted unified-turn commit `01b2d1f`.
- Added `tests_and_misc/esp32_led_flicker_diag` and `tools/verify-led-flicker.ps1` without changing production firmware behavior.
- The focused test lights all 64 squares / 256 LEDs in a fixed blue-orange checkerboard and sends the identical buffer every 100 ms in mirrored order: core 1, core 0, core 0, core 1.
- All four phases run for 30 seconds with WiFi connected, motors locked off, and the magnet continuously LOW.
- Guarded COM11 verification passed automated checks: core 1 sent 300/300 frames, core 0 sent 298/298 frames, every phase ran on its requested core, and production restored automatically.
- Visual flickering remained intermittent across the equal comparison. Flexing the LED data wire could deliberately produce severe corruption, and normal online checkmate animation also flickered.
- Conclusion: the defect is not specific to offline mode or one ESP32 core. Evidence points to the physical data wire/connection or marginal NeoPixel signal integrity.
- No runtime LED workaround was added. Deferred hardware checks are wire replacement/retermination, solder inspection, short paired data/ground routing, a 330-470 ohm series resistor near the first LED, and a 74AHCT125 level shifter if the LEDs are powered at 5 V.
- Production remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM. The comparison build is 878,279 / 44,728.
- The issue is documented and accepted as non-blocking for the next offline milestone.

## 2026-07-17 Temporary LED Index Calibration

- Created branch `codex/led-index-calibration` for a temporary physical LED-order mapping tool.
- Added backend endpoints to select one of 256 LEDs, clear the strip, and poll a revisioned latest-state value. UI/API numbers are 1-256; firmware pixel indices remain 0-255.
- Added `LED Index Calibration` controls under Gantry Diagnostics: previous, next, direct numeric selection, and clear. Advancing clears the prior LED and lights exactly one new LED.
- Added standalone sketch `tests_and_misc/esp32_led_index_calibration/esp32_led_index_calibration.ino`. It polls the backend over WiFi, updates the strip only when the selected revision changes, disables all motor outputs, and continuously holds the magnet LOW.
- Added `tools/verify-led-index-calibration.ps1` with `Compile`, `Upload`, and `Restore` actions. `Upload` deliberately leaves calibration firmware active; `Restore` reinstalls production firmware.
- Verification passed: backend syntax/API smoke checks, invalid-index rejection, zero-warning client lint, client build, exact production baseline `1,042,543 / 47,128`, and calibration build `1,022,639 / 46,640`.
- Calibration firmware was uploaded through COM11 and LED 1 was selected as the initial mapping point. Production must be restored after the physical mapping is complete.
- The user completed and confirmed the one-pixel-at-a-time physical map. Exact square traversal and row-specific 2x2 offsets are recorded in `docs/led-layout.md`.
- Existing whole-square lighting remains correct because every raw square owns `rawSquareIndex * 4` through `+3`. The selected offline text renderer uses these 64 whole-square groups as an 8x8 display; the distinct C/H per-LED orientations remain documented only for possible future 16x16 effects.

## 2026-07-17 Offline LED Feedback And Human Promotion Selection

- Created branch `codex/offline-led-promotion-feedback` from `3dbef41`.
- Added portable `OfflineLedRenderer` with an 8x8 logical square grid backed by a complete 256-LED RGB frame. Every cell paints all four LEDs under one chess square identically, so within-square pixel ordering is irrelevant. It includes whole-square roles, centered 3x5 short status labels, and 5x7 Q/R/B/N glyphs.
- Host tests prove all 64 grid cells map uniquely, preserve conventional board orientation, and never split a square's four LEDs. Added deterministic feedback for setup, legal quiet/capture/special moves, AI thinking, robot execution, sync recovery, check, checkmate, draw, promotion, OK, wait, and error. Brightness remains 40.
- Added `OfflineHumanPromotionSelector`: remove the pawn, cycle Q/R/B/N every 2.5 seconds, latch the first replacement occupancy, require 500 ms stability, support temporary re-lift, clean cancellation, sync-warning recovery, and `millis()` wraparound.
- Added `HumanPromotionRequest` through the physical controller/coordinator and a real runtime `HumanPromotionPending` phase. Human promotion remains uncommitted until explicit Q/R/B/N confirmation, then emits exact SAN/FEN/game state and an engine request.
- Added default-off `ENABLE_OFFLINE_LED_PROMOTION_DIAGNOSTICS`. Core 0 publishes complete frames through a synchronized mailbox; core 1 exclusively calls `strip.show()`. The guarded build blocks homing/commands/motors and holds the magnet LOW.
- Added `npm run test:offline-led-feedback`, included it in `test:foundation`, and added `tools/verify-offline-led-promotion.ps1` with a five-minute COM11 interaction gate and production restoration in `finally`.
- Automated gates pass: LED/promotion regressions, full foundation suite/verifier, 100-game/6,838-ply soak, client build, zero-warning lint, and all firmware compile gates.
- Production remains exactly `1,042,543 / 47,128`. The final square-grid diagnostic is `1,260,323 / 52,968` with `1,885,405` bytes application headroom.
- First physical attempt exposed and fixed a false handoff during a lifted-piece boundary while ownership was still `OfflineIdle`. A real reconnect/handoff/recovery still freezes safely.
- Second attempt reached exact setup, `HumanTurn`, and detected the `a7` lift, but `a8` never reported occupied. The verifier timed out and restored production. Physical acceptance remains pending an `a8` sensor/placement retest; it is not claimed as passed. Evidence: ignored `logs/offline-led-promotion-acceptance.log`.
- Deferred: continuous full-game operation, production ownership switching, persistence, reconnect transfer, offline undo/redo, voice prompts, and online promotion.

## 2026-07-19 Mentor Foundation Milestone 1: Persistent Text Mentor

- Preserved the unaccepted offline LED/promotion work as WIP commit `f0f0b4b` on `codex/offline-led-promotion-feedback`; the mentor branch does not contain that checkpoint.
- Created `codex/mentor-foundation` from clean commit `3dbef41`.
- Added a namespaced `app/mentor/` backend with a `node:sqlite` storage adapter, idempotent migrations, persistent conversations/messages, deterministic first-message titles, search, rename/delete, deletion cascades, and startup recovery of interrupted streams.
- Added request-ID idempotency and a 24,000-character recent-context cap. Complete history remains stored even when older content is omitted from a Gemini prompt.
- Added streaming `gemini-3.5-flash` text through isolated Socket.IO conversation rooms. Streaming starts, ordered deltas, completion, cancellation, and failures are persisted and broadcast independently per chat.
- Added REST interfaces under `/api/mentor/conversations` for conversation CRUD and message submission. The database and WAL files live under ignored `app/data/mentor.sqlite*`.
- Added desktop-only `/mentor-v2` alongside the unchanged `/mentor` Live Voice route. The new route has a permanent 280px history sidebar, search/date groups, rename/delete, streamed central chat, pinned composer, deterministic learning suggestions, and a fixed 480px read-only workspace placeholder.
- Added `npm run test:mentor-foundation` covering migration/restart persistence, CRUD, search, cascade deletion, stream recovery, duplicate request IDs, ordered deltas, cancellation, mocked Gemini errors, reconnect persistence, and Socket.IO subscription isolation.
- Verification passed: mentor regressions, `node --check server.js`, client lint with zero warnings, client production build, physical regressions, and the complete existing `npm run test:foundation` suite.
- `node:sqlite` emits Node 24's expected experimental warning; storage behavior is covered by restart regressions and remains behind the mentor storage adapter.
- Milestone 2 remains next: persistent per-conversation chess sessions, backend move/FEN validation, revision conflicts, board-event reconstruction, and an interactive right-side workspace.

## 2026-07-19 Mentor Foundation Milestone 2: Authoritative Chess Workspace

- Added a second SQLite migration for one `mentor_chess_sessions` row per conversation and an ordered `mentor_board_events` timeline. Existing Milestone 1 conversations are backfilled with independent standard positions.
- Added `MentorChessService` as the authoritative rules boundary. It reconstructs each board from `initialFen` plus validated events with `chess.js`; stored FEN/PGN values are treated as checked caches.
- Added revisioned board APIs for legal UCI moves, validated FEN loading, reset, and orientation. Every mutation requires `expectedRevision`; stale clients receive HTTP `409`, `stale_revision`, and the current authoritative state.
- Added client action IDs and idempotent board events. Concurrent actions cannot both commit at one revision, and `mentor-board-updated` is isolated to the conversation room.
- Conversation detail now includes FEN, PGN, orientation, revision, turn, complete move history, legal UCI moves, game status, and board-event timeline. Check, checkmate, stalemate, insufficient-material, repetition, and fifty-move outcomes are represented explicitly.
- Gemini text prompts now include the current conversation board's FEN, PGN, turn, game status, and recent SAN moves. Gemini still has no board-control tools and is instructed not to claim it moved pieces.
- Replaced the right-side preview with an interactive square board, backend-committed move list, turn/result status, flip, reset, and validated FEN dialog. One optimistic move may be previewed; stale or illegal results roll back to server state.
- Added reconnect-safe chat subscription acknowledgment plus REST reconciliation polling, closing a race where a very fast stream could finish before a newly navigated client joined its Socket.IO room.
- Added `npm run test:mentor-chess`, `test:mentor-browser`, and aggregate `test:mentor`. Browser checks use local Playwright Core plus Edge at 1440x900 and 1920x1080.
- Automated verification passed: mentor storage/stream/socket regressions, chess/restart/API/socket regressions, both Playwright desktop workflows, zero-warning client lint, client production build, backend syntax checks, physical regressions, and the full existing foundation suite.
- Playwright verified chat creation, streaming, history reload/search/rename/delete, fixed 280/480px side columns, square board sizing, legal moves, stale rollback, FEN/reset, and separate board restoration per chat. `/` and legacy `/mentor` still render at both desktop sizes; legacy voice code was not modified.
- A real `gemini-3.5-flash` streaming smoke call succeeded with the configured local API key. Automated tests remain deterministic and do not consume Gemini quota.
- Persistent data is stored in ignored `app/data/mentor.sqlite*`. Node 24 still prints the expected experimental warning for `node:sqlite`.
- Deferred as planned: Gemini board-control tools, openings/puzzles/practice workflows, rolling summaries, explicit import from normal/physical games, voice migration, progress tracking, and physical-board observation/execution.

## 2026-07-20 Gemini Mentor Board-Control Tools

- Created `codex/mentor-board-tools` from clean mentor-foundation commit `62f1cd5`.
- Pinned `@google/genai` to exact version `1.44.0` and moved mentor generation to `ai.chats.create()` with manual function responses. Streaming text is preserved before, between, and after tool calls, including Gemini thought-signature context retained by the SDK chat session.
- Added seven conversation-bound tools: `get_board_state`, `play_move`, `play_line`, `load_position`, `reset_board`, `set_orientation`, and `annotate_board`. Gemini cannot select another conversation or supply authoritative revisions/action IDs.
- Tool execution is limited to 8 model/tool rounds and 12 calls per user request. Calls returned together are executed sequentially so revision-dependent board mutations remain deterministic.
- `play_line` prevalidates up to 24 plies before changing the board, commits one move per second, and stops future moves on cancellation or revision conflict without rolling back completed moves.
- Added SQLite migration v3 for persistent `mentor_tool_calls` and revision-bound `mentor_board_annotations`. Interrupted pending/running calls become failed on restart; completed chess actions are never replayed. Duplicate client request IDs reuse the existing assistant/tool records.
- All mutations still pass through `MentorChessService`. Illegal moves, invalid FENs, game-over moves, malformed/unknown tools, stale revisions, and annotation-limit violations return structured side-effect-free results to Gemini.
- Added semantic board annotations with maximums of 16 highlighted squares and 12 arrows: `idea` blue, `good` green, `warning` amber, `danger` red, and `special` purple. Moves, loads, and resets clear annotations; orientation changes preserve them.
- Added Socket.IO lifecycle events for tool start, progress, completion, failure, and cancellation. Conversation detail groups persisted tool calls with the assistant message that caused them.
- `/mentor-v2` now shows compact live/persisted tool cards, controlled arrows and square highlights, 350 ms board animation, and authoritative move-by-move demonstration updates. Manual board input and toolbar mutations are locked while a mentor request is active.
- The existing Stop command aborts Gemini generation, pending delays, and future tool actions while preserving already committed board changes. Legacy `/mentor`, `/`, normal/physical games, and firmware remain isolated.
- Added `npm run test:mentor-tools` and expanded deterministic Playwright coverage for paced line demonstrations, tool progress, persisted annotations/tool history, control locking, cancellation, reload, and desktop layouts at 1440x900 and 1920x1080.
- Verification passed: aggregate mentor regressions, real `gemini-3.5-flash` function-call smoke, zero-warning client lint, client production build, backend syntax, full physical/offline foundation suite, and complete firmware verifier matrix.
- Production firmware remains byte-identical at `1,042,543` bytes flash and `47,128` bytes static RAM. No firmware or physical-board runtime source changed.
- Deferred: Stockfish-grounded mentor analysis, structured openings/puzzles/practice modes, tool-action undo, learner progress, voice migration, normal-game import, and physical-board execution.

## 2026-07-20 Mentor Rollout And Theme Unification

- Created `codex/mentor-rollout-theme` from accepted mentor-tools commit `4c0ed52`.
- Promoted the persistent text-and-board workspace to `/mentor` and `/mentor/:conversationId`.
- Moved the unchanged legacy Live Voice page to `/mentor-live`.
- Added backward-compatible redirects from `/mentor-v2` and `/mentor-v2/:conversationId`; conversation IDs are preserved and redirects do not create duplicate chats.
- Updated the normal board's `Open Mentor Page` entry point and copy to describe interactive lessons, analysis, and board demonstrations. Mentor history navigation now uses the primary `/mentor/:conversationId` URLs, and the sidebar retains a direct link to `/mentor-live`.
- Extended the shared application tokens with reusable page, panel, input, hover, and special-role surfaces. The mentor now inherits the app's blue/slate background, borders, text, blue accent, semantic status colors, and `Outfit` typography instead of maintaining an olive palette.
- Matched mentor chessboard squares to the normal board at dark `#1e293b` and light `#e2e8f0`. Semantic annotation colors remain blue/green/amber/red/purple.
- Preserved the 280px history sidebar, flexible conversation column, 480px board workspace, tool cards, streaming, cancellation, board locking, persistence, and Gemini tool behavior.
- Expanded Playwright coverage to enter through the real game-page button, test primary and legacy routes, preserve conversations across v2 redirects, verify companion/voice links, compare computed shared tokens and board colors, and wait for each new chat's route/socket subscription before interaction.
- Visual inspection passed at 1440x900 and 1920x1080 with no overlap, overflow, board distortion, or contrast issue.
- Verification passed: aggregate mentor regressions, zero-warning client lint, client production build, backend syntax, physical regressions, and the complete foundation suite.
- No backend mentor schema, physical-board, offline-core, or firmware source changed.

## 2026-07-20 Stockfish-Grounded Mentor Analysis

- Created `codex/mentor-stockfish-analysis` from accepted rollout/theme commit `021e0eb`.
- Added a mentor-only persistent Stockfish 18 UCI service. It starts lazily, uses one thread, 32 MB hash, WDL output, up to three principal variations, and a serialized queue capped at eight waiting jobs.
- Mentor search uses predictable wall-clock limits: `quick` is 1,000 ms and `deep` is 3,000 ms. Move assessment divides that total between source-position and resulting-position searches.
- The worker parses centipawn/mate scores, WDL, depth, selective depth, nodes, NPS, elapsed time, best move, and UCI/SAN principal variations. Scores and WDL are normalized to White while retaining side-to-move values.
- Cancellation sends UCI `stop`, drains the final `bestmove`, and advances the queue safely. Engine crashes and watchdog timeouts fail only the current job and restart Stockfish lazily for the next analysis.
- Added internal Gemini tools `analyze_position` and `analyze_move`. Neither accepts a conversation ID or FEN; both bind to the authoritative conversation board and reject stale revisions without board mutations.
- `analyze_position` returns the current evaluation, WDL, best move, telemetry, and up to three ranked lines. Terminal positions with no legal move are rejected cleanly.
- `analyze_move` assesses the latest committed move when UCI is omitted, or a legal uncommitted candidate when UCI is supplied. It returns before/after evaluation, best alternative, centipawn loss or mate impact, and `forced`, `best`, `good`, `inaccuracy`, `mistake`, or `blunder` classification.
- Classification thresholds are 15/50/100/250 centipawns. Missing or allowing forced mate overrides centipawn bands as a blunder; preserving a forced mate is handled explicitly.
- Updated Gemini's system instruction to require Stockfish evidence before objective best-move, evaluation, tactical, or move-quality claims and to distinguish engine evidence from teaching explanation.
- Analysis calls/results use the existing persistent `mentor_tool_calls` records; no SQLite migration was required. Duplicate request/provider IDs reuse completed results and never rerun Stockfish.
- Added structured position and move-analysis cards with evaluation, WDL, top lines, classifications, best alternatives, depth, nodes, and timing.
- Added an orientation-aware evaluation bar beside the mentor board. It is neutral before analysis, uses only the latest completed result whose FEN exactly matches the current board, clears on position change, survives reload, and remains valid through board flips.
- Added `npm run test:mentor-engine` and included it in `npm run test:mentor`. Regressions cover UCI parsing, MultiPV, WDL/mate normalization, SAN conversion, queueing, pressure limits, cancellation, timeout, crash recovery, legal real-engine output, classifications, stale positions, candidate immutability, persistence, and duplicate execution.
- Playwright now covers persisted analysis cards, current-FEN evaluation display, invalidation after a move, orientation, latest-move assessment, and cancellation of a deep search at 1440x900 and 1920x1080. Screenshots are written under ignored `app/tmp/mentor-analysis-*.png` and were visually inspected without overlap or clipping.
- Verification passed: aggregate mentor suite, zero-warning client lint, production client build, `node --check server.js`, and the complete physical/offline `npm run test:foundation` suite.
- A real configured `gemini-3.5-flash` smoke request called `analyze_position`, consumed a real Stockfish result, and completed a grounded natural-language answer.
- Existing `/api/evaluate`, `/api/engine-move`, normal games, physical-board planning, offline core, legacy `/mentor-live`, and firmware were not changed.
- Deferred: full-game review, opening databases, generated puzzle curriculum, learner scoring/progress, voice integration, normal/physical game import, and physical-board mentor execution.

## 2026-07-20 Mentor Chat Scrolling And Tool-Loop Follow-Up

- Investigated conversation `d418728b-8fbc-4a5a-8611-ef97e8ebb0d1`. The first puzzle completed, while follow-up request `4f17a98b-936f-4d03-9308-5b678be386d5` executed eight successful board/Stockfish tools and then left an empty failed assistant message.
- Root cause: the provider allowed eight tool-bearing model rounds but did not reserve the required ninth model turn for Gemini to consume the eighth tool result and produce final text. The loop now permits that final text-only turn while still limiting executable tool rounds to eight and total tool calls to twelve.
- Tightened the mentor instruction so a puzzle/example chooses and validates one position instead of repeatedly replacing the board unless a tool reports an invalid position.
- Added structured `[MENTOR_RESPONSE_FAILED]` backend logging with conversation ID, request ID, assistant-message ID, error, and stack trace. Future provider failures are visible in the server output instead of only becoming an empty failed message in SQLite.
- Replaced unconditional `scrollIntoView` calls on every streamed delta with a chat-owned scroll container. Streaming follows only while the reader is near the bottom; scrolling upward holds the reader's position and exposes an icon button to jump back to the latest message.
- Added visible thin scrollbars for chat, conversation history, and board move history.
- Locked the conversation and board columns to the viewport. The board stage and board summary cannot shrink or move as chat content grows; only the board move list uses remaining-height scrolling.
- Added regressions for eight tool rounds followed by a final answer, structured failure logging, long streaming overflow, manual scroll retention during streaming, jump-to-latest, and a fixed board top edge at `1440x900` and `1920x1080`.
- Verification passed: `npm run test:mentor`, client lint/build, backend syntax checks, and `npm run test:foundation`.

## 2026-07-20 Unified Mentor Voice Foundation

- Created `codex/mentor-unified-voice-foundation` from clean mentor-analysis/follow-up commit `c96fb2a`.
- Extracted Gemini Live handling from the monolithic server socket block into `app/mentor/live-service.js`. Sessions are bound to one validated conversation, browser socket, and generated session ID; concurrent text/tool responses, second sockets, stale sessions, and cross-conversation input are rejected.
- The unified mentor uses `gemini-3.1-flash-live-preview` with 16 kHz signed PCM microphone input, 24 kHz signed PCM output, input/output transcription, automatic voice activity detection, and full-duplex interruption.
- Each Live session is seeded once with up to 12,000 characters of recent persisted messages plus authoritative FEN, PGN, turn, game status, recent moves, orientation, revision, and annotations. Later committed board revisions are queued as silent realtime context updates; Live has no board or Stockfish tools yet.
- Added namespaced `mentor-live-*` Socket.IO events for start, PCM input/end, typed input, stop, status, user/assistant transcripts, audio, interruption, failure, and closure. Typed Live requests retain client request-ID idempotency, while spoken request IDs are derived from the session and audio-turn ordinal.
- Completed spoken and typed Live turns now persist in the existing message table with `kind='voice'`. Interrupted assistant text is retained as `cancelled`, provider failures are retained as `failed`, unfinished voice messages recover as failed after restart, and the first completed spoken turn can title a new conversation.
- Added `useMentorLive` and raw PCM browser helpers. The client requests echo cancellation, noise suppression, and automatic gain control; resamples capture to 16 kHz; plays returned 24 kHz PCM without `decodeAudioData`; keeps the mic active during playback; and immediately clears queued audio on interruption.
- Added microphone, mute, and stop controls to the existing `/mentor` composer. While Live is connected, typed input uses the same Gemini session and voice turns appear in normal persistent history. Route changes, conversation changes, disconnects, unloads, and Stop release microphone, processor, tracks, audio contexts, playback sources, and the provider session.
- Mute disables microphone transmission and sends `audioStreamEnd` without closing the session. The chess workspace remains usable during Live except under its existing authoritative mutation lock.
- `/mentor-live` now redirects to `/mentor`, and the separate voice navigation entry was removed. The old `LiveMentor.jsx` component remains in source for rollback reference.
- Browser playback is intentionally the only Live output in this milestone. Gemini PCM is no longer globally broadcast to ESP32 TCP audio clients; targeted board-speaker delivery remains deferred.
- Added deterministic fake-Live backend coverage for context seeding, PCM/text input, transcript deduplication, persistence states, title generation, interruption, provider errors, idempotency, socket/conversation conflicts, disconnect cleanup, and board context updates. Added a conditional real Live smoke test.
- Fixed a pre-existing streamed-chat scroll race: a scheduled auto-scroll now rechecks whether the reader is still near the bottom, so manual upward scrolling is not overridden. The chat remains independently scrollable while the board workspace stays fixed.
- Verification passed: aggregate `npm run test:mentor`, a real configured Gemini Live smoke with 17 returned audio chunks, zero-warning client lint, client production build, backend syntax checks, physical regressions, and the complete `npm run test:foundation` suite. Playwright passed and screenshots were inspected at 1440x900 and 1920x1080.
- Deferred: Live board/analysis function calling, targeted ESP32 speaker output, session resumption/compression, and voice-first lesson workflows.

## 2026-07-20 Gemini Live Board And Stockfish Tools

- Created `codex/mentor-live-tools` from clean unified-voice commit `d06bf97`.
- Registered the same nine conversation-local declarations used by the text mentor in Gemini 3.1 Flash Live: `get_board_state`, `play_move`, `play_line`, `load_position`, `reset_board`, `set_orientation`, `annotate_board`, `analyze_position`, and `analyze_move`.
- Live function calls are executed through the existing `MentorToolService`, `MentorChessService`, mentor-only Stockfish process, board-event timeline, and `mentor_tool_calls` table. No duplicate chess rules, analysis service, or Live-specific board state was added.
- Gemini Live calls are handled synchronously with manual `sendToolResponse`. Provider calls execute sequentially in returned order, retain the existing eight-batch/twelve-call limits, and receive matching call IDs, names, and structured outputs or errors.
- A durable voice user/assistant pair is created before the first tool starts. Early partial speech updates the same user message and replaces the temporary first-message title; all tool cards remain attached to the same assistant voice response before and after tool execution.
- Added request/provider-call idempotency in `MentorToolService`. Concurrent duplicates share the in-flight promise, and completed duplicate calls reuse the persistent tool record instead of replaying a board mutation or Stockfish request.
- Tool cancellation IDs abort matching queued/running calls. Stop aborts the full batch, closes Live, clears browser audio, and preserves already committed moves. `play_line` still commits one ply per second and retains completed plies when interrupted; Stockfish cancellation continues through its existing `stop` path.
- Live board-context delivery now carries action metadata. Board revisions already included in a tool result suppress only that tool's redundant context update; unrelated manual board changes remain queued for Gemini.
- The Live client now exposes `tool_running` with labels such as `Reading board`, `Analyzing position`, `Demonstrating line`, and `Updating board`. Manual board moves and toolbar mutations lock only during tool execution, while microphone transmission, mute, and Stop remain available.
- Existing tool cards, progress, annotations, 350 ms board animation, and matching-FEN evaluation bar are reused for voice turns and survive reload. Typed Live submissions are rejected while a synchronous tool batch is active.
- Expanded deterministic Live regressions cover all nine tools, calls before final transcription, provider ordering and result IDs, malformed/illegal/unknown tools, twelve-call limits, duplicate provider IDs, typed-input busy rejection, line and analysis cancellation, persistence, conversation isolation, and the function-call `turnComplete` edge case.
- Playwright now verifies Live tool cards, one-second line pacing, board locking, microphone availability, Stockfish evaluation, annotations, Stop midway through a line, partial-position preservation, and reload restoration at `1440x900` and `1920x1080`. Each viewport uses an isolated fake server/database to prevent cross-run state contamination.
- A real configured Gemini Live smoke passed with both `get_board_state` and `annotate_board`, matching manual function responses, spoken output, and 27 returned audio chunks.
- Verification passed: `npm run test:mentor`, client lint with zero warnings, client production build, backend syntax checks, `npm run test:physical`, and the complete `npm run test:foundation` suite. Screenshots under ignored `app/tmp/mentor-live-*.png` were visually inspected without overlap, clipping, or board movement.
- No SQLite migration, physical-board logic, offline core, firmware, normal-game engine behavior, or ESP32 audio path changed.
- Deferred: targeted ESP32 speaker delivery, physical-board observation/control, Live session resumption/compression, and voice-driven robot execution.

## 2026-07-20 Gemini Live Microphone Startup Fix

- Reproduced the reported behavior in the real browser: Gemini Live opened, briefly accepted microphone audio, then closed the WebSocket with code `1007` and `Request contains an invalid argument.` The browser microphone and PCM pipeline were working.
- Isolated the rejected payload with real Gemini probes. All nine Live tool declarations were accepted individually and together; the failure occurred only when alternating persisted `user`/`model` messages were sent through `sendClientContent` without Gemini 3.1's newer initial-history setup flag.
- Kept the intentionally pinned `@google/genai` version and changed Live seeding to one labelled user-context message containing the capped prior transcript plus authoritative chess workspace. This preserves conversation continuity without elevating transcript text into the system instruction.
- Added structured provider-close logging with WebSocket code, reason, and clean-close state. Unexpected provider closes now emit a visible `mentor_live_provider_closed` failure instead of silently returning the microphone button to inactive.
- Added regressions for collapsed transcript/history seeding and unexpected provider closure. The conditional real Live smoke now sends prior learner/mentor context before exercising `get_board_state` and `annotate_board`.
- Verification passed: real affected-conversation context probe, aggregate mentor suite, desktop Playwright at both viewports, client lint/build, and real Gemini Live smoke with two tools and 15 audio chunks.
- Browser acceptance confirmed the repaired session remained at `Live voice listening` with Mute and Stop available until it was deliberately stopped.

## 2026-07-20 Mentor Activity And Practice Foundation

- Created `codex/mentor-activity-curriculum` from clean Live-tools commit `0b027ac` and completed the first of three isolated activity-coordinator commits.
- Added persistent `mentor_activities` and `mentor_activity_events` storage with one active or paused activity per conversation, learner/mentor colors, authoritative board revision, generation IDs, prediction state, attempts, hints, transitions, and restart recovery.
- Added durable SQLite execution leases in addition to in-process de-duplication. Duplicate subscriptions, sockets, or callbacks cannot start two mentor turns, and interrupted thinking turns recover as a fresh mentor turn after restart.
- Added the initial `practice_game` coordinator for standard/current positions and either learner color. Board events now record `learner`, `mentor`, or `system` ownership while remaining compatible with old events.
- After every accepted learner move, the coordinator creates a compact activity turn and guarantees exactly one opponent outcome: Gemini must run matching-revision Stockfish analysis and play one legal teaching candidate or request a prediction; an analysis-only response receives one corrective turn, followed by a transparent Stockfish-best fallback if still unresolved.
- Teaching choices are restricted to the top three analyzed candidates within 50 centipawns of the best move. Forced mates override teaching flexibility. One-legal-move positions do not require analysis.
- Pause, resume, prediction, game-over, stale-revision, board-setup locking, duplicate requests, and cancellation are transactional. Stop pauses the activity and prevents corrective/fallback execution while preserving completed moves.
- Added activity APIs, Socket.IO `mentor-activity-updated`, and initial Gemini activity tools. Text and Live use the same coordinator and persist generated activity turns in normal conversation history.
- Added `npm run test:mentor-activity`. Regressions cover the reported `e4`/analysis-only failure, corrective and engine fallback behavior, grounded teaching choices, prediction/pause/resume, Human Black opening turns, duplicate triggers, and restart recovery.
- Verification passed: `npm run test:mentor` including Playwright, client-visible mentor behavior, and backend syntax checks for all modified modules.
- Remaining on this branch: curated openings/puzzles/lessons and global learner progress, followed by the activity controls, dialogs, promotion chooser, browser acceptance, and full project regression gate.

## 2026-07-20 Mentor Curriculum And Learner Progress

- Completed the second isolated activity milestone on `codex/mentor-activity-curriculum`.
- Added a startup-validated catalog with six opening drills (Italian, Ruy Lopez, Queen's Gambit, London, Sicilian, French), twelve tactical puzzles across mating patterns/forks/pins/skewers/discovered attacks, and five guided lessons covering piece movement, central control, development, king safety, and tactical scanning.
- Catalog lines are validated move by move with `chess.js`; the tactical fixtures were also reviewed against the real mentor Stockfish process and corrected where the intended move or position was unsound.
- Opening drills, puzzles, and lessons now enforce their expected learner move before board commit. Incorrect moves leave the authoritative position unchanged, increment the attempt count, and return a recoverable coaching error.
- Added three-level hints, scripted mentor continuations, either-color opening drills, exact step tracking, completion events, and restart-safe activity reconstruction.
- Added a persistent singleton learner profile with `Beginner`, `Intermediate`, or `Advanced` skill band and up to eight goals. Topic mastery is stored globally across conversations and is capped at 100.
- Completion awards are transactional and idempotent: +10 first try without hints, +6 with hints, or +3 after an incorrect attempt. Abandoned activities do not reduce mastery or grant completion points.
- Recommendations prioritize the selected skill band and the learner's lowest-mastery topics.
- Added profile, catalog, recommendation, activity-start, and hint APIs. Conversation details now include active activity and global progress summaries; progress updates broadcast through `mentor-progress-updated`.
- Added `propose_activity` and completed all six activity tools for text and Live. Custom lines are legality checked; generated openings are Stockfish-checked at each ply, generated puzzles require a forced mate or a unique first move at least 150 centipawns ahead, and invalid generated content falls back to a suitable reviewed catalog item.
- Added `npm run test:mentor-curriculum`. It executes all 23 curated activities through the real coordinator and covers strict rollback, either-color openings, hints, generated fallback, profile persistence, recommendations, scoring, and duplicate completion awards.
- Verification passed: aggregate `npm run test:mentor`, all pre-existing mentor tool/Live regressions, and desktop Playwright.
- Remaining on this branch: activity bar and dialogs, profile/progress UI, promotion chooser, new browser workflows, and full project acceptance.

## 2026-07-20 Mentor Activity UI And Full Acceptance

- Completed the third isolated activity milestone on `codex/mentor-activity-curriculum`.
- Added a compact board-side activity bar with the current activity, learner color, goal, step progress, turn state, and Start, Pause/Resume, Hint, and End controls.
- Added a starter dialog for practice games, opening drills, puzzles, and guided lessons. Practice games support standard/current positions and either learner color; catalog activities use the reviewed opening, puzzle, and lesson catalog.
- Added a profile/progress dialog for Beginner, Intermediate, or Advanced skill band, optional goals, topic mastery bars, and coordinator-generated recommendations.
- Added a Q/R/B/N chooser for learner promotions. The client no longer silently promotes a mentor-workspace pawn to a queen; the selected piece is submitted as part of the authoritative UCI move.
- Manual moves are activity-aware. Board input opens only on the learner turn, prediction states lock the board, and reset/FEN loading remain disabled while an activity controls the workspace. Orientation and safe analysis remain available.
- Gemini-started activities now require explicit learner consent in the current user turn. Direct Start Activity clicks count as explicit consent. Generated activity proposals remain validated and fall back to reviewed catalog content when invalid.
- Persisted `engine_fallback` and `activity_fallback` tool cards make guaranteed mentor replies transparent in history. An analysis-only mentor response receives one corrective turn; if it still omits the required move, the coordinator commits exactly one legal engine/scripted fallback move.
- Fixed a Live activity-turn defect where the active-tool guard received a conversation ID instead of the Live session record. Text and Gemini Live now share the same reliable activity coordinator and fallback behavior.
- Added socket-driven activity/progress refreshes and retained state across reloads and conversation changes. Tool cards, activity messages, board events, and progress remain conversation-isolated.
- Expanded regressions for explicit-consent enforcement, persisted fallback cards, Live `e4` activity fallback, puzzle hints and wrong-move rollback, profile scoring persistence, practice pause/resume/end, and underpromotion.
- Desktop Playwright acceptance passed at 1440x900 and 1920x1080. The chat remains independently scrollable, the 480px board workspace remains fixed and square, and activity/profile dialogs fit without overlap.
- Verification passed: `npm run test:mentor`, zero-warning client lint, client production build, backend syntax checks, `npm run test:physical`, and the complete `npm run test:foundation` suite. The foundation run covered 813 synchronized integration plies plus rules, engine, coordinator, routing, ownership, recovery, capture, en-passant, castling, promotion, and unified-turn regressions.
- The optional real Gemini Live tool smoke was attempted twice. Both provider sessions stayed open but returned no requested tool output within 60 seconds; deterministic fake-Live activity/tool coverage passed, so this is recorded as an external smoke-test caveat rather than a local regression.
- No physical-board runtime, offline core, firmware, normal-game engine behavior, or ESP32 audio path changed in this milestone.
- Deferred: ESP32 speaker delivery, physical-board mentor observation/execution, cloud profiles, full PGN review, and voice-driven robot movement.

## 2026-07-21 Targeted ESP32 Mentor Speaker Production

- Created `codex/mentor-esp32-speaker` from clean activity/curriculum commit `c03d957`.
- Replaced the anonymous global TCP audio broadcast with `MentorSpeakerService`. Boards authenticate with a versioned JSON handshake using board ID plus `ESP32_AUDIO_TOKEN`; Live audio is bound to one conversation, session, socket, and device.
- Added framed `CMSP` protocol messages for `START`, sequenced `PCM`, `CLEAR`, `END`, and `PING`. Gemini output is decoded to raw 24 kHz signed PCM16LE before transmission. Device telemetry reports readiness, buffering, playback, underruns, clearing, errors, heap, PSRAM, and sensor timing.
- Added `GET /api/mentor/audio/devices`, Live start output options, `mentor-live-interrupt-output`, and `mentor-speaker-status`. `Auto` prefers `main-board` and sends only future chunks to browser after a failure; explicit `Board` refuses unavailable hardware; `Browser` preserves full-duplex playback.
- Added persistent `/mentor` controls for `Auto | Board | Browser`, device selection, and board volume. During board playback the browser microphone track remains open but PCM transmission is gated. Interrupt clears board/browser output and resumes microphone transmission immediately.
- Added production `mentor_speaker` firmware using ESP-IDF standard I2S: BCLK GPIO 10, LRCLK GPIO 9, DIN GPIO 11. The board decodes the speaker transport to 24 kHz signed PCM16LE and duplicates each mono sample into both 16-bit stereo slots. Playback uses DMA writes, software saturation/volume, a 2 MiB PSRAM ring, and approximately 1.8 seconds of device-side prebuffering.
- Speaker TCP reception and I2S playback run in an isolated core-0 task. The module has no motor or magnet references. Existing HTTP polling remains on its own core-0 task, while sensors, motion, magnet, and LEDs retain their production paths on core 1.
- Queue flushing occurs on interruption, Stop, provider close, conversation change, socket disconnect, connection loss, or session replacement. I2S/PSRAM initialization failure leaves normal board operation available and reports the speaker unavailable.
- Added `npm run test:mentor-speaker`, Live routing regressions, browser selector/persistence coverage, and `tools/verify-mentor-speaker.ps1`. Updated every exact-size firmware gate to the new production baseline.
- Automated verification passed for speaker protocol/authentication/routing, aggregate mentor regressions, desktop Playwright, zero-warning lint, client production build, backend syntax, physical regressions, the complete host-only foundation suite, and the production firmware compile.
- USB CDC-on-boot is disabled in every verifier (`CDCOnBoot=default`) so `Serial` remains available through the board's CH343 COM11 upload/monitor bridge. Enabling CDC had redirected telemetry to an unconnected native USB interface.
- Fixed a pre-existing Wi-Fi retry defect found during speaker hardware acceptance. The former three-second `WiFi.disconnect()` loop produced disconnect reason 8 and repeatedly cancelled association on `Thejaka_EXT`; production now uses a non-destructive ten-second `WiFi.reconnect()` retry and logs connected IP/RSSI or disconnect reason.
- Audio delivery now uses progressive buffering. The backend gates microphone transmission on the first board-audio chunk, starts board playback after collecting three seconds of PCM, and continues filling the ESP32 buffer while playback runs. Longer replies therefore do not wait for Gemini's complete response before starting. The response safety limit is 40 seconds and the server queue limit is 42 seconds.
- Earlier whole-response buffering removed stutter but caused long startup delays and allowed room noise to interrupt Gemini before playback. Persisted voice replies exposed this as `cancelled`; progressive buffering fixes that failure without restoring the original underrun behavior.
- Exceeding the response limit reports `response_too_long` without marking the healthy board as degraded. Real device errors, disconnects, and backpressure still use the degraded/fallback path.
- During physical-observer acceptance, sustained raw PCM and later G.711 mu-law playback exposed the ESP32 Arduino lwIP receive-window limit on the hotspot. Tone playback and decoded-stream checksums proved I2S and source audio were sound, while long voice streams ran the network buffer too close to empty.
- Board transport now uses stateful 4-bit IMA ADPCM at 24 kHz (approximately 12 KB/s instead of 48 KB/s raw PCM). The server preserves codec state across Gemini chunks; the ESP32 expands ADPCM into the existing PCM ring before I2S. Browser playback remains the original Gemini PCM and is unchanged.
- Current production firmware baseline: exactly `1,079,947` bytes flash and `48,456` bytes static RAM using `app3M_fat9M_16MB`.
- Private local firmware/backend secrets contain matching audio credentials and remain ignored. Example files contain placeholders only.
- The accepted local network is supplied through ignored firmware secrets; credentials are intentionally not recorded in this tracked handoff file.
- Hardware acceptance passed after guarded COM11 upload: authenticated `main-board`, 2 MiB advertised buffer, zero underruns, 2 ms maximum sensor gaps, approximately 6.18 MB free PSRAM, clear 1-10 and 1-20 speech, and stable playback of a captured 14.08-second real Gemini response. The ADPCM replay received and consumed all `675,844` decoded bytes with matching FNV-1a hashes, built almost ten seconds of buffer margin, and was confirmed audibly smooth. Partial DMA write timeouts are accounted for by exact accepted-byte tracking and did not duplicate or lose samples. The browser path remains unchanged and clear.
- Final telemetry review found that natural stream completion was initially counted as an underrun because a completed final TCP control frame was processed only when another byte arrived. The parser now finalizes a frame immediately when its payload completes; cross-task end/prebuffer flags were also made volatile. A guarded 4.52-second hardware tone test now finishes with clean `ended` telemetry, zero I2S timeouts, and no false underrun, so the client playback state no longer relies on the idle timeout.
- Final focused verification passed: mentor-speaker regressions, zero-warning client lint, client production build, backend syntax checks, and the exact production firmware compile/upload gate.
- Deferred: physical-board mentor observation/control, voice-driven robot movement, offline speech, and multiple-board management.

## 2026-07-21 Physical Board Mentor Observation

- Created `codex/mentor-physical-observer` from clean speaker commit `c07e3d9`.
- Added a read-only physical observer that consumes the existing authoritative physical-state emission. It exposes server/session identity, monotonic mentor revision, FEN/PGN, complete verified move metadata, robot and recovery state, sensor freshness, and occupancy differences without creating a second chess state.
- Added persistent, exclusive `main-board` bindings in SQLite. One conversation can attach at a time; reloads preserve the binding, while a backend restart or new physical session marks it stale and closes the old Live session so reattachment is explicit.
- Added source-aware mentor context and analysis. Physical mode exposes only board read, Stockfish position/move analysis, orientation, and app-only annotations. Move, line, position-load, reset, and activity tools return `physical_board_read_only` and never enqueue physical commands.
- Physical and virtual analysis results now carry distinct source keys. The evaluation bar only uses a result whose FEN and source match the visible workspace. Physical annotations and the last analyzed FEN are stored with the binding and clear when the real FEN changes.
- Added deterministic critical guidance for synchronization warnings, hard errors, restore requests, pending castling-rook placement, check, checkmate, and draws. Ordinary moves remain silent. Repeated snapshots are deduplicated, while a resolved warning can be announced again if it recurs.
- With Live voice active, urgent recovery guidance clears current board/browser output, cancels read-only tools, preserves the interrupted transcript, and speaks immediately. Check and game-result guidance queues behind current speech. Without Live, the same event and deterministic response persist in chat with `kind='physical'` and do not rename an empty conversation.
- Added the `Virtual | Physical` workspace selector, physical status/sensor-age strip, verified move history, locked physical board controls, and safety-first overlays for missing, extra, lifted, legal-target, and checked-king squares. Detaching restores the conversation's untouched virtual board exactly.
- Added `npm run test:mentor-physical`, Live interruption/queue regressions, API/browser attachment fixtures, and desktop physical-view screenshots at 1440x900 and 1920x1080.
- Automated verification passed: aggregate `npm run test:mentor`, zero-warning client lint, client production build, backend syntax checks, `npm run test:physical`, and the complete host/offline foundation chain through unified-turn regressions.
- Hardware acceptance passed on the real board: exclusive attachment and reload persistence, live mirroring through verified human/robot turns, Stockfish analysis of the exact physical FEN, read-only command isolation, urgent one- and two-square recovery guidance, restoration detection, and resumed conversation after the final square was restored.
- Urgent guidance now owns one deterministic persisted/spoken response, clears stale board/browser output, discards provider output from the interrupted turn, and resumes the prior conversation only after exact occupancy recovery. This removed duplicate recovery messages and stale speech after restoration.
- The observer did not change motion, occupancy authority, or robot command processing. Firmware changed only to harden the already-existing mentor speaker transport during this milestone's spoken-guidance acceptance; the production baseline is now `1,079,947` bytes flash and `48,456` bytes static RAM.

## 2026-07-22 Physical Mentor Opening Drills

- Created `codex/mentor-physical-opening-drills` from accepted physical-observer commit `c765b4e` and delivered the work as three isolated commits: reviewed curriculum, physical transaction coordination, and mentor UI/acceptance.
- Expanded the reviewed opening catalog from six to 18 fixed lines, each exactly ten plies and validated move by move with `chess.js`: Italian, Two Knights, Ruy Lopez, Scotch, Vienna, Queen's Gambit Declined/Accepted, Slav, London, Catalan, English, Reti, Open Sicilian, French Advance, Caro-Kann Classical, Scandinavian, Pirc, and King's Indian Defense.
- Physical opening drills require an attached, synchronized full standard starting position with no move history, pending robot/undo/redo work, or robot-owned graveyard pieces. The learner is White and the physical robot is Black. Virtual activities retain their existing color and position options.
- The activity coordinator now owns the reviewed physical line transaction. Only the exact expected learner move is accepted; a wrong source or destination enters recoverable synchronization guidance and does not mutate chess state. Restoring the committed position reopens the same prescribed move.
- Scripted Black replies bypass Stockfish choice and normal physical fallback selection. The exact reviewed move is either planned and executed or the drill pauses as `route_blocked`; it is never replaced with another legal move.
- Early boxed `b8c6` and `g8f6` replies use a verified three-part temporary-clearance plan when normal routing cannot move the knight: `a7 -> a5`, knight, `a5 -> a7`, or `h7 -> h5`, knight, `h5 -> h7`. Each transfer uses existing board routing and sensor verification, and the pawn is restored before the chess move commits.
- Captures, board/lane routing, and castling in reviewed lines reuse the accepted production planner. Undo and redo are disabled while a physical opening drill or finished-lesson lock owns the board.
- A completed line offers `Repeat`, `Continue`, or `Finish`. Repeat waits for the exact standard setup to remain stable before resetting the physical game and activity. Continue releases the drill into normal engine play. Finish locks the current position until an explicit `Resume play` action.
- The mentor workspace now allows Start Activity while attached to the physical board, shows only the 18 reviewed openings grouped by family, fixes the learner to White, and exposes route retry and line-resolution controls. The virtual activity UI is unchanged.
- Text and Gemini Live receive the active opening, current step, exact expected move, and complete reviewed catalog in physical context. After each verified scripted Black reply, Live gives a concise explanation and names the next required learner move; without Live, deterministic guidance is persisted in chat. Ordinary physical moves remain silent.
- Added `npm run test:mentor-physical-opening` and included it in the aggregate mentor suite. It validates every scripted line and physical Black plan, exact-move enforcement, temporary knight clearance, wrong-move rollback, route retry, repeat, and completion behavior.
- Verification passed: aggregate mentor suite, desktop Playwright at `1440x900` and `1920x1080`, zero-warning client lint, production client build, backend syntax, existing physical regressions, and the complete foundation suite including the 813-ply deterministic integration simulation.
- Firmware source was unchanged. The production compile gate remains exactly `1,079,947` bytes flash and `48,456` bytes static RAM.
- Real-board acceptance of a complete ten-ply drill remains the final manual gate; automated tests prove planning and transaction behavior without moving hardware.
## 2026-07-22 Physical Opening Completion Live Watchdog

- A real Queen's Gambit Accepted drill completed all ten reviewed plies correctly: `d4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3 c5`.
- The board was not stuck. It correctly entered `mentor_drill_complete`, but Gemini Live failed to finish the final summary turn and left the client showing `Live voice thinking`.
- Physical Live turns now have a 15-second watchdog. If Gemini does not finish, the deterministic physical guidance is finalized, persisted, and the session returns to listening instead of remaining stuck.
- Opening guidance immediately exposes deterministic response text, and queued opening explanations are coalesced so stale steps cannot play after the lesson advances.
- A completed physical opening now explicitly says to choose Repeat, Continue, or Finish, and this state overrides a stale thinking indicator in the client.
- Regression coverage deliberately simulates a silent Gemini Live provider and verifies fallback completion without closing the Live session.

## 2026-08-02 Physical Mentor Speech Cadence

- Real-board opening acceptance showed that immediate recovery speech was too sensitive to short-lived sensor changes. A normal lift/place or a settling piece could interrupt useful teaching audio, then trigger unnecessary restoration chatter.
- Recoverable physical guidance now requires the same warning to remain current for two seconds before it can interrupt Live voice. If the board returns to a legal or synchronized phase first, the pending warning is discarded and no recovery acknowledgement is generated.
- Hard physical errors remain immediate. Legal `piece_lifted` snapshots remain silent.
- Live opening guidance now waits for a stable post-robot position for 1.5 seconds. Starting the next move, entering robot motion, or entering a warning before that boundary cancels the stale narration instead of letting it overlap later turns.
- Focused physical observer/opening regressions and the complete `npm run test:mentor` suite passed. The backend was restarted and `main-board` reconnected; no firmware change or upload was required.
- A subsequent continuous-game test exposed a separate Live protocol defect: physical state revisions were sent through realtime text input, which can ask Gemini to respond. A legal `d1` lift therefore produced unsolicited stale recovery speech and a fabricated Stockfish-failure claim even though the recorded `Bg5` analysis had completed successfully.
- Physical Live context now uses `sendClientContent(..., turnComplete: false)` and only verified physical move commits are forwarded. Transient lifts, robot planning, and repeated sensor snapshots no longer create model turns.
- Check, checkmate, and draw guidance now waits until no robot job is pending. Its identity is based on session, event type, and FEN rather than phase/status fields, preventing the same checking position from announcing during planning and again after verification.
- The Live instruction forbids speaking private bracketed control markers and forbids claiming a Stockfish failure without a current tool error. Live, physical observer, opening, and complete mentor regressions passed.

## 2026-08-03 Physical Opening Teaching Depth And Continuation

- Physical opening drills now create an explicit introductory mentor turn before the first move. The introduction names the opening's strategic goal, gives the first teaching cue, explains what to watch for, and asks for the first reviewed move.
- Post-reply guidance now uses the catalog goal and per-step teaching cues. Gemini is instructed to explain cause and effect across the learner move and Black reply, including central control, development, king safety, pawn structure, or coordination, instead of only announcing notation.
- Deterministic no-Live fallback messages also include the relevant teaching cue and next step.
- After the ten-ply reviewed line, lifting any White piece that has a legal move now automatically selects Continue and opens normal physical play. Repeat and Finish remain available, while invalid disturbances still stay inside the protected completion state.
- Verified with the complete mentor suite, physical planner/state regressions, backend syntax checks, client lint, and production client build. No firmware change or upload is required.

## 2026-08-03 Physical Opening Live Transcript And Watchdog Fix

- Real London System testing showed every mentor explanation being finalized exactly 15 seconds after creation. The physical-turn watchdog measured total turn duration rather than provider inactivity, so richer explanations were cut off while valid transcript/audio was still arriving.
- Physical Live turns now use an inactivity watchdog. Transcript and audio progress rearm the timer, while a genuinely silent provider still falls back and returns the session to listening.
- Opening introduction and step narration no longer preload deterministic assistant text as the actual response. Gemini's real output transcript is streamed, persisted, and shown in chat. The deterministic text is used only if Gemini provides no output.
- Urgent physical safety guidance retains exact pinned wording and remains protected from provider paraphrasing.
- Added a Live regression that emits speech over a period longer than the initial timeout, verifies it is not cut off, and verifies the persisted assistant message contains the actual spoken transcript rather than fallback text.
- Complete `npm run test:mentor`, including browser and speaker regressions, passed. This is backend-only; no firmware upload is required.

## 2026-08-03 Demo Baseline Accepted

- Milestone 0 physical acceptance is complete. Production firmware, setup, quiet play, captures, castling, undo/redo, recovery guidance, LEDs/history, physical mentor mirroring, Stockfish analysis, Gemini Live board-speaker output, and both required opening lines passed real-board checks.
- The Italian Game and Queen's Gambit Accepted ten-ply lines completed exactly. A later London System test confirmed the richer introduction, lesson narration, real transcript persistence, and clean transition into normal play.
- After the reviewed line, normal physical play intentionally becomes silent unless the learner explicitly requests continued coaching. A future mentor-intent milestone will expose continuous coaching as an explicit mode rather than making every ordinary move trigger unsolicited speech.
- Final extended physical play reached 86 verified plies and game over. Temporary centering mismatches were recovered; no robot job, unsafe route, or synchronization warning remained unresolved.
- `docs/demo-readiness.md` records the accepted checklist. Production firmware remains `1,079,947` bytes flash and `48,456` bytes static RAM.

## 2026-08-03 Mentor Physical Intent And Selective Coaching

- Created `codex/mentor-intent-narration` from accepted baseline `0fd2069`.
- Extracted the physical-game start transaction so the Companion Board endpoint and mentor use the same reset, Home, and calibration command path. Mentor starts are fixed to full setup, Human White, Level 1 Balanced, and the accepted Z/I coordinates.
- Added a five-second ESP32 freshness gate based on the latest physical poll or sensor snapshot. Mentor tools cannot start over an active game and cannot access motors, magnet, raw sensors, or command queues.
- Added high-level Gemini tools for physical status, start, attach, and selective coaching. Ambiguous game requests must ask Physical or Virtual; explicit physical intent is required and persisted action IDs prevent replay.
- Added restart-safe coaching metadata and action records in SQLite. Manual attachment asks once; Gemini-started games use selective coaching; Continue and legal-lift continuation after a reviewed opening enable selective coaching.
- Selective coaching waits for a verified robot reply and 1.5 seconds of stable occupancy, then quick-analyzes the preceding learner move. It speaks only for check/game results, promotion, mate impact, inaccuracy or worse, a three-point material swing, or every third complete turn. Ordinary lifts and routine moves stay silent.
- Coaching requests are keyed by session, move, trigger, and FEN. Stale analysis and queued narration are discarded. Non-urgent narration is never interrupted by normal board movement; urgent safety guidance retains priority.
- Live source changes now refresh only the Gemini provider connection after the current tool response. The browser microphone, speaker selection, volume, and Live session ID remain intact, while the refreshed provider receives physical context and physical-safe tools.
- Added a compact persisted Selective coaching control and live analysis/explanation statuses in `/mentor`.
- Added `npm run test:mentor-physical-intent` and expanded Live/physical allowlist and source-refresh regressions. Aggregate mentor, physical planner/state, client lint/build, foundation, and firmware compile results are recorded in the milestone commit.

## 2026-08-06 Shared Side And Difficulty Configuration

- Added one migration-backed Human White/Black and Level 1-15 preference shared by the Companion Board, Mentor, Socket.IO clients, and the validated `set_game_preferences` Gemini tool.
- Physical sessions now store human/robot colors and configured/active/queued engine levels. Engine level and profile are snapshotted before asynchronous selection and retained in robot jobs, move history, and logs.
- Human Black calibration schedules exactly one White robot opening move. Lift acceptance, automatic replies, recovery, capture/castling state, status text, and actor-based undo/redo are color-aware. Physical opening drills remain explicitly learner-White-only.
- Added generation-checked active physical difficulty updates. An in-flight search and its robot job keep the old level; the next engine transaction uses the new level.
- The Companion Board now supports virtual games from either side, Human Black engine opening, active-side orientation, an explicit New Virtual Game command, and stale engine callback rejection.
- Both desktop pages render the same compact settings controls. Mentor-started physical games use the shared side/level with Balanced personality; Companion personality selection remains independent.
- Added `npm run test:game-settings` plus Human Black physical and browser regressions. The full mentor suite, physical suite, lint/build, backend syntax, and Playwright checks at 1440x900 and 1920x1080 pass. The user-assisted real-board Human Black gate remains before physical acceptance.

## 2026-08-06 Unified Physical Transfer Planner

- Created `codex/unified-physical-transfer-planner` from `bb55f43`.
- Replaced the Mentor-only opening-knight exception with one shared physical transfer boundary used by normal robot moves, reviewed opening replies, undo, redo, capture attacker phases, captured-piece graveyard removal/restoration, en passant, and castling king/rook phases.
- Routing order is board, Z/I lane or lane-board, then one same-color board-only pawn relocation. Temporary clearance always restores the pawn before the next choreography phase. Back-rank queenside knights prefer the a-pawn and kingside knights prefer the h-pawn, preserving the accepted physical behavior for `b8c6`, `g8f6`, `b1c3`, `g1f3`, and reverse undo routes.
- Added phase transactions with unique transaction/phase/attempt command IDs. Chess FEN, history, undo, and redo stay uncommitted until every phase verifies. Failure preserves earlier verified phases, compares sensors to the failed phase's exact start occupancy, and allows only that phase to retry after restoration.
- Robot graveyard reservations are transactional: planning uses `Pending`, captured removal changes the slot to `Occupied`, later failure leaves it occupied, and verified undo restoration releases it.
- Physical state and logs now expose the active transaction, phase index/count/kind, attempt, verified phases, clearance metadata, and failure checkpoint. Completed phase IDs are retained in a bounded duplicate-result set.
- A stale backend returning `404` for shared settings now produces the explicit client message `Backend update required; restart the ChessProject server.` No browser-only fallback was added.
- Scoped automated verification passed for shared planner determinism, normal and Mentor knight clearance, undo/redo clearance, phase retry/recovery, stale/out-of-order/duplicate results, pending graveyard transitions, capture state immutability, game settings, physical state/planner, relevant Mentor physical regressions, desktop browser workflows at 1440x900 and 1920x1080, zero-warning client lint, production client build, backend syntax, and diff checks. Firmware and `offline_core` remain unchanged.
- Real-board acceptance remains pending: finish Human Black/difficulty handoff, verify Nf3 Undo/Redo clearance, run a reviewed `g8f6`, then confirm one capture and one castle without duplicate phases or unresolved synchronization state.

## 2026-08-06 Online Physical Promotions

- Created `codex/online-physical-promotions` from `48e97c3`.
- The previously pending shared-side/difficulty and unified-transfer real-board gates are accepted. Human Black, difficulty handoff, Undo/Redo clearance, reviewed opening clearance, capture, and castling were reported working without unresolved physical errors.
- Added validated custom-FEN physical setup. It requires one king per color and no pawns on ranks 1 or 8, calibrates against exact FEN occupancy, and preserves turn, castling rights, en-passant state, side, level, and personality. Robot-to-move positions schedule one reply only after calibration.
- Removed the production promotion filter. Human and robot quiet/capture promotions now use the unified transfer planner and remain logically uncommitted until an occupancy-driven replacement transaction completes.
- Human promotion requires pawn placement, observed removal, Q/R/B/N selection from the timed board display or app, replacement, and a fresh 500 ms stable snapshot. App selection locks the board letter but cannot bypass removal.
- Robot promotion executes pawn motion first, then holds the requested identity indefinitely until the pawn is removed and the requested replacement is stably present. Capture graveyard occupancy remains committed after captured removal while replacement is pending.
- Physical state exposes the promotion transaction, actor, operation, color, source/target, legal choices, selected/displayed identity, selection source, removal state, stage, and stability timing. Selection requests are guarded by transaction ID and session generation.
- Promotion Undo requires an empty-then-occupied pawn replacement gate before reverse motion. Redo replays pawn motion and then repeats the recorded Q/R/B/N replacement gate before restoring chess history.
- Ported the measured 16x16 matrix mapping into production firmware, including distinct C and H orientations. Firmware renders large Q/R/B/N/P glyphs, owns the 2.5-second cycle, reports the displayed letter in snapshots, and highlights the required replacement square in amber.
- Physical review exposed game-over animation priority hiding the Undo pawn-replacement prompt. Promotion display now cancels an active celebration before drawing, and the photographed Q/R glyphs were refined for clearer recognition.
- Network tasks now enqueue complete LED commands; core 1 exclusively applies them and calls `strip.show()`. The promotion renderer is non-blocking and has no motor or magnet references.
- Added Companion custom-position preview, physical promotion controls, virtual Q/R/B/N chooser, and an attached-Mentor promotion panel. Mentor physical guidance emits one deduplicated replacement instruction and leaves identity authority with the board/app.
- Added `npm run test:physical-promotion` to the physical suite. Focused regressions cover all four human choices, capture promotion, robot promotion, app locking, no-removal rejection, 500 ms commitment, custom FEN state preservation, Undo/Redo, firmware mapping bijection, timing/wraparound, and Mentor prompt identity.
- Verification passed: `npm run test:physical`, complete `npm run test:mentor`, zero-warning client lint, client production build, backend syntax checks, diff checks, and production firmware compilation.
- Accepted production firmware baseline: `1,083,819` bytes flash and `48,768` bytes static RAM with `app3M_fat9M_16MB`, OPI PSRAM, and `CDCOnBoot=default`.
- Real-board acceptance passed through COM11. Timed board selection committed `a8=N` and the expected insufficient-material draw; Undo required pawn replacement and reversed the pawn to `a7`; app locking committed `a8=B`; and the Black fixture executed `a2a1q`, held the fixed queen prompt, accepted replacement, and produced Mentor Live spoken check guidance.
- The final standard-position regression committed human `e4` and robot `d5`. Sensors matched exactly in `ready`, with no pending job/promotion, synchronization warning, or error. Setup-only calibration warnings while arranging pieces were expected and resolved.

## 2026-08-07 Voice-First Gemini Physical Curriculum

- Created `codex/mentor-physical-curriculum` from accepted promotion baseline `574945e` and delivered the implementation as three isolated commits.
- Added physical `practice_game` activities with `mentor` or `stockfish` opponent modes. Mentor-led turns require matching-revision Stockfish analysis, constrain Gemini to the top three candidates within 50 centipawns, preserve forced mates, and expose only the guarded `play_physical_move` operation.
- Gemini physical moves now persist a concise strategic plan. The plan is included in subsequent turn prompts so move selection and narration can remain coherent instead of becoming unrelated move-by-move commentary.
- A missing Gemini move receives one corrective turn. If Gemini still omits a move, the verified Stockfish best move is routed through the same physical planner and recorded as an engine fallback. Logical activity progress advances only after exact physical verification.
- Generalized all 18 reviewed opening lines for Human White or Human Black. Human Black receives the prescribed White robot move first, and difficulty never changes a reviewed continuation.
- Enabled all 12 reviewed puzzles for physical setup. Puzzle difficulty maps shared levels 1-5 to beginner, 6-10 to intermediate, and 11-15 to advanced. The app/voice context exposes an exact piece checklist; occupancy must match and the learner must explicitly confirm identity before moves are accepted.
- Physical puzzle mistakes remain uncommitted, preserve the authoritative position, and use the existing hint progression. Scripted robot defenses continue through the normal guarded planner.
- Reworked `/mentor` into the primary desktop voice-first physical product surface. It retains transcript/history, microphone and board-speaker controls, physical board and move history, shared side/difficulty, activity state, safety feedback, promotion selection, Pause/Resume, Hint, and End.
- Removed text entry, suggestion prompts, Virtual/Physical switching, manual activity/profile dialogs, FEN/reset/demonstration controls, and the standalone selective-coaching toggle from the visible Mentor surface. Existing virtual services remain covered internally for compatibility.
- Updated Live and text instructions to ask Mentor-led or Stockfish-led for an ambiguous play request, support physical opening/puzzle intent, use dynamic learner colors, state mistakes plainly, and never imply access to raw motors, magnets, sensors, paths, or command queues.
- Stockfish-led physical narration now analyzes the recorded learner move rather than the subsequent robot move.
- Added `npm run test:mentor-physical-curriculum` and replaced the old product-surface browser workflow with voice-first Playwright checks at `1440x900` and `1920x1080`.
- Automated acceptance passed: complete `npm run test:mentor`, `npm run test:physical`, zero-warning client lint, production client build, backend syntax checks, and diff checks. The intentionally simulated provider failures/timeouts in regression logs are expected assertions.
- Firmware and `offline_core` are unchanged. Production remains `1,083,819` bytes flash and `48,768` bytes static RAM. The full user-assisted physical gate remains pending before milestone acceptance.

## 2026-08-07 Voice-First Physical Activity Startup Fix

- Real logs showed that no failing run had a valid physical activity. One Mentor-led request failed `start_activity` consent and then called virtual `play_move`; one Stockfish request created a virtual practice activity; and the Italian-as-Black request failed physical attachment, flipped only the virtual orientation, and asked the Black learner to make White's first move.
- Gemini Live now has a production-only pre-attachment tool set. It cannot call virtual `play_move`, `play_line`, position loading/reset, or orientation as a substitute for physical activity startup.
- Live `start_activity` now transactionally establishes or attaches the physical board before activity creation. Requested learner color updates the shared default, drives the new physical session, and sets the physical view orientation.
- An explicit physical request may attach an active unbound game directly. A pristine standard-position game may be restarted to change learner color; a progressed game is rejected with a side conflict and is never reset silently.
- Expanded consent recognition for natural replies such as `I'll go with Mentor and White` while retaining the explicit-start gate.
- Added a deterministic reproduction for an unattached `Teach me the Italian Game as Black` request. It asserts physical attachment occurs first, Black reaches the physical activity coordinator, and virtual move/orientation tools are absent.
- Complete `npm run test:mentor`, `npm run test:physical`, zero-warning client lint, client production build, backend syntax, and diff checks pass. Firmware remains unchanged.

## 2026-08-07 Mentor-Led Physical Reply Fix

- Real logs showed Stockfish correctly analyzed the physical post-`Nf3` FEN and selected `g8f6`, but `play_physical_move` was rejected because policy/status emissions advanced the activity revision while leaving the chess position unchanged. Gemini then falsely narrated the unverified move.
- Physical teaching evidence now matches the authoritative physical session source key and exact FEN. Hardware queueing refreshes and submits the latest physical revision immediately before execution.
- Live activity turns now queue behind an active response instead of throwing `mentor_live_busy`. The initial game-ready announcement expires after the learner commits a move, preventing it from blocking the corrective turn.
- A stranded `mentor_turn` or `mentor_thinking` transaction resumes when Live reconnects. Pause/Resume converts `mentor_thinking` to `mentor_turn` so a failed response can be retried safely without duplicating a robot move.
- Added regressions for status-only revision churn, current-revision hardware queueing, queued Live activity turns, and reconnect recovery. Focused regressions, complete `npm run test:mentor`, complete `npm run test:physical`, backend syntax, and diff checks pass. Firmware and client code are unchanged.

## 2026-08-07 Physical-Only Mentor Startup Hardening

- A second live test showed that Gemini could bypass `start_activity` by calling the lower-level `start_physical_game` or `attach_physical_game` tools. Failed calls were sometimes narrated as successful, and repeated starts replaced the session generation, which made the prior attachment appear degraded.
- The primary Mentor is now unconditionally physical. Its Live instruction never asks Physical or Virtual; it asks only Mentor-led or Stockfish-led and learner color when those details are missing.
- Voice-first tool declarations no longer expose direct physical start/attach operations. `start_activity` is the only supported gameplay startup transaction, and stale direct provider calls are rejected with `voice_activity_start_required`.
- Spoken consent normalization now accepts filler-prefixed and naturally phrased confirmations that identify the physical board, opponent mode, learner color, or playing against Gemini.
- Complete Mentor and physical suites, voice-first browser checks, backend syntax, client lint, and client build pass. Firmware and `offline_core` remain unchanged; only the real-board startup and first-reply retest remains.

## 2026-08-07 Guided-Turn Coaching And Narration Reliability

- The red cards in the real guided-game transcript were failed tool records: a redundant `start_activity` call and a transient first `play_physical_move` rejection. The latter caused Gemini to narrate once before correction and again after the successful retry.
- Matching activity starts are now idempotent. A guarded Mentor move can recover an exact, safe `ready` state back to `robot_thinking`; genuine pending jobs, wrong turns, mismatches, and unsafe phases still fail.
- Physical learner moves made while previous narration is active are retained in a deferred turn queue. When narration ends, the newest verified turn executes once. Superseded request IDs cannot start a corrective pass for an already-advanced board.
- Every generated physical Mentor turn now requires `analyze_move` evidence for the learner's exact move plus `analyze_position` evidence for Gemini's reply. The final explanation must state the move classification, immediate consequence, stronger alternative for weak moves, and a concrete two-to-three-ply plan.
- Added regressions for duplicate starts, mandatory learner-move evidence, deferred narration turns, and latest-revision execution. Complete Mentor/physical suites, voice-first browser checks, backend syntax, client lint, and production build pass. Firmware and `offline_core` are unchanged.

## 2026-08-07 Physical Mentor Ownership And Activity Switching

- Created `codex/mentor-physical-session-handoff` from `28b9e19` to close the remaining Milestone 3 ownership, reviewed-content, and active-difficulty gaps.
- Added migration-backed physical handoff transactions with request/owner conversations, exact physical identity and revision, requested activity, expiry, resolution, and terminal result. Pending handoffs survive restart; expired, stale, failed, and duplicate decisions cannot start another session or robot move.
- Starting an activity now automatically adopts unowned, ended, or stale board ownership. A genuine active owner produces a structured choice to continue that conversation or safely end and transfer the board. Merely creating or viewing a chat does not claim hardware.
- Transfers revalidate the owner, activity, server instance, session generation, state revision, sensors, robot motion, commands, promotions, Undo/Redo, and recovery. The previous Live session and queued guidance stop before detachment; the requesting conversation receives the new physical context.
- Added the compact ownership card and navigation flow for `Continue game` and `End & use this chat`, with Socket.IO updates and reload-safe pending state.
- Restricted physical voice activity startup to practice games, reviewed openings, and reviewed puzzles. Named or uniquely matched openings resolve to catalog IDs; custom and ambiguous physical content is rejected. Human Black Italian coverage requires the reviewed `e2e4` robot opener.
- Active Stockfish-led games now accept spoken difficulty changes for the next robot search. Existing in-flight work retains its captured level; side changes remain next-game only, and Mentor/opening/puzzle behavior is unchanged.
- Added `npm run test:mentor-physical-handoff` and integrated it into `npm run test:mentor`. Coverage includes restart persistence, expiry, automatic and contested ownership, both handoff actions, busy/stale safety, duplicate decisions, reviewed activity resolution, Human Black opening order, and active difficulty applicability.
- Automated acceptance passed: focused handoff/settings/curriculum tests, complete Mentor and physical suites, Playwright at both desktop sizes, zero-warning lint, production build, backend syntax, and diff checks. Firmware and `offline_core` were not changed. The real-board Milestone 3.5 acceptance gate remains pending.

## 2026-08-07 Grounded Coaching And Physical Activity Recovery

- Created `codex/mentor-grounded-coaching-recovery` from `d577682` and split the acceptance corrections into two commits.
- Physical Stockfish narration now receives an exact evidence bundle: physical source identity, learner and robot move records, before/after/current FEN, exact piece map and material, PGN/history, game status, move classification, centipawn or mate impact, best alternative, and current-position principal variation.
- Coaching generation uses structured JSON and validates move, capture, square, piece, and continuation claims. One rejected draft is regenerated with explicit claim errors; a second rejection uses deterministic Stockfish-grounded text. Only approved text is persisted and voiced.
- Unexpected Live failure clears audio and reconnects once with retained microphone, output device, and volume. A second failure exposes manual restart; Stop and navigation remain intentional non-recovering closures. Physical introductions queued during source switching wait until reconnection completes.
- Added migration-backed physical activity intent. Named reviewed openings and later color/mode answers merge across spoken turns; completed intent cannot reopen from cumulative transcript updates.
- Gemini handoff declarations now accept only the learner's action. The backend binds the active handoff UUID, while REST buttons retain explicit ID validation.
- The physical Mentor surface now supports guided games and reviewed openings only. Physical puzzle tools, setup controls, prompts, and copy were removed; requests are rejected before ownership or custom-FEN mutation. Virtual puzzle/catalog compatibility and historical records remain.
- Focused grounded coaching, recovery, handoff, opening-intent, puzzle rejection, physical curriculum/observer, and browser tests pass. The complete Mentor and physical suites, shared settings, client lint/build, backend syntax, and diff checks also pass. The corrected real-board gate remains before Milestone 3 is marked accepted.

## 2026-08-07 Physical Coaching And End-Game Acceptance Fix

- Real-board records showed every Stockfish-led turn using the repeated `unclassified` fallback. The physical server exposes `beforeFen`/`afterFen`, while move analysis expects normalized `before`/`after`; coaching now serializes the verified human and robot records before analysis.
- The Mentor End action now ends the underlying physical session at an exact stable boundary, clears pending physical work, detaches ownership, and refreshes the workspace instead of merely cancelling the activity while normal physical play continues.
- Confirmed `end_and_start` handoffs may replace the already validated active physical session. This closes the failure where the owner activity was cancelled but the new session then returned `physical_game_active`, consuming the pending handoff.
- Added regression coverage for physical move normalization, physical-session release, active-session replacement, duplicate handoffs, and Human Black reviewed-opening startup.
- Complete `npm run test:mentor`, `npm run test:physical`, client lint/build, backend syntax, and diff checks pass. Firmware and `offline_core` remain unchanged. Grounded narration and both End/transfer paths still require the final real-board retest.

## 2026-08-07 Physical Coaching Latency And Live Recovery Follow-Up

- The inspected Stockfish-led game remained synchronized through 26 plies. The physical server committed every human and robot move without a duplicate reply or unresolved motion transaction.
- The long coaching delay came from two sequential quick Stockfish requests followed by an unbounded structured Gemini request. Move and position analysis now run in parallel, failures are logged independently, and structured drafting has a six-second total deadline before deterministic grounded fallback.
- A red `analyze_move` card occurred when Gemini sent the already committed human move `g2g3` as a candidate in the later position. Physical analysis now recognizes the latest verified human UCI and evaluates its recorded before/after FEN instead of rejecting it as an illegal current candidate.
- Gemini Live closed after a provider session-duration `GoAway`, recovered once, then later closed again. Recovery allowance was lifetime-scoped; it now resets after ten seconds of stable recovered service so independent later provider rotations can recover while immediate repeated failures still require manual restart.
- Added regressions for bounded coaching latency, committed physical move analysis, stable recovery reset, a second independent recovery, and immediate repeat-failure protection.
- Complete `npm run test:mentor`, `npm run test:physical`, client lint/build, backend syntax, and diff checks pass. Firmware and `offline_core` remain unchanged.

## 2026-08-07 Physical Coaching Generation And Mentor Retry Follow-Up

- Real acceptance records confirmed five of six completed Stockfish-turn coaching drafts used deterministic fallback because the six-second Gemini drafting deadline expired. The limit prevented the prior long waits but made fallback the common path.
- Structured coaching now disables model thinking, uses native JSON schema output, caps output length, and keeps the six-second total deadline. A real API probe completed in about 1.8 seconds with the optimized configuration.
- A failed `Bxe4` capture removal left the captured White knight on `a4` rather than robot graveyard `Z4`. The user restored it to `e4`, and the server correctly retained phase 1/2 as retryable with exact pre-phase occupancy and no chess-state commit.
- The Companion page already exposed the guarded retry endpoint, but the voice-first Mentor page did not. Mentor now displays `Retry robot move` only when a transaction is paused, a robot job is retained, and sensors exactly match the failed phase's safe before-state.
- Complete Mentor and physical suites, focused coaching/observer regressions, client lint/build, backend syntax, and diff checks pass. The active physical transaction remains paused until the user explicitly retries it.

## 2026-08-07 Full-Game Coaching And Speaker Buffer Follow-Up

- The first full game after loading the optimized coaching generator completed 24 coached turns: 15 direct Gemini drafts, two valid regenerations, and seven deterministic fallbacks. No drafting timeout occurred.
- Three fallbacks incorrectly rejected captures that were present in a verified Stockfish continuation. Capture validation now replays each principal variation from the exact physical FEN and accepts only captures chess.js confirms in that line.
- Capture wording without a redundant claim record is accepted only when the verified learner move, robot reply, or selected continuation actually contains a capture. Invented captures remain blocked.
- The tactical-language guard now rejects concrete unsupported piece/square attack claims without treating every general strategic use of words such as pressure or attack as a hallucination. The generation instruction explicitly avoids unsupported forks, pins, skewers, threats, and trapped-piece claims.
- Two audible stalls correlated with Gemini provider chunk gaps of about 5.4 and 9.5 seconds. ESP32 telemetry showed no general I2S or sensor failure. Board playback now buffers ten seconds of decoded audio before starting, or starts at response completion for shorter replies, to absorb those upstream gaps.
- Focused coaching and speaker regressions, backend syntax checks, and the complete `npm run test:mentor` suite pass.

## 2026-08-08 Guarded Production Offline Interaction Gate

- Created `codex/offline-production-interaction` from clean commit `547e044`.
- Added portable `OfflineLedRenderer`, `OfflineSideSelector`, and `OfflineHumanPromotionSelector` modules. The renderer covers all 256 measured matrix positions, including distinct C/H row orientation, and suppresses duplicate frames. Side selection requires a one-second sole king lift and 500 ms restored setup. Human promotion uses removal, 2.5-second Q/R/B/N cycling, one-placement latching, and 500 ms confirmation.
- Extended the offline physical controller, coordinator, and runtime with a real `HumanPromotionPending` transaction and `HumanPromotionRequest`. FEN, history, and turn remain unchanged until exact replacement confirmation.
- Added default-off `ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS` with Standard, HumanPromotion, and RobotPromotion fixtures. It reuses bounded homing, PSRAM tables, ownership, the three-second/depth-12 engine, unified motion compiler, phase adapter, guarded hardware executor, and transactional graveyard state.
- Added a core-0-to-core-1 LED frame mailbox; core 1 remains the sole `strip.show()` owner. The guarded runtime blocks normal commands and speaker playback, authorizes the magnet only during verified motion, freezes at bounded fixture limits, and emits `[OFFLINE_INTERACTION_DIAG]` telemetry.
- Added `npm run test:offline-interaction`, included it in `test:foundation`, and added `tools/verify-offline-interaction.ps1`. The aggregate verifier now also includes the previously omitted unified-turn firmware compile gate.
- Automated acceptance passes: 100-game/6,838-ply soak, full foundation suite, aggregate host/client verifier, client build and zero-warning lint, production baseline, and every offline diagnostic compile gate. Production remains exactly `1,083,819 / 48,768`; the final isolated Standard interaction build is `1,401,191 / 53,904` with `1,744,537` bytes of application headroom.
- The aggregate firmware matrix exceeded the one-hour command wrapper after all gates through castling had passed; promotion, unified-turn, and interaction completed successfully as standalone verifiers. A stale Arduino generated cache caused one transient promotion compile failure after termination; using a workspace-local build path removed the cache dependency.
- Milestone 3 physical acceptance is recorded as complete based on the successful full-game grounded-coaching, speaker, retry/end, and online-operation retests.
- Milestone 4 physical acceptance is complete. Standard White and Black, human knight promotion, robot queen promotion, resource telemetry, automatic production restoration, and a final online regression passed on COM11.
- Accepted fixture telemetry recorded exact final occupancy, magnet LOW, no duplicate commits, searches within the 3.1-second gate, and a 10 ms maximum sensor-loop gap.
- The restored online game accepted `e4`, `exd5`, and `c4`; robot replies `d5`, `c6`, and `cxd5` each committed exactly once with no unresolved warning or motion transaction.

## 2026-08-09 Guarded Continuous Offline Gameplay

- Created `codex/offline-continuous-gameplay` from clean commit `331c6dd`.
- Added a portable, wrap-safe continuous session/reset controller. New games increment a generation, terminal reset requires both actual king squares lifted for 2 seconds, and standard setup must remain exact for 500 ms before side selection reopens.
- Added persistent game-loop firmware state over the accepted runtime, engine, unified compiler, phase adapter, promotions, LEDs, and guarded motor executor. Graveyard keys remain reserved until a deliberate terminal reset completes.
- Added Standard and TerminalReset fixtures, `[OFFLINE_GAME_DIAG]` telemetry, a 12-turn non-terminal checkpoint, exact checked/result king feedback, `CLR` reset guidance, and backend-return freezing at an exact boundary.
- Added `npm run test:offline-continuous` and `tools/verify-offline-continuous-gameplay.ps1`; the focused host regression passes.
- The Standard continuous firmware compiles at `1,442,511` bytes flash and `54,352` bytes static RAM, leaving `1,703,217` bytes application headroom. Full automated and physical acceptance remain pending before the milestone commit.
- Final physical acceptance passed. Standard completed 12 human moves, 12 robot replies, 18 verified phases, and retained six graveyard slots; maximum sensor gap was 10 ms and maximum search time was 3,011 ms.
- TerminalReset completed the controlled Black castling checkmate, two-second king reset gesture, standard restoration, Human Black selection, exactly one White opener, and one further Black/White turn. It ended with exact occupancy and magnet LOW.
- The first reset trial exposed insufficient `CLR` guidance. Offline `SET` and `CLR` now preserve their status glyph while coloring detected required squares cyan, missing required squares red, and unexpected occupied squares yellow. Host regressions and the repeated physical terminal gate passed.
- A dedicated backend-return run reached `ReconnectPending` after two successful heartbeats and froze at the untouched starting-position boundary with `WAIT`, zero moves, zero motor activity, and magnet LOW.
- The clean production restore initially lacked the ignored `firmware_secrets.h`, so it could not poll the backend despite matching IPs in the active workspace. The restore artifact was rebuilt from the clean baseline with the current ignored secrets and retained the exact `1,083,819 / 48,768` baseline.
- Final online regression committed verified human `e2e4` and robot `d7d5`; the backend returned to `ready` with no error, synchronization warning, pending job, or motion transaction.
- Final diagnostic sizes are Standard `1,444,227 / 54,352` and TerminalReset `1,444,311 / 54,352`.

## 2026-08-09 LED And Transfer-Planner Parity

- Created `codex/offline-led-transfer-parity` from the accepted continuous-gameplay baseline. The milestone is split into an LED/palette commit and a central temporary-clearance commit.
- The LED renderer now uses one fixed sideways text orientation across offline statuses and promotion glyphs. Characters run along the file axis with glyph tops toward rank 8. Text is drawn first, then square/action colors, preventing text from being overwritten by guidance overlays. The measured 256-pixel mapping and distinct C/H row orientations remain intact.
- Offline colors now match the online physical roles: detected green, missing red, extra amber, source blue, quiet green, capture red, special purple, check red, winner green, draw purple, with amber `WAIT`/`SET`/`SIDE`/`CLR`, blue `AI`, red `ERR`, and green `GO`/`OK`.
- Added deterministic host coverage for mapping bijection, orientation extents, palette roles, frame deduplication, and promotion glyph snapshots. Added `npm run test:offline-led-parity` and wired it into the foundation suite.
- Centralized temporary pawn clearance in `OfflineMotionPlanner`: ordinary board and lane/lane-board routes are attempted first; only one same-color pawn is considered afterward, with one-step or starting-rank two-step movement, deterministic cost ordering, reserved-square exclusions, rejected-candidate metadata, and stage/primary/restore phases. The unified compiler routes those phases through the existing guarded motion compiler.
- Host clearance coverage proves `g1f3` uses `h2-h4`, `g8f6` uses `h7-h5`, `b1c3` uses `a2-a4`, `e2e4` needs no clearance, and repeated planning leaves the game unchanged. The existing motion parity suite remains green for capture, en passant, castling, promotion, lanes, graveyards, failures, and deterministic repeats.
- Added `ENABLE_OFFLINE_LED_TRANSFER_PARITY_DIAGNOSTICS` with `LedGallery`, `WhiteClearance`, and `BlackClearance` fixtures. The gallery renders the complete feedback vocabulary; clearance fixtures are planner-only and keep motors locked and the magnet LOW. The new verifier is `tools/verify-offline-led-transfer-parity.ps1`.
- Firmware compile evidence: clean tracked production `1,083,819` flash / `48,768` RAM; gallery `1,134,535` / `53,744`; White clearance `1,276,443` / `53,744`; Black clearance `1,276,507` / `53,744`. A live-tree production compile is larger because unrelated uncommitted speaker/audio files are present and are excluded from this milestone.
- Final parity hardware/foundation acceptance and the isolated second commit remain pending.
