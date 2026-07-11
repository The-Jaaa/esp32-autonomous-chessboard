# Live Audio Relay

Private demo helper for relaying a Windows audio input to the ESP32 as a live MP3 stream.

The current PC exposes only this capture input to FFmpeg:

```text
Microphone Array (Intel® Smart Sound Technology for Digital Microphones)
```

The scripts default to FFmpeg's ASCII-only alternative device ID for that microphone, because the human-readable name contains `®` and may be decoded incorrectly by Windows PowerShell.

For Spotify/system audio, install or enable a loopback/virtual audio device, then pass that device name to `start_live_audio_relay.ps1`.

List capture devices:

```powershell
& "C:\Users\Thejaka\Desktop\ChessProject\tools\audio-relay\list_audio_devices.ps1"
```

Start relay:

```powershell
& "C:\Users\Thejaka\Desktop\ChessProject\tools\audio-relay\start_live_audio_relay.ps1"
```

Start relay with a virtual cable later:

```powershell
& "C:\Users\Thejaka\Desktop\ChessProject\tools\audio-relay\start_live_audio_relay.ps1" -Device "CABLE Output (VB-Audio Virtual Cable)"
```

ESP stream URL format:

```text
http://<PC_WIFI_IP>:8001/live.mp3
```

Keep this as a private local demo. Do not save, redistribute, or expose captured Spotify audio.
