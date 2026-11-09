# Exhibition modes

## Roadmap and status — 2026-11-02

1. **Exhibition controls, light show, and Spectrum:** implemented; hardware evidence is recorded below.
2. **Autonomous playback with restoration and lift-to-takeover:** implemented and software-verified; physical acceptance is in progress. See [Autonomous exhibition](autonomous-exhibition.md).
3. **Silent voice control:** next after autonomous acceptance; push-to-talk using the existing Gemini integration, with Stockfish replies and no generated speech/coaching.
4. **Engine self-play:** optional after the selected script and its automatic restoration pass the full physical gate.

Autonomous games are background activity to keep the board moving. They need not be short or understandable to passing visitors. The exhibition is approximately one to two weeks away; later milestones receive detailed plans after the preceding hardware results.

## Using the light show

On the main page, scroll the controls column to **Exhibition**. Start requires updated, connected firmware, no active physical game, no pending movement, and a reported idle gantry with the magnet off. Pieces can be anywhere, or absent.

- **Auto** rotates Colour wave, Chessboard pulse, Sweep, and Breathing glow every 30 seconds. Individual patterns can also be selected.
- Slow/Normal/Fast use 10/6/3-second animation cycles. Normal is the default.
- Brightness ranges from 10–100%. The 100% setting retains the existing strip ceiling of 40/255; it does not mean full electrical brightness. Default is 100%.
- Start and Stop are idempotent. Settings can change while running. A changed running configuration restarts the animation timing; unchanged repeated requests do not.
- The ESP32 renders whole-square effects using the measured serpentine square mapping, at most 20 frames per second. Sensor/network processing continues. No frame streaming or generated audio is involved.
- Browser reload/navigation does not stop the show. The backend retains settings until restart; startup defaults to off/Auto/Normal/100%.

The status distinguishes Starting, Running, Stopping, Off, Unsupported, and Disconnected. A disconnected show continues locally. A Stop requested while disconnected is retained by the server, but only reaches the board after reconnection. On backend restart, a surviving show is cleared when the board reconnects.

Starting a physical game, including a Mentor-started game, requests show shutdown before normal setup and homing. Starting the **light show itself never homes or moves the gantry**, changes the magnet, or resets the chess position. Gantry diagnostics and LED calibration are unavailable while the show owns the board.

An ordinary physical game can be ended with **End Physical Game → Confirm End Game** at a fresh, synchronised Ready/Game-over boundary. Ending preserves completed history and leaves the pieces in place; it releases the physical session and clears its LEDs. Mentor-owned games must use their existing Mentor End flow. End is not an emergency motion-abort button.

## Interfaces and compatibility

- `GET /api/exhibition/status`: desired settings, reported runtime, capability, connection freshness, and applied state.
- `POST /api/exhibition/light-show`: required boolean `enabled`, optional `pattern` (`auto`, `wave`, `chessboard`, `sweep`, `breathing`), integer `brightnessPercent` (10–100), and `speed` (`slow`, `normal`, `fast`). Missing settings retain their current values. Invalid settings return 400; ownership/readiness conflicts return 409.
- `POST /api/physical/end`: `expectedSessionGeneration` and `expectedRevision` from current physical status. Rejects stale requests, busy/recovering boards, magnet-on state, mismatched occupancy, and Mentor ownership.
- Socket.IO `exhibition-status` publishes requested/applied and connection transitions. Clients also refresh status periodically.
- Physical poll responses include persistent `exhibition` desired state with a server-instance identifier and revision. Firmware coalesces these through a latest-value mailbox, applies them in the LED-owning main loop, and reports acknowledgement in snapshot `boardRuntime`.
- Runtime reports include capability, motion busy/pending, magnet state, and applied exhibition instance/revision/enabled state. Snapshots have a one-second heartbeat even without occupancy changes. Freshness expires after five seconds.
- Old firmware can continue existing gameplay; it cannot start a light show. The new UI reports the required update. No database migration, Wi-Fi credential change, or audio-mode change is required.

## Software verification

From `app`, run `npm run test:exhibition` for controller/protocol/End tests and desktop browser tests at 1440×900 and 1920×1080. Tests use an isolated backend, temporary database, and simulated firmware; they do not connect to or move the real board.

The foundation verification script now builds/lints the client and runs the exhibition tests alongside physical/settings checks and the firmware compile gate. The demo verification script additionally runs the complete Mentor suite. Firmware upload occurs only when an upload port is explicitly supplied.

The controller/protocol/End regressions, exhibition desktop browser tests, physical/settings suite, complete Mentor suite, client lint/build, and backend syntax checks passed. Screenshots of the Exhibition panel were inspected. Firmware compiled for the production ESP32-S3 16 MB / OPI PSRAM / 3 MB app target: **1,897,135 bytes flash** and **59,048 bytes static RAM** (3,044 bytes flash and 160 bytes RAM above the previous gate). The exact-size production compile gate was updated to those measured values. A successful compile is not hardware acceptance.

