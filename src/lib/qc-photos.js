/**
 * In-process QC photos.
 *
 * The QC Tool lets the inspector attach up to three photos to any checklist
 * parameter. The phone shrinks each one to a JPEG and the backend puts it in
 * the private R2 bucket; ProductionEntryProcessInspectionDetail.ImageKeys
 * keeps the object keys as a JSON array (sql/qc/004_inspection_photos.sql).
 * Viewing goes through short-lived signed URLs, never stored.
 */

import { uploadBuffer, viewUrl } from './r2-storage.js';

export const QC_PHOTOS_MAX = 3;
export const QC_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const QC_PHOTO_FOLDER = 'qc-inspection-images';

/** The phone always sends a JPEG; check the bytes, not the declared type. */
function isJpeg(buffer) {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** Stores one photo for a plant ('KOL' | 'AHM'); returns its R2 key. */
export async function uploadQcPhoto(buffer, database) {
  if (!isJpeg(buffer)) throw new Error('Photo must be a JPEG image.');
  if (buffer.length > QC_PHOTO_MAX_BYTES) throw new Error('Photo is too large (max 5 MB).');
  const { key } = await uploadBuffer({
    folder: `${QC_PHOTO_FOLDER}/${database}`,
    buffer,
    contentType: 'image/jpeg',
  });
  return key;
}

/** True only for keys uploadQcPhoto made for this plant, so a save cannot point at other objects. */
export function isQcPhotoKey(key, database) {
  const pattern = new RegExp(`^${QC_PHOTO_FOLDER}/${database}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.jpg$`);
  return typeof key === 'string' && pattern.test(key);
}

/** ImageKeys column (JSON array text) → signed view URLs, in order. */
export async function qcPhotoUrls(imageKeys) {
  let keys = [];
  try {
    keys = JSON.parse(imageKeys || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(keys)) return [];
  return Promise.all(keys.filter((k) => typeof k === 'string').map((k) => viewUrl(k)));
}
