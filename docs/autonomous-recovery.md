# Autonomous placement recovery

Autonomous playback and restoration use the normal-game sync-warning colour (pulsing amber) only on squares whose occupancy differs from the expected corrected position. Unaffected squares are dark during the warning. Music continues, and the selected light show/Spectrum returns after recovery.

The app names the tracked physical piece, intended destination, and missing/extra squares. Correct a recoverable failed transfer by placing that piece at its intended destination. Returning it to its source does not complete the transfer. Wait for the app to report that the robot is stopped before correcting anything.

Board corrections require a full occupancy match for at least 500 ms and three distinct sensor snapshots. After a one-second resuming indication, the controller requests an acknowledged firmware baseline reconciliation. Only that acknowledgement commits the transfer and allows subsequent movement. Neither the failed command nor an earlier phase is replayed. A displacement after an already committed transfer restores the current board without advancing the ledger again.

For a graveyard destination, place the named piece in the named slot and press its confirmation button. Storage is unsensed: matching board occupancy cannot establish that a piece reached the correct bay. Confirmation is tied to the current run, revision, and recovery identity. An occupancy mismatch invalidates an earlier confirmation.

During restoration, correcting the affected piece is protected against false takeover. Lifting an unrelated piece still requests takeover. After correction, a latched takeover takes priority and leads to acknowledged homing rather than another restoration transfer. Pause and Restore & Exit intent are retained.

Homing/positioning faults, missing terminal command results, firmware run changes, failed reconciliation acknowledgement, and unknown failures remain blocking recovery. Home for Manual Reset remains available once the board is idle and the operator confirms pieces are resting and the gantry is clear. Backend restart never resumes an interrupted run.

## Interface

- Autonomous status includes `recovery`: its identity, category, terminal/recoverable flags, tracked piece/source/destination, expected occupancy, affected indices and square names, correction readiness, storage confirmation requirement, and recovery stage.
- The existing autonomous control endpoint accepts `confirm-recovery-placement` with `runId`, `expectedRevision`, and `recoveryId`.
- Firmware reports `placementRecoverySupported` and `homingFault`. New autonomous starts require placement-recovery capability; older firmware retains existing non-autonomous functionality.
- Poll visual context supplies the affected-square mask and protected correction squares. The bounded `autonomous-reconcile` command validates the full sensor baseline while magnet-off, changes no motor target, clears placement interference only, and preserves takeover.

## Verification and physical acceptance

Controller regressions exercise manual completion of all 114 transfers in both directions, including captures, castling, promotion exchanges, storage confirmation, broken stability, duplicate sensor sequences, stale/busy/magnet telemetry, failed acknowledgement, late results, already committed displacement, and takeover during restoration recovery. Portable firmware tests verify baseline reconciliation rejection and preservation of takeover. Browser tests cover recovery instructions and automatic continuation at both desktop sizes.

Physical acceptance remains separate: verify targeted warning colours, board-piece correction, a captured pawn corrected into its named storage bay with confirmation, and restoration correction followed by unrelated-lift takeover, with music and Spectrum active. Do not count manually corrected cycles toward the required three unattended exhibition cycles.

## Delivery evidence: 2026-11-04

Software checks passed: the foundation gate (physical/settings, autonomous state/portable firmware/browser, Spectrum, Exhibition state/browser, client build/lint, backend syntax), the complete Mentor suite including its browser checks, and Spotify relay/mixer suites. Final targeted autonomous-state tests also passed after the last fault-message hardening change. Evidence is retained in `logs/placement-recovery-software.log`, `logs/placement-recovery-mentor.log`, `logs/placement-recovery-spotify.log`, and `logs/placement-recovery-compile.log`.

The final production firmware compile used the existing ESP32-S3 production configuration: 1,908,183 bytes flash and 101,464 bytes static RAM. The exact-size gate was updated to these measured values. The binary is in `tmp/placement-recovery-production/esp32_firmware.ino.bin`.

Physical evidence for this change: none yet. The live backend was not restarted and the connected board was not flashed or moved during implementation. Activation requires the matching backend and firmware; physical recovery acceptance and the original exhibition-readiness gates remain pending. Existing November 3 movement observations are not acceptance of this newer recovery implementation.

