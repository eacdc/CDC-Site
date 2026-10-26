/**
 * GSTINs: the check character, and how far apart two of them are.
 *
 * A GSTIN is 15 characters: state code (2), PAN (10), entity number (1), "Z",
 * and a check character computed from the first 14. A misread digit almost
 * always breaks the check, so a GSTIN that fails it was not read correctly -
 * and the supplier's real GSTIN is usually one or two characters away, on one
 * of the ERP's supplier ledgers.
 *
 * Seen in October 2026 on real invoices read by the extractor: 19AADFR0768H1Z1
 * for 19AADFR9768H1ZI, 19AAICG2283B1ZZ for 19AAICG2285N1ZZ, and on one invoice
 * a GSTIN that was simply invented.
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Upper case, letters and digits only. */
export function cleanGstin(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The check character for the first 14 characters, or null if they cannot have one. */
export function gstinCheckChar(first14) {
  const s = cleanGstin(first14);
  if (s.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = CHARS.indexOf(s[i]);
    if (v < 0) return null;
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/** Shape and check character both right. */
export function isValidGstin(value) {
  const s = cleanGstin(value);
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(s)) return false;
  return gstinCheckChar(s.slice(0, 14)) === s[14];
}

/**
 * Edit distance with swaps of neighbours counting as one (optimal string
 * alignment): "2946" read as "2964" is one mistake, not two.
 */
export function gstinDistance(a, b) {
  const x = cleanGstin(a);
  const y = cleanGstin(b);
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length];
}

/**
 * The known GSTINs nearest to one that was read, within `max` mistakes.
 * Returns every GSTIN at the smallest distance found, so a caller can refuse
 * a tie rather than pick one.
 */
export function nearestGstins(read, known = [], max = 2) {
  const r = cleanGstin(read);
  if (!r) return { distance: null, gstins: [] };
  let best = Infinity;
  let found = [];
  for (const g of new Set(known.map(cleanGstin).filter(Boolean))) {
    // Same state code: a misread rarely changes it, and two suppliers in
    // different states one character apart are not a misreading.
    if (g.slice(0, 2) !== r.slice(0, 2)) continue;
    const dist = gstinDistance(r, g);
    if (dist > max) continue;
    if (dist < best) { best = dist; found = [g]; } else if (dist === best) found.push(g);
  }
  return { distance: found.length ? best : null, gstins: found };
}
