# Offline Chess Development

## Current Baseline

The active implementation is server-owned online physical chess. The ESP32 firmware scans sensors, drives LEDs and motion, executes backend motion plans, and reports verification results over WiFi HTTP. Firmware uploads are USB-only. It does not currently contain an active offline chess engine or offline game controller.

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
