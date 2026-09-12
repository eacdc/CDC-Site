export class MalformedSummary extends Error {}

const BUCKETS = ['decisions', 'openIssues', 'blocked', 'notable'];

function stripFence(raw) {
  const t = String(raw ?? '').trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * Parses and validates the summariser's output into exactly four string arrays.
 *
 * A missing bucket becomes an empty array rather than an error — "nothing was
 * decided" is a legitimate outcome and the model expressing it by omission is
 * not worth a retry. Structurally broken output (not JSON, not an object) does
 * throw, so the caller can fall back to the strong model.
 */
export function parseSummary(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw new MalformedSummary(`not JSON: ${String(raw).slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedSummary(`not an object: ${String(raw).slice(0, 200)}`);
  }

  const out = {};
  for (const bucket of BUCKETS) {
    const value = parsed[bucket];
    out[bucket] = Array.isArray(value)
      ? value
          .filter((b) => typeof b === 'string')
          .map((b) => b.trim())
          .filter(Boolean)
      : [];
  }
  return out;
}

/** True when a summary carries nothing at all — not worth storing. */
export function isEmptySummary(bullets) {
  return BUCKETS.every((b) => (bullets[b] ?? []).length === 0);
}
