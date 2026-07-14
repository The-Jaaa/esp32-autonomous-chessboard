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

The rules wrapper deliberately contains no engine search, pathfinder, firmware ownership switching, persistence, or ESP32 integration. The host-only physical controller and engine described below remain isolated from the online application and firmware.

Foundation verification on 2026-07-14 passed with nine `chess.js` legal-move parity positions, standard and Kiwipete perft, move metadata, castling, en passant, all four promotions, check/game outcomes, repetition, and exact apply/undo restoration. The complete online regression suite continued to pass, and firmware usage remained exactly 1,095,735 bytes of flash and 51,856 bytes of static RAM.

## Physical Baseline Result

The full physical-board gate was completed on 2026-07-14 and passed. The session exercised calibration, normal play, captures and graveyard movement, castling, checkmate, repeated Undo Turn, and repeated Redo Turn. All 33 reported robot jobs completed successfully, and the final state was a successfully replayed checkmate.

The session contained two transient robot occupancy mismatches and two piece-centering warnings. Each was recoverable and resolved before play continued; no error-level event or unresolved mismatch remained at the end.

During undo of the human capture `Rxf5`, the backend correctly entered `undo_waiting_human_restore` and requested that the captured black pawn be returned to `f5`. The workflow completed after the pawn was detected, but the user could not readily tell why play had paused. Clear board-level communication for manual captured-piece restoration is deferred to the later offline LED/status communication milestone; no behavior change is included in the foundation pass.

## Host-Only Physical Move Interpreter

The second offline component is `offline_core/offline_physical.h/.cpp`. It interprets stable 64-square binary occupancy snapshots while remaining independent of Arduino, WiFi, sensors, LEDs, motors, pathfinding, graveyards, and engine search.

Its physical mapping exactly matches the online board: raw index `0=h8`, `1=h7`, `56=a1`, and `63=a8`. It supports either human color and exposes hardware-neutral phases, events, legal targets, highlights, occupancy differences, and accepted `MoveInfo` metadata.

Implemented physical sequences:

- quiet moves, cancellation, and duplicate-snapshot idempotence;
- ordinary captures that observe victim removal before attacker placement;
- en passant with source, capture square, and destination verification;
- king-first kingside and queenside castling followed by the rook;
- quiet and capture promotions that pause for an explicit queen, rook, bishop, or knight choice;
- recoverable sync warnings for wrong-color lifts, pieces with no legal moves, illegal destinations, multi-piece disturbances, and movement while waiting for the opponent.

`OfflineGame` now also provides read-only legal-move descriptions, piece lookup, and occupied-square access. Applying moves remains the only mutating rules operation used by the interpreter.

Run the interpreter regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-physical
```

`npm run test:foundation` includes the online physical regressions plus the host rules, physical interpreter, engine, turn coordinator, and quick integration regressions. The complete foundation verification passed on 2026-07-14. Client lint retained the same eight existing warnings, and the unlinked firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

The controller assumes snapshots are already debounced. It does not perform setup calibration or infer a promotion identity from occupancy. Binary occupancy also cannot distinguish a restored captured piece from the attacker after the capture square has first been observed empty; the controller therefore enforces the intended ordered capture workflow and treats exact restoration as cancellation.

## Host-Only Deterministic Engine

`offline_core/offline_engine.h/.cpp` adds a portable search-only opponent around the same pinned chess rules library. It accepts a FEN and returns a legal UCI move, centipawn or mate score, completed depth, node and elapsed-time telemetry, principal variation, ranked root candidates, terminal outcome, and stop reason.

The engine currently uses:

- deterministic iterative-deepening negamax with alpha-beta pruning;
- quiescence search for captures, promotions, and check evasions;
- material, pawn-square, centralization, mobility, bishop-pair, advanced-rook, and king-safety evaluation;
- principal-variation, transposition, promotion, capture, killer, history, and UCI move ordering;
- a fixed 4,096-entry transposition table with 16-byte entries, capped at exactly 64 KiB;
- a default hard 3,000 ms deadline, maximum depth 12, and the last fully completed iteration as the trusted result.

The search is deterministic and contains no opening book or randomness. A later variation milestone can select among close root candidates, but this milestone always returns the proven principal move. Quiescence continuations may make the reported principal variation longer than the nominal completed depth.

Run the engine regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-engine
```

Regressions cover invalid and terminal FENs, legal moves for both sides, repeatability, mate in one/two, delaying forced mate, check evasions, major captures, castling, en passant, all promotion choices, transposition-table parity, node limits, and the 3,000 ms deadline with 100 ms tolerance. A host benchmark corpus reports move, depth, nodes, elapsed time, and principal variation.

