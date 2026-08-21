/**
 * Supplier Portal MongoDB connection.
 *
 * Its own connection and its own URI (`MONGODB_URI_SupplierPortal`), following
 * the pattern the CDC Bills module already uses. Keeping it separate means the
 * portal can be pointed at a different cluster, backed up on its own schedule,
 * and — most usefully during the first mapping pass — restored without
 * touching anything else.
 *
 * Models are exported as live bindings, populated once `ensureSupplierPortalReady()`
 * resolves. Importing a model before that gives you `null`, which is why every
 * route awaits the ready call first.
 */

import mongoose from 'mongoose';
import { SCHEMAS } from '../models/schemas.js';
import { UOM_SEED, AMBIGUOUS_UOMS } from '../config/uom-seed.js';

let connection = null;
let connecting = null;

/** Live bindings — null until `ensureSupplierPortalReady()` has resolved. */
export let SupplierGroup = null;
export let QuoteDocument = null;
export let QuoteLine = null;
export let SupplierItem = null;
export let ItemMapping = null;
export let RateHistory = null;
export let MappingQueue = null;
export let DocumentSet = null;
export let UomNormalisation = null;
export let AuditLog = null;
export let User = null;
export let SupplierUser = null;
export let Session = null;
export let ItemClassification = null;
export let DeliveryDateSnapshot = null;
export let PaperBrandRule = null;

const BINDINGS = [
  'SpSupplierGroup', 'SpQuoteDocument', 'SpQuoteLine', 'SpSupplierItem',
  'SpItemMapping', 'SpRateHistory', 'SpMappingQueue', 'SpDocumentSet',
  'SpUomNormalisation', 'SpAuditLog', 'SpUser', 'SpSupplierUser',
  'SpSession', 'SpItemClassification', 'SpDeliveryDateSnapshot',
  'SpPaperBrandRule',
];

function assign(models) {
  ({
    SpSupplierGroup: SupplierGroup,
    SpQuoteDocument: QuoteDocument,
    SpQuoteLine: QuoteLine,
    SpSupplierItem: SupplierItem,
    SpItemMapping: ItemMapping,
    SpRateHistory: RateHistory,
    SpMappingQueue: MappingQueue,
    SpDocumentSet: DocumentSet,
    SpUomNormalisation: UomNormalisation,
    SpAuditLog: AuditLog,
    SpUser: User,
    SpSupplierUser: SupplierUser,
    SpSession: Session,
    SpItemClassification: ItemClassification,
    SpDeliveryDateSnapshot: DeliveryDateSnapshot,
    SpPaperBrandRule: PaperBrandRule,
  } = models);
}

function clear() {
  assign(Object.fromEntries(BINDINGS.map((n) => [n, null])));
}

/**
 * Connect once and register every model on that connection.
 *
 * @throws {Error} if the URI is missing or the connection fails
 */
export async function ensureSupplierPortalReady() {
  if (SupplierGroup) return;

  const uri = process.env.MONGODB_URI_SupplierPortal;
  if (!uri || !String(uri).trim()) {
    throw new Error(
      'MONGODB_URI_SupplierPortal is not set. Add it to backend/.env for the Supplier Portal.',
    );
  }

  if (!connecting) {
    connecting = (async () => {
      const conn = mongoose.createConnection(uri.trim(), { autoIndex: false });
      const models = {};
      for (const [name, schema] of Object.entries(SCHEMAS)) {
        models[name] = conn.model(name, schema);
      }
      await conn.asPromise();
      connection = conn;
      assign(models);
      console.log('✅ Supplier Portal MongoDB connected (MONGODB_URI_SupplierPortal)');

      // Indexes are built explicitly rather than on model registration so a
      // slow build is visible in the logs instead of racing the first request.
      await Promise.all(Object.values(models).map((m) => m.ensureIndexes()));
      await seedUomNormalisation();
    })();
  }

  try {
    await connecting;
  } catch (err) {
    connecting = null;
    connection = null;
    clear();
    throw err;
  }
}

/**
 * Seed the UOM table on first run. Existing rows are left alone — the purchase
 * team edits this table, and a redeploy must not undo their corrections.
 */
async function seedUomNormalisation() {
  const existing = await UomNormalisation.estimatedDocumentCount();
  if (existing > 0) return;
  const rows = [
    ...UOM_SEED.map((u) => ({ ...u, raw: u.raw.toUpperCase(), isAmbiguous: false })),
    ...AMBIGUOUS_UOMS.map((raw) => ({
      raw: raw.toUpperCase(), canonical: null, factor: 1, isAmbiguous: true,
    })),
  ];
  await UomNormalisation.insertMany(rows, { ordered: false });
  console.log(`[SP] Seeded ${rows.length} UOM normalisation rows`);
}

/** The raw connection, for transactions and health checks. */
export function supplierPortalConnection() {
  return connection;
}

export async function closeSupplierPortal() {
  if (!connection) return;
  const conn = connection;
  connection = null;
  connecting = null;
  clear();
  await conn.close();
}
