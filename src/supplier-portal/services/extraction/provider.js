/**
 * Extraction provider interface.
 *
 * The spec calls for GPT-4o vision or Claude behind a single interface so
 * either can be swapped in. Everything downstream — review screen, matching,
 * rate history — consumes the shape defined here and never the provider's own
 * response.
 *
 * A provider implements:
 *
 *   name: string
 *   extractQuote({ pages, docType, hints }) -> ExtractedQuote
 *   extractInvoice({ pages, hints })        -> ExtractedInvoice
 *   adjudicate({ line, candidates, mapped })-> { cdcItemId|null, confidence, rationale }
 *
 * `pages` is an array of `{ url, pageNo, mimeType }`. Providers receive URLs
 * rather than buffers because both storage backends already issue short-lived
 * signed URLs and the vision APIs fetch them directly.
 */

import { z } from 'zod';

/**
 * A value copied off the document, kept as text.
 *
 * Models return `74342` for a cell printed `74,342` no matter how firmly the
 * prompt asks for a string, so a number here is accepted and stringified —
 * `String(74342)` preserves the digits, and nothing has been rounded or had
 * its separators stripped on the way.
 *
 * This replaces a blanket "stringify every number in the response" pass, which
 * was applied before validation and therefore also stringified `lineNo` and
 * `confidence` — the two fields that genuinely are numbers. A correct
 * extraction of 47 lines was rejected 47 times over, by our own safety net.
 * Coercion has to know which field it is looking at.
 */
const printed = () => z.preprocess(
  (v) => {
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string' && v.trim() === '') return null;
    return v;
  },
  z.string().nullable(),
);

/**
 * A genuine number — a line index, a confidence.
 *
 * Lenient in the other direction for the same reason: a model that returns
 * `"1"` for line one is not wrong about anything that matters, and failing the
 * document over it would be the same mistake in reverse. Only a string that
 * is actually numeric converts; `"one"` still fails, loudly.
 */
const counted = () => z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '') return null;
      if (Number.isFinite(Number(t))) return Number(t);
    }
    return v;
  },
  z.number(),
);

/** One line as the extractor read it, before any normalisation. */
export const ExtractedQuoteLineSchema = z.object({
  lineNo: counted().pipe(z.number().int().nonnegative()),
  productName: printed(),
  productCode: printed(),
  packSize: printed(),
  /**
   * The unit as printed ON THIS LINE. Never inferred from a column header —
   * Print Sales' column reads "RATE PER LTR" while its rows say `131.00/UNIT`,
   * `160.00/PC` and `375.00/KG`.
   */
  uom: printed(),
  rate: printed(),
  gstNote: printed(),
  gsmFrom: printed(),
  gsmTo: printed(),
  productForm: printed(),
  width: printed(),
  micron: printed(),
  notes: printed(),
  text: printed(),
  confidence: counted().nullable().pipe(z.number().min(0).max(1).nullable()),
});

/**
 * Who wrote the quote, read off the letterhead, footer or signature block.
 *
 * Kept separate from `addressedTo` because the two are the easiest pair on the
 * page to confuse, and confusing them files a supplier's rates against CDC
 * itself. `foundIn` records where the name was seen so a reviewer can check the
 * identification without opening the source document.
 */
export const ExtractedSupplierSchema = z.object({
  name: printed(),
  gstin: printed(),
  phone: printed(),
  email: printed(),
  address: printed(),
  signatory: printed(),
  foundIn: printed(),
});

/**
 * The CDC entity and address the quote is addressed to.
 *
 * This is what identifies the plant. CDC's Tangra and Panchla addresses both
 * mean Kolkata; Ahmedabad means Ahmedabad. Getting it from the address beats
 * asking a person, who will pick whichever plant they work at.
 */
export const ExtractedAddresseeSchema = z.object({
  company: printed(),
  address: printed(),
  gstin: printed(),
  attention: printed(),
});

export const ExtractedQuoteSchema = z.object({
  supplierName: printed(),
  supplierGstin: printed(),
  supplier: ExtractedSupplierSchema.nullable().optional(),
  addressedTo: ExtractedAddresseeSchema.nullable().optional(),
  subjectLine: printed().optional(),
  documentDate: printed(),
  effectiveFrom: printed(),
  effectiveTo: printed(),
  /** True when the document says prices may change without notice. */
  isSoftQuote: z.boolean().nullable(),
  /** The sentence that made it soft — a flag without its reason is not trusted. */
  softQuoteEvidence: printed().optional(),
  plantMentions: z.array(printed()).nullable(),
  entityScope: printed(),
  commercialTerms: z.object({
    creditDays: printed(),
    freightTerms: printed(),
    insurance: printed(),
    gstNote: printed(),
    paymentTerms: printed(),
  }).nullable(),
  /**
   * Rules stated in prose rather than priced per line: "sheet price 1.00 extra
   * from reel price", "reel cut ₹1/kg extra", "(470.00/m²)" above a plate
   * table. Captured so the derived rate can be generated and validated instead
   * of invented.
   */
  statedRules: z.array(z.object({
    kind: printed(),
    text: printed(),
    value: printed(),
  })).nullable(),
  /** Set when the document prices two plants in separate blocks. */
  plantBlocks: z.array(z.object({
    plant: printed(),
    lineNos: z.array(counted().pipe(z.number().int())),
  })).nullable(),
  lines: z.array(ExtractedQuoteLineSchema),
});

