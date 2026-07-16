# Offline Chess Development

## Current Baseline

The active implementation is server-owned online physical chess. The production ESP32 firmware scans sensors, drives LEDs and motion, executes backend motion plans, and reports verification results over WiFi HTTP. Firmware uploads are USB-only. Offline gameplay is not active, but an explicit default-off diagnostic build can now link and exercise the host-tested offline foundation on the ESP32-S3.

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
- Client lint passes with zero warnings and zero errors.
- ESP32-S3 firmware compiles with the USB-only `app3M_fat9M_16MB` partition scheme.
- The current USB-only baseline is exactly 1,042,543 bytes flash and 47,128 bytes static RAM.

### USB-Only Firmware Baseline

OTA was removed on 2026-07-14 because this project used it only for wireless sketch uploads. WiFi HTTP polling, snapshots, commands, and job results are unchanged. Firmware uploads now require the USB serial port.

The last verified OTA baseline used `min_spiffs` and measured 1,095,735 bytes flash / 51,856 bytes static RAM. Removing `ArduinoOTA`, mDNS, UDP, OTA state, and motion-interruption branches reduced the firmware to 1,042,543 bytes flash / 47,128 bytes static RAM.

Use this partition setting in Arduino IDE:

```text
16M Flash (3MB APP/9.9MB FATFS)
```

The equivalent Arduino CLI FQBN option is `PartitionScheme=app3M_fat9M_16MB`, providing a 3,145,728-byte application partition. Select the USB COM port for every upload. Upload only while the gantry is idle and the electromagnet is off.

The USB-only image was uploaded to the physical ESP32-S3 on COM11. It booted under the new partition, posted an occupancy snapshot to the running backend, and consumed a harmless magnet-off diagnostic command from the physical command queue. The board was not in a calibrated starting position, so a new human move and robot reply were not physically executed during this upload check; the existing planner/state regressions passed and the earlier complete physical baseline remains the motion reference.

### Embedded Offline Resource Gate

`ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS` is defined in `esp32_firmware/offline_embedded_config.h` and defaults to `0`. The normal build therefore does not compile or link the offline modules and remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM.

The enabled build is compiled by passing the repository's `offline_core/` directory as an Arduino library and setting `compiler.cpp.extra_flags=-DENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS=1`. Arduino-only wrappers under `offline_core/src/` include every production-relevant offline module: rules, engine, physical interpreter, turn coordinator, board routing, Z/I/graveyard routing, and move choreography. The normal MinGW host implementation remains unchanged.

The pinned chess library has an embedded-only allocation path guarded by `CHESS_EMBEDDED_PSRAM_TABLES`:

- the 819,200-byte rook attack table is allocated in PSRAM;
- the 41,984-byte bishop attack table is allocated in PSRAM;
- the 32,768-byte squares-between table is also initialized in PSRAM, avoiding a large pre-`setup()` stack temporary;
- allocation and external-address checks must pass before any offline smoke/search work starts;
- a missing PSRAM device or failed allocation emits a failed diagnostic summary and ends the diagnostic task cleanly.

The current diagnostic build is 1,240,207 bytes flash / 51,248 bytes static RAM. Its 3,145,728-byte app partition retains 1,905,521 bytes of headroom, well above the required 512 KiB.

Diagnostics run in a 49,152-byte, idle-priority task pinned to core 0. The normal sensor/hardware loop continues on core 1 and the priority-1 network task can preempt search. Every motion command is rejected in this build, the magnet is continuously driven LOW, and the structured report is emitted as `[OFFLINE_DIAG]` JSON over the USB serial/JTAG console.

Run compile-only resource verification from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\verify-offline-embedded.ps1
```

To upload the diagnostic image, parse its complete USB report, and automatically restore the production image afterward:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\verify-offline-embedded.ps1 `
  -UploadPort COM11 `
  -SerialLogPath tmp\offline-embedded-diagnostic.log
```

The physical ESP32-S3 diagnostic session on 2026-07-14 passed rules, apply/undo, Q/R/B/N promotion, physical interpretation, coordinator transactions, board and external routes, graveyard selection, capture, en passant, castling, and promotion choreography. It also passed deterministic 2,000-node searches and 250 ms, 1 second, and 3 second timed searches.

Measured hardware resources and concurrency during that session:

- attack/squares-between initialization: 780 ms;
- free internal heap: 150,824 bytes;
- largest internal allocation: 139,252 bytes;
- minimum observed internal heap: 110,148 bytes;
- free PSRAM after search: 7,431,636 bytes;
- diagnostic stack headroom: 22,412 bytes;
- maximum sensor-loop gap: 2 ms across 4,826 scans;
- successful HTTP polls during search: 49;
- 3-second opening search: depth 4, 17,216 nodes, 3,000 ms;
- 3-second middlegame search: depth 1, 18,624 nodes, 3,005 ms.

The 250 ms middlegame search reached its deadline before completing depth 1, but returned a deterministic legal fallback as designed. No crash, watchdog, brownout, motor movement, or magnet activation occurred. The verifier restored the default USB-only production firmware at the end.

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

Portable offline modules remain under `offline_core/`. Production firmware does not link them. The only accepted embedded boundary is the default-off diagnostic adapter under `offline_core/src/`, selected explicitly by the diagnostic compile flag; runtime online/offline ownership switching is still deferred.

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

`npm run test:foundation` includes the online physical regressions plus the host rules, physical interpreter, engine, turn coordinator, quick integration, board-route, external-route, motion choreography, and motion-execution regressions. The complete foundation verification passed on 2026-07-14. Client lint retained the same eight existing warnings, and the unlinked firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

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

## Host-Only Board Route Planner

`offline_core/offline_route.h/.cpp` is a portable C++17 board-only route planner. It matches the existing online JavaScript `buildBoardTransferPlan` behavior without linking into the backend, client, firmware, physical controller, or turn coordinator.

`BoardRouteRequest` supplies source and target squares, expected occupancy, optional latest sensed occupancy, ignored squares, and whether a verified simple pawn push may use the online direct-route shortcut. `BoardRouteResult` reports success or a blocked reason, route mode, route cost, the raw square path, and compressed drag waypoints. The convenience `planQuietMove` operation rejects captures, castling, en passant, and promotions because their choreography belongs to later milestones.

The planner preserves the online routing rules:

