const http = require("http");
const { spawn } = require("child_process");

const ffmpegPath =
  process.env.FFMPEG_PATH ||
  "C:\\Users\\Thejaka\\Desktop\\ChessProject\\tools\\ffmpeg\\extract\\ffmpeg-8.1.2-essentials_build\\bin\\ffmpeg.exe";

const audioDevice =
  process.env.AUDIO_DEVICE ||
  "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{39F03D20-FBE1-44F4-8E9C-B133CD54BC16}";

const host = process.env.RELAY_HOST || "0.0.0.0";
const port = Number(process.env.RELAY_PORT || "8001");
const bitrate = process.env.RELAY_BITRATE || "96k";
const sampleRate = process.env.RELAY_SAMPLE_RATE || "44100";
const channels = process.env.RELAY_CHANNELS || "1";

function startFfmpeg() {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "dshow",
    "-i",
    `audio=${audioDevice}`,
    "-vn",
    "-ac",
    channels,
    "-ar",
    sampleRate,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    bitrate,
    "-f",
    "mp3",
    "pipe:1",
  ];

  return spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      [
        "ESP audio relay is running.",
        `Stream: http://${req.headers.host}/live.mp3`,
        `FFmpeg: ${ffmpegPath}`,
        `Device: ${audioDevice}`,
      ].join("\n")
    );
    return;
  }

  if (!req.url.startsWith("/live.mp3")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
    return;
  }

  console.log(`[relay] client connected from ${req.socket.remoteAddress}`);
  const ffmpeg = startFfmpeg();

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Connection": "close",
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[ffmpeg] ${text}`);
  });

  ffmpeg.on("close", (code, signal) => {
    console.log(`[relay] ffmpeg exited code=${code} signal=${signal || ""}`);
    if (!res.destroyed) res.end();
  });

  req.on("close", () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    console.log("[relay] client disconnected");
  });
});

server.listen(port, host, () => {
  console.log(`[relay] listening on http://${host}:${port}/live.mp3`);
  console.log(`[relay] device: ${audioDevice}`);
  console.log(`[relay] ffmpeg: ${ffmpegPath}`);
});
