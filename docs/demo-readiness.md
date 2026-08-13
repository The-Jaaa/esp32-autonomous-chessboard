# ChessProject Demo Readiness

## Baseline Status

Milestone 0 was accepted on 2026-08-03 on `codex/demo-baseline`, based on
commit `95c8d69` plus the isolated baseline changes recorded here. The complete
automated gate and every required physical check passed on production firmware.

The intended demonstration is the complete online system: normal virtual
chess, server-authoritative physical chess, Gemini text and Live mentoring,
board speaker output, physical-board observation, and reviewed opening
instruction. Physical gameplay requires the ChessProject backend.

## Repeatable Verification

From the repository root, run the complete automated gate:

```powershell
.\tools\verify-demo-baseline.ps1
```

This runs the mentor regression suite, online physical/settings foundation,
client lint and production build, and the production firmware compile gate. It
also verifies that the private firmware HTTP and audio hosts match the laptop's
active IPv4 address.

For the final production upload and speaker registration check, keep the gantry
idle and the magnet off, start the backend, connect the USB cable, and run:

```powershell
.\tools\verify-demo-baseline.ps1 -UploadPort COM11
```

The verified production target is ESP32-S3 with the 16 MB
`app3M_fat9M_16MB` partition, OPI PSRAM, `CDCOnBoot=default`, and USB upload.
The current online-only production baseline is `1,894,091` bytes flash and
`58,888` bytes static RAM.

Result summaries are written to ignored `logs/demo-baseline-*.json` files.

## Network Preflight

The ESP32 currently uses private, compiled-in WiFi and server settings. Before a
demo, connect the laptop and board to the configured network and run the
verification script. If the hotspot assigns the laptop a new address, update
both `CHESS_SERVER_BASE_URL` and `CHESS_AUDIO_SERVER_HOST` in the ignored
`esp32_firmware/firmware_secrets.h`, then reflash production firmware.

Do not begin a physical game unless:

- ports 3000 and 3001 are listening;
- `/api/physical/status` responds with a fresh sensor snapshot;
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

## Remaining Demo Work

1. Re-run the reduced online-only acceptance gate after firmware cleanup.
2. Complete one physical Companion turn and one Mentor speaker response on the cleaned firmware.
3. Freeze final demonstration operations, documentation, and release evidence.

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
firmware is unchanged. The required real-board Human Black
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
immutability, and existing capture/castling behavior. Firmware is unchanged.
Real-board acceptance of the Human Black settings
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

## Milestone 3: Voice-First Physical Curriculum

Automated implementation is complete on `codex/mentor-physical-curriculum` in
three isolated commits. The Mentor can coordinate a physical practice game
against either Gemini or Stockfish, teach all 18 reviewed openings with the
learner playing White or Black, and guide all 12 reviewed puzzles through an
explicit physical setup-confirmation gate.

Gemini-controlled moves remain high-level and guarded. Gemini must first obtain
matching-position Stockfish candidates, may choose only a top-three move within
50 centipawns of the best, and submits one UCI move plus a persisted strategic
plan. The existing physical server remains responsible for legality, routing,
motors, sensors, verification, promotions, graveyards, and recovery. One
corrective turn is allowed if Gemini analyzes without moving; Stockfish then
provides the deterministic fallback.

The primary `/mentor` surface is now desktop, physical-board, and voice-first.
It retains conversation history, read-only transcripts, board/move state,
speaker controls, side/difficulty settings, activity status, safety feedback,
promotion controls, Pause/Resume, Hint, and End. Text input, virtual source
selection, manual activity/profile dialogs, FEN/reset commands, and board
demonstrations are no longer exposed on that page. Virtual mentor services
remain internally compatible.

Automated acceptance passed: `npm run test:physical`, the complete
`npm run test:mentor` suite, Playwright at `1440x900` and `1920x1080`, zero-
warning client lint, production client build, backend syntax checks, and diff
checks. Firmware was not changed; the accepted production
baseline remains `1,083,819` bytes flash and `48,768` bytes static RAM.

Real-board acceptance remains required before this milestone is marked
demonstration-ready: Mentor-led three-turn play, Stockfish-led difficulty
handoff, a Human Black reviewed opening, one physical puzzle with wrong-move
recovery and a hint, Pause/Resume, and urgent mismatch guidance.

### Voice Activity Startup Correction

The first real voice-first trial exposed three orchestration failures. A
Mentor-led request could fail its activity-consent check and then mutate the
hidden virtual board; a Stockfish activity could start virtually while the
learner moved physical pieces; and an Italian-as-Black request could flip only
the virtual orientation after physical attachment failed. Gemini then described
those actions as successful even though no physical activity owned the board.

Production Gemini Live now receives only physical startup/activity tools until
the conversation is attached. A Live `start_activity` transaction establishes
or attaches the physical board first, applies the requested learner color,
aligns orientation to that color, and only then creates the activity. A pristine
standard-position session may be restarted safely to change sides; a progressed
game returns a conflict instead of being discarded. Orientation remains a view
setting and cannot substitute for learner color or activity creation.