On the 2026-07-14 MinGW host run, the three-second starting-position search completed depth 7, examined approximately 8 million nodes, and selected `b1c3`. Root candidates are searched with full windows so their reported scores are directly comparable for the future variation feature. These figures are host measurements only; ESP32 depth and working-memory placement must be measured during a later firmware-integration milestone.

The engine is not connected to `OfflinePhysicalController`, the backend, client, or firmware. No ESP32 upload or physical-board test is required for this milestone.

## Host-Only Offline Turn Coordinator

`offline_core/offline_coordinator.h/.cpp` connects the host-only physical interpreter and deterministic engine through a transactional turn state machine. It remains portable C++17 and is not referenced by the backend, client, or ESP32 firmware.

The coordinator exposes these phases:

- `HumanTurn` and `HumanPromotionPending` while physical snapshots are interpreted;
- `EngineSearchNeeded` with a generation-tagged FEN and `SearchLimits` request;
- `OpponentMoveReady` and `OpponentMoveExecuting` for an externally executed move;
- `OpponentPromotionPending` until the engine-selected Q/R/B/N replacement is confirmed;
- `GameOver`, recoverable `SyncWarning`, and internal `Error` states.

Search is deliberately split-phase. The caller retrieves `pendingEngineRequest()`, runs `OfflineEngine::searchFen` outside sensor processing, and submits the result with its request generation. Stale generations are rejected without replacing the active request. An empty or illegal result causes a fresh generation for the same authoritative FEN.

Opponent moves are previewed without changing `OfflineGame`. The resulting `OpponentMovePlan` includes engine telemetry, full move metadata, pre/post FEN, pre/post occupancy, and expected game status. After external hardware execution:

- exact post-move occupancy commits the move;
- exact pre-move occupancy makes the same staged move ready for retry;
- any other occupancy enters `SyncWarning` without changing the game;
- recovery may either restore the pre-position or complete the exact post-position without rerunning search.

For opponent promotion, post-move occupancy is necessary but not sufficient because binary sensors cannot identify the replacement piece. The coordinator remains uncommitted in `OpponentPromotionPending` until `confirmOpponentPromotion(q/r/b/n)` matches the engine-selected promotion.

`OfflinePhysicalController` remains the single owner of authoritative rules state. Its new opponent methods only preview a legal opponent move or commit one whose supplied occupancy exactly matches that preview. Duplicate snapshots and completion reports are idempotent.

Run coordinator regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-coordinator
```

The suite covers Human White and Black, real fixed-depth engine handoff, stale/illegal results, uncommitted staging, quiet moves, captures, en passant, both castling sides, human and opponent promotion, retry and mismatch recovery, duplicate reports, checkmate, stalemate, insufficient material, fifty-move draw, and threefold repetition. It is included in `npm run test:foundation`.

Still deferred: firmware linking, FreeRTOS search execution, setup calibration, pathfinding, motors, graveyards, LEDs, persistence, online/offline ownership switching, and reconnect handoff.

## Host-Only Offline Integration And Soak Tests

`tests_and_misc/offline_integration_host.cpp` drives the rules, physical interpreter, real offline engine, and turn coordinator as one deterministic host system. It alternates Human White and Human Black, selects human moves from sorted legal moves with a fixed-seed PRNG, and uses node-limited engine searches (`timeLimitMs=0`, `maxNodes=2000`, `maxDepth=12`).

Human moves are translated into stable occupancy snapshots for quiet moves, captures, en passant, king-first castling, and explicit Q/R/B/N promotions. Opponent moves pass through request, search, staging, execution, occupancy verification, and promotion confirmation. A separate `OfflineGame` oracle applies only committed moves and verifies exact FEN, occupancy, side to move, metadata, and game status after every ply.

The simulator injects deterministic recoverable failures: stale search generations, partial opponent occupancy, restoration to the pre-move board, completion to the expected post-move board, cancelled human lifts, wrong-piece disturbances, and duplicate reports. Every warning must resolve without rerunning the staged search or committing twice.

Two test tiers use the same executable:

```powershell
Set-Location .\app
npm run test:offline-integration  # 12 games, up to 120 plies; included in test:foundation
npm run test:offline-soak         # 100 games, up to 200 plies; milestone/debugging gate
```

The 2026-07-14 acceptance runs produced:

- quick: 12 games, 719 plies, 138 captures, 5 castling moves, 3 en-passant moves, and 7 promotions;
- soak: 100 games, 7,952 plies, 1,257 captures, 42 castling moves, 4 en-passant moves, 54 promotions, 96 checkmates, and 2 repetition draws;
- both tiers exercised every injected recovery branch and finished without an unresolved `SyncWarning` or `Error`.

No production source changed for this milestone. Physical route planning, firmware linking, motor/LED execution, graveyards, persistence, and ownership switching remain deferred.
