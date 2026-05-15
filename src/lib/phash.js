/**
 * Perceptual hash for duplicate-image detection (check #48).
 *
 * Uses `jimp` (already installed in this backend) to compute a perceptual
 * hash. Jimp's `pHash()` returns a 64-character binary string ("01...");
 * we convert that to 16 hex chars for compact storage.
 *
 * NOTE: We only hash supplier invoice page 1 — Tally vouchers and GRN
 * sheets are CDC-generated and visually similar across bills, which would
 * cause false-positive duplicates if hashed.
 */
import * as jimp from 'jimp';

const { Jimp } = jimp;

/**
 * Compute a 16-char hex perceptual hash of the image at the given URL.
 * Returns null on failure (we never want phash issues to block a bill
 * upload).
 */
export async function generatePhash(imageUrl) {
  try {
    const img = await Jimp.read(imageUrl);
    if (typeof img.pHash !== 'function') {
      // Some Jimp versions expose hash() returning a base-2 string
      const h = img.hash(2);
      return binToHex(h);
    }
    const binary = img.pHash();
    return binToHex(binary);
  } catch (err) {
    console.warn('[phash] failed to hash image:', err?.message || err);
    return null;
  }
}

function binToHex(s) {
  if (!s) return null;
  // Pad to a multiple of 4
  const padded = s.length % 4 ? s.padEnd(s.length + (4 - (s.length % 4)), '0') : s;
  let hex = '';
  for (let i = 0; i < padded.length; i += 4) {
    hex += parseInt(padded.substring(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two equal-length hex strings interpreted as
 * binary. Returns Infinity if either is missing or lengths differ.
 */
export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) return Infinity;
  if (hexA.length !== hexB.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const a = parseInt(hexA[i], 16);
    const b = parseInt(hexB[i], 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
    let xor = a ^ b;
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}