The exact failure is covered by a regression requiring an unattached request
for the Italian Game as Black to establish physical ownership, preserve Black
as the learner, and never expose virtual `play_move` or `set_orientation` as
startup alternatives. The complete Mentor and physical suites, client lint,
client build, backend syntax, and diff checks pass. The corrected real-board
startup paths still require a short retest.

### Mentor-Led Reply Transaction Correction

The first real Mentor-led game exposed a status-revision race. Stockfish
successfully analyzed the post-`Nf3` physical position and selected `g8f6`, but
activity-policy status updates advanced the physical state revision without
changing the FEN. Candidate validation incorrectly required the old revision,
rejected `play_physical_move` twice, and Gemini then described the unexecuted
move as if it had succeeded. A queued game-start announcement also occupied the
Live turn when the corrective attempt began.

Physical candidate evidence is now bound to the physical session source key and
exact analyzed FEN. The current physical revision is refreshed immediately
before the guarded move is queued, so status-only revision changes cannot
invalidate a matching analysis while hardware execution still receives the
latest safety revision. Activity turns wait behind an active Live response,
obsolete game-start announcements are discarded after the learner moves, and a
stranded `mentor_thinking` turn resumes when Live reconnects. Pause/Resume also
normalizes `mentor_thinking` back to an executable mentor turn.

Regression coverage reproduces matching-FEN revision churn, queued Live
activity execution, stale start-announcement suppression, and reconnect
recovery. The complete `npm run test:mentor` and `npm run test:physical` suites,
backend syntax checks, and diff checks pass. A real-board Mentor-led reply
retest remains required.

### Physical-Only Voice Startup Hardening

Follow-up real sessions exposed a second startup path that bypassed the
activity coordinator. Gemini could call the lower-level physical start or
attach tools, receive an error, and still announce that a game had started.
Repeated attempts could also create a newer physical-session generation,
making the previous conversation stale and presenting as a degraded board.

The voice-first Mentor now treats the physical board as the only gameplay
source. It never asks Physical or Virtual. Before attachment it can inspect
settings/status and call `start_activity`; after attachment it receives only
the read-only and guarded physical activity tools. Direct voice calls to
`start_physical_game` and `attach_physical_game` are rejected even if a stale
provider declaration attempts them. `start_activity` is the sole transaction
that establishes board ownership and creates a playable activity.

Natural spoken consent is also normalized before validation, including filler
prefixes and phrases that explicitly name the physical board, Mentor-led or
Stockfish-led play, learner color, or playing against Gemini. The complete
Mentor and physical suites, voice-first browser checks, client lint/build, and
backend syntax checks pass. A final real-board startup and first-reply retest
remains required.

### Guided-Turn Coaching And Narration Reliability

A full guided-game trial exposed two visible red tool failures and two turn
coordination defects. Gemini redundantly called `start_activity` after the same
game was already active. Its first guarded move could also arrive while the
physical adapter reported `ready` rather than `robot_thinking`, causing a
corrective turn and duplicate narration. Finally, a verified learner move made
while the previous narration was still active could be committed physically
without receiving its queued Mentor turn.

Matching activity starts are now idempotent and never reset the game. A matching
activity/turn with exact occupancy may safely recover the transient
`ready -> robot_thinking` boundary before queueing the guarded move; unsafe or
ambiguous phases still fail normally. Physical turn requests received during
active narration are coalesced and run as soon as that narration completes.
Superseded response generations cannot launch a corrective turn for a newer
position.

Guided Mentor turns now require quick analysis of the learner's exact last move
as well as current-position candidate analysis. After the robot reply verifies,
Gemini must state the engine classification plainly, explain the consequence,
and connect the position to a concrete two-to-three-ply plan for both sides.
Weak moves are labeled directly, with the stronger alternative, and generic or
repeated development commentary is explicitly disallowed.

Regression coverage includes duplicate activity startup, missing learner-move
analysis, status-revision execution, and a learner move committed during active
narration. Complete Mentor and physical suites, browser checks, client
lint/build, and backend syntax checks pass. Firmware remains
unchanged; a real guided-game retest remains required.

## Milestone 3.5: Physical Mentor Ownership And Activity Switching

Physical-board ownership is now claimed by activity intent rather than by chat
navigation. Opening a new conversation does not disturb the current game. An
activity request automatically adopts an unowned, ended, or stale board. When
another conversation owns a genuinely active game, the request creates a
persisted handoff and offers two safe choices: return to the current game, or
end it and start the requested activity in the new conversation.

Transfers are allowed only at an exact stable boundary. The backend rechecks
the server identity, physical-session generation, state revision, owner,
activity, sensors, robot state, promotion, Undo/Redo, recovery, and pending
commands before changing ownership. Decisions are idempotent, expire after ten
minutes, stop the previous conversation's Live session, and cannot replay a
robot move. Failed post-transfer startup is persisted as failed rather than
left pending.

