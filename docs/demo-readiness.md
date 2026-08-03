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

1. Shared White/Black and difficulty controls, including validated Gemini use.
2. Online physical promotions.
3. Gemini-led physical curriculum beyond fixed opening drills.
4. Production offline feedback, side selection, and promotion interaction.
5. Continuous production offline gameplay.
6. Online/offline ownership, persistence, and reconnect handoff.
7. Final demo operations, documentation, and release acceptance.

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
