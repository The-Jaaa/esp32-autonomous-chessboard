# Autonomous exhibition game

## Operation

The main page's **Autonomous Game** panel runs Talâ€“Shamkovich, Kiev 1965, then physically reverses every completed transfer and repeats. The game has 83 plies, both sides castle, 15 captures, and White's final `fxg8=Q+`. The historical record ends with Black's resignation; the controller does not invent a checkmate continuation.

The PGN is stored in `app/exhibition/tal-shamkovich-1965.pgn`. `engine-review.json` records a Stockfish 18 review of all 83 pre-move positions using the existing Mentor engine service at 200 ms per position. It is a tactical review, not a claim that every historical move is best. In particular, the final physical promotion matches the engine's preferred move. The unannotated moves and headers came from the [Tal game collection](https://github.com/brianerdelyi/ChessPGN/blob/main/Life%20and%20Games%20of%20Mikhail%20Tal.pgn); book commentary and variations are not included.

Before Start:

1. Arrange the correct original pieces in their normal starting positions, with all 16 calibrated graveyard slots empty.
2. Keep the gantry clear and confirm both conditions with the checkbox. Occupancy sensors cannot identify piece types or inspect the graveyard.
3. Start music and Spectrum if desired, then click **Start Autonomous Game**. Starting the game preserves the current music/visual configuration; it does not select a song or force Spectrum on.

Start requires fresh firmware capability and idle/magnet-off telemetry, no existing physical/Mentor activity, and exact starting occupancy. All forward routes and the complete transfer ledger are compiled before any command is queued. The fixed capture allocation uses the production `DEFAULT_GRAVEYARD_SLOTS`; normal-game custom slot settings do not override this reviewed exhibition layout.

There is no intentional gap between verified transfers. **Pause** finishes the current individual transfer before holding, so a paused position can be partway through castling or a temporary-clearance operation. **Resume** continues only from fresh matching occupancy. **Restore & Exit** reverses the completed prefix and leaves the board available rather than repeating.

## Captures, promotion, and return

All 32 original physical pieces have stable identities named after their initial squares. Both colours' captures use tracked storage. Script-wide slot assignment avoids consuming bays needed by later captures; greedy nearest-slot allocation was rejected by preflight. The compiled sequence has 114 piece transfers and uses at most 15 storage slots.

After Black captures White's original queen on e3, the final promotion captures the knight on g8. The robot stages the promoting pawn on an empty square, retrieves the white queen from its recorded bay, places it on g8, then parks the pawn in the queen's vacated bay. The ledger records which pawn the physical queen now represents. No spare queen or manual exchange is required.

Each transfer commits its identity/storage change only after its result matches the expected board. Restoration reverses the recorded waypoint sequence and identity snapshots in strict reverse order, including temporary pawn clearances, castling, and the three promotion-exchange transfers. Reversing a route is valid because the other pieces are restored to precisely the arrangement in which that transfer was planned. Graveyard endpoints are unsensed: their locations are inferred from acknowledged execution, not independently verified by sensors.

Repeat requires starting occupancy, the complete initial physical-identity ledger, and no tracked storage/staging occupancy. No human-restoration fallback is used during an automatic cycle.

## Lift-to-takeover and recovery

During automatic restoration, lift a piece outside the transaction's protected squares to request takeover. Protected squares include all source, destination, route, and staging squares for that original move. A lift inside this set is not a valid gesture. The **Manual Takeover** button provides the same handover without a gesture and is also available during playback.

Hold the lifted piece and wait. The robot finishes the active piece transfer, verifies its placement, switches the magnet off, and homes. Only **Manual reset ready** means the handover is complete. Then reset the remaining pieces yourself. The controller stays available and does not resume restoration or restart the script. Accidental lifts have the same effect; the sensors cannot infer intent.

Unexpected additions, uncertain placements, failed homing, or failed moves hold the run instead of homing blindly or replaying a command. Recovery uses amber light indications, including when the normal visual setting is off. For an unrecoverable/uncertain transfer, manually reconcile the entire starting position and empty storage, then use **Confirm Manual Reset**. This is an operator recovery action, not automatic correction of piece identities.

Each homing axis has a 15-second timeout. A failed home latches a movement fault until a successful re-home. Acknowledged homing is used for autonomous startup and takeover.

