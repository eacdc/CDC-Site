/**
 * Separate MongoDB connection for CDC Bills (PurchaseBills collection).
 * Uses MONGODB_URI_Billing — not the main MONGODB_URI used by the rest of
 * the backend.
 */
import mongoose from 'mongoose';
import { purchaseBillSchema } from './models/PurchaseBill.js';
import { cdcBillsUserPasswordSchema } from './models/CdcBillsUserPassword.js';
import { cdcBillsActivityLogSchema } from './models/CdcBillsActivityLog.js';
import { cdcBillsSessionSchema } from './models/CdcBillsSession.js';

let billingConnection = null;
/** Live binding: set after `ensurePurchaseBillsReady()` resolves. */
export let PurchaseBill = null;
export let CdcBillsUserPassword = null;
export let CdcBillsActivityLog = null;
export let CdcBillsSession = null;

/** In-flight first connection; reset if connection fails. */
let connecting = null;

/**
 * Connect once and register the PurchaseBill model on this connection.
 * @throws {Error} if MONGODB_URI_Billing is missing or connection fails
 */
export async function ensurePurchaseBillsReady() {
  if (PurchaseBill && CdcBillsUserPassword && CdcBillsActivityLog && CdcBillsSession) return;
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
      CdcBillsUserPassword = c.model('CdcBillsUserPassword', cdcBillsUserPasswordSchema);
      CdcBillsActivityLog = c.model('CdcBillsActivityLog', cdcBillsActivityLogSchema);
      CdcBillsSession = c.model('CdcBillsSession', cdcBillsSessionSchema);
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
    CdcBillsUserPassword = null;
    CdcBillsActivityLog = null;
    CdcBillsSession = null;
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
    CdcBillsUserPassword = null;
    CdcBillsActivityLog = null;
    CdcBillsSession = null;
    connecting = null;
  }
}