Final combined verification passed using `tools/verify-demo-baseline.ps1 -SkipNetworkPreflight`, including the exact-size production firmware gate. Its result is recorded in `logs/demo-baseline-20261102-091123.json`. Network preflight and firmware upload were not performed. Separate Spotify relay/mixer regressions also passed. No real-board acceptance is claimed.

## Pending real-board acceptance

Record actual Pass/Fail results after uploading the new production firmware:

1. Check all four patterns and Auto, square orientation, brightness and speed changes, and timely sensor/runtime telemetry.
2. Run the show continuously for 30 minutes. Verify networking and sensors, and check existing speaker/audio operation during animation.
3. Observe that light-show Start/Stop causes no gantry movement or magnet activation. Repeat ten Start/Stop cycles.
4. Disconnect the backend: animation continues. Request Stop while disconnected and confirm it applies on reconnection. Restart the backend during a show and confirm it reconciles to off.
5. Start a normal physical game directly from the show: animation stops, normal homing/setup completes, and one player move plus one robot reply verifies correctly.
6. End an ordinary game at a stable boundary, confirm pieces remain in place and history remains visible, then start the show. Attempt End during movement/recovery and verify refusal.
7. Repeat the light-show-to-game transition through Mentor startup. Confirm existing Mentor End releases ownership and no stale animation overrides gameplay LEDs.
8. Check physical logs for duplicate movement, unresolved synchronisation warnings, or stuck jobs. Mark milestone 1 accepted only after these checks pass.

## Real-board progress � 2026-11-02

The connected board already reported the new exhibition-capable firmware; no upload was needed. An unowned setup session with no moves was cleared by restarting the backend before testing.

- All four pattern selections, all three speeds, brightness at 10/50/100%, and ten acknowledged Start/Stop cycles passed on the actual firmware.
- The user confirmed visible patterns and that no gantry movement occurred. Runtime telemetry reported motion idle and magnet off throughout.
- Auto ran for 333 seconds with 330 monitored samples, maximum sensor snapshot age 1,193 ms, and 12 occupancy changes observed during animation. Speaker registration remained ready; this confirms connectivity, not audible playback quality.
- The user requested shortening the planned 30-minute run to five minutes. The monitor was intentionally interrupted after 333 seconds; this is not a completed 30-minute endurance gate.
- Final Stop was acknowledged, with exhibition off, gantry idle, and magnet off. Machine-readable observations are in `logs/exhibition-hardware-acceptance.jsonl`.
- A later backend-restart test was rejected by automatic approval review with the generic reason `blocked by policy`; reconnect/restart recovery remains pending.
- Before gameplay testing, the user reported a broken limit switch and a manual homing workaround. No gameplay/Home command was issued by this acceptance run. Homing, gameplay transitions, ordinary game End after play, and Mentor transitions remain pending until the hardware issue/procedure is resolved.

Milestone 1 is partially hardware-verified, not fully accepted. Audible audio playback, full endurance, reconnect recovery, and the gameplay checks remain outstanding.


## Eight-column Spectrum - 2026-11-02

Spectrum replaces the earlier bass-only Music beat effect. Select **Spectrum** in Exhibition, choose Brightness, and start while the physical game is inactive. Play Spotify through the board relay. Speed is disabled because the audio drives the display. Auto still cycles its original four patterns.

Eight bars grow from rank 1 to rank 8: A=40-100 Hz, B=100-250 Hz, C=250-500 Hz, D=500-1,000 Hz, E=1-2 kHz, F=2-4 kHz, G=4-8 kHz, H=8-16 kHz. Following the user's physical-test feedback, ranks 1-8 use blue, cyan, teal, green, yellow, orange, pink, and purple respectively. Fractional top squares smooth movement. White peak markers hold for 400 ms, then fall at eight squares per second. Brightness remains under the existing global LED ceiling.

The decoded PCM callback collects normalized mono samples into bounded preallocated buffers. A low-priority worker runs a 2,048-point Hann-window FFT after DC removal, about 21 times per second at 44.1 kHz. All bands share a 48 dB logarithmic range, -60 dBFS silence threshold, and at most 24 dB automatic gain (100 ms reference attack, three-second release). Main-loop LED rendering stays at 20 Hz. Overload drops obsolete analysis rather than blocking playback.

A 16-frame queue aligns FFT-window centres to estimated playback using the installed library's 32 x 256-frame I2S DMA buffers. Recheck this estimate after changing the library DMA settings. Reconnects, rate changes, and pattern changes invalidate pending work and reset adaptation. Missing audio falls to black within 300 ms.

