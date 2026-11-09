# Native Stockfish 19 and Ultra

Run `./tools/setup-stockfish.ps1` from PowerShell before starting the app. It downloads the pinned official Windows x64 universal archive, verifies its SHA-256, extracts it under ignored `tools/stockfish/`, and checks UCI identity and compiler features. The release manifest is `tools/stockfish-version.json`. This Stockfish 19 release supplies a universal executable; it selects the supported instruction set automatically. On the project laptop it reports x86-64-avxvnni with AVX2 support. The distribution includes upstream source and GPL license. Keep those available if redistributing the executable.

`STOCKFISH_PATH` optionally selects another native Stockfish 19 executable. No npm engine or JavaScript fallback remains. Missing, wrong-version or unsupported executables produce a setup error. Installing app npm dependencies alone does not install Stockfish.

## Behaviour

All Stockfish consumers use the native engine service. Game moves, physical normal play and companion evaluations use one persistent four-thread / 256 MB hash instance. Mentor analysis uses a separate one-thread / 32 MB instance. A move preempts an active background evaluation; queued evaluations are coalesced and at most two game searches may wait. The HTTP background-evaluation budget is 500 ms. The depth query remains accepted for compatibility but no longer extends a background evaluation.

Normal levels preserve their existing candidate sampling, deliberate mistakes, personality weighting and depth limits. Candidate scoring is serialized through the persistent engine instead of spawning four engines. Exact playing strength changes with the new engine and is not Elo-calibrated. Depth searches have a 30-second safety watchdog; timeout is an error, not a successful partial search.

The companion page's Ultra toggle is available for virtual games and ordinary physical games. The virtual preference is remembered in local browser storage (`chess.ultraMode`); physical changes are session-scoped. Ultra never changes shared normal levels or Mentor schemas. The normal slider is disabled while Ultra is selected and resumes at its stored level when Ultra is turned off. Autonomous operation and Mentor activities disable the toggle. Changes during thinking apply to the next engine turn. Personality has no effect on Ultra move selection.

`POST /api/engine-move` accepts optional `difficultyMode: normal | ultra`, defaulting to normal. Ultra uses MultiPV 1, Skill Level 20, UCI_LimitStrength false and `go movetime 3000`. Responses include the selected mode and search telemetry. Terminal/invalid positions are rejected, queue overflow returns 503, and Ultra failures leave the board position intact with Retry available. No cached or random fallback is used for Ultra. Resetting a game, unmounting the page or entering physical/autonomous mode aborts virtual work. Response-disconnect cancellation stops server work; the engine is drained or restarted before another request can use it. FEN and generation checks reject stale browser responses.

## Verification

Run `npm --prefix app run test:ultra` for engine policy, real native searches and browser checks. Existing Mentor engine tests cover crashes, timeout and recovery. Run the normal physical/settings and Mentor suites and client build/lint for migration regressions. The foundation verification includes Ultra tests.

The initial two-position warm-engine benchmark produced approximately 3,017-3,019 ms HTTP response time for 3,001 ms searches. Separate concurrent Mentor analysis completed while Ultra retained its budget. A further test with the real FFmpeg mixing/MP3 pipeline processing generated music and Mentor analysis running concurrently returned in about 3,010 ms. This uses local generated PCM; it does not assert a live Spotify-account or physical-speaker endurance result. Results are in ignored `logs/stockfish-19-benchmark.json`; the previous Lite depth-15 baseline is `logs/stockfish-18-baseline.json`. These are latency and legal-move checks, not a strength rating or a statistically controlled engine match. Full native depth-15 comparison results use a warm hash and should not be read as a cold-start speed ratio.

No ESP32 firmware changes or upload are needed. Restart the backend at an idle board boundary after upgrading. Spotify is off by default after a backend restart and can be restored to its prior setting.

## Deployed verification

The backend was restarted with no active physical session or autonomous playback. Both persistent native Stockfish processes started successfully. A live Ultra request returned legal `d2d4` from the starting position, reporting 3,000 ms engine search time, depth 27, and 3,197 ms total client-observed time. The prior Spotify relay enabled state was restored. No firmware was flashed. The physical board was disconnected during this deployment, so hardware-connected gameplay and live Spotify speaker endurance were not revalidated; physical protocol and Mentor integration regression suites passed with simulated board inputs.

All planned software suites passed: native/Ultra integration and browser checks, physical planner/state/promotion, shared game settings, complete Mentor suite including browser tests, client production build/lint, and backend syntax. Normal levels retain their policies but have not been calibrated to human Elo ratings on the new engine.

## Physical Ultra extension

Ultra is also available for ordinary companion-controlled physical games. The start request accepts `difficultyMode`, defaulting to `normal`. `PATCH /api/physical/difficulty-mode` accepts `difficultyMode` and `expectedSessionGeneration`; changes apply on the next robot turn. Physical mode is session-scoped and does not overwrite shared level settings or the browser preference. Mentor activities remain normal. Ultra preserves the best move and pauses if it has no safe physical route, rather than substituting another move. No firmware change is required. Physical gameplay acceptance must be checked separately.