- expected and sensed occupancy are merged with logical OR;
- source, target, and explicit ignored squares are cleared before routing;
- a clear rank, file, or diagonal chess line is preferred;
- buffered A* is attempted before relaxed A*;
- orthogonal and diagonal steps cost 10 and 14 respectively;
- buffered A* adds 10 per adjacent occupied square;
- diagonal movement between two occupied orthogonal neighbors remains allowed;
- JavaScript neighbor insertion and equal-score tie order are preserved;
- consecutive steps in the same direction are compressed into one drag waypoint.

The existing JavaScript planner is exported only through the server's test module boundary. Its production call sites and runtime behavior are unchanged.

Run the route regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-route
```

The 2026-07-14 acceptance run passed 16 exact C++/JavaScript parity fixtures and 256 deterministic randomized C++ safety cases. Fixtures cover direct pawn pushes, one-square moves, long clear lines, routed knight transfers, crowded/blocked boards, diagonal corner-adjacent passage, expected-plus-sensed occupancy, ignored obstructions, waypoint compression, and deterministic repeated planning. Every successful C++ route is additionally checked for valid endpoints, unoccupied traversed squares, and lossless compressed-segment reconstruction.

The 100-game offline soak, complete `npm run test:foundation`, and `tools/verify-foundation.ps1` all passed. The client production build passed, lint retained only the same eight existing warnings, and the unlinked ESP32 firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

This milestone deliberately returns `NoBoardPath` when the 8x8 board has no route. Z/I lanes, graveyards, capture staging/removal, castling choreography, LED previews, motor commands, coordinator wiring, and ESP32 integration remain deferred. The next isolated milestone will add host-only Z/I lane and graveyard routing on top of this accepted board-route API.

## Host-Only Z/I Lane And Graveyard Routing

`offline_core/offline_external_route.h/.cpp` builds a portable external-routing layer on the accepted board planner. It remains host-only and is not connected to the physical interpreter, turn coordinator, backend runtime, client, or ESP32 firmware.

The module provides:

- normalized Z/I slot metadata with the current 16 default coordinates;
- square and external-coordinate route targets;
- board-first transfer planning with optional forced-lane routing;
- direct Z/I and lane-to-board re-entry routes;
- robot graveyard removal previews with full candidate scoring and failure details;
- pure, case-insensitive, idempotent reserve/release helpers for caller-owned slot keys.

Transfer routing first uses `OfflineBoardRoutePlanner`. Only `NoBoardPath`, or an explicit forced-lane request, permits an external route. Lane preference, rank-distance ordering, occupied-slot exclusion, lane-transit checks, sensed board occupancy, target deduplication, and route costs match the online JavaScript planner. Direct lane routes retain the online `1000 + targetCount * 100` cost; lane-board routes retain `1200 + rankDistance * 12 + boardPathCost`.

Graveyard routing evaluates every free, routable slot. Z slots exit through `a1-a8` and I slots through `h1-h8`. Candidate scores preserve online board-path cost, adjacent-piece crowding multiplied by 12, middle-out ordering `4, 5, 3, 6, 2, 7, 1, 8`, and the I-side `0.5` preference offset. A piece already on its selected edge square uses the online zero-length board path before moving off-board.

Unlike the online session's current mutable preview, the host planner never reserves a slot while planning. A successful result proposes a slot key; a later coordinator/choreography milestone will call `reserveVerifiedSlot` only after hardware occupancy verification. Failed and abandoned previews therefore consume no graveyard capacity.

Run the external-route regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-external-route
```

The 2026-07-14 parity run passed 22 shared C++/JavaScript fixtures covering board preference, direct pawn passthrough, Z/I and opposite-lane selection, lane-board re-entry, sensed obstruction, occupied transit, malformed/full slots, default coordinates, normalization, middle-out and safety-weighted graveyard choices, edge-square removal, deterministic repetition, and exact failure details. C++ checks also enforce immutable inputs, valid/deduplicated targets, no partial failed routes, and transactional reservation behavior.

The 100-game soak, complete foundation suite, client production build, and final `tools/verify-foundation.ps1` run passed. Client lint retained the same eight existing warnings, and the unlinked firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM. One earlier full-verifier attempt encountered a transient timeout in the unchanged host engine executable; the engine suite passed immediately when rerun and the complete verifier then passed normally.

Complete capture/castling choreography, coordinator integration, LEDs, firmware motion commands, server switching, persistence, and ESP32 linking remain deferred. The next milestone will compose the accepted board and external route primitives into host-only capture and castling choreography.

## Host-Only Capture And Castling Choreography

`offline_core/offline_motion.h/.cpp` composes the accepted board and external route planners into complete forward-move plans. It remains a pure host-only module and is not connected to the physical interpreter, turn coordinator, backend runtime, client, or ESP32 firmware.

`OfflineMotionPlanner::planMove(game, uci, context)` validates the move without modifying `OfflineGame`. The context supplies optional sensed occupancy, configured Z/I slots, and caller-owned occupied graveyard keys. Successful results include legal move metadata, the selected strategy, total route cost, combined raw and compressed paths, rejected strategy reasons, a proposed graveyard slot, and exact initial, per-phase, and final board occupancy.

Abstract phase kinds are:

- `QuietTransfer`
- `AttackerStage`
- `CapturedRemoval`
- `AttackerFinal`
- `CastleKing`
- `CastleRook`

Each phase owns exactly one accepted transfer or graveyard route and records its expected before/after occupancy. A plan is accepted only when its final phase occupancy exactly equals the occupancy produced by applying the legal move in a copied rules position.

Quiet moves delegate to the external route planner. Captures preserve the online order: direct removal followed by the attacker, stage-first when necessary, remove-first board/lane fallback, then the final board-staging fallback. En passant removes the pawn from `MoveInfo.capturedSquare`. Graveyard selection is a proposal only; planning never modifies the caller's occupied-slot keys. Castling moves the king first, plans the rook against the intermediate king position, and supports White/Black on both sides with board, lane, and lane-board routes.

Illegal UCI moves are rejected without mutating the supplied game. Legal promotions now retain `MoveInfo::promotion` and reuse the accepted quiet-transfer or capture choreography. `MotionPlanStatus::UnsupportedPromotion` remains in the public enum for source compatibility, but the planner no longer returns it for a legal, routable Q/R/B/N promotion.