The voice-first physical tool declaration now exposes only practice games,
reviewed opening drills, and reviewed puzzles. Opening names and stale Gemini
proposals are resolved back to unique reviewed catalog entries; ambiguous or
custom physical content is rejected. Human Black Italian instruction is
covered explicitly and queues the reviewed first move `e2e4`. Physical puzzles
always come from the reviewed 12-item catalog.

Difficulty can now change during an active Stockfish-led physical activity. It
applies to the next engine search while in-flight search or motion retains its
captured level. Side changes remain next-game settings, Mentor-led policy is
unchanged, and opening/puzzle scripts are not altered mid-activity.

Automated acceptance passed: the new handoff regressions, game-settings suite,
physical curriculum suite, complete Mentor and physical suites, Playwright at
`1440x900` and `1920x1080`, zero-warning client lint, production client build,
backend syntax, and diff checks. Firmware remains unchanged.
The eight-step real-board handoff/opening/puzzle gate remains required before
Milestone 3 and 3.5 are marked demonstration-ready.

## Milestone 3.5 Acceptance Corrections: Grounded Coaching And Reliable Voice

Physical Stockfish coaching is now generated from one immutable evidence
record containing the exact learner move, robot reply, before/after/current
FENs, piece map, material, verified move history, and matching Stockfish
classification and principal variation. Generated explanations are validated
against that evidence. One rejected response may be regenerated with its
specific claim errors; a second failure uses a deterministic engine-grounded
explanation. Gemini Live voices the approved script rather than independently
reinterpreting the physical board.

Unexpected Live provider errors, closures, and physical-turn timeouts now
clear unfinished audio and reconnect once with the same session settings and
latest physical context. Current queued narration resumes only after the new
provider session is ready. A second failure returns to a clean manual-start
state. Intentional Stop, navigation, and conversation changes never reconnect.

Gemini handoff calls now contain only `continue_existing` or `end_and_start`;
the backend binds the current persisted handoff ID. Button/REST decisions
remain ID-checked. Opening introductions queued during a transfer wait for the
requesting Live session to reconnect before they are spoken.

A migration-backed pending physical intent retains a reviewed opening and
later learner-color answer across separate spoken turns. For example,
`Teach me the Italian Game` followed by `I'll play Black` resolves to
`italian-game` and starts with the prescribed robot move `e2e4`. Completed
intents cannot be reopened by a late cumulative transcript.

Physical Mentor puzzles have been removed from declarations, prompts, and the
product surface. Requests recommend a guided game or reviewed opening and do
not claim the board or start custom setup. Catalog data, virtual compatibility,
history, and legacy records remain; an old active physical puzzle is paused
and can only be ended.

The two implementation commits pass focused grounded-coaching, Live recovery,
handoff, retained-intent, puzzle-rejection, physical observer, physical
curriculum, and desktop browser regressions. The complete Mentor and physical
suites, shared settings, client lint/build, backend syntax, and diff checks
also pass. Milestone 3 remains pending until the corrected real-board gate
completes.

### Real-board acceptance correction

The first corrected hardware run exposed two transaction defects. Physical
move records store `beforeFen` and `afterFen`, but the coaching analyzer was
given those raw records even though it consumes normalized `before` and
`after` fields. Every turn therefore fell back to the repeated
`unclassified` checkpoint instead of producing grounded move guidance.
Physical moves are now normalized before analysis, so the exact learner move,
classification, robot reply, and verified continuation reach the coaching
pipeline.

Ending a Mentor activity previously cancelled only its database activity and
resumed ordinary physical play. It did not release the physical game. A
confirmed cross-chat handoff then cancelled the old activity but failed when
the new session encountered that still-active game, leaving the handoff in a
terminal failed state. The End action now requires a stable board boundary,
ends the underlying physical session, detaches its conversation, and returns
the UI to an available board. A confirmed `end_and_start` handoff is separately
authorized to replace the validated active session in one transaction.

Regressions cover raw physical move normalization, complete physical-session
release from End, active-session replacement during handoff, and duplicate
handoff safety. The complete Mentor and physical suites, client lint/build,
backend syntax, and diff checks pass. A final real-board retest is still
required before Milestone 3 acceptance.

## Offline Gameplay Retirement

As of 2026-08-13, standalone offline gameplay and server-ownership switching
are retired from the active product. The board now always waits for and retries
its normal backend connection. The production path retains sensors, LEDs,
speaker audio, bounded motion, promotion handling, online routing, graveyards,
Undo/Redo, Mentor observation/control, and all stale-session safety checks.

Historical implementation and hardware evidence remain available through Git
history. It is no longer part of current source, firmware builds, verification,
or the demonstration roadmap. Removing the default-off sources did not alter
the production image: the measured baseline remains `1,894,091` bytes flash and
`58,888` bytes static RAM.
