import 'dotenv/config';

/** CLIENT_ORIGIN may list several origins, comma-separated (e.g. the deployed site and localhost). */
function origins(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['http://localhost:5173'];
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  clientOrigins: origins(process.env.CLIENT_ORIGIN),
  livekit: {
    url: process.env.LIVEKIT_URL ?? '',
    apiKey: process.env.LIVEKIT_API_KEY ?? '',
    apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  },
};

export const livekitConfigured = (): boolean => Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
