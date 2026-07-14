# Offline Chess Development

## Current Baseline

The active implementation is server-owned online physical chess. The ESP32 firmware scans sensors, drives LEDs and motion, executes backend motion plans, reports verification results, and supports OTA updates. It does not currently contain an offline chess engine or offline game controller.

The earlier offline implementation described near the end of the local `codex.md` was reverted on 2026-07-14 and is historical only.

## Baseline Verification

Run the complete software and firmware baseline from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\verify-foundation.ps1
```

Verified before the offline foundation work:

- Backend syntax passes.
- Physical planner and physical state regressions pass.
- Client production build passes.
- Client lint completes with warnings only.
- ESP32-S3 firmware compiles with the OTA-capable `min_spiffs` partition scheme.
- Baseline firmware uses approximately 55% flash and 15% static RAM.

## Required Hardware Gate

Before enabling any offline firmware behavior, verify all of the following on the physical board:

- Full starting-position calibration.
- Human quiet move and robot reply synchronization.
- Capture and graveyard handling.
- Human castling.
- Undo Turn and Redo Turn.
- Prompt legal-move LED clearing and synchronized app move history.
- No unresolved mismatch or unsafe-route errors in the physical log.

If this gate exposes a baseline failure, stop offline development and fix the online baseline separately.

## Development Boundary

Host-only offline modules belong under `offline_core/`. Until a later milestone explicitly integrates them, they must not be included from `esp32_firmware/esp32_firmware.ino` or placed inside the Arduino sketch directory.

## Host-Only Rules Foundation

The first offline component is a portable rules wrapper in `offline_core/`. It vendors Disservin `chess-library` at commit `57159616358c2d4c09e0d4fb1562ca7f2d36a2fb` and is compiled only by the MinGW host regression runner.

The wrapper currently provides FEN loading/reset, side to move, sorted legal UCI moves, SAN and physical move metadata, apply/undo, check state, and terminal game outcomes. Promotions support queen, rook, bishop, and knight at the rules level.

Run its regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-rules
```

This foundation deliberately contains no engine search, physical occupancy controller, pathfinder, firmware ownership switching, persistence, or ESP32 integration.

Foundation verification on 2026-07-14 passed with nine `chess.js` legal-move parity positions, standard and Kiwipete perft, move metadata, castling, en passant, all four promotions, check/game outcomes, repetition, and exact apply/undo restoration. The complete online regression suite continued to pass, and firmware usage remained exactly 1,095,735 bytes of flash and 51,856 bytes of static RAM.

## Physical Baseline Result

The full physical-board gate was completed on 2026-07-14 and passed. The session exercised calibration, normal play, captures and graveyard movement, castling, checkmate, repeated Undo Turn, and repeated Redo Turn. All 33 reported robot jobs completed successfully, and the final state was a successfully replayed checkmate.

The session contained two transient robot occupancy mismatches and two piece-centering warnings. Each was recoverable and resolved before play continued; no error-level event or unresolved mismatch remained at the end.

During undo of the human capture `Rxf5`, the backend correctly entered `undo_waiting_human_restore` and requested that the captured black pawn be returned to `f5`. The workflow completed after the pawn was detected, but the user could not readily tell why play had paused. Clear board-level communication for manual captured-piece restoration is deferred to the later offline LED/status communication milestone; no behavior change is included in the foundation pass.
