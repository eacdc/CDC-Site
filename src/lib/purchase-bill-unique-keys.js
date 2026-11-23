/**
 * Unique keys on PurchaseBills (bill_dedup_key, tally_voucher_number) must
 * never be stored as null. Mongo unique indexes treat null as a value, so a
 * second bill without GSTIN+invoice (or without a voucher) fails with:
 *   E11000 ... bill_dedup_key_1 dup key: { bill_dedup_key: null }
 *
 * PUR/384/26-27 and PUR/O/384/26-27 are different voucher strings; they only
 * collided because extraction saved a null dedup key.
 *
 * Tally voucher numbers are unique per location (KOL and AHM each run their
 * own Tally), so that index is { location, tally_voucher_number }.
 */
import { DEFAULT_LOCATION } from '../config/cdc.js';
import { buildBillDedupBase, buildBillDedupKey, financialYear } from './purchase-bill-dedup.js';

export const UNIQUE_OPTIONAL_FIELDS = ['bill_dedup_key', 'tally_voucher_number'];

const UNIQUE_FIELD_LABEL = {
  tally_voucher_number: 'Tally voucher',
  bill_dedup_key: 'Supplier invoice (GSTIN/PAN + bill number)',
};

/**
 * Unique fields from a duplicate-key error's keyValue. The voucher index also
 * holds `location`, which is scope, not the conflicting value.
 */
function conflictKeyValue(err) {
  const keyValue = err?.keyValue || {};
  return Object.fromEntries(
    Object.entries(keyValue).filter(([k]) => UNIQUE_OPTIONAL_FIELDS.includes(k)),
  );
}

export function uniqueConflictInfo(err) {
  const keyValue = err?.keyValue || {};
  const keyPattern = err?.keyPattern || {};
  const keys = [...Object.keys(keyPattern), ...Object.keys(keyValue)];
  const field = keys.find((k) => UNIQUE_OPTIONAL_FIELDS.includes(k)) || keys[0] || null;
  const value = field ? keyValue[field] : undefined;
  return {
    field,
    value,
    location: keyValue.location ?? null,
    label: (field && UNIQUE_FIELD_LABEL[field]) || field || 'unique field',
  };
}

function isEmptyUniqueValue(v) {
  return v == null || (typeof v === 'string' && !v.trim());
}

/**
 * A bill flagged as a duplicate supplier invoice gives up its unique key (it
 * keeps `bill_dedup_base`), so the original keeps the key and is never itself
 * flagged as a duplicate of the copy. Call after verification, before saving.
 */
export function releaseDedupKeyIfDuplicate(bill) {
  const dup = (bill.check_results || []).some(
    (r) => r.check_id === 'DUPLICATE_BILL_NUMBER' && r.status === 'fail' && r.actual?.existing_bill_id,
  );
  if (dup) {
    bill.set?.('bill_dedup_key', undefined);
    if (!bill.set) bill.bill_dedup_key = undefined;
  }
  return dup;
}

export function stripEmptyUniqueKeys(bill) {
  const unset = {};
  for (const field of UNIQUE_OPTIONAL_FIELDS) {
    if (isEmptyUniqueValue(bill[field])) {
      unset[field] = 1;
      bill.set?.(field, undefined);
      if (bill._doc) delete bill._doc[field];
    }
  }
  return unset;
}

async function unsetInDb(Model, id, unset) {
  if (!unset || Object.keys(unset).length === 0) return;
  await Model.collection.updateOne({ _id: id }, { $unset: unset });
}

/**
 * Save a bill without writing null unique keys. On a null-index collision,
 * $unset and retry. On a real duplicate, keep extracted fields for review.
 */
export async function saveBillWithoutNullUniqueKeys(bill) {
  const Model = bill.constructor;
  const unset = stripEmptyUniqueKeys(bill);

  try {
    await bill.save();
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const keyValue = conflictKeyValue(err);
    const nullUnset = { ...unset };
    for (const [field, value] of Object.entries(keyValue)) {
      if (isEmptyUniqueValue(value)) nullUnset[field] = 1;
    }

    if (Object.keys(nullUnset).length > 0) {
      await unsetInDb(Model, bill._id, nullUnset);
      for (const field of Object.keys(nullUnset)) {
        bill.set?.(field, undefined);
        if (bill._doc) delete bill._doc[field];
      }
      try {
        await bill.save();
      } catch (retryErr) {
        if (retryErr?.code !== 11000) throw retryErr;
        // Index still treats missing as null (old non-sparse unique). Persist
        // via $set/$unset so mongoose cannot write null back.
        await persistWithoutMongooseNull(bill, nullUnset);
      }
      await unsetInDb(Model, bill._id, stripEmptyUniqueKeys(bill));
      return;
    }

    const conflictUnset = Object.fromEntries(Object.keys(keyValue).map((k) => [k, 1]));
    for (const field of Object.keys(keyValue)) {
      bill.set?.(field, undefined);
      if (bill._doc) delete bill._doc[field];
    }
    bill.verification_status = 'needs_review';
    bill.extraction_error = formatDuplicateSaveError(err);
    await unsetInDb(Model, bill._id, conflictUnset);
    try {
      await bill.save();
    } catch (retryErr) {
      if (retryErr?.code !== 11000) throw retryErr;
      await persistWithoutMongooseNull(bill, { ...conflictUnset, ...stripEmptyUniqueKeys(bill) });
    }
    return;
  }

  await unsetInDb(Model, bill._id, unset);
}

