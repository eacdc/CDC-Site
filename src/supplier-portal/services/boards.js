/**
 * Searching board rates across every quote on file.
 *
 * The item-centric comparison the portal already had — find an ItemID, see who
 * quoted it — works for ink and does not work for board. A board quote does
 * not name an item: it names a grade and a GSM band, and one band covers many
 * ItemIDs. That is why board lines are stored spec-first, and it is why they
 * need a way in of their own.
 *
 * This is that way in: ask for a grade and a GSM, get every live quoted rate
 * that covers it, cheapest first, across suppliers and however differently
 * each of them spelled the grade.
 *
 * "Live" is the same rule the item comparison uses — an expired quote is not a
 * price you can buy at, and a rejected document is not a quote at all.
 */

import { ensureSupplierPortalReady, QuoteDocument, QuoteLine, SupplierGroup } from '../db/mongo.js';
import { searchBoardRates } from '../lib/board-search.js';
import { BOARD_GRADES, gradeLabel } from '../config/board-grades.js';

/** Documents whose rates count. */
const USABLE_STATUSES = ['EXTRACTED', 'NEEDS_REVIEW', 'APPROVED'];

/**
 * Board rates matching a query.
 *
 * @param {Object} query
 * @param {string} [query.grade]      canonical or any known spelling
 * @param {number} [query.gsm]
 * @param {string} [query.form]       REEL | SHEET
 * @param {string} [query.plant]      KOLKATA | AHMEDABAD
 * @param {string} [query.supplyMode] MILL_ORDER | EX_STOCK
 * @param {boolean} [query.includeExpired]
 */
export async function searchBoards(query = {}) {
  await ensureSupplierPortalReady();

  const docFilter = { status: { $in: USABLE_STATUSES } };
  if (query.plant) docFilter.plantScope = query.plant;

  /*
    Expired quotes are excluded by default rather than shown greyed out. A rate
    you cannot buy at, sitting at the top of a list sorted by price, is worse
    than absent — it is the answer to a question nobody asked, in the position
    reserved for the answer to the one they did.
  */
  if (!query.includeExpired) {
    docFilter.$or = [{ effectiveTo: null }, { effectiveTo: { $gte: new Date() } }];
  }

  const docs = await QuoteDocument.find(docFilter)
    .select('_id supplierGroupId plantScope effectiveFrom effectiveTo quoteStrength materialClass originalFilename')
    .lean();

  if (!docs.length) return { rows: [], quotes: 0 };

  const byDoc = new Map(docs.map((d) => [String(d._id), d]));

  const lines = await QuoteLine.find({
    quoteDocumentId: { $in: docs.map((d) => d._id) },
    supersededByLineId: null,
  }).lean();

  const supplierNames = await supplierNameMap(docs);

  // Flatten a stored line into the shape `searchBoardRates` reads: the paper
  // fields live under `raw`, and the rate is wanted as text so the search can
  // show what the document printed rather than a rounded reconstruction.
  const rows = lines.map((line) => {
    const doc = byDoc.get(String(line.quoteDocumentId)) || {};
    return {
      lineId: String(line._id),
      quoteDocumentId: String(line.quoteDocumentId),
      supplier: supplierNames.get(String(doc.supplierGroupId)) || null,
      supplierGroupId: doc.supplierGroupId ? String(doc.supplierGroupId) : null,
      plant: (doc.plantScope || [])[0] || null,
      effectiveFrom: doc.effectiveFrom || null,
      effectiveTo: doc.effectiveTo || null,
      quoteStrength: doc.quoteStrength || null,
      sourceFile: doc.originalFilename || null,

      productName: line.raw?.productName || null,
      mill: line.raw?.mill || null,
      brand: line.raw?.brand || null,
      grade: line.raw?.grade || null,
      shade: line.raw?.shade || null,
      bulk: line.raw?.bulk || null,
      brightness: line.raw?.brightness || null,
      productForm: line.raw?.productForm || null,
      gsmFrom: line.raw?.gsmFrom ?? null,
      gsmTo: line.raw?.gsmTo ?? null,
      supplyMode: line.raw?.supplyMode || null,

      rate: line.raw?.rate || null,
      uom: line.normalised?.uom || line.raw?.uom || null,
      normalisedRate: line.normalised?.ratePerBaseUom ?? line.normalised?.rate ?? null,
    };
  });

  return { rows: searchBoardRates(rows, query), quotes: docs.length };
}

/** Supplier names for the documents in hand, in one query rather than per row. */
async function supplierNameMap(docs) {
  const ids = [...new Set(docs.map((d) => d.supplierGroupId).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const groups = await SupplierGroup.find({ _id: { $in: ids } }).select('_id name').lean();
  return new Map(groups.map((g) => [String(g._id), g.name]));
}

/**
 * The grades worth offering in the search, with how many live rows each has.
 *
 * A grade with nothing behind it is offered too, greyed out by the count. An
 * empty dropdown entry that returns nothing is a better answer than a missing
 * one, which reads as "the portal cannot search for that".
 */
export async function boardGradeOptions(query = {}) {
  const { rows } = await searchBoards({ ...query, grade: null, gsm: null });

  const counts = new Map();
  for (const row of rows) {
    if (!row.grade) continue;
    counts.set(row.grade, (counts.get(row.grade) || 0) + 1);
  }

  return BOARD_GRADES.map((g) => ({
    canonical: g.canonical,
    label: gradeLabel(g.canonical),
    rows: counts.get(g.canonical) || 0,
  }));
}
