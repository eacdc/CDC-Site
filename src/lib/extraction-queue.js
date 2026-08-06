/**
 * In-memory background queue for bill extraction + verification.
 *
 * When a bill is saved with verification_status = "pending_extraction",
 * callers enqueue its MongoDB _id. A serial async worker picks jobs one
 * at a time, runs OpenAI vision + aggregation + verification, and persists
 * results. No external dependency (no Redis, no BullMQ) — suitable for a
 * single Render instance.
 *
 * NOTE: jobs are lost on process restart. Bills with verification_status
 * "pending_extraction" at startup are picked up via recoverPendingOnStartup().
 */

import { aggregateAllSlots, buildCanonicalFields } from './purchase-bill-aggregation.js';
import { runVerificationChecks, computeVerificationStatus } from './purchase-bill-verification.js';
import { extractAllSlotPages } from './purchase-bill-extract-slots.js';
import { generatePhash } from './phash.js';
import { resolveViewUrl } from './media-url.js';
import { buildDbHelpers } from './purchase-bill-db-helpers.js';

// ---------- queue state ----------

const queue = [];
let processing = false;
let _PurchaseBill = null; // injected once DB is ready

export function setQueueModel(model) {
  _PurchaseBill = model;
}

/** Add a bill _id to the processing queue. */
export function enqueue(billId) {
  queue.push(String(billId));
  scheduleWorker();
}

function scheduleWorker() {
  if (!processing) {
    // Use setImmediate so the HTTP response returns first
    setImmediate(runWorker);
  }
}

// ---------- worker ----------

async function runWorker() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const billId = queue.shift();
    try {
      await processBill(billId);
    } catch (err) {
      console.error('[extraction-queue] unhandled error for bill', billId, err?.message || err);
      // Mark bill as needs_review with an extraction_error note so the UI can show it
      try {
        await _PurchaseBill.findByIdAndUpdate(billId, {
          verification_status: 'needs_review',
          extraction_error: err?.message || 'Extraction failed',
        });
      } catch { /* ignore secondary failure */ }
    }
  }

  processing = false;
}

async function processBill(billId) {
  if (!_PurchaseBill) throw new Error('PurchaseBill model not ready');

  const bill = await _PurchaseBill.findById(billId);
  if (!bill) {
    console.warn('[extraction-queue] bill not found:', billId);
    return;
  }
  if (bill.verification_status !== 'pending_extraction') {
    // Already processed (e.g. duplicate enqueue)
    return;
  }

  console.log('[extraction-queue] processing bill', billId);

  // 1. Vision extraction for pages that don't have extracted fields yet
  const slotsWithExtraction = await extractAllSlotPages(bill.slots);

  // 2. Aggregate
  const aggregatedSlots = aggregateAllSlots(slotsWithExtraction);
  const canonical = buildCanonicalFields(aggregatedSlots, { setType: bill.set_type });

  // 3. Perceptual hash
  let invoice_image_phash = bill.invoice_image_phash || null;
  if (!invoice_image_phash) {
    const firstPage = aggregatedSlots.supplier_invoice?.pages?.[0];
    const phashUrl = await resolveViewUrl(firstPage);
    if (phashUrl) {
      invoice_image_phash = await generatePhash(phashUrl);
    }
  }

  // 4. Apply extracted data to bill document
  Object.assign(bill, canonical);
  bill.slots = aggregatedSlots;
  bill.invoice_image_phash = invoice_image_phash;

  // 5. Verification
  const helpers = buildDbHelpers(bill._id);
  const results = await runVerificationChecks(bill, helpers);
  const { status, blocking, warning } = computeVerificationStatus(results);
  bill.check_results = results;
  bill.verification_status = status;
  bill.blocking_failures_count = blocking;
  bill.warning_failures_count = warning;

  await bill.save();
  console.log('[extraction-queue] done bill', billId, '->', status);
}

// ---------- startup recovery ----------

/**
 * Called once after the billing DB is ready.
 * Picks up any bills stuck in "pending_extraction" from a previous crash.
 */
export async function recoverPendingOnStartup() {
  if (!_PurchaseBill) return;
  try {
    const pending = await _PurchaseBill
      .find({ verification_status: 'pending_extraction' })
      .select('_id')
      .lean();
    if (pending.length) {
      console.log(`[extraction-queue] recovering ${pending.length} pending bill(s)`);
      for (const b of pending) enqueue(b._id);
    }
  } catch (err) {
    console.warn('[extraction-queue] recovery failed:', err?.message);
  }
}