async function persistWithoutMongooseNull(bill, extraUnset = {}) {
  const Model = bill.constructor;
  const obj = typeof bill.toObject === 'function' ? bill.toObject() : { ...bill };
  delete obj._id;
  delete obj.__v;
  const unset = { ...extraUnset };
  for (const field of UNIQUE_OPTIONAL_FIELDS) {
    if (isEmptyUniqueValue(obj[field])) {
      unset[field] = 1;
      delete obj[field];
    }
  }
  const update = { $set: obj };
  if (Object.keys(unset).length) update.$unset = unset;
  await Model.collection.updateOne({ _id: bill._id }, update);
}

export function formatDuplicateSaveError(err) {
  const keyValue = conflictKeyValue(err);
  const parts = Object.entries(keyValue)
    .filter(([, v]) => !isEmptyUniqueValue(v))
    .map(([k, v]) => `${k}=${v}`);
  if (parts.length === 0) {
    return 'Unique index collided on an empty key. Restart the backend so the index can be repaired, then reprocess.';
  }
  return `Duplicate ${parts.join(', ')} already exists. Extracted data was kept for review.`;
}

function isPartialStringUnique(index, field) {
  const partial = index?.partialFilterExpression;
  const type = partial?.[field]?.$type;
  return Boolean(index?.unique && (type === 'string' || type === 2));
}

function sameKey(a = {}, b = {}) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * Bring stored dedup keys to the current rule (supplier + invoice number
 * ignoring punctuation / leading zeros + financial year). Runs on every
 * startup and only writes rows whose key or base changed.
 *
 * Bills that only now count as duplicates: the earliest upload keeps the key;
 * later ones give it up and are flagged for review. Nothing is deleted.
 * Bills that already had no key (earlier duplicates) only get a base.
 */
export async function migrateBillDedupKeys(coll) {
  const cursor = coll.find(
    { $or: [{ bill_dedup_key: { $type: 'string' } }, { invoice_number: { $type: 'string' } }] },
    { projection: { supplier_gstin: 1, supplier_pan: 1, invoice_number: 1, invoice_date: 1, bill_dedup_key: 1, bill_dedup_base: 1 } },
  ).sort({ uploaded_at: 1, _id: 1 });

  const owner = new Map(); // new key → _id of the bill keeping it
  const ops = [];
  const flagged = [];
  for await (const row of cursor) {
    const base = buildBillDedupBase(row);
    const key = buildBillDedupKey(row);
    const $set = {};
    const $unset = {};
    if (base && base !== row.bill_dedup_base) $set.bill_dedup_base = base;
    if (!base && row.bill_dedup_base) $unset.bill_dedup_base = 1;
    // No key under today's rules (e.g. a misread 14-character GSTIN saved by
    // older code): keep the old key as it is.
    if (typeof row.bill_dedup_key === 'string' && key) {
      if (owner.has(key)) {
        $unset.bill_dedup_key = 1;
        flagged.push({ _id: row._id, original: owner.get(key), invoice_number: row.invoice_number, fy: financialYear(row.invoice_date) });
      } else {
        owner.set(key, row._id);
        if (key !== row.bill_dedup_key) $set.bill_dedup_key = key;
      }
    }
    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) ops.push({ updateOne: { filter: { _id: row._id }, update } });
  }

  // Free the copies' keys first so no original collides with a copy's old key.
  ops.sort((a, b) => Number(Boolean(b.updateOne.update.$unset?.bill_dedup_key)) - Number(Boolean(a.updateOne.update.$unset?.bill_dedup_key)));
  if (ops.length) {
    try {
      await coll.bulkWrite(ops, { ordered: false });
    } catch (err) {
      console.warn(`[purchase-bills] dedup key migration: ${err?.writeErrors?.length ?? 1} write(s) failed:`, err?.message);
    }
  }

  for (const f of flagged) {
    const bill = await coll.findOne({ _id: f._id }, { projection: { check_results: 1, verification_status: 1 } });
    const message = `Bill ${f.invoice_number} from this supplier already exists for ${f.fy ? `FY ${f.fy}` : 'any year (invoice date unknown)'} (bill ${String(f.original)}). Found when duplicate matching started ignoring punctuation and leading zeros.`;
    const checks = (bill?.check_results || []).filter((r) => r.check_id !== 'DUPLICATE_BILL_NUMBER');
    checks.push({
      check_id: 'DUPLICATE_BILL_NUMBER', category: 'duplicate', level: 'blocking', status: 'fail',
      message, expected: 'unique', actual: { existing_bill_id: String(f.original) },
    });
    const $set = {
      check_results: checks,
      blocking_failures_count: checks.filter((r) => r.level === 'blocking' && r.status === 'fail').length,
    };
    if (bill?.verification_status !== 'rejected') $set.verification_status = 'needs_review';
    await coll.updateOne({ _id: f._id }, { $set });
  }

  console.log(`[purchase-bills] dedup keys: updated ${ops.length} bills, flagged ${flagged.length} new duplicates${flagged.length ? `: ${flagged.map((f) => `${f._id} (copy of ${f.original})`).join(', ')}` : ''}`);
}

