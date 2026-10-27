/**
 * Ignoring a blocking check on a GRN: "I know - post it anyway", with the
 * reason, from the person signed in.
 *
 * A warning has always posted with a typed reason. A block could not be got
 * past at all, which left a genuine invoice - a rate the buyer agreed on the
 * phone, a supplier's subtotal that is out by a rupee - stuck until someone
 * edited the numbers to make the check pass. Now a block may be ignored too,
 * but the ignore is stored on the document set (who, when, why), not taken
 * from the client at post time, and the post route works it out again from
 * the stored checks.
 *
 * An ignore belongs to one check: its code and, for a line check, its line.
 * The checks are run again after every edit and every "Match again"; an
 * ignore still applies to the same code and line afterwards, and is dropped
 * as soon as that check passes (or its line is gone) - it was about a problem
 * that no longer exists, and must not silently cover the next one.
 *
 * Pure: the route stores and audits, this decides.
 */

/**
 * Blocks that cannot be ignored, because posting would not do what the
 * person thinks. Each says what to do instead.
 */
export const NOT_IGNORABLE = {
  // Ignored, it would put the same invoice into stock and the books twice.
  INV001: 'This invoice is already posted - posting it again would receive the goods twice. Edit or delete the existing GRN from History instead.',
  // Not CDC's invoice: its goods and its tax credit are someone else's.
  INV013: "The invoice is not billed to CDC. If the buyer GSTIN was misread, correct it in the invoice header.",
  // The writer receives only lines that sit on a PO line: an ignored INV002
  // would post the GRN without this line, silently.
  INV002: 'A line on no open PO line cannot be received - the GRN would be posted without it. Put it on a PO line, or remove it.',
  // The writer refuses freight without a ledger whatever the checks say.
  INV018: 'Choose the freight ledger under Additional charges - the purchase invoice cannot be written without one.',
};

/** A check's line, or null for one about the whole invoice. */
function lineOf(x) {
  const n = x?.lineNo;
  return n === undefined || n === null || n === '' ? null : Number(n);
}

function sameCheck(a, b) {
  return a.code === b.code && lineOf(a) === lineOf(b);
}

/** True for a failing block a person may ignore. */
export function canIgnore(check) {
  return Boolean(check) && !check.passed && check.severity === 'BLOCK' && !NOT_IGNORABLE[check.code];
}

function hasReason(ignore) {
  return String(ignore?.reason ?? '').trim() !== '';
}

/** The ignore that applies to a check, if any. */
function ignoreFor(check, ignored = []) {
  if (!canIgnore(check)) return null;
  return ignored.find((o) => sameCheck(o, check) && hasReason(o)) || null;
}

/**
 * Ignore one failing block. Refused without a reason, for a check that is not
 * failing, and for one in NOT_IGNORABLE. Ignoring it again replaces the reason.
 * @returns {{ignored: Array} | {error: string, status: number}}
 */
export function ignoreCheck(ignored = [], checks = [], { code, lineNo, reason, by, byName, at = new Date() } = {}) {
  const want = { code: String(code ?? ''), lineNo: lineOf({ lineNo }) };
  const why = String(reason ?? '').trim();
  if (!why) return { status: 400, error: 'Give the reason this check can be ignored.' };
  if (NOT_IGNORABLE[want.code]) return { status: 400, error: `${want.code} cannot be ignored. ${NOT_IGNORABLE[want.code]}` };
  const target = checks.find((c) => sameCheck(c, want) && !c.passed && c.severity === 'BLOCK');
  if (!target) {
    return { status: 404, error: `${want.code}${want.lineNo === null ? '' : ` on line ${want.lineNo}`} is not a failing blocking check - run the checks again.` };
  }
  return {
    ignored: [
      ...ignored.filter((o) => !sameCheck(o, want)),
      {
        code: want.code,
        lineNo: want.lineNo,
        reason: why,
        // What the check said when it was ignored, for whoever reads it later.
        message: target.message ?? null,
        by: by ?? null,
        byName: byName ?? by ?? null,
        at,
      },
    ],
  };
}

/** Take an ignore back. `found` is false when there was none. */
export function undoIgnore(ignored = [], { code, lineNo } = {}) {
  const want = { code: String(code ?? ''), lineNo: lineOf({ lineNo }) };
  const kept = ignored.filter((o) => !sameCheck(o, want));
  return { ignored: kept, found: kept.length < ignored.length };
}

/**
 * The ignores that still apply to a fresh run of the checks: each must name a
 * block that is still failing, and carry a reason. The rest are dropped.
 */
export function liveIgnores(ignored = [], checks = []) {
  return ignored.filter((o) => hasReason(o) && checks.some((c) => sameCheck(c, o) && canIgnore(c)));
}

/**
 * The checks with each ignored block stamped - overrideReason, overriddenBy,
 * overriddenByName, overriddenAt - as an accepted warning is at post time, so
 * the reason is stored with the check it excuses. A stale stamp on a block is
 * cleared; warnings are left as they are.
 */
export function withIgnores(checks = [], ignored = []) {
  return checks.map((c) => {
    if (c.severity !== 'BLOCK') return c;
    const {
      overrideReason, overriddenBy, overriddenByName, overriddenAt, ...rest
    } = c;
    const o = ignoreFor(c, ignored);
    if (!o) return rest;
    return {
      ...rest,
      overrideReason: o.reason,
      overriddenBy: o.by ?? null,
      overriddenByName: o.byName ?? o.by ?? null,
      overriddenAt: o.at ?? null,
    };
  });
}

/**
 * The failing blocks nothing excuses. Posting - and its preview - is refused
 * while there is one. Worked out from the stored checks and the stored
 * ignores only; nothing the client sends at post time counts.
 */
export function unresolvedBlocks(checks = [], ignored = []) {
  return checks.filter((c) => !c.passed && c.severity === 'BLOCK' && !ignoreFor(c, ignored));
}
