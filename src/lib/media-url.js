/**
 * media-url.js — the USE_R2 rollback gate (MIGRATION.md §9).
 *
 * Every read of a stored image reference goes through here. The gate is:
 *
 *     USE_R2=true  and an r2_key exists  → mint a short-lived presigned URL
 *     otherwise                          → return the legacy Cloudinary URL
 *
 * Both the R2 key and the Cloudinary URL stay on the record, so rolling back
 * is flipping USE_R2 to false — no data restore, no redeploy of old code.
 *
 * Signed URLs are NEVER persisted (MIGRATION.md §5): store the key, sign on
 * read. Everything exported here is async for that reason; propagate the
 * await up the call stack rather than caching the result.
 */

import { viewUrl, downloadUrl } from './r2-storage.js';

/** MIGRATION.md §9. Off unless explicitly enabled, so deploys are inert. */
export function isR2Enabled() {
  return process.env.USE_R2 === 'true';
}

/**
 * Resolve one page/asset reference to a URL a browser or fetcher can use.
 *
 * @param {{ r2_key?: string, cloudinary_url?: string } | null | undefined} ref
 * @param {number} [expiresIn] seconds; r2-storage defaults to 3600
 * @returns {Promise<string|null>}
 */
export async function resolveViewUrl(ref, expiresIn) {
  if (!ref) return null;
  if (isR2Enabled() && ref.r2_key) {
    return viewUrl(ref.r2_key, expiresIn);
  }
  return ref.cloudinary_url || null;
}

/**
 * Batch form. Preserves input order and keeps nulls in place so callers can
 * zip the result against the original array.
 *
 * @param {Array<{ r2_key?: string, cloudinary_url?: string }>} refs
 * @returns {Promise<Array<string|null>>}
 */
export async function resolveViewUrlList(refs, expiresIn) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  return Promise.all(refs.map((ref) => resolveViewUrl(ref, expiresIn)));
}

/**
 * Save-as URL. Falls back to the plain Cloudinary URL when the gate is off —
 * Cloudinary has no equivalent of ResponseContentDisposition here, so the
 * legacy path simply returns the delivery URL as it always did.
 *
 * @param {{ r2_key?: string, cloudinary_url?: string }} ref
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
export async function resolveDownloadUrl(ref, filename, expiresIn) {
  if (!ref) return null;
  if (isR2Enabled() && ref.r2_key) {
    return downloadUrl(ref.r2_key, filename, expiresIn);
  }
  return ref.cloudinary_url || null;
}

/**
 * For single-column stores that hold either an absolute URL (legacy
 * Cloudinary, or a bare filename resolved elsewhere) or an R2 object key —
 * notably dbo.JobBookingJobCard.Jobcardproductimg, which has no room for a
 * separate key field.
 *
 * An absolute http(s) value is always passed through untouched, so legacy
 * rows keep working regardless of the flag.
 *
 * @param {string|null|undefined} stored
 * @returns {Promise<string|null>}
 */
export async function resolveStoredRef(stored, expiresIn) {
  const s = typeof stored === 'string' ? stored.trim() : '';
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (isR2Enabled()) return viewUrl(s, expiresIn);
  // Flag off and not a URL: a bare filename handled by the portal's
  // @ImageBaseUrl convention. Return unchanged.
  return s;
}
