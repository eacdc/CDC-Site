/**
 * Reports.
 *
 * Every report takes a plant and echoes it back. None of them compares a rate
 * at one plant against a rate at the other.
 *
 * All of them support `?format=csv`, because the purchase team lives in Excel
 * and a report they cannot export is a report they will not use.
 */

import { Router } from 'express';
import { requireAuth, requireSite } from '../middleware/auth.js';
import {
  quotesNeedingRefresh, plantCoverageGaps, leakage, crossSupplierSpread,
  singleSourceRisk, dataQuality, masterDuplicates,
} from '../services/reports.js';
import { PLANTS, SITE_BY_PLANT } from '../config/constants.js';

const router = Router();
router.use(requireAuth, requireSite);

function plantFor(req) {
  const requested = req.query.plant;
  if (requested) {
    const upper = String(requested).toUpperCase();
    if (!SITE_BY_PLANT[upper]) {
      const err = new Error(`Unknown plant "${requested}".`);
      err.status = 400;
      throw err;
    }
    return upper;
  }
  return req.sp.site === 'AHM' ? PLANTS.AHM : PLANTS.KOL;
}

/** Send as JSON or CSV depending on `?format`. */
function send(res, req, rows, filename) {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(Array.isArray(rows) ? rows : rows.lines || []));
  }
  return res.json(rows);
}

router.get('/refresh-needed', async (req, res, next) => {
  try {
    const rows = await quotesNeedingRefresh(req.sp.site, {
      plant: plantFor(req),
      withinDays: req.query.withinDays ? Number(req.query.withinDays) : undefined,
    });
    send(res, req, rows, 'quotes-needing-refresh');
  } catch (err) { next(err); }
});

router.get('/plant-gaps', async (req, res, next) => {
  try {
    send(res, req, await plantCoverageGaps(req.sp.site, { plant: plantFor(req) }), 'plant-coverage-gaps');
  } catch (err) { next(err); }
});

/** The report that justifies the project. */
router.get('/leakage', async (req, res, next) => {
  try {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getFullYear(), to.getMonth() - 3, to.getDate());

    const result = await leakage(req.sp.site, { plant: plantFor(req), from, to });
    send(res, req, result, 'leakage');
  } catch (err) { next(err); }
});

router.get('/spread', async (req, res, next) => {
  try {
    const rows = await crossSupplierSpread(req.sp.site, {
      minSpreadPct: req.query.minSpreadPct ? Number(req.query.minSpreadPct) : undefined,
      months: req.query.months ? Number(req.query.months) : undefined,
    });
    send(res, req, rows, 'cross-supplier-spread');
  } catch (err) { next(err); }
});

router.get('/single-source', async (req, res, next) => {
  try {
    send(res, req, await singleSourceRisk(req.sp.site, { plant: plantFor(req) }), 'single-source-risk');
  } catch (err) { next(err); }
});

router.get('/data-quality', async (req, res, next) => {
  try {
    const rows = await dataQuality(req.sp.site, {
      spreadFactor: req.query.spreadFactor ? Number(req.query.spreadFactor) : undefined,
    });
    send(res, req, rows, 'data-quality');
  } catch (err) { next(err); }
});

router.get('/master-duplicates', async (req, res, next) => {
  try {
    send(res, req, await masterDuplicates(req.sp.site), 'master-duplicates');
  } catch (err) { next(err); }
});

/**
 * CSV from an array of flat-ish objects.
 *
 * Nested values are JSON-encoded rather than dropped: a column reading
 * `["Bagla","Unik"]` is still useful in a spreadsheet, and a silently missing
 * column is not.
 */
function toCsv(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(',')),
  ].join('\n');
}

export default router;
