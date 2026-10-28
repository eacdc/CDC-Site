/**
 * Red flags on fields of an extracted invoice: where a person must look before
 * the GRN posts.
 *
 * Two sources:
 *  - MODEL: fields the model itself reported it could not read with certainty
 *    (its "uncertain" list) - smudged stamps, handwriting, small print.
 *  - CHECK: fields the answer proves wrong on its own face, after the one
 *    retry (invoice-review.js) - a line that does not multiply out, a
 *    subtotal that does not add up, a GSTIN failing its check character, an
 *    e-way bill that is not twelve digits.
 *
 * A flag clears when the value is changed, or when a person marks it checked.
 * Posting is refused while any flag is open.
 *
 * Paths: a header field by name ("gateEntryNo"), a line field as
 * "lines.<lineNo>.<field>" ("lines.3.qty"), a whole line as "lines.<lineNo>"
 * (its quantity, rate and amount do not agree - one of the three is wrong).
 */

/**
 * Only fields the page shows can carry a flag: a flag nobody can see would
 * block posting with no way to clear it. Header fields of steps 2 and 4, and
 * the line fields of step 2.
 *
 * Not the e-way bill, the vehicle number or a line's HSN: CDC does not hold a
 * GRN for any of them (28 Oct 2026), so they are never flagged.
 */
export const HEADER_FLAG_FIELDS = [
  'invoiceNo', 'invoiceDate', 'supplierGstin', 'buyerGstin', 'shipToGstin',
  'gateEntryNo', 'gateEntryDate', 'poNumbers', 'taxType',
  'subTotal', 'discount', 'discountPct', 'taxable', 'cgst', 'sgst', 'igst', 'grandTotal',
];
const LINE_FLAG_FIELDS = [
  'description', 'qty', 'uom', 'rate', 'amount', 'discountPct', 'discountAmount', 'taxableValue', 'poRef',
];
/** Editing any of these on a line clears a whole-line flag on it. */
const LINE_MONEY = ['qty', 'stockQty', 'rate', 'amount', 'discountPct', 'discountAmount', 'taxableValue'];

/**
 * A path as the model might write it - "lines[2].qty", "line 2 qty",
 * "Lines.2.Qty" - in the one form used here, or null if it names no field.
 */
