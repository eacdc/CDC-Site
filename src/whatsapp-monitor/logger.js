import pino from 'pino';
import { config } from './config.js';

/** Scoped to this module; the rest of the backend keeps using console. */
export const logger = pino({
  name: 'whatsapp-monitor',
  level: config.logLevel,
  ...(config.nodeEnv === 'production'
    ? {}
    : { transport: { target: 'pino/file', options: { destination: 1 } } }),
});
