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

/** One line as the extractor read it, before any normalisation. */
export const ExtractedQuoteLineSchema = z.object({
  lineNo: z.number().int().nonnegative(),
  productName: z.string().nullable(),
  productCode: z.string().nullable(),
  packSize: z.string().nullable(),
  /**
   * The unit as printed ON THIS LINE. Never inferred from a column header —
   * Print Sales' column reads "RATE PER LTR" while its rows say `131.00/UNIT`,
   * `160.00/PC` and `375.00/KG`.
   */
  uom: z.string().nullable(),
  rate: z.string().nullable(),
  gstNote: z.string().nullable(),
  gsmFrom: z.string().nullable(),
  gsmTo: z.string().nullable(),
  productForm: z.string().nullable(),
  width: z.string().nullable(),
  micron: z.string().nullable(),
  notes: z.string().nullable(),
  text: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
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
  name: z.string().nullable(),
  gstin: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  signatory: z.string().nullable(),
  foundIn: z.string().nullable(),
});

/**
 * The CDC entity and address the quote is addressed to.
 *
 * This is what identifies the plant. CDC's Tangra and Panchla addresses both
 * mean Kolkata; Ahmedabad means Ahmedabad. Getting it from the address beats
 * asking a person, who will pick whichever plant they work at.
 */
export const ExtractedAddresseeSchema = z.object({
  company: z.string().nullable(),
  address: z.string().nullable(),
  gstin: z.string().nullable(),
  attention: z.string().nullable(),
});

export const ExtractedQuoteSchema = z.object({
  supplierName: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  supplier: ExtractedSupplierSchema.nullable().optional(),
  addressedTo: ExtractedAddresseeSchema.nullable().optional(),
  subjectLine: z.string().nullable().optional(),
  documentDate: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  /** True when the document says prices may change without notice. */
  isSoftQuote: z.boolean().nullable(),
  /** The sentence that made it soft — a flag without its reason is not trusted. */
  softQuoteEvidence: z.string().nullable().optional(),
  plantMentions: z.array(z.string()).nullable(),
  entityScope: z.string().nullable(),
  commercialTerms: z.object({
    creditDays: z.string().nullable(),
    freightTerms: z.string().nullable(),
    insurance: z.string().nullable(),
    gstNote: z.string().nullable(),
    paymentTerms: z.string().nullable(),
  }).nullable(),
  /**
   * Rules stated in prose rather than priced per line: "sheet price 1.00 extra
   * from reel price", "reel cut ₹1/kg extra", "(470.00/m²)" above a plate
   * table. Captured so the derived rate can be generated and validated instead
   * of invented.
   */
  statedRules: z.array(z.object({
    kind: z.string(),
    text: z.string(),
    value: z.string().nullable(),
  })).nullable(),
  /** Set when the document prices two plants in separate blocks. */
  plantBlocks: z.array(z.object({
    plant: z.string(),
    lineNos: z.array(z.number().int()),
  })).nullable(),
  lines: z.array(ExtractedQuoteLineSchema),
});

export const ExtractedInvoiceLineSchema = z.object({
  lineNo: z.number().int().nonnegative(),
  description: z.string().nullable(),
  hsn: z.string().nullable(),
  gsm: z.string().nullable(),
  size: z.string().nullable(),
  unitWt: z.string().nullable(),
  bundles: z.string().nullable(),
  totalUnits: z.string().nullable(),
  qty: z.string().nullable(),
  uom: z.string().nullable(),
  rate: z.string().nullable(),
  amount: z.string().nullable(),
});

export const ExtractedInvoiceSchema = z.object({
  invoiceNo: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  supplierState: z.string().nullable(),
  buyerGstin: z.string().nullable(),
  shipToGstin: z.string().nullable(),
  shipToAddress: z.string().nullable(),
  eWayBillNo: z.string().nullable(),
  vehicleNo: z.string().nullable(),
  poNumbers: z.array(z.string()).nullable(),
  taxType: z.enum(['CGST_SGST', 'IGST']).nullable(),
  subTotal: z.string().nullable(),
  freight: z.string().nullable(),
  taxable: z.string().nullable(),
  cgst: z.string().nullable(),
  sgst: z.string().nullable(),
  igst: z.string().nullable(),
  roundOff: z.string().nullable(),
  grandTotal: z.string().nullable(),
  lines: z.array(ExtractedInvoiceLineSchema),
});

export const AdjudicationSchema = z.object({
  cdcItemId: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
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