export function normaliseFlagPath(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const line = t.match(/^lines?\s*[[.\s#]*\s*(\d+)\s*\]?\s*[.\s]*([a-z]+)?$/i);
  if (line) {
    if (!line[2]) return `lines.${Number(line[1])}`;
    const field = LINE_FLAG_FIELDS.find((f) => f.toLowerCase() === line[2].toLowerCase());
    return field ? `lines.${Number(line[1])}.${field}` : null;
  }
  const header = HEADER_FLAG_FIELDS.find((f) => f.toLowerCase() === t.replace(/[^a-z]/gi, '').toLowerCase());
  return header || null;
}

const CHECK_FIELD = {
  SUBTOTAL: 'subTotal', TAXABLE: 'taxable', GRAND_TOTAL: 'grandTotal',
};

/**
 * The flags for a freshly read invoice.
 * @param {Object} input
 * @param {Array}  input.uncertain       the model's list of paths
 * @param {Array}  input.problems        invoiceProblems() of the kept answer
 * @param {Object} [input.identification] supplier identification result
 * @param {Object} [input.read]          the answer as read (for the GSTIN read)
 */
export function buildFieldFlags({ uncertain = [], problems = [], identification = null, read = {}, disagreements = [] } = {}) {
  const flags = new Map();
  const add = (field, source, reason) => {
    if (!field) return;
    const was = flags.get(field);
    // A proof beats a doubt: keep the CHECK reason when both apply.
    if (!was || (source === 'CHECK' && was.source === 'MODEL')) flags.set(field, { field, source, reason, resolved: false });
  };

  for (const raw of uncertain || []) {
    add(normaliseFlagPath(raw), 'MODEL', 'The reader could not make this out with certainty. Check it against the invoice.');
  }
  // Read twice, two answers: the model was not sure, whatever it said.
  for (const d of disagreements || []) {
    add(normaliseFlagPath(d.field), 'MODEL', `Read twice, with two different answers: "${d.first ?? 'blank'}" and "${d.second ?? 'blank'}". `
      + 'Check it against the invoice.');
  }

  for (const p of problems || []) {
    if (p.kind === 'LINE_ARITHMETIC' || p.kind === 'LINE_WITHOUT_QTY' || p.kind === 'LINE_DISCOUNT') add(`lines.${p.lineNo}`, 'CHECK', p.message.split('. ')[0] + '.');
    else if (p.kind === 'GSTIN') {
      if (p.field === 'supplierGstin' && identification?.matchedBy === 'GSTIN_NEAR') {
        add('supplierGstin', 'CHECK', `Read as ${read.supplierGstin ?? '?'}, which fails the GSTIN check character; `
          + `${identification.correctedGstin} from the supplier's ledger is used instead. Check it is the right one.`);
      } else {
        add(p.field, 'CHECK', `This GSTIN fails its check character, so at least one character was misread.`);
      }
    } else if (CHECK_FIELD[p.kind]) add(CHECK_FIELD[p.kind], 'CHECK', p.message.split('. ')[0] + '.');
  }
  return [...flags.values()];
}

function valueAt(header, lines, path) {
  const m = path.match(/^lines\.(\d+)(?:\.(\w+))?$/);
  if (!m) return header?.[path];
  const line = (lines || []).find((l) => Number(l.lineNo) === Number(m[1]));
  if (!line) return undefined;
  return m[2] ? line[m[2]] : LINE_MONEY.map((k) => line[k]);
}

/**
 * One value as compared: a stored Date and the same day sent back as text
 * are equal, as are 100 and "100.00". Only a real change clears a flag.
 */
function comparable(value, path) {
  if (Array.isArray(value)) return value.map((v) => comparable(v, path)).join('|');
  if (value === null || value === undefined || value === '') return '';
  if (/date$/i.test(path)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value).trim() : d.toISOString().slice(0, 10);
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (Number.isFinite(n) && String(value).trim() !== '') return `#${Math.round(n * 1000) / 1000}`;
  return String(value).trim();
}

const same = (a, b, path) => comparable(a, path) === comparable(b, path);

/**
 * Clear every open flag whose value changed between `before` and `after`;
 * drop flags on lines that no longer exist.
 */
export function resolveEditedFlags(flags = [], before = {}, after = {}, who = null) {
  const now = new Date();
  return (flags || []).flatMap((f) => {
    const flag = { ...f };
    const line = flag.field.match(/^lines\.(\d+)/);
    if (line && !(after.lines || []).some((l) => Number(l.lineNo) === Number(line[1]))) return [];
    if (!flag.resolved && !same(valueAt(before.header, before.lines, flag.field), valueAt(after.header, after.lines, flag.field), flag.field)) {
      Object.assign(flag, { resolved: true, how: 'EDITED', by: who, at: now });
    }
    return [flag];
  });
}

/** Mark one flag checked. Returns the new list, and whether it was found. */
export function confirmFlag(flags = [], field, who = null) {
  let found = false;
  const out = (flags || []).map((f) => {
    if (f.field !== field) return f;
    found = true;
    return f.resolved ? f : { ...f, resolved: true, how: 'CONFIRMED', by: who, at: new Date() };
  });
  return { flags: out, found };
}

/** Can this field carry a flag? An invoice read before 28 Oct 2026 may hold one that no longer can. */
export const isFlaggable = (field) => normaliseFlagPath(field) === field || /^lines\.\d+$/.test(String(field));

export const openFlags = (flags = []) => (flags || []).filter((f) => !f.resolved && isFlaggable(f.field));
