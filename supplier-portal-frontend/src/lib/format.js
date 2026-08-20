/**
 * Formatting.
 *
 * Currency is always Indian grouping (₹1,23,456.78) and dates are always
 * DD-MMM-YYYY. Both are fixed rather than locale-driven: this is one office
 * reading one set of numbers, and a figure that renders differently on two
 * machines is a figure two people will disagree about.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const NUMBER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

/** ₹1,23,456.78 — an em dash for a genuinely absent value. */
export function money(value, { whole = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return (whole ? INR_WHOLE : INR).format(Number(value));
}

/**
 * Large figures in lakh and crore.
 *
 * ₹4.2 Cr is read at a glance; ₹4,20,00,000 has to be counted. Used only on
 * summary tiles — tables keep the full number so it can be checked.
 */
export function moneyShort(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return INR_WHOLE.format(n);
}

export function number(value, dp) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  if (dp === undefined) return NUMBER.format(Number(value));
  return Number(value).toFixed(dp);
}

/** A signed percentage, so the direction reads without decoding the sign. */
export function percent(value, { dp = 1, signed = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(dp)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 20-Aug-2026. */
export function date(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date(d)} ${hh}:${mm}`;
}

/**
 * "in 12 days" / "8 days ago" — for quote expiry, where the count matters more
 * than the date.
 */
export function relativeDays(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return '—';
  const n = Number(days);
  if (n === 0) return 'today';
  if (n > 0) return `in ${n} day${n === 1 ? '' : 's'}`;
  return `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ago`;
}

/** Kolkata, not KOLKATA — shouting a plant name in a table is noise. */
export function plantLabel(plant) {
  if (!plant) return '—';
  const t = String(plant).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function siteLabel(site) {
  return site === 'AHM' ? 'Ahmedabad' : 'Kolkata';
}

/** Truncate for a fixed-width cell, with the full text kept for the title. */
export function truncate(text, length = 60) {
  const t = String(text ?? '');
  return t.length > length ? `${t.slice(0, length - 1)}…` : t;
}
