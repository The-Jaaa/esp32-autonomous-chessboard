const { SpotifyRelayService } = require('../../app/audio/spotify-relay-service');

const relay = new SpotifyRelayService({
  rootDir: process.env.CHESS_PROJECT_ROOT,
  ffmpegPath: process.env.FFMPEG_PATH,
  librespotPath: process.env.LIBRESPOT_PATH,
  host: process.env.SPOTIFY_RELAY_HOST || '0.0.0.0',
  port: Number(process.env.SPOTIFY_RELAY_PORT || 8001),
  streamHost: process.env.SPOTIFY_RELAY_PUBLIC_HOST || ''
});

relay.on('status', (status) => {
  console.log(`[Spotify Relay] state=${status.state} spotify=${status.spotifyActive ? 'active' : 'idle'} clients=${status.clientCount}`);
});

async function shutdown() {
  await relay.close().catch(() => {});
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

relay.enable().catch((error) => {
  console.error(`[Spotify Relay] ${error.message}`);
  process.exitCode = 1;
});
