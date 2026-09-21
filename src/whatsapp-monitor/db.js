import mongoose from 'mongoose';
import { config, assertConfigured } from './config.js';
import { logger } from './logger.js';

/**
 * Its own Mongo connection on MONGODB_URI_WA, following the same pattern as
 * db-voice-notes.js. Mongoose is used only to open the connection — everything
 * below works against the native driver's collections, with no schemas or
 * models, because these documents are written and read as plain objects.
 */
let connection = null;
let database = null;

export async function connect() {
  if (database && connection?.readyState === 1) return database;
  assertConfigured();

  connection = mongoose.createConnection(config.mongodbUri);
  await connection.asPromise();
  database = connection.db;

  logger.info({ db: database.databaseName }, 'mongo connected');
  return database;
}

export async function close() {
  if (connection) await connection.close();
  connection = null;
  database = null;
}

function coll(name) {
  if (!database) throw new Error('whatsapp-monitor db not connected - call connect() first');
  return database.collection(name);
}

export const groups = () => coll('groups');
export const messages = () => coll('messages');
export const runs = () => coll('runs');
export const concerns = () => coll('concerns');
export const alerts = () => coll('alerts');
export const summaries = () => coll('summaries');
export const owners = () => coll('owners');
export const routing = () => coll('routing');
export const locks = () => coll('locks');

/** Idempotent. Safe to run on every boot. */
export async function ensureIndexes() {
  await messages().createIndex({ msgId: 1 }, { unique: true, name: 'msgId_unique' });
  await messages().createIndex({ groupId: 1, ts: -1 }, { name: 'group_ts' });
  await messages().createIndex(
    { receivedAt: 1 },
    { name: 'receivedAt_ttl', expireAfterSeconds: config.messageTtlSeconds },
  );
  await messages().createIndex({ groupId: 1, classified: 1 }, { name: 'group_classified' });
  // The concern detail view reads a whole reply thread in time order; without
  // this it would be a collection scan on every open.
  await messages().createIndex({ groupId: 1, threadRootId: 1, ts: 1 }, { name: 'group_thread_ts' });

  await concerns().createIndex({ groupId: 1, category: 1, status: 1 }, { name: 'group_cat_status' });
  await concerns().createIndex({ createdAt: -1 }, { name: 'createdAt_desc' });
  await alerts().createIndex({ concernId: 1 }, { name: 'concernId' });
  await summaries().createIndex({ groupId: 1, kind: 1, periodEnd: -1 }, { name: 'group_kind_period' });
  // The daily summary is upserted by this key, so it must be unique — a retry
  // or a restart at 20:05 must replace the day's summary, not add a second.
  await summaries().createIndex(
    { groupId: 1, kind: 1, dayKey: 1 },
    { name: 'group_kind_day', unique: true, partialFilterExpression: { dayKey: { $exists: true } } },
  );
  await routing().createIndex({ groupId: 1, category: 1 }, { name: 'routing_lookup' });
  await runs().createIndex({ startedAt: -1 }, { name: 'startedAt_desc' });

  logger.info('indexes ensured');
}
