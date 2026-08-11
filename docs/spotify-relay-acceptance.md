# Spotify Relay Acceptance

## Automated gates

- `npm run test:spotify-relay` passes in `app`.
- `npm run test:mentor-speaker` passes in `app`.
- Client lint and production build pass.
- Production ESP32 firmware compiles with 16 MB flash, OPI PSRAM, the production
  partition, and 240 MHz CPU settings.
- `/live.mp3` rejects missing or incorrect Basic authentication.
- Relay queues stay bounded and Spotify inactivity returns desired board mode to
  `mentor` after ten seconds.

## Standalone board gate

Use the standalone Wi-Fi stream sketch before flashing production firmware.

1. Enable the relay and select `UoM Chessboard` in Spotify.
2. Confirm both speakers are clear at ESP volume 20.
3. Confirm initial audio begins within three seconds of the board entering relay
   mode.
4. Interrupt and restore the hotspot, terminate FFmpeg, terminate librespot, and
   reset the ESP one at a time.
5. Require reconnect within 30 seconds in every case and within three seconds
   after Spotify audio resumes once the relay is healthy.

## Production board gate

1. Pause Spotify and require mentor mode in `10 +/- 2` seconds.
2. Trigger Gemini speech while music plays. Music must duck smoothly to quiet
   but audible background; speech must start without clipped words; music must
   recover smoothly.
3. Run both speakers at volume 20 for 30 minutes with track changes and repeated
   mentor interruptions.
4. Reject any brownout, watchdog, OOM, reboot, sustained dropout, distortion, or
   steadily growing relay buffer.
5. While music plays, verify sensors, LEDs, one human move, one robot move, and a
   final magnet-low, gantry-idle state.
6. Restart Wi-Fi, backend, librespot, FFmpeg, and ESP individually. Each must
   recover within 30 seconds or visibly fall back to mentor/browser audio.
7. Restart the backend and confirm Spotify remains disabled until explicitly
   enabled again.
8. Inspect Git changes and runtime logs. No token, Wi-Fi password, Spotify cache,
   song, captured audio, account data, or IP-specific configuration may appear.

Record pass/fail, observed times, reset reason, and any audible fault for every
physical step. Automated tests do not replace this hardware acceptance.