export const ExtractedInvoiceLineSchema = z.object({
  lineNo: counted().pipe(z.number().int().nonnegative()),
  description: printed(),
  hsn: printed(),
  gsm: printed(),
  size: printed(),
  unitWt: printed(),
  bundles: printed(),
  totalUnits: printed(),
  qty: printed(),
  uom: printed(),
  rate: printed(),
  amount: printed(),
});

export const ExtractedInvoiceSchema = z.object({
  invoiceNo: printed(),
  invoiceDate: printed(),
  supplierName: printed(),
  supplierGstin: printed(),
  supplierState: printed(),
  buyerGstin: printed(),
  shipToGstin: printed(),
  shipToAddress: printed(),
  eWayBillNo: printed(),
  vehicleNo: printed(),
  poNumbers: z.array(printed()).nullable(),
  taxType: z.enum(['CGST_SGST', 'IGST']).nullable(),
  subTotal: printed(),
  freight: printed(),
  taxable: printed(),
  cgst: printed(),
  sgst: printed(),
  igst: printed(),
  roundOff: printed(),
  grandTotal: printed(),
  lines: z.array(ExtractedInvoiceLineSchema),
});

export const AdjudicationSchema = z.object({
  cdcItemId: counted().nullable().pipe(z.number().int().nullable()),
  confidence: counted().pipe(z.number().min(0).max(1)),
  rationale: z.string(),
});

/**
 * Every numeric field above is a string on purpose.
 *
 * The extractor's job is to report what the document says; converting
 * `74,342` or `131.00/UNIT` to a number is a decision with rules attached, and
 * those rules live in `lib/uom.js` where they are tested. A model that returns
 * a float has already silently made that decision, and the raw text needed to
 * check it is gone.
 */

const providers = new Map();

export function registerProvider(provider) {
  if (!provider?.name) throw new Error('An extraction provider needs a name.');
  providers.set(provider.name, provider);
  return provider;
}

/**
 * Load the built-in providers.
 *
 * Registration is a side effect of importing a provider module, and for a
 * while nothing imported them — so the registry was empty in every deployment
 * and the first real extraction failed with "Available: none". A registry that
 * depends on somebody remembering an import somewhere else is a registry that
 * is empty exactly when it is first needed, and the symptom points at
 * configuration rather than at the missing line.
 *
 * So the registry loads its own. The import is dynamic and cached because
 * `openai-provider.js` imports this module back; a static import here would be
 * a cycle whose behaviour depends on evaluation order.
 */
let builtInsPromise = null;

export function ensureBuiltInProviders() {
  if (!builtInsPromise) {
    builtInsPromise = (async () => {
      await import('./openai-provider.js');
      // Anthropic registers only when a key is configured — a
      // registered-but-keyless provider fails once per request instead of
      // being absent, which is harder to diagnose, not easier.
      if (process.env.ANTHROPIC_API_KEY) {
        const { registerAnthropicProvider } = await import('./anthropic-provider.js');
        registerAnthropicProvider();
      }
    })();
    builtInsPromise.catch(() => { builtInsPromise = null; });
  }
  return builtInsPromise;
}

/**
 * The configured provider. `EXTRACTION_PROVIDER` selects it; OpenAI is the
 * default because CDC already holds programmatic keys for it.
 */
export async function getProvider(name = process.env.EXTRACTION_PROVIDER || 'openai') {
  await ensureBuiltInProviders();

  const provider = providers.get(name);
  if (!provider) {
    const available = [...providers.keys()];
    throw new Error(
      `Extraction provider "${name}" is not registered. Available: ${available.join(', ') || 'none'}.`
      + (name === 'anthropic' && !process.env.ANTHROPIC_API_KEY
        ? ' ANTHROPIC_API_KEY is not set on the server.'
        : ''),
    );
  }
  return provider;
}

/** Registered provider names. Async because the built-ins load on demand. */
export async function listProviders() {
  await ensureBuiltInProviders();
  return [...providers.keys()];
}
