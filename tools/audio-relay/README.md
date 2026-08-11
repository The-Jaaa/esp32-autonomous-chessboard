# Spotify Connect Wi-Fi Relay

This private demo path makes the chessboard appear in Spotify Connect as
`UoM Chessboard`. The laptop receives Spotify through librespot, mixes mentor
speech with FFmpeg, and serves one authenticated MP3 stream to the ESP32-S3.
No virtual audio cable is required.

## One-time setup

1. Install or build the pinned receiver:

   ```powershell
   & ".\tools\setup-librespot.ps1" -InstallPrerequisites
   ```

2. Open a new terminal if Rust was installed, then run the script again without
   `-InstallPrerequisites` if it did not continue automatically.
3. Copy `app/.env.example` to the ignored `app/.env` and set:
   - `ESP32_AUDIO_TOKEN` to the same private value used by firmware.
   - `CHESS_AUDIO_SERVER_HOST` and `SPOTIFY_RELAY_PUBLIC_HOST` to the laptop's
     Wi-Fi IPv4 address.
4. On Windows, allow the Node backend and librespot only on Private networks.
   Run the following once from an Administrator PowerShell window, replacing
   the alias if needed; do not add router port forwarding:

   ```powershell
   Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
   & ".\tools\configure-spotify-relay-firewall.ps1"
   ```

Spotify Premium is required. librespot is unofficial and intended here only
for a private project demonstration. Do not capture, save, or redistribute the
streamed audio.

## Normal app flow

Start the backend from `app`, open the mentor controls, and enable the Spotify
toggle. The receiver is deliberately off after every backend restart. Select
`UoM Chessboard` from Spotify on a controller connected to the same Wi-Fi.

The board changes to relay mode only when audible Spotify PCM arrives. Ten
seconds after Spotify becomes inactive, it releases the HTTP decoder and
returns to the normal mentor speaker transport. Mentor speech is delayed about
750 ms, mixed over ducked music, and the song continues underneath.

Status endpoints:

```text
GET  http://<laptop>:3000/api/audio/spotify
PUT  http://<laptop>:3000/api/audio/spotify  {"enabled":true}
GET  http://<laptop>:8001/health
GET  http://<laptop>:8001/live.mp3  (HTTP Basic auth required)
```

## Standalone diagnostic

The PowerShell entrypoint runs the same relay service without the chess app:

```powershell
& ".\tools\audio-relay\start_live_audio_relay.ps1" -PublicHost "YOUR_LAPTOP_WIFI_IP"
```

For the standalone ESP sketch, create the ignored file
`New folder/wifi_stream_speaker_test/wifi_stream_secrets.h` beside the example
header, fill in Wi-Fi, URL, and the matching token, then upload the sketch with
the normal ESP32-S3 N16R8 settings.

Use `/health` to inspect state without credentials. Never paste the token into
logs or commit the real secrets header, binaries, caches, or downloaded songs.