## Physical session started: 2026-11-04

The operator made the board available for firmware update/tests and confirmed correct starting pieces, empty storage, and clear gantry. Production firmware was uploaded on COM9 with flash hash verification. The board reconnected reporting placementRecoverySupported, acknowledged homing, idle motion, magnet off, and no homing fault. A firmware-upload sequence reset exposed an idle sensor-sequence bookkeeping issue; the backend now accepts a reset counter after stale telemetry only while no run owns the board. Active-run duplicate/out-of-order rejection is retained, with a regression test. The targeted autonomous suite passed after this fix, and the updated backend was restarted before movement.

Run cad4f3d2-84f2-426e-8943-617b55e22387 homed and verified e4. During e7-e5 placement recovery, the operator confirmed: 'I corrected the pawn; only affected squares flashed.' Logs record the stable-correction/resuming indication, queued autonomous-reconcile command, acknowledgement, and continued game without repeating the completed move. This is physical evidence for board-piece manual correction and targeted warning lights.

The castling king transfer later entered recovery and reconciled, then continued to the separate rook transfer. The rook transfer entered recovery at cursor 15 with f1, f3, and e4 reported missing and h1 extra; operator inspection/correction was requested. This is not yet acceptance of graveyard confirmation or restoration takeover. At the last check Spotify remained ready with zero Spectrum frames, so combined recovery/music acceptance was still pending.

The operator requested restart after reporting the gantry hit an unspecified edge during a move, and confirmed it was free to move with nothing jammed. The previous run was explicitly abandoned via prepare-manual-reset. Acknowledged homing succeeded and the board entered manual-ready with no homing fault. Starting-position reconciliation and empty storage are required before the fresh run. The edge-contact report is retained as an unresolved physical observation; no route changes were made.

### Fresh run and restoration-boundary finding

After reset, run 4f102b1c-5527-4f44-9cf9-0f4746d61250 verified both castles and several storage transfers. Physical board-placement recoveries reconciled while Spotify was playing and Spectrum frames advanced, including the pawn move after the first capture, Nc3, and Qd3. Storage transfers completed normally, so the unsensed-placement confirmation path was not physically exercised.

Restore & Exit switched to reversing history after correcting Ne2. The first reverse knight transfer committed, then an unexpected d2 reading was classified as blocking interference. The operator reported uncertainty over whether the knight stopped on d2 and lifted it to look for its destination. Inspection found a backend boundary issue: clearing the completed transfer's protected squares before the next phase could misclassify late robot route changes. The controller now retains the last transfer's reservations and identity/destination, uses recoverable post-commit displacement without recommitting it, and still detects unrelated lifts. A regression reproducing e2-c3 restoration with late d2 displacement passes; autonomous browser tests also pass after the fix.

The operator placed the knight on c3 and confirmed all pieces down/gantry clear. The updated backend was loaded, abandoning the interrupted ledger rather than restoring it across restart. A fresh homing/reset was requested for a shorter restoration/takeover test. Physical acceptance of this boundary fix, storage confirmation, and restoration takeover remains pending at this point.

### Compressed-route reservation correction

The shorter opening run a7f6a4f2-3ff7-4d4e-b641-6d0e86a51700 reached Nf3 and paused. Restore & Exit followed by Pause attempted the first inverse clearance h2-h4. Firmware latched interference/positioning fault and stopped; the operator confirmed the pawn physically stopped on h3. Inspection found that reservations included compressed endpoints but omitted intermediate sensed squares, allowing the robot-carried pawn itself to trigger interference. Compiled reservations now cover every sensed square touched by each board drag segment, including intermediate and corner-touch squares; physical waypoints and movement settings are unchanged. Portable interpolation and controller tests verify h3 is protected in both directions, and the complete autonomous-state/browser suites passed. This is a backend compilation fix, not a firmware change.

The updated backend was loaded and acknowledged homing cleared the positioning fault. The board was left manual-ready with magnet off and setup LEDs, awaiting the operator's short opening reset before another physical restoration/takeover attempt. The test that exposed the fault is not counted as passed restoration acceptance.
