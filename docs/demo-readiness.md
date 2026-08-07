# ChessProject Demo Readiness

## Baseline Status

Milestone 0 was accepted on 2026-08-03 on `codex/demo-baseline`, based on
commit `95c8d69` plus the isolated baseline changes recorded here. The complete
automated gate and every required physical check passed on production firmware.

The intended demonstration is the complete system: normal virtual chess,
server-authoritative physical chess, Gemini text and Live mentoring, board
speaker output, physical-board observation, and reviewed opening instruction.
Host-only offline components remain development foundations and are not yet a
production standalone game mode.

## Repeatable Verification

From the repository root, run the complete automated gate:

```powershell
.\tools\verify-demo-baseline.ps1
```

This runs the mentor regression suite, deterministic 100-game offline soak,
complete physical/offline foundation suite, client lint and production build,
and all firmware compile gates. It also verifies that the private firmware HTTP
and audio hosts match the laptop's active IPv4 address.

For the final production upload and speaker registration check, keep the gantry
idle and the magnet off, start the backend, connect the USB cable, and run:

```powershell
.\tools\verify-demo-baseline.ps1 -UploadPort COM11
```

The verified production target is ESP32-S3 with the 16 MB
`app3M_fat9M_16MB` partition, OPI PSRAM, `CDCOnBoot=default`, and USB upload.
The accepted compile baseline is `1,079,947` bytes flash and `48,456` bytes
static RAM.

Result summaries are written to ignored `logs/demo-baseline-*.json` files.

## Network Preflight

The ESP32 currently uses private, compiled-in WiFi and server settings. Before a
demo, connect the laptop and board to the configured network and run the
verification script. If the hotspot assigns the laptop a new address, update
both `CHESS_SERVER_BASE_URL` and `CHESS_AUDIO_SERVER_HOST` in the ignored
`esp32_firmware/firmware_secrets.h`, then reflash production firmware.

Do not begin a physical game unless:

- ports 3000 and 3001 are listening;
- `/api/physical/heartbeat` responds;
- `main-board` appears ready in `/api/mentor/audio/devices`;
- the physical log receives current sensor snapshots;
- no old movement command remains queued.

## Physical Acceptance Checklist

Record each item as Pass, Fail, or Blocked. Any software failure must be fixed
and rerun before this baseline is frozen. A known external mechanical issue may
be documented, but it cannot be reported as a software pass without evidence.

| Area | Required check | Status |
| --- | --- | --- |
| Setup | Production firmware boots, joins WiFi, registers the speaker, homes, and completes full starting-position calibration. | Accepted |
| Quiet play | A legal human quiet move and robot reply complete with exact app/sensor synchronization. | Accepted |
| Capture | A robot capture removes the victim to a free configured graveyard slot and places the attacker correctly. | Accepted |
| Castling | Human castling completes king-first and rook-second without a mismatch. | Accepted |
| Undo/redo | Undo Turn and Redo Turn physically restore and replay the latest full turn. | Accepted |
| Recovery | A deliberate recoverable one-square displacement produces clear guidance and returns to Ready after restoration. | Accepted |
| LEDs/history | Legal-move LEDs clear promptly and the app move history remains synchronized after moves and undo/redo. | Accepted |
| Mentor mirror | `/mentor` attaches to the current physical session and mirrors verified moves without adding robot commands. | Accepted |
| Mentor analysis | Stockfish analysis uses the attached physical FEN and updates the matching evaluation display. | Accepted |
| Voice/speaker | Gemini Live speaks clearly through `main-board`; interruption and recovery guidance work without duplicate speech. | Accepted |
| Italian Game | Complete the reviewed ten-ply line `e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 O-O d6`. | Accepted |
| Queen's Gambit Accepted | Complete the reviewed ten-ply line `d4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3 c5`. | Accepted |
| Final logs | Physical logs contain no unresolved mismatch, unsafe route, stuck robot job, or duplicate mentor response. | Accepted |

Acceptance included complete real-board Italian Game, Queen's Gambit Accepted,
and London System drills, followed by continued normal play. The final extended
game reached 86 verified plies and game over. Recoverable centering warnings were
restored successfully and no robot job or synchronization warning remained
unresolved. Production firmware remained `1,079,947` bytes flash and `48,456`
bytes static RAM.

