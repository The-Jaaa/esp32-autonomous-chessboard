# GitHub Publication Checklist

Use this checklist before pushing the project to a public GitHub repository.

## Safe To Commit

- Source code under `app/`
- Firmware sketches under `esp32_firmware/`, `esp32_ota_led/`, `tests_and_misc/`, and the ESP32 audio/WiFi test sketch folders
- Hardware schematics, PCB exports, and Gerber files under `hardware/`
- Markdown documentation
- Public images or diagrams you own
- `package.json` and `package-lock.json`

## Do Not Commit

- `app/.env` or any file containing real API keys
- WiFi SSIDs/passwords
- downloaded MP3/WAV songs
- generated LittleFS/SPIFFS images
- compiled firmware binaries
- `node_modules/`
- portable FFmpeg downloads or extracted binaries
- local logs and temporary render files

## Recommended First Publish Flow

```powershell
git init
git add .
git status
git commit -m "Initial public project snapshot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Check `git status` carefully before the commit. If music files, secrets, build binaries, or `node_modules` appear, stop and update `.gitignore` first.