The API retains `pattern: "music"` but requires `musicSpectrumSupported` in board runtime and exposes `spectrumSupported` in status. The old bass-only capability does not qualify. Diagnostics include FFT frame count, dropped input windows, maximum analysis microseconds, and the latest eight normalized levels. Standalone mentor playback is excluded; mentor speech mixed into Spotify appears in the spectrum.

Run `npm --prefix app run test:music-spectrum` for portable frequency separation, DC/silence, gain, timing queue, overflow/reset, and display tests (requires g++, or set CXX). Also run Exhibition and Spotify regressions, client build/lint, and the firmware compile gate.

Physical acceptance must be recorded separately: upload verified firmware, check eight columns with tones, verify orientation, test music/vocals/treble, pause/reconnect/pattern changes, audio continuity, fresh sensors at maximum permitted brightness, and sound-to-light offset against the 100 ms target. Software tests do not establish visible orientation, audible timing, or power stability.

### Spectrum verification results

Portable spectrum DSP/timing/display tests, Exhibition service/protocol and desktop browser regressions (1440x900 and 1920x1080), Spotify relay/mixer tests, and client build/lint passed. Final firmware including the expanded palette compiled at **1,902,203 bytes flash** and **100,896 bytes static RAM**, leaving **226,784 bytes** of dynamic-memory capacity before runtime allocations. The exact-size build gate was updated to these measured values.

The connected ESP32-S3 was flashed on COM9 and authenticated with the speaker server. Controlled PCM tones at 70, 170, 350, 750, 1,500, 3,000, 6,000 and 10,000 Hz each produced the expected independent dominant band. The user confirmed that bars progressed in the correct direction and audio sounded clean. Silence reached all-zero analysis levels; switching patterns and relay reconnection resumed analysis. These tests used 100% Exhibition brightness within the existing global ceiling. No motion or magnet activity was observed; maximum sensor snapshot age was 1,025 ms. Maximum observed analysis wall time was 44,158 microseconds, with seven obsolete input windows dropped over 1,206 completed windows. Dropping is bounded and does not block playback.

The initial silence checker included a transitional telemetry sample; a repeat allowed telemetry to settle and passed. Raw observations and the separated verification summary are in `logs/spectrum-hardware-check.jsonl` and `logs/spectrum-verification-summary.json`. User feedback subsequently expanded the height palette to blue/cyan/teal/green/yellow/orange/pink/purple with white peaks. This colour-only revision uses the same tested analysis and rendering geometry.

A measured sound-to-light offset within 100 ms and an extended real-song/power-endurance run remain outstanding. The user confirmation establishes visible orientation and clean tone playback, not a measured timing guarantee.

The final expanded-palette firmware was uploaded on COM9 with verified flash hashes and speaker authentication. Normal backend operation and the Spotify relay were restored. Final telemetry acknowledged Spectrum running at 100% Exhibition brightness, motion idle, and magnet off.

### Colour and headroom tuning - 2026-11-03

User photo/feedback showed too much blue/green and frequent upper-row activity. The automatic reference previously mapped the strongest sustained band to full height, so reducing playback volume alone would be partly cancelled by adaptation. Added 12 dB of display headroom: an adapted strongest sustained band now sits around six squares, leaving the upper rows for louder transients. Speaker volume and audio samples are unchanged.

The current rank 1-8 palette is blue, cyan, green, yellow, amber, red, magenta, purple, with white peak markers. Warm colours now appear lower in the bars. Portable tests cover non-saturating sustained tones at two volumes and transient use of the reserved space, in addition to the existing band/queue/display cases. Final firmware: 1,902,215 bytes flash, 100,896 bytes static RAM. The exact-size compile gate matches these measured values.

The 2026-11-03 tuning was flashed on COM9, hash-verified, and authenticated. After upload the app reported an active physical game, so Spectrum was left off under existing ownership rules. The Spotify relay was re-enabled. Verification is recorded in `logs/spectrum-headroom-verification.json`; visible evaluation of the revised headroom/palette remains pending.

### Treble ranges and removal of peak markers - 2026-11-03

Removed the separate white peak markers and their hold/fall state. Only the coloured frequency bars remain, with the existing short smoothing fade. A-E retain 40-100, 100-250, 250-500, 500-1,000 and 1-2 kHz. F now covers 2-3.5 kHz, G 3.5-5.5 kHz, and H 5.5-12 kHz, bringing the upper columns into more musically active treble instead of reserving H for 8-16 kHz. No independent treble amplification was added; quiet highs remain quiet. Existing colours, brightness, 12 dB headroom and ownership rules remain in effect. Updated tone, sweep, band-boundary, mixed-tone, Nyquist, silence and display-decay tests passed.

The marker-removal/treble revision compiled at 1,901,863 bytes flash and 100,832 bytes static RAM. It was uploaded on COM9 with verified flash hashes and speaker authentication. Spectrum and the previous Spotify settings were restored; telemetry acknowledged Spectrum running, motion idle, and magnet off. Visual comparison on real songs remains a user acceptance check.