## Concurrency, protocol, and restart

LED rendering has one owner: a low-priority core-0 task. Spectrum analysis is also pinned to core 0, below the audio coordinator. The existing stepper loop remains on core 1; it no longer renders the strip. Ordinary move effects are suppressed during autonomous motion, while recovery temporarily overrides Spectrum. Obsolete spectrum analysis frames remain bounded and droppable.

- `GET /api/exhibition/autonomous/status` returns run identity/revision, motion state, progress, current transfer, expected occupancy, physical tokens, and the logical board/history.
- `POST /api/exhibition/autonomous/start` requires `confirmedStartingPieces: true` and `confirmedEmptyGraveyard: true`.
- `POST /api/exhibition/autonomous/control` accepts `action`, `runId`, and `expectedRevision`. Actions are `pause`, `resume`, `restore-and-exit`, `manual-takeover`, and the guarded recovery action `confirm-manual-reset`.
- `GET /api/exhibition/autonomous/script` serves the PGN. Socket.IO `autonomous-status` updates the UI.
- Firmware reports `concurrentSpectrumSupported`, `controlledTakeoverSupported`, and `acknowledgedHomingSupported`. Autonomous commands carry a run ID, increasing revision, expected occupancy, and protected squares.
- A firmware-local lift latch prevents another restoration transfer after takeover even before the backend sees it. Duplicate/stale revisions cannot re-execute transfers. Result reports are retained across transient transport/server failures; terminal 4xx responses discard obsolete reports.
- Only one transfer is in flight. After a network interruption, the controller reconciles the acknowledged result and fresh board before scheduling more. An interrupted backend or firmware run requires operator reconciliation; it is not resumed from guessed state.

Existing light-only mode and normal/Mentor gameplay remain separate. The standard gameplay Start action still stops light-only exhibition mode; autonomous Start preserves it. Gantry diagnostics, LED calibration, and other physical session starts are rejected while autonomous motion owns the board.

## Verification and acceptance

Run `npm run test:autonomous` from `app`. It covers legality and storage, all forward/reverse identity transitions, three complete simulated cycles, takeover at all 114 reverse boundaries, failure/duplicate/stale/disconnect cases, portable firmware-guard tests, and browser controls at 1440Ã—900 and 1920Ã—1080. The existing foundation script includes these checks.

Software simulation does not prove physical clearance, reliable magnetic pickup, motor timing, or uninterrupted audio under simultaneous load. Real-board acceptance must record repaired homing, quiet moves, all captures/castling/promotion exchanges, at least three complete unattended cycles, takeover at multiple restoration stages, Pause/Resume, Restore & Exit, displacement recovery, and reconnection without duplicated movement. Keep machine-readable hardware observations in ignored `logs/` and record the actual outcome below.

## Verification results — 2026-11-03

The complete software gate passed (`logs/demo-baseline-20261103-180502.json`): physical/settings, complete Mentor and browser regressions, client build/lint, autonomous controller/guard/browser checks, Spectrum and Exhibition suites. Spotify relay/mixer regressions also passed separately. A final targeted autonomous rerun covers the drop-centering metadata correction below.

The production firmware compiled at **1,906,879 bytes flash** and **101,272 bytes static RAM**. The exact-size gate was updated to those measured values. It was uploaded on COM9 with flash hash verification, and the board reconnected reporting all three new capabilities. No Wi-Fi credentials or existing unrelated workspace changes were overwritten.

The first real-board run started after all 32 starting squares were detected. Acknowledged homing completed; e4, e5, and temporary h2–h4 clearance verified. The g1–h2–g3–f3 knight transfer then produced an inconsistent full-board result and the controller held in recovery with no subsequent movement queued. Current sensors report the knight on g3, while f3 appeared transiently during the result. The exact cause is not yet established; physical observation was requested before moving anything further. Motion idle and magnet off were confirmed after the hold.

Inspection also found that compiled transfers omitted the existing drop-centering option. Forward and reverse plans now retain `nudgeTargetIndex`, with a regression checking it for every transfer. This is a source correction, not proof that it caused the observed displacement. The active hardware run remains stopped and its original controller state is retained for inspection; a fresh run after reconciliation will use the corrected planner.