The online JavaScript planner received one narrowly scoped correction in its deepest capture fallback: every stale undefined `removal` reference now uses the selected `fallbackRemoval`, and that same slot is reserved when the online fallback becomes executable. The branch was extracted into a test-exported composition helper so the previously latent failure is exercised directly; production strategy order and call sites are unchanged.

Run the motion regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-motion
```

The current 2026-07-14 acceptance run passes 30 shared C++/JavaScript fixtures. Coverage includes direct and lane quiet moves, sensed-occupancy route changes, efficient direct capture, staged capture, remove-first fallback, capture with an attacker lane route, en passant, full and blocked graveyards, all four castling directions, crowded rook lane re-entry, unsafe rook-route rejection, White/Black Q/R/B/N quiet promotions, capture promotions, blocked promotion routes, illegal moves, exact phase occupancy, graveyard candidates, rejected strategy order/reason categories, deterministic repetition, immutable inputs, and the corrected deepest online fallback.

The 100-game soak passed 7,952 plies with 1,257 captures, 42 castling moves, 4 en-passant moves, and 54 promotions in the unchanged coordinator/rules simulation. The complete foundation suite and `tools/verify-foundation.ps1` passed. Client build succeeded, lint retained the same eight existing warnings, and firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

Still deferred: motor primitives, LED choreography, undo/redo motion plans, persistence, online/offline switching, and ESP32 linking. Coordinator integration, transactional graveyard reservation, and opponent promotion choreography are now implemented by the later host-only milestones below.

## Host-Only Motion Execution Transactions

`OfflineTurnCoordinator` now connects engine results to `OfflineMotionPlanner` while `OfflinePhysicalController` remains the only owner of authoritative chess state. Engine results are checked against the latest stable sensed occupancy before routing. The coordinator tries the preferred move and unique ranked root candidates, rejects illegal or unroutable candidates, and selects the strongest routable move. Promotion candidates participate in the same selection. For non-mate candidates within five centipawns, route cost and then UCI order provide deterministic physical tie-breaking; mate rank is never traded for route convenience.

Each selected move creates a `MotionExecutionTransaction` containing the engine generation, transaction ID, preferred and selected moves, engine score, fallback reason, complete motion plan, current/verified phases, rejected candidates, and graveyard reservation state. Quiet moves, captures, en passant, and castling execute through their existing abstract phase sequence. A phase advances only after a successful hardware report whose occupancy exactly matches that phase's expected after-state. Failed unchanged phases are retryable, ambiguous occupancy enters recoverable `SyncWarning`, stale/out-of-order reports are rejected, and duplicate verified reports are idempotent.

Robot graveyard state is now transactional. A selected capture owns its proposed slot as `Pending` without adding it to occupied capacity. A successful `CapturedRemoval` report changes it to `Occupied`. If a later phase fails and the complete pre-move board is restored, the slot remains occupied until the caller explicitly confirms that the captured piece was removed from the unsensored graveyard. The transaction then returns to `Pending` for retry. The compatibility `completeOpponentExecution` path remains available as an explicit atomic hardware-success adapter and verifies all phases at once.

The rules FEN, side to move, history, and outcome remain unchanged during planning and every intermediate physical phase. Only the final verified phase commits the selected move. A completed move opens the human turn or enters `GameOver`. If every ranked candidate is physically blocked, the coordinator retains the engine result in `OpponentMotionBlocked` so the same result can be replanned after board or route recovery.

Run the dedicated regressions with:

```powershell
Set-Location .\app
npm run test:offline-motion-execution
```

The current 2026-07-14 acceptance run covers sensed-occupancy guards, strongest-routable fallback, the five-centipawn tie window, mate priority, quiet moves, direct/staged captures, en passant, all four castling directions, phase retry and confirmation, stale/duplicate reports, exact state immutability, graveyard `Free/Pending/Occupied` behavior, restored-piece release confirmation, full-graveyard fallback, atomic compatibility completion, Q/R/B/N promotion replacement, and promotion outcomes including check, checkmate, and stalemate.

The current 100-game soak passed 6,758 committed plies with 1,160 captures, 34 castling moves, 8 en-passant moves, 66 total promotions, and 45 completed opponent promotions. The complete foundation suite and `tools/verify-foundation.ps1` passed. Client build and zero-warning lint both succeeded, and firmware remained exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

Still deferred: firmware phase-report integration, motor and LED adapters, persistence, undo/redo motion transactions, and online/offline ownership switching.

## Host-Only Opponent Promotion Choreography

Legal opponent promotions now flow through the same engine candidate ranking, physical route planning, and phase verification as every other opponent move. Quiet promotions use `QuietTransfer`; capture promotions retain `CapturedRemoval` and `AttackerFinal`, including the proposed graveyard slot and its `Pending -> Occupied` transition. White and Black can promote to queen, rook, bishop, or knight. Planning remains deterministic and does not mutate the authoritative game.

After the final pawn-motion phase is verified, the coordinator enters `OpponentPromotionPending` instead of committing. The staged FEN, history, side to move, and result remain unchanged while a person replaces the pawn because the binary hall sensors can prove occupancy but cannot identify the replacement piece. The external caller can report:

- the promotion target temporarily empty through `processOpponentPromotionSnapshot`, producing `OpponentPromotionReplacementInProgress`;
- exact expected occupancy, producing `OpponentPromotionConfirmationReady`;
- any unrelated occupancy disturbance, producing recoverable `SyncWarning` with exact differences.

The occupancy-aware `confirmOpponentPromotion(piece, occupancy)` commits only when occupancy exactly matches the staged post-position and the normalized Q/R/B/N identity matches the engine-selected UCI move. Wrong pieces, invalid identities, and target-empty snapshots leave the same transaction pending. Recovery returns to replacement-in-progress or confirmation-ready without rerunning the engine or motion plan. The original one-argument method remains as a trusted compatibility adapter. Duplicate phase, snapshot, completion, and confirmation reports are idempotent.

Capture-promotion graveyard ownership is not rolled back while replacement is pending: once `CapturedRemoval` is verified, that slot remains occupied even if replacement later pauses for recovery. Atomic `completeOpponentExecution` also enters promotion pending and cannot bypass identity confirmation.

Regressions cover White/Black Q/R/B/N quiet promotions, capture promotions, board/lane/blocked routes, exact per-phase occupancy, strongest-routable selection, state immutability, target-empty replacement, unrelated-disturbance recovery, wrong identity and wrong occupancy, duplicate/stale reports, atomic completion, transactional graveyard state, and promotions producing check, checkmate, or stalemate. The quick integration suite forces all four opponent identities and the deterministic soak completes naturally selected opponent promotions.

Acceptance results on 2026-07-14:

- `npm run test:offline-motion`, `test:offline-coordinator`, `test:offline-motion-execution`, and `test:offline-integration` passed;
- the 100-game soak completed 6,758 plies and 45 opponent promotions without an unresolved transaction;
- `npm run test:foundation` and `tools/verify-foundation.ps1` passed;
- client lint has zero warnings/errors and the production build passes;
- unlinked firmware remains exactly 1,095,735 bytes flash and 51,856 bytes static RAM.

This remains host-only. Firmware prompts, LEDs, motors, voice guidance, promotion undo/redo, persistence, and online/offline ownership switching are still deferred.

## Offline Runtime Ownership Diagnostics

`offline_core/offline_ownership.h/.cpp` now provides the portable ownership state machine that will eventually arbitrate control between the backend and the local offline runtime. It is host-tested independently of Arduino and has these states:

- `BootProbe`: wait up to 10 seconds for the backend;
- `OnlineOwned`: normal backend ownership;
- `OnlinePaused`: an active online game lost its server, so new commands are blocked while an already-running motion may finish;
- `OfflineIdle`: no online game needs recovery and local control may begin at a stable boundary;
- `ReconnectPending`: require two matching successful heartbeats before transferring ownership;
- `RecoveryRequired`: server/session identity changed during an active or paused game, so automatic continuation is unsafe.

The defaults are a one-second heartbeat interval, one-second HTTP read and connect timeouts, three consecutive failures before declaring the server unavailable, and two consecutive successes before reconnection. Timer arithmetic is safe across the ESP32 `millis()` wraparound. A changed server instance may be adopted after two heartbeats only when there is no active game, the local board is stable, and the remote heartbeat reports `safeToSwitch`; active or paused games require explicit recovery. A future offline game can continue through `ReconnectPending` until its next exact stable turn boundary, where the manager emits a handoff-required decision. No FEN/history/graveyard transfer is invented in this milestone.

The backend exposes read-only `GET /api/physical/heartbeat` with protocol version, process-unique server ID, physical-session generation, active phase, session-active state, and transition-safety state. The server ID remains stable for one Node process. The generation increments only when `/api/physical/start` creates a new physical session. Regression tests prove heartbeat reads do not mutate the physical state or command queue.

Run the host regression directly with:

```powershell
Set-Location .\app
npm run test:offline-ownership
```

`ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS` is independent from the existing resource diagnostic and defaults to `0`. The enabled ESP32 build keeps sensor scanning and heartbeat HTTP traffic active, does not consume normal movement commands, rejects motion at the queue and executor boundaries, and continuously holds the magnet LOW. `[OWNERSHIP_DIAG]` JSON reports transitions, heartbeat latency, task placement, motor lock, sensor timing, and synthetic transition checks. Board corners briefly show green online, amber offline, and blue/amber while reconnecting; paused/recovery states use persistent red warning patterns. Offline gameplay remains disabled.

`tools/verify-offline-ownership.ps1` compiles production and diagnostic variants, enforces the exact production baseline, optionally uploads and validates diagnostic telemetry, and restores production firmware in a `finally` block. `tools/verify-foundation.ps1` includes the compile-only ownership gate.

Acceptance results on 2026-07-15:

- the accepted online baseline completed a full physical game with 12 verified robot replies and checkmate, with no motion or synchronization errors;
- the 100-game soak passed 6,758 plies, 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and every injected recovery;
- `npm run test:foundation` and `tools/verify-foundation.ps1` passed; client build and zero-warning lint passed;
- production remains exactly 1,042,543 bytes flash and 47,128 bytes static RAM;
- the ownership diagnostic is 1,037,391 bytes flash and 47,200 bytes static RAM, leaving 2,108,337 bytes of application-partition headroom;
- the resource diagnostic with embedded ownership smoke is 1,244,715 bytes flash and 51,248 bytes static RAM, leaving 1,901,013 bytes of application-partition headroom;
- the final ownership hardware run recorded 2,409 sensor scans, a 10 ms maximum sensor gap, and a 42 ms maximum live heartbeat duration;
- a real backend outage produced three failed probes of approximately 1,003 ms each, then `OnlineOwned -> OfflineIdle`; restart produced `OfflineIdle -> ReconnectPending -> OnlineOwned` after two successes;
- the resource diagnostic, now including an embedded ownership smoke test, passed with 151,308 bytes free internal heap, a 139,252-byte largest internal block, 7,433,348 bytes free PSRAM, 22,396 bytes task stack headroom, a 2 ms maximum sensor gap, and 50 successful HTTP polls;
- both diagnostic sessions automatically restored the normal production firmware on COM11.

Hardware testing exposed and fixed two diagnostic-path issues before acceptance. A rapidly restarted idle server originally triggered `RecoveryRequired` even without an active game; it now uses the two-heartbeat idle adoption path while retaining the strict active-game identity guard. ESP32 `HTTPClient::setTimeout` did not cover TCP connection establishment, so `setConnectTimeout` is now configured separately and heartbeat latency is enforced by the verifier. The serial verifier also accepts safety fields repeated in the final summary because the one-time startup line can precede monitor attachment.

Still deferred: actual offline coordinator input from sensors, offline engine turns, route/motion execution, setup calibration, ownership persistence, state-transfer endpoints, offline LEDs beyond diagnostic status, offline undo/redo, and production online/offline switching. The next isolated milestone will connect stable sensor snapshots to the offline coordinator in a read-only diagnostic mode that can produce engine and motion plans but cannot move pieces.

## Embedded Read-Only Offline Runtime Diagnostics

`offline_core/offline_runtime.h/.cpp` now provides a portable, single-turn runtime around the accepted ownership manager and turn coordinator. It defaults to the standard position, Human White, a three-second/depth-12 engine search, the current Z/I coordinates, and an empty robot graveyard. Its states are `Disabled`, `WaitingForSetup`, `HumanTurn`, `EngineSearchNeeded`, `PlanReady`, `SyncWarning`, `HandoffPending`, `GameOver`, and `Error`.

The runtime arms only after exact standard occupancy remains stable for 500 ms. Stable sensor changes are passed to `OfflineTurnCoordinator`; duplicate snapshots are idempotent, incorrect setup reports missing/extra squares, cancelled lifts restore `HumanTurn`, and ambiguous occupancy enters recoverable synchronization warning. Search remains split-phase so the caller can continue scanning sensors. The result is submitted with the latest sensed occupancy, preventing a stale or disturbed board from producing a motion plan.

This milestone deliberately stops at `PlanReady`. A legal human move is committed, but the selected opponent move remains a preview in `OpponentMoveReady`: no execution begins, no phase is verified, no graveyard slot becomes occupied, and the authoritative FEN, history, and side to move remain at the post-human position. The runtime freezes there and reports later sensor changes without advancing the game.

Reconnect handling follows the accepted ownership boundary. A confirmed server reconnect before the human move produces `HandoffPending`; a reconnect after the human move does not discard or complete the staged offline turn. Actual FEN/history/graveyard transfer remains deferred.

`ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS` is default-off and mutually exclusive with ownership/resource diagnostics. Its ESP32 build:

- initializes the embedded chess tables in PSRAM;
- scans and publishes complete debounced occupancy snapshots on core 1 through a synchronized mailbox;
- runs ownership heartbeat handling on core 0 at priority 1;
- runs the offline runtime and engine worker on core 0 at priority 0;
- rejects command polling and every motion entry point, holds the magnet LOW continuously, and uses only existing diagnostic status colors;
- emits `[OFFLINE_RUNTIME_DIAG]` JSON for setup differences, accepted human move, engine telemetry, candidate selection, route/graveyard metadata, every abstract motion phase, resource use, timing, and safety checks.

Run the host regression directly with:

```powershell
Set-Location .\app
npm run test:offline-runtime
```

Compile or perform the guarded USB test with:

```powershell
.\tools\verify-offline-runtime.ps1
.\tools\verify-offline-runtime.ps1 -UploadPort COM11 -SerialTimeoutSeconds 360
```

The verifier always restores production firmware in `finally`, including timeout and failure paths. It checks the exact production baseline, diagnostic partition headroom, ownership transition to `OfflineIdle`, setup arming, the human move, search telemetry, complete plan output, non-commit invariants, resource thresholds, sensor/heartbeat progress, motor lock, and magnet safety.

Acceptance results on 2026-07-15:

- `npm run test:offline-runtime`, the complete `npm run test:foundation`, the 100-game/6,758-ply soak, client build, and zero-warning lint passed;
- production remains byte-identical at 1,042,543 bytes flash and 47,128 bytes static RAM;
- runtime diagnostics compile at 1,256,919 bytes flash and 51,536 bytes static RAM, leaving 1,888,809 bytes of application-partition headroom;
- resource diagnostics, now including a read-only runtime smoke, compile at 1,260,343 bytes flash and 51,248 bytes static RAM;
- ownership diagnostics compile at 1,037,847 bytes flash and 47,232 bytes static RAM;
- the updated resource diagnostic passed on COM11 with the read-only runtime preview, 151,468 bytes free internal heap, a 139,252-byte largest internal block, 7,433,348 bytes free PSRAM, 22,208 bytes task-stack headroom, a 2 ms maximum sensor gap, and 49 successful HTTP polls;
- the updated ownership diagnostic passed on COM11 with 2,408 sensor scans, an 11 ms maximum sensor gap, two successful heartbeats, and 44 ms maximum heartbeat latency;
- the final guarded COM11 runtime run completed `BootProbe -> OfflineIdle -> WaitingForSetup -> HumanTurn -> EngineSearchNeeded -> PlanReady`: it accepted physical `g2g4`, searched for 3,000 ms to depth 3 across 18,688 nodes, selected `d7d5`, and emitted one complete quiet-transfer phase;
- a transient sensed-occupancy mismatch after search entered `SyncWarning` as designed, then recovered to the same staged plan when the board stabilized without rerunning the engine;
- the runtime hardware run recorded 1,501 sensor scans and three heartbeat attempts during search, a 2 ms maximum sensor gap, 133,340 bytes free internal heap, a 106,484-byte largest internal block, 7,430,464 bytes free PSRAM, and 26,704 bytes task-stack headroom;
- motion-plan freeze, unchanged motors, magnet LOW, search deadline, memory, sensor, and heartbeat checks all passed; `opponentMoveCommitted` remained false;
- production firmware was automatically restored after every hardware diagnostic.

The milestone hardware gate is accepted. Still deferred: simulated or real phase execution, motors, gameplay LEDs, promotion prompts, persistent graveyard state, reconnect state transfer, offline undo/redo, and production ownership switching. The next isolated milestone is a motor-locked phase-execution adapter that consumes a staged plan and generates simulated phase reports without enabling physical movement.

## Motor-Locked Offline Phase Execution Adapter

`offline_core/offline_phase_execution.h/.cpp` now provides the portable boundary between a staged `OfflineReadOnlyRuntime` plan and a future hardware executor. The adapter does not contain motor logic. It exposes one current phase at a time and wraps each request in a token containing the motion transaction ID, phase index, and monotonically increasing attempt number.

The execution sequence is explicit:

1. `begin()` asks the coordinator to start the already staged transaction.
2. `takeCurrentRequest()` marks exactly one phase request as awaiting a report.
3. `submitReport()` accepts only the exact current token and reported occupancy.
4. A successful exact after-checkpoint advances to the next phase; an unchanged failed phase becomes retryable with a new attempt token.
5. Ambiguous occupancy enters recovery. The caller can report a restored checkpoint, explicitly release a restored captured piece from its unsensored graveyard slot, or complete pending promotion replacement.
6. The coordinator commits FEN/history only after every phase and any required promotion identity are verified.

Stale transaction, phase, and attempt tokens are rejected. Accepted duplicates are idempotent, reports cannot skip or reorder phases, and reaching an after-checkpoint without an explicit success report does not advance state. Graveyard ownership remains coordinator-controlled: a capture slot starts `Pending`, becomes `Occupied` after verified captured removal, and needs explicit release confirmation if the captured piece is restored during recovery. Q/R/B/N promotions remain pending until exact occupancy and the selected identity both match.

`OfflineReadOnlyRuntime` grants narrow friend access only to this adapter. Its existing public coordinator accessor remains const, and normal read-only `PlanReady` behavior is unchanged unless a caller explicitly constructs and starts the adapter.

Run the host regression directly with:

```powershell
Set-Location .\app
npm run test:offline-phase-execution
```

The host suite covers quiet phases, controlled unchanged failure/retry, attempt-token freshness, stale/duplicate/out-of-order reports, recovery through before and after checkpoints, captures and graveyard transitions, restored-slot release, en passant, all castling directions, Q/R/B/N promotion replacement, state immutability before final verification, game-over commit, and deterministic repetition. It is included in `npm run test:foundation`.

`ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS` defaults to `0` and is mutually exclusive with resource, ownership, and read-only runtime diagnostics. The enabled ESP32 build reuses the accepted setup, sensor mailbox, heartbeat, PSRAM chess tables, engine search, and route-plan generation. After `PlanReady`, it:

- reports the first phase as a controlled failure with exact before-occupancy;
- verifies the same transaction/phase is reissued with an incremented attempt;
- reports every phase successful with synthetic expected occupancy;
- simulates matching promotion replacement when required;
- verifies the opponent move commits internally;
- compares the untouched real sensor snapshot with the post-human board and freezes.

Synthetic checkpoints are never written to the sensor mailbox or ownership-safety input. Command polling, homing, queueing, and motion execution remain blocked, while the magnet is continuously forced LOW. `[OFFLINE_PHASE_DIAG]` JSON includes plan and route metadata, request tokens, reports, retries, graveyard state, promotion events, committed FEN, actual-versus-simulated occupancy, timing, resources, and safety checks.

Compile or perform the guarded USB diagnostic with:

```powershell
.\tools\verify-offline-phase-execution.ps1
.\tools\verify-offline-phase-execution.ps1 -UploadPort COM11 -SerialTimeoutSeconds 360
```

The verifier restores production firmware in `finally`. It requires the controlled retry, ordered phase completion, internal commit, unchanged physical board, unchanged motors, magnet LOW, blocked command consumption, search within 3,100 ms, sensor gaps below 25 ms, heartbeat progress during search, and all accepted memory thresholds.

Automated acceptance results on 2026-07-15:

- the dedicated adapter suite, complete foundation suite, and 100-game/6,758-ply soak passed;
- the soak covered 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and all injected recoveries;
- client build and zero-warning lint passed;
- production remains exactly 1,042,543 bytes flash and 47,128 bytes static RAM;
- the phase diagnostic compiles at 1,286,427 bytes flash and 51,536 bytes static RAM, leaving 1,859,301 bytes of application headroom;
- the read-only runtime diagnostic compiles at 1,257,315 / 51,536, ownership at 1,037,847 / 47,232, and resource diagnostics with an adapter smoke at 1,282,727 / 51,248;
- `tools/verify-foundation.ps1` passes with every diagnostic compile gate.

The guarded COM11 hardware run is accepted. It detected physical `g1f3`, searched for 3,011 ms to depth 4 across 19,392 nodes, and selected quiet reply `d7d5`. Phase 0 attempt 1 was deliberately reported failed at unchanged occupancy; the adapter issued attempt 2 for the same transaction and phase, accepted its simulated success, and committed the exact previewed FEN internally. The real board remained at the post-human occupancy. Motors were unchanged, the magnet stayed LOW, command consumption remained blocked, and production firmware was restored automatically.

Hardware metrics were a 2 ms maximum sensor gap, 1,506 sensor scans and three heartbeat attempts during search, 131,136 bytes free internal heap, a 106,484-byte largest internal block, 7,430,464 bytes free PSRAM, and 17,528 bytes task-stack headroom. Every telemetry, timing, memory, retry, ordering, isolation, and safety assertion passed.

Real motor primitives, gameplay LEDs, persistent graveyard state, reconnect transfer, offline undo/redo, and production automatic switching remain deferred. The next guarded milestone should translate one accepted quiet phase into real travel/pickup/drag/drop primitives before enabling captures or multi-phase physical motion.

## Guarded Real Quiet-Move Diagnostics

`offline_core/offline_quiet_motion.h/.cpp` now provides the first portable compiler from a verified phase request to concrete hardware primitives. It accepts exactly one ordinary `QuietTransfer` whose route remains on the 8x8 board and emits ordered `Travel`, `Pickup`, compressed `Drag`, `Drop`, and `Verify` operations. Direct pawn routes and all accepted board-only route modes are supported. Consecutive squares in the same direction remain one continuous drag segment, and only the final drag is marked for the existing 250-step board-drop compensation.

The compiler rejects captures, en passant, castling, promotion, Z/I lanes, external coordinates, graveyard state, malformed paths, occupied route squares, and any before/after occupancy that is not the exact quiet move transition. Compilation is deterministic and does not modify the phase request. The phase adapter now carries the already validated `MoveInfo`, allowing the compiler to enforce this boundary without re-parsing or mutating chess state. `kQuietMotionMaximumAttempts` fixes the automatic hardware limit at two attempts.

Run the host regressions directly with:

```powershell
Set-Location .\app
npm run test:offline-quiet-motion
```

`ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS` defaults to `0` and is mutually exclusive with every earlier diagnostic. The enabled build reuses the accepted ownership manager, stable-snapshot mailbox, runtime, engine, planner, phase adapter, square coordinates, and motion speed profiles. External HTTP motion, diagnostics motion, normal homing, and queue execution remain blocked. A core-0 worker stages the transaction while the existing core-1 hardware loop alone services the guarded hardware mailbox.

The hardware diagnostic performs bounded homing before setup can arm. Each axis has a 20-second approach deadline, debounced switch sampling, bounded release movement, active sensor scans, and magnet-LOW enforcement. Logical `(0,0)` is assigned only after both switches are proven and the accepted 100-step calibrated release point is restored. It does not call the existing unbounded `homeGantry()` path.

Before motion, the real stable occupancy must exactly equal the phase's expected-before checkpoint. Fast magnet-off travel goes to the source, pickup authorizes the magnet only inside the executor, slow magnet-on drag follows compressed board waypoints, the final board drag receives 250-step compensation, and drop immediately revokes magnet authorization. No nudge recovery is available. Full expected-after occupancy must settle within 1.5 seconds before a success report can commit the opponent move.

An unchanged failed attempt is sent through the accepted adapter retry path once, producing a new attempt token. A second failure is final. Any partial or ambiguous occupancy enters synchronization warning and freezes without another motion. Every success, failure, timeout, task exit, and normal loop iteration outside authorized pickup/drag forces the magnet LOW.

Diagnostic JSON is serialized through a dedicated FreeRTOS mutex. This prevents ownership heartbeat output from interleaving with longer quiet-motion records on USB Serial. The lock exists only in diagnostic builds; production code and behavior remain unchanged.

Compile or run the guarded USB gate with:

```powershell
.\tools\verify-offline-quiet-motion.ps1
.\tools\verify-offline-quiet-motion.ps1 -UploadPort COM11 -SerialTimeoutSeconds 360
```

The verifier compiles both variants, optionally uploads and parses the physical run, and restores production firmware in `finally`. It requires bounded home, ordered primitives, real motor and magnet activity, exact occupancy, internal FEN commit, magnet LOW at completion, blocked external commands, memory/timing limits, and a parseable summary.

Automated acceptance on 2026-07-15 passes `npm run test:offline-quiet-motion`, the complete foundation suite, client build, zero-warning lint, and every firmware compile gate. Production remains exactly 1,042,543 bytes flash and 47,128 bytes static RAM. The final guarded quiet-motion diagnostic is 1,305,695 / 51,952 with 1,840,033 bytes of application headroom. Resource, ownership, runtime, and simulated-phase diagnostics also compile with the shared telemetry lock.

The guarded COM11 acceptance run passed end to end. Bounded homing succeeded, physical `g1f3` was accepted, and the engine selected `d7d5` after a 3,003 ms depth-4 search across 19,392 nodes. The robot executed the direct quiet move, final occupancy exactly matched the preview, the adapter committed the expected FEN, and production firmware was restored automatically. A prior successful run also exercised the allowed recovery path: attempt one left occupancy unchanged and attempt two completed the same tokenized phase. No third attempt was made.

Final hardware metrics were a 5 ms maximum sensor gap, 1,502 sensor scans and three heartbeat attempts during search, 130,544 bytes free internal heap, a 104,436-byte largest internal block, 7,430,496 bytes free PSRAM, and 16,808 bytes task-stack headroom. The magnet activated only inside pickup/drag and was LOW in the final report. Setup also demonstrated recoverable feedback for an intermittently detected `d7` pawn before the accepted move; no warning remained when execution began. The complete serial transcript is retained locally under `tmp/offline-quiet-motion-hardware-2026-07-15.log`.

Still deferred: real captures, en passant, castling, promotions, Z/I travel, graveyard drops, gameplay LEDs, persistence, reconnect state transfer, offline undo/redo, and production automatic offline ownership.

## Guarded Real Offline Capture Diagnostics

`offline_core/offline_capture_motion.h/.cpp` adds the first portable compiler for a real multi-phase offline capture. It accepts one phase request at a time and deliberately supports only `CapturedRemoval` followed by `AttackerFinal`. Captured removal compiles to board travel, pickup, compressed board drag, one external-coordinate drag, drop, and board verification. Attacker final reuses the accepted quiet-motion compiler for a board-only transfer. The graveyard leg never receives board-drop compensation; exactly the final attacker drag onto the chessboard is marked for the existing 250-step overshoot.

The compiler verifies phase tokens and metadata, exact before/after occupancy, a `Pending` capture slot for removal, an `Occupied` slot for attacker final, clear route squares, finite external coordinates, and matching graveyard labels/coordinates. It rejects staging, en passant, castling, promotion, attacker lane routing, malformed paths, and unexpected phase kinds. Compilation is deterministic and leaves requests unchanged. `kCaptureMotionMaximumAttempts` limits each physical phase to two attempts.

The controlled physical fixture is intentionally small:

- White king `e1`;
- White rook `e2`;
- Black king `a8`;
- Black pawn `d5`;
- Human move `e2e4` (`Re4`);
- deterministic opponent move `d5e4`;
- captured rook route `e4 -> h4 -> I4`, where I4 is `(17600, -350)`;
- attacker route `d5 -> e4`;
- final FEN `k7/8/8/8/4p3/8/8/4K3 w - - 0 2`.

The original proposed black king square `e8` was invalid because the rook on `e2` already checks `e8` while the FEN says White is to move. Moving only the black king to `a8` makes the fixture legal while preserving the intended human move, engine capture, graveyard route, and final attacker movement.

`ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS` defaults to `0` and is mutually exclusive with all earlier diagnostics. The enabled ESP32 build reuses bounded homing, ownership heartbeats, stable sensor snapshots, PSRAM chess tables, the three-second engine search, motion planning, phase tokens, speed profiles, and the guarded core-1 hardware mailbox. It blocks normal HTTP motion, command polling, diagnostic movement, and unbounded homing. Magnet HIGH is authorized only while a compiled pickup/drag program is active and is forced LOW after every phase, failure, timeout, abort, and task exit.

The runtime requires exact fixture occupancy for 500 ms, accepts the physical rook move, and refuses execution unless the engine and planner produce exactly `d5e4`, strategy `capture-direct-after-removal`, graveyard `I4`, and two ordered phases. It verifies real occupancy before and after each phase. Verified removal changes I4 from `Pending` to `Occupied`; chess FEN/history remain unchanged until the attacker phase also verifies. An unchanged failure can retry once with the adapter's incremented token. A partial or ambiguous board enters synchronization warning and freezes. Nudge recovery and automatic restoration are not available in this diagnostic.

Run the host regression or compile/run the USB gate with:

```powershell
Set-Location .\app
npm run test:offline-capture-motion