## Known Accepted Hardware Caveats

- A damaged board sticker can physically catch a dragged piece. Repairing the
  surface remains recommended before the final demonstration.
- Brief LED corruption can be induced by disturbing the LED data wire. The
  renderer minimizes writes, but the signal-integrity issue remains physical.
- Binary occupancy sensors cannot identify promotion piece type; workflows must
  ask the user to provide the requested piece.

## Remaining Demo Milestones

1. Complete the real-board Human Black acceptance gate for shared side and difficulty settings.
2. Online physical promotions.
3. Gemini-led physical curriculum beyond fixed opening drills.
4. Production offline feedback, side selection, and promotion interaction.
5. Continuous production offline gameplay.
6. Online/offline ownership, persistence, and reconnect handoff.
7. Final demo operations, documentation, and release acceptance.

## Shared Side And Difficulty Configuration

The Companion Board and Mentor now use one SQLite-backed preference for Human
White/Black and Level 1-15. Both pages update immediately through
`game-settings-updated`. Side changes apply to the next game, while difficulty
changes update an attached physical session through its generation-checked
settings endpoint and take effect at the next engine-selection transaction.

Physical sessions record human/robot colors and the configured, active-search,
and queued-job levels. Human Black completes normal calibration, receives one
verified White robot opener, and then owns only Black lifts and moves. Captures,
castling, synchronization recovery, and actor-based undo/redo use the same
color-aware state machine. Reviewed physical opening drills remain learner-White
only.

Virtual Companion games support either side, orient to the active human color,
and expose an explicit New Virtual Game command. A generation guard prevents a
late engine response from a previous game from mutating the new game. Companion
personality selection remains unchanged; mentor-started physical games always
use Balanced with the shared side and level. Gemini can update the same defaults
through `set_game_preferences` without receiving low-level board controls.

Automated acceptance covers migration persistence and validation, REST and
socket behavior, mentor tool use, Human Black move interpretation, captures,
castling, engine-level snapshotting, one-time White opening scheduling,
actor-based undo/redo, and desktop virtual Human Black play. Client lint/build,
backend syntax, physical regressions, and relevant mentor regressions pass. The
firmware and offline core are unchanged. The required real-board Human Black
test remains pending before this milestone is physically accepted.

## Mentor Physical Intent And Selective Coaching

The mentor can now start the default physical game through validated high-level
tools. Ambiguous game requests require a Physical-or-Virtual choice; an explicit
physical request starts one full standard setup as Human White at Level 1,
Balanced, using the accepted Z/I graveyard coordinates. A fresh ESP32 physical
poll or sensor snapshot is required. Active games are attached rather than
reset, and start/attach request IDs are persisted so they cannot execute twice.

Starting or attaching from Gemini Live completes the current tool response and
then refreshes only the provider connection. The browser microphone, selected
speaker target, output mode, volume, and Live session identity remain intact.
The refreshed provider receives the physical context and read-only physical
tool set; no mentor tool receives motor, magnet, raw sensor, or command-queue
access.

Physical bindings now persist `off`, `prompt_pending`, or `selective` coaching.
Gemini-started games and continued opening drills use selective coaching;
manual attachment asks once. The coordinator waits for a verified robot reply
and 1.5 seconds of stable occupancy, analyzes the preceding human move with
quick Stockfish, and speaks only for important move-quality/mate events,
check/game results, promotions, material swings of at least three points, or a
three-complete-turn strategic checkpoint. Ordinary lifts and routine moves are
silent. Urgent recovery guidance retains interrupt priority.

Automated acceptance includes migration/restart persistence, intent and
idempotency, Live source refresh, silent lifts, three-turn cadence, all mentor
regressions and desktop browser checks, existing physical planner/state tests,
zero-warning client lint, and production client build. Firmware source and the
accepted `1,079,947` flash / `48,456` static RAM baseline are unchanged.

## Unified Physical Transfer Planner

Companion games, reviewed Mentor openings, undo, redo, captures, en passant,
castling, and robot-owned graveyard restoration now use the same physical
transfer-planning boundary. Each transfer tries the normal board route, then
Z/I lane routing, and only then considers moving one same-color pawn out of the
way. The pawn uses a legal one-square push or a legal two-square starting push,
stays on the board, and is restored before the next choreography phase.

