/**
 * Separate MongoDB connection for CDC Bills (PurchaseBills collection).
 * Uses MONGODB_URI_Billing — not the main MONGODB_URI used by the rest of
 * the backend.
 */
import mongoose from 'mongoose';
import { purchaseBillSchema } from './models/PurchaseBill.js';

let billingConnection = null;
/** Live binding: set after `ensurePurchaseBillsReady()` resolves. */
export let PurchaseBill = null;

/** In-flight first connection; reset if connection fails. */
let connecting = null;

/**
 * Connect once and register the PurchaseBill model on this connection.
 * @throws {Error} if MONGODB_URI_Billing is missing or connection fails
 */
export async function ensurePurchaseBillsReady() {
  if (PurchaseBill) return;
  const uri = process.env.MONGODB_URI_Billing;
  if (!uri || !String(uri).trim()) {
    throw new Error(
      'MONGODB_URI_Billing is not set. Add it to backend/.env for the CDC Bills tool.',
    );
  }
  if (!connecting) {
    connecting = (async () => {
      const c = mongoose.createConnection(uri.trim());
      const Model = c.model('PurchaseBill', purchaseBillSchema);
      await c.asPromise();
      billingConnection = c;
      PurchaseBill = Model;
      console.log('✅ Billing MongoDB connected (PurchaseBills / MONGODB_URI_Billing)');
      // Recover bills that were stuck in pending_extraction on last run
      const { setQueueModel, recoverPendingOnStartup } = await import('./lib/extraction-queue.js');
      setQueueModel(Model);
      await recoverPendingOnStartup();
    })();
  }
  try {
    await connecting;
  } catch (err) {
    connecting = null;
    PurchaseBill = null;
    if (billingConnection) {
      try { await billingConnection.close(); } catch { /* ignore */ }
      billingConnection = null;
    }
    throw err;
  }
}

export async function closePurchaseBillsMongo() {
  if (billingConnection) {
    await billingConnection.close();
    billingConnection = null;
    PurchaseBill = null;
    connecting = null;
  }
}