Set-Location ..
.\tools\verify-offline-capture-motion.ps1
.\tools\verify-offline-capture-motion.ps1 -UploadPort COM11 -SerialTimeoutSeconds 300 -SerialLogPath tmp/offline-capture-motion-hardware-2026-07-15.log
```

The USB verifier compiles production and diagnostic images, validates structured `[OFFLINE_CAPTURE_MOTION_DIAG]` and ownership telemetry, and restores production firmware in `finally` after success, failure, or timeout.

Automated acceptance on 2026-07-15 passes the focused capture regression, the complete foundation suite, the 100-game/6,758-ply soak, client build, zero-warning lint, and every existing firmware compile gate. The soak covered 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and all injected recoveries. Production remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM. The final capture diagnostic compiles at 1,315,931 / 52,032 with 1,829,797 bytes of application-partition headroom.

Physical USB acceptance passed on COM11. Bounded homing succeeded, physical `e2e4` was accepted, and the engine selected `d5e4` after a 3,000 ms depth-7 search across 45,824 nodes. The robot moved the rook through `e4 -> h4 -> I4`, verified I4 as occupied transactionally, moved the pawn `d5 -> e4`, matched exact occupancy, and committed FEN `k7/8/8/8/4p3/8/8/4K3 w - - 0 2`. The final report recorded the magnet LOW, a 5 ms maximum sensor gap, 1,501 search-time sensor scans, three search-time heartbeat attempts, 138,884 bytes free internal heap, an 86,004-byte largest internal block, 7,430,464 bytes free PSRAM, and 19,464 bytes task-stack headroom. Production firmware was restored automatically and the Serial evidence is retained locally at `tmp/offline-capture-motion-hardware-2026-07-15.log`.

Two preliminary mechanically successful runs exposed diagnostic-only memory-lifetime issues: copied plan/state objects and the last runtime update remained alive until resource measurement. Narrowing those lifetimes raised free internal heap and the largest contiguous block above their accepted thresholds without changing production behavior. The final run also exposed a strict-mode verifier assumption that every execution event contained `graveyardStateAfter`; the parser now checks field presence and validates the saved passing telemetry correctly.

Still deferred: generalized captures, staged capture choreography, en passant, castling, promotions, arbitrary Z/I transit, gameplay LEDs, persistent graveyard state, reconnect transfer, offline undo/redo, and production automatic offline ownership.

## Guarded Real Offline Staged-Capture Diagnostics

`OfflineCaptureMotionCompiler` now supports the accepted three-phase `CaptureStageFirstBoard` shape while preserving the existing direct-capture path. `AttackerStage` and staged `AttackerFinal` are compiled as ordinary board-only transfers against their exact phase-local occupancy. Staging and final placement receive the existing final board-drop overshoot; captured removal to an external graveyard coordinate does not.

The controlled fixture is:

- initial FEN `k7/8/8/8/8/8/1NPPbP2/2B2n1K w - - 0 1`;
- human move `b2d1` (`Nd1`);
- deterministic opponent move `e2d1` (`Bxd1`);
- strategy `capture-stage-first-board`, staging square `e1`, and graveyard slot `I4` at `(17600, -350)`;
- phase 0: bishop `e2 -> e1`;
- phase 1: knight `d1 -> e2 -> f3 -> g4 -> h4 -> I4`, compressed to board waypoints `d1 -> g4 -> h4` before the external drop;
- phase 2: bishop `e1 -> d1`;
- final FEN `k7/8/8/8/8/8/2PP1P2/2Bb1n1K w - - 0 2`.

The compiler validates tokens, exact before/after occupancy, phase source and destination, graveyard state, and board-only attacker routes. Direct captures remain supported. En passant, castling, promotion, attacker lane routing, malformed staging, and unexpected phases remain rejected. Every phase keeps the accepted two-attempt maximum; a retry is available only when sensors prove that the phase left the exact before-state.

`ENABLE_OFFLINE_STAGED_CAPTURE_MOTION_DIAGNOSTICS` defaults to `0`. In the enabled build it selects the staged fixture and telemetry while reusing the accepted capture diagnostic's bounded homing, heartbeat, sensor mailbox, engine/coordinator transaction, guarded core-1 executor, and magnet authorization. Normal HTTP movement and unbounded homing remain blocked. I4 becomes transactionally occupied only after captured removal verifies, and chess FEN/history remain unchanged until attacker final verifies.

Run the host regression or compile/run the USB gate with:

```powershell
Set-Location .\app
npm run test:offline-staged-capture-motion

