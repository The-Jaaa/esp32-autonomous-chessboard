# GitHub Publication Checklist

Use this checklist before pushing the project to a public GitHub repository.

## Safe To Commit

- Source code under `app/`
- Firmware sketches under `esp32_firmware/` and `firmware_tests/`
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

## Recommended Publish Flow

```powershell
git add .
git status
git diff --cached --check
git commit -m "Describe the change"
git push -u origin main
```

Check `git status` carefully before the commit. If music files, secrets, build binaries, or `node_modules` appear, stop and update `.gitignore` first.
