/**
 * Unique keys on PurchaseBills (bill_dedup_key, tally_voucher_number) must
 * never be stored as null. Mongo unique indexes treat null as a value, so a
 * second bill without GSTIN+invoice (or without a voucher) fails with:
 *   E11000 ... bill_dedup_key_1 dup key: { bill_dedup_key: null }
 *
 * PUR/384/26-27 and PUR/O/384/26-27 are different voucher strings; they only
 * collided because extraction saved a null dedup key.
 */

export const UNIQUE_OPTIONAL_FIELDS = ['bill_dedup_key', 'tally_voucher_number'];

const UNIQUE_FIELD_LABEL = {
  tally_voucher_number: 'Tally voucher',
  bill_dedup_key: 'Supplier invoice (GSTIN/PAN + bill number)',
};

export function uniqueConflictInfo(err) {
  const keyValue = err?.keyValue || {};
  const keyPattern = err?.keyPattern || {};
  const field = Object.keys(keyPattern)[0] || Object.keys(keyValue)[0] || null;
  const value = field ? keyValue[field] : undefined;
  return {
    field,
    value,
    label: (field && UNIQUE_FIELD_LABEL[field]) || field || 'unique field',
  };
}

function isEmptyUniqueValue(v) {
  return v == null || (typeof v === 'string' && !v.trim());
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

    const keyValue = err.keyValue || {};
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
  const keyValue = err.keyValue || {};
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

/**
 * Drop unique indexes that still index null, unset stored nulls, then create
 * partial unique indexes that only apply to real strings.
 */
export async function repairPurchaseBillUniqueIndexes(Model) {
  const coll = Model.collection;
  console.log('[purchase-bills] repairing unique indexes…');

  const specs = [
    { name: 'bill_dedup_key_1', key: { bill_dedup_key: 1 }, field: 'bill_dedup_key' },
    { name: 'tally_voucher_number_1', key: { tally_voucher_number: 1 }, field: 'tally_voucher_number' },
  ];

  try {
    const indexes = await coll.indexes();
    for (const spec of specs) {
      const matches = indexes.filter((idx) => {
        const keys = Object.keys(idx.key || {});
        return keys.length === 1 && keys[0] === spec.field && idx.unique;
      });
      for (const idx of matches) {
        if (isPartialStringUnique(idx, spec.field)) continue;
        await coll.dropIndex(idx.name);
        console.log(`[purchase-bills] dropped unique index ${idx.name} (sparse=${Boolean(idx.sparse)} partial=${JSON.stringify(idx.partialFilterExpression || null)})`);
      }
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
        Object.keys(idx.key || {}).length === 1 && idx.key?.[spec.field] === 1 && idx.unique
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
