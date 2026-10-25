import { createApp } from './app.js';
import { config, livekitConfigured } from './config.js';

const { http, io, rooms } = createApp();
const sweeper = setInterval(() => rooms.sweep(), 60_000);

http.listen(config.port, () => {
  console.log(`card-games-server listening on :${config.port}`);
  console.log(`  allowed client origins: ${config.clientOrigins.join(', ')}`);
  if (!livekitConfigured()) console.warn('  LiveKit is not configured: video is off, the games still work.');
});

function shutdown() {
  clearInterval(sweeper);
  rooms.close();
  void io.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