Set-Location ..
.\tools\verify-offline-staged-capture-motion.ps1
.\tools\verify-offline-staged-capture-motion.ps1 -UploadPort COM11 -SerialTimeoutSeconds 300 -SerialLogPath tmp/offline-staged-capture-motion-hardware-2026-07-15.log
```

The USB verifier checks the exact engine move, strategy, staging square, all raw/compressed paths, primitive order, overshoot policy, token order, graveyard transition, final occupancy/FEN, safety/resource thresholds, and production restoration in `finally`.

Automated host acceptance on 2026-07-15 passes the staged regression, the complete foundation suite, and the deterministic 100-game/6,758-ply soak. The soak again covered 1,160 captures, 34 castlings, 8 en-passant moves, 66 promotions, and all injected recoveries. Production remains exactly 1,042,543 bytes flash / 47,128 bytes static RAM. The staged diagnostic compiles at 1,316,795 / 52,032 with 1,828,933 bytes of application-partition headroom. The accepted direct-capture diagnostic also still compiles at 1,316,631 / 52,032.

Physical COM11 acceptance passed on 2026-07-16. Bounded homing succeeded, physical `b2d1` was accepted, and the engine selected `e2d1` after a 3,004 ms depth-5 search across 32,832 nodes. The robot staged the bishop `e2 -> e1`, moved the knight through `d1 -> g4 -> h4 -> I4`, then moved the bishop `e1 -> d1`. All three phase tokens verified on their first attempt, I4 changed `Pending -> Occupied`, exact final occupancy matched, and the coordinator committed FEN `k7/8/8/8/8/8/2PP1P2/2Bb1n1K w - - 0 2`.

The final report recorded the magnet LOW, a 5 ms maximum sensor gap, 1,502 search-time sensor scans, three search-time heartbeat attempts, 143,436 bytes free internal heap, an 81,908-byte largest internal block, 7,432,264 bytes free PSRAM, and 18,416 bytes task-stack headroom. Every routing, primitive-order, overshoot, graveyard, occupancy, timing, memory, and safety assertion passed. Production firmware was restored automatically, and Serial evidence is retained locally at `tmp/offline-staged-capture-motion-hardware-2026-07-16.log`.

The staged-capture milestone is accepted. Arbitrary active-piece Z/I lane motion remains the next isolated gate. En passant, castling, promotions, gameplay LEDs, persistent graveyard state, reconnect transfer, offline undo/redo, and production automatic switching remain deferred.