Spotify was enabled and its receiver was ready, but no song was streaming during this initial run (`spectrumFrames` remained zero). Therefore simultaneous song/Spectrum/motor performance has **not** been accepted. No complete physical playback, promotion, automatic restoration, or takeover cycle has yet passed. Machine-readable observations are in `logs/autonomous-hardware-acceptance.jsonl` and the physical board log for 2026-11-03.

Status: implemented and software-verified; hardware acceptance paused at the observed knight-placement mismatch. The three-cycle gate and remaining real-board tests are still required.


### Placement observation and retry preparation

The user confirmed the knight physically ended on g3. This establishes an actual transfer displacement, not solely a transient sensor reading. A song subsequently streamed successfully and Spectrum analysis advanced while motion was held. The breathing amber display was the intended recovery override.

The drop-centering correction passed the autonomous regression suite and was loaded by restarting the backend. The UI now explains that amber recovery lighting temporarily replaces Spectrum. Client lint/build passed for this message change. No further movement was commanded during this investigation.

The Spotify receiver was re-enabled after restart; song selection must be resumed in Spotify. At the last retry-preparation check the board was idle with the magnet off, Spectrum selected, and 31 starting squares occupied (e7 still missing). A short opening retry that pauses after Nf3 is prepared but has not been started. The centering correction has not yet been established as a physical solution.

### Routing experiments withdrawn

Subsequent retries used experimental autonomous-only orthogonal knight routes and an extra empty-source carriage visit after dropping a piece. A short opening pilot reached f3; the longer run verified both castles before a capture/clearance placement failed at ply 16. The operator observed two white pawns near the a2/b2/a3/b3 junction. These observations establish displacement, but do not establish routing as its cause. Surface friction remains an operator-reported possible cause.

At the operator's request, all diagnostic routing experiments were removed. Autonomous moves again call the existing shared physical planner without knight-route overrides or additional corner restrictions. The extra post-drop carriage travel was also removed; the original drop-centering metadata remains preserved. The compiled script is back to 114 transfers. The new exhibition capture-slot allocation and promotion exchange remain part of the autonomous feature.

After rollback, the autonomous state, firmware-guard, and browser suites passed, including three simulated cycles and all 114 restoration takeover boundaries. The existing physical planner, state, and promotion suites also passed. The backend was reloaded without issuing movement. Physical acceptance remains incomplete; further tests require surface preparation as appropriate and a confirmed full starting setup with empty storage. No physical three-cycle, promotion, or restoration/takeover acceptance is claimed.

### Original-route retry

After the operator confirmed surface/setup readiness and re-centred h8, all 32 starting squares registered. Run `83872500-769b-41c9-a9d0-8a699986b740` homed successfully and attempted the original straight e2-e4 transfer. The returned full-board state failed verification; e3 was detected instead of the expected e4 in the monitor snapshot. A nearby log snapshot also detected e4 transiently. The controller entered recovery after this first transfer, with motion idle, no pending work, and magnet off. Physical placement confirmation was requested before any reset or further motion. No route change was made. Spotify telemetry remained ready rather than streaming during this retry, so concurrent music acceptance was not established.

The operator confirmed that the pawn physically stopped on e3. The issued plan was the original straight e2-to-e4 transfer, with target index 27, rather than an e3 command. No route or calibration changes were made. Music subsequently reported playing/Spotify active, with nonzero Spectrum levels and increasing analysis frames while the board remained in recovery, idle and magnet off. Whether the carriage reached e4 or stopped short remains unconfirmed.

### Successful original opening and later Qd3 hold

After manual reset, run `172facfa-a113-4612-8a07-9a7fba503732` homed and completed the original e2-e4 transfer; the operator confirmed centred placement and smooth travel. After resuming, the original Nf3 route and temporary h-pawn return passed; the operator confirmed knight f3, pawn h2, and no neighbouring displacement. Both castles and the first two capture/storage operations then verified with music playing and advancing Spectrum analysis. No movement-route or calibration changes were made between the failed e4 attempt and this run.

At ply 25 (13.Qd3), transfer 36 failed with firmware error 'Drop verification failed after nudge attempts.' Sensor occupancy remained at d1 and not d3. The controller held with motion idle and magnet off, without scheduling another move. Physical queen location was requested. This run does not establish full playback, promotion, automatic restoration, or three unattended cycles. Logs retain the precise outcomes; successful opening checks must not be presented as complete hardware acceptance.