/**
 * Backfill `location` on rows that predate it, drop unique indexes that still
 * index null (or the retired global voucher index), unset stored nulls, then
 * create partial unique indexes that only apply to real strings.
 */
export async function repairPurchaseBillUniqueIndexes(Model) {
  const coll = Model.collection;
  console.log('[purchase-bills] repairing unique indexes…');

  // `field` is the optional value the partial filter is on.
  const specs = [
    { name: 'bill_dedup_key_1', key: { bill_dedup_key: 1 }, field: 'bill_dedup_key' },
    {
      name: 'location_1_tally_voucher_number_1',
      key: { location: 1, tally_voucher_number: 1 },
      field: 'tally_voucher_number',
    },
  ];
  // Voucher numbers were globally unique before AHM bills; that blocks AHM
  // PUR/70/26-27 whenever KOL has the same number.
  const retired = [{ tally_voucher_number: 1 }];

  try {
    const backfill = await coll.updateMany(
      { $or: [{ location: { $exists: false } }, { location: null }] },
      { $set: { location: DEFAULT_LOCATION } },
    );
    if (backfill.modifiedCount) {
      console.log(`[purchase-bills] set location=${DEFAULT_LOCATION} on ${backfill.modifiedCount} older bills`);
    }

    try {
      await migrateBillDedupKeys(coll);
    } catch (err) {
      console.warn('[purchase-bills] dedup key migration failed:', err?.message || err);
    }

    const indexes = await coll.indexes();
    for (const idx of indexes) {
      if (!idx.unique) continue;
      if (retired.some((key) => sameKey(idx.key, key))) {
        await coll.dropIndex(idx.name);
        console.log(`[purchase-bills] dropped retired unique index ${idx.name}`);
        continue;
      }
      const spec = specs.find((sp) => sameKey(idx.key, sp.key));
      if (!spec || isPartialStringUnique(idx, spec.field)) continue;
      await coll.dropIndex(idx.name);
      console.log(`[purchase-bills] dropped unique index ${idx.name} (sparse=${Boolean(idx.sparse)} partial=${JSON.stringify(idx.partialFilterExpression || null)})`);
    }

    const unsetDedup = await coll.updateMany(
      { bill_dedup_key: null },
      { $unset: { bill_dedup_key: 1 } },
    );
    const unsetVoucher = await coll.updateMany(
      { tally_voucher_number: null },
      { $unset: { tally_voucher_number: 1 } },
    );
    console.log(
      `[purchase-bills] unset null unique keys (dedup=${unsetDedup.modifiedCount || 0}, voucher=${unsetVoucher.modifiedCount || 0})`,
    );

    const afterDrop = await coll.indexes();
    for (const spec of specs) {
      const existing = afterDrop.find((idx) => idx.name === spec.name || (
        sameKey(idx.key, spec.key) && idx.unique
      ));
      if (existing && isPartialStringUnique(existing, spec.field)) {
        console.log(`[purchase-bills] unique index ${existing.name} already partial`);
        continue;
      }
      const opts = {
        unique: true,
        name: spec.name,
        partialFilterExpression: { [spec.field]: { $type: 'string' } },
      };
      try {
        await coll.createIndex(spec.key, opts);
      } catch (createErr) {
        const msg = String(createErr?.message || '');
        if (!/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(msg)) throw createErr;
        await coll.dropIndex(spec.name);
        await coll.createIndex(spec.key, opts);
      }
      console.log(`[purchase-bills] created partial unique index ${spec.name}`);
    }

    const finalIndexes = await coll.indexes();
    for (const spec of specs) {
      const idx = finalIndexes.find((i) => i.name === spec.name);
      console.log(`[purchase-bills] ${spec.name}: unique=${Boolean(idx?.unique)} sparse=${Boolean(idx?.sparse)} partial=${JSON.stringify(idx?.partialFilterExpression || null)}`);
    }
  } catch (err) {
    console.warn('[purchase-bills] unique index repair failed:', err?.message || err);
  }
}
