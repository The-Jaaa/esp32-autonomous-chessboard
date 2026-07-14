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