The operator confirmed the queen remained on d1 and attributed the failure to friction, requesting continuation from this position. The implemented recovery controls currently support full manual reset only; Resume is restricted to verified paused states. No failed transfer was marked successful and no retry was issued. Continuing from a failed placement requires a guarded recovery capability that is not currently implemented.

### Restart after friction preparation

The operator confirmed the complete reset ready. All 32 starting squares matched, firmware was idle/magnet off, and Spotify was playing. Run `92df3a56-6947-4e87-96f2-8d6282003c0c` homed successfully, verified the original opening routes and both castles, and stored the first captured pawn. After the temporary a-pawn return verified, a subsequent fresh snapshot no longer detected a2. At cursor 26 there was no pending transfer; the controller waited for matching occupancy. The acceptance operator issued Pause, leaving the run at a verified boundary with the ledger intact. The user was asked to inspect and, if merely off-centre, centre only the a2 pawn. This pause can use ordinary Resume once fresh matching occupancy returns; no failed command is being retried or marked successful.

### Continuation after a2 centring

The user confirmed a2 was slightly off-centre and manually centred it. Fresh occupancy then matched the last committed ledger exactly; ordinary Resume continued at cursor 26 without replaying a completed transfer. The original Qd3 move succeeded in this run, and play continued through ply 59. A brief Spotify-ready interval occurred; playback and Spectrum subsequently resumed, and the operator confirmed songs playing.

At ply 60 (30...dxe4), cursor 76, the captured white e4 pawn was commanded through the original shared-planner path e4-d3-c3-a1-Z1. Firmware returned a board state with e4 empty and unexpected c3 occupancy. Full-board verification held the run before Black's capturing pawn advanced. Motion idle and magnet off were confirmed. Physical pawn location was requested; no route changes or automatic retry were issued. Load samples during this continuation recorded maximum sensor age 1102 ms, minimum observed free heap 57440 bytes, and maximum Spectrum analysis time 29010 us. The a2 intervention makes this an assisted run, not an unattended acceptance cycle. Full promotion/restoration acceptance remains pending.

The operator confirmed the captured white pawn physically stopped on c3 and attributed this to friction. Its intended destination Z1 was not reached. The transfer remains uncommitted, and the run remains held; no automatic restoration or further movement was issued. Original routing is unchanged. Surface/drag reliability must be addressed before an uninterrupted physical acceptance attempt. A complete manual starting-position reconciliation and empty storage are required to restart under the current recovery controls.

### Recovery handover for normal play

Added explicit `prepare-manual-reset` control (Home for Manual Reset). It requires operator confirmation that pieces are resting and the gantry area is clear, fresh sensors, acknowledged-homing firmware, and idle/magnet-off telemetry. It abandons the uncertain transfer under a new run identity without committing or replaying it, stops the light show, and acknowledges homing before releasing movement ownership. After successful home, live starting-position LEDs show missing squares in red, correct occupied squares in green, and extra occupied squares in amber. A failed home stays in recovery and does not enable setup guidance. Starting normal physical play clears this temporary guidance ownership. The backend restart did not restore the old demonstration ledger or resume playback.

Light-show controls now explain that the recovery indication overrides the saved Start/Stop setting until recovery is resolved. Software checks passed: autonomous state (including guarded reset homing and timeout failure), autonomous browser at both desktop sizes (including setup LED colours), existing Exhibition state/browser, physical planner/state/promotion, client lint/build, backend syntax, and diff checks. No firmware or routing changes were needed.

On the physical board, acknowledged reset homing succeeded with magnet off. The operator confirmed: 'Yes, homed and setup lights showing.' The board was left manual-ready for arranging the starting pieces and starting normal play. This verifies the new recovery handover only; it does not satisfy autonomous game/restoration acceptance.

### Placement recovery improvement (2026-11-04)

The later implementation described in `docs/autonomous-recovery.md` supersedes the earlier whole-board breathing indication and full-reset-only placement recovery. Original movement routes and settings remain unchanged. Physical acceptance of the new recovery behaviour must be recorded separately from automated checks and from the November 3 tests above.