Temporary clearance is represented as three explicit phases:
`temporary-clearance-stage`, the original transfer phase, and
`temporary-clearance-restore`. Back-rank knight moves retain the accepted rook
pawn behavior: queenside uses the a-pawn and kingside uses the h-pawn. This now
applies equally to normal play and reviewed openings; the old opening-only
`b8c6`/`g8f6` exception was removed.

Robot motion is transactional. The backend sends one phase at a time with a
unique transaction, phase, and attempt ID. Chess state and move history commit
only after every phase verifies. A failed phase keeps earlier verified phases,
requires the board to match that phase's exact start occupancy, and retries
only that phase. Stale, duplicate, and out-of-order results cannot advance the
transaction.

Robot graveyard slots now transition from `Free` to `Pending` when a capture is
staged and to `Occupied` only after captured-piece removal verifies. A later
attacker failure keeps the slot occupied. Undo restoration releases the slot
when the captured piece is verified back on the board.

The settings API remains authoritative. A client that reaches an old backend
without `/api/game-settings` now reports `Backend update required; restart the
ChessProject server` instead of silently creating independent browser settings.

Automated checks cover shared normal/Mentor knight planning, white and black
rook-pawn clearance, undo/redo, deterministic selection, pending graveyard
state, phase-only retries, stale/out-of-order/duplicate reports, logical-state
immutability, and existing capture/castling behavior. Firmware and
`offline_core` are unchanged. Real-board acceptance of the Human Black settings
gate and the new phased clearance sequence remains pending.

The shared-settings and unified-transfer physical gates were subsequently
accepted on the real board. Human White/Black play, difficulty handoff,
actor-based Undo/Redo, temporary knight clearance, reviewed-opening clearance,
capture, and castling completed without unresolved synchronization or duplicate
phase errors.

## Online Physical Promotions

Companion virtual and server-controlled physical games now support queen,
rook, bishop, and knight promotions. Physical promotion is transactional: the
pawn first reaches the final rank, the player removes it, the board or app
selects an identity, and the replacement must remain sensor-stable for 500 ms
before chess FEN, history, turn, or game result commits. Robot promotions use
the same motion planner and pause indefinitely for the exact requested piece.

The production firmware renders large promotion letters across the measured
16x16 NeoPixel matrix. It cycles `Q`, `R`, `B`, and `N` every 2.5 seconds,
reports the displayed identity with sensor snapshots, and performs all
`strip.show()` calls on core 1 through an LED-command mailbox. Promotion prompts
take priority over game-over animations, use refined Q/R glyphs, and highlight
the replacement square in amber alongside the requested letter. Promotion
display code has no motor or magnet access. The accepted production compile
baseline is `1,083,819` bytes flash and `48,768` bytes static RAM.

Physical Undo requires the promoted piece to be replaced by a pawn before
reverse motion begins. Redo moves the pawn forward, then repeats the original
replacement gate. Capture-promotion graveyard state remains transactional and
is not rolled back when a later replacement is still pending.

Custom physical setup accepts a validated FEN with exactly one king per color
and no pawns on ranks 1 or 8. Calibration compares sensors to that exact
occupancy while preserving turn, castling, en-passant, difficulty, side, and
personality. A robot-to-move position schedules one robot reply after setup.

Automated acceptance covers custom setup, all Q/R/B/N human choices, quiet and
capture promotion, robot replacement, app locking, removal/stability gates,
promotion Undo/Redo, matrix bijection, Mentor prompt deduplication, existing
physical regressions, the complete Mentor suite, client lint/build, backend
syntax, and production firmware compilation.

Real-board acceptance passed on COM11. A custom White promotion cycled to a
knight and committed `a8=N` as an insufficient-material draw; promotion Undo
required pawn replacement before returning it to `a7`, and app-locked bishop
selection committed `a8=B`. A Black-to-move custom fixture executed `a2a1q`,
held a fixed queen prompt, accepted the empty-then-occupied replacement, and
Mentor Live announced the resulting check through the board speaker. The final
standard-position regression committed human `e4` and verified robot `d5` with
exact occupancy, no pending work, and no synchronization or motion error.
