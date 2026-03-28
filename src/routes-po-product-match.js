/**
 * PO → ProductMaster match (read-only SELECT only; validated by sql-guard).
 * For least privilege in production, use a dedicated MSSQL login with db_datareader (or equivalent)
 * and point DB_* env vars used by getPool to that user for this service only.
 */
import { Router } from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { PDFParse } from 'pdf-parse';
import { getPool, sql } from './db.js';
import { assertReadOnlySelect } from './sql-guard.js';

const router = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').toLowerCase();
    const isImage = type.startsWith('image/');
    const isPdf = type === 'application/pdf';
    const isText = type === 'text/plain';
    if (isImage || isPdf || isText) return cb(null, true);
    return cb(new Error('Only image, PDF, or text files are allowed'), false);
  }
});

const HINTS_MODEL = process.env.PO_MATCH_HINTS_MODEL || 'gpt-4o-mini';
const OCR_MODEL = process.env.PO_MATCH_OCR_MODEL || 'gpt-4o-mini';
const SCORE_MODEL = process.env.PO_MATCH_SCORE_MODEL || 'gpt-4o';
const DEFAULT_TOP_N = 80;
const MAX_TOP_N = 150;
const MAX_KEYWORDS = 10;
const MAX_SUBSET_ATTEMPTS = 120;
const SCORE_BATCH_SIZE = 12;

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isLikelyImage(file) {
  const type = (file?.mimetype || '').toLowerCase();
  return type.startsWith('image/');
}

function isLikelyPdf(file) {
  const type = (file?.mimetype || '').toLowerCase();
  return type === 'application/pdf' || (file?.originalname || '').toLowerCase().endsWith('.pdf');
}

function bufferToDataUrl(file) {
  const mime = (file?.mimetype || 'image/png').toLowerCase();
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

function dedupeStrings(values, max = MAX_KEYWORDS) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const v = String(value || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function fallbackKeywordExtract(text) {
  const rawTokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    'purchase', 'order', 'po', 'no', 'date', 'client', 'invoice', 'qty', 'quantity',
    'total', 'rate', 'description', 'item', 'items', 'for', 'and', 'the', 'with'
  ]);

  const filtered = rawTokens.filter((token) => token.length >= 3 && !stop.has(token));
  return dedupeStrings(filtered, 8);
}

function combinations(values, size) {
  const result = [];
  const cur = [];

  function walk(start) {
    if (cur.length === size) {
      result.push([...cur]);
      return;
    }
    for (let i = start; i < values.length; i += 1) {
      cur.push(values[i]);
      walk(i + 1);
      cur.pop();
    }
  }

  walk(0);
  return result;
}

function escapeLikeParam(value) {
  return String(value || '').replace(/[%_]/g, '');
}

function buildJobNameAttempts(jobNameKeywords) {
  const attempts = [];
  let used = 0;

  // Pass A: strongest subsets first, stop-at-first-hit in caller.
  for (let size = jobNameKeywords.length; size >= 1; size -= 1) {
    const combos = combinations(jobNameKeywords, size);
    for (const combo of combos) {
      attempts.push({ mode: 'and-subset', keywords: combo });
      used += 1;
      if (used >= MAX_SUBSET_ATTEMPTS) return attempts;
    }
  }

  // Pass B (widen): OR chains.
  if (jobNameKeywords.length >= 1) {
    attempts.push({ mode: 'or-single-chain', keywords: [...jobNameKeywords] });
  }
  if (jobNameKeywords.length >= 2) {
    const pairCombos = combinations(jobNameKeywords, 2);
    for (const combo of pairCombos) {
      attempts.push({ mode: 'or-pair', keywords: combo });
      used += 1;
      if (used >= MAX_SUBSET_ATTEMPTS) break;
    }
  }

  return attempts;
}

function hasSearchableCriteria(hints) {
  if (!hints) return false;
  if (hints.jobNameKeywords?.length) return true;
  if (hints.codeCandidates?.length) return true;
  if (hints.clientNameTokens?.length) return true;
  if (normalizeText(hints.salespersonName)) return true;
  return false;
}

function willApplySearchPredicate(hints, dynamic) {
  const clause = dynamic?.baseOrClause ?? buildDynamicConditions(hints).baseOrClause;
  if (normalizeText(clause)) return true;
  return Boolean(hints.jobNameKeywords?.length);
}

function buildDynamicConditions(hints) {
  const params = [];
  const codeParts = [];
  const clientParts = [];
  const salesParts = [];

  for (let i = 0; i < hints.codeCandidates.length; i += 1) {
    const code = hints.codeCandidates[i];
    const name = `code_${i}`;
    params.push({ name, type: sql.NVarChar(100), value: code });
    codeParts.push(`pm.ProductMasterCode = @${name}`);
    codeParts.push(`pm.ProductCode = @${name}`);
    codeParts.push(`pm.RefProductMasterCode = @${name}`);
  }

  for (let i = 0; i < hints.clientNameTokens.length; i += 1) {
    const token = `%${escapeLikeParam(hints.clientNameTokens[i])}%`;
    const name = `client_${i}`;
    params.push({ name, type: sql.NVarChar(120), value: token });
    clientParts.push(`client.LedgerName LIKE @${name}`);
    clientParts.push(`client.TradeName LIKE @${name}`);
    clientParts.push(`client.LegalName LIKE @${name}`);
    clientParts.push(`client.ExLedgerName LIKE @${name}`);
  }

  if (hints.salespersonName) {
    const name = 'sales_name';
    params.push({ name, type: sql.NVarChar(120), value: `%${escapeLikeParam(hints.salespersonName)}%` });
    salesParts.push(`sales.LedgerName LIKE @${name}`);
    salesParts.push(`sales.TradeName LIKE @${name}`);
  }

  const dynamicOrBlocks = [];
  if (codeParts.length) dynamicOrBlocks.push(`(${codeParts.join(' OR ')})`);
  if (clientParts.length) dynamicOrBlocks.push(`(${clientParts.join(' OR ')})`);
  if (salesParts.length) dynamicOrBlocks.push(`(${salesParts.join(' OR ')})`);

  return {
    baseOrClause: dynamicOrBlocks.join(' OR '),
    params
  };
}

function buildQuery({ attempt, baseOrClause, topN }) {
  const params = [{ name: 'TopN', type: sql.Int, value: topN }];
  let jobClause = '';

  if (attempt && attempt.keywords.length) {
    const clauses = [];
    for (let i = 0; i < attempt.keywords.length; i += 1) {
      const p = `job_kw_${i}`;
      const keyword = `%${escapeLikeParam(attempt.keywords[i])}%`;
      params.push({ name: p, type: sql.NVarChar(120), value: keyword });
      clauses.push(`pm.JobName LIKE @${p}`);
    }

    if (attempt.mode === 'and-subset') {
      jobClause = `(${clauses.join(' AND ')})`;
    } else {
      jobClause = `(${clauses.join(' OR ')})`;
    }
  }

  const arms = [];
  if (jobClause) arms.push(jobClause);
  if (baseOrClause) arms.push(`(${baseOrClause})`);

  const whereArms = arms.length ? `AND (${arms.join(' OR ')})` : '';

  const query = `
SELECT TOP (@TopN)
  pm.ProductMasterID,
  pm.ProductMasterCode,
  pm.RefProductMasterCode,
  pm.ProductCode,
  pm.JobName,
  pm.BookingNo,
  pm.OrderQuantity,
  pm.CriticalInstructions,
  pm.Remark,
  pm.ClosedJobSize,
  pm.JobType,
  pm.JobReference,
  pm.DeliveryDate,
  pm.QuoteDate,
  pm.LedgerID,
  pm.SalesEmployeeID,
  client.LedgerName AS ClientLedgerName,
  client.TradeName AS ClientTradeName,
  client.LegalName AS ClientLegalName,
  client.GSTNo AS ClientGSTNo,
  sales.LedgerName AS SalesLedgerName,
  sales.TradeName AS SalesTradeName
FROM ProductMaster pm
LEFT JOIN LedgerMaster client ON pm.LedgerID = client.LedgerID
LEFT JOIN LedgerMaster sales ON pm.SalesEmployeeID = sales.LedgerID
WHERE ISNULL(pm.IsDeletedTransaction, 0) = 0
${whereArms}
ORDER BY pm.ModifiedDate DESC, pm.CreatedDate DESC;`.trim();

  return { query, params };
}

async function extractImageTextWithVision(file) {
  const imageDataUrl = bufferToDataUrl(file);
  const completion = await openai.chat.completions.create({
    model: OCR_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You extract text from client purchase orders. Return plain text only and preserve line structure.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract all visible PO text with key labels and values. Return plain text only.' },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
        ]
      }
    ],
    temperature: 0
  });

  return normalizeText(completion?.choices?.[0]?.message?.content);
}

async function extractHints(poText) {
  try {
    const completion = await openai.chat.completions.create({
      model: HINTS_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'Extract concise search hints from a client PO.',
            'Return strict JSON only.',
            'jobNameKeywords: important words/phrases that can appear in ProductMaster.JobName.',
            'codeCandidates: values likely to be ProductMasterCode/ProductCode/RefProductMasterCode.',
            'clientNameTokens: client name fragments.',
            'salespersonName: optional sales rep name if present.'
          ].join(' ')
        },
        { role: 'user', content: poText }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'po_search_hints',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobNameKeywords: { type: 'array', items: { type: 'string' } },
              codeCandidates: { type: 'array', items: { type: 'string' } },
              clientNameTokens: { type: 'array', items: { type: 'string' } },
              salespersonName: { anyOf: [{ type: 'string' }, { type: 'null' }] }
            },
            required: ['jobNameKeywords', 'codeCandidates', 'clientNameTokens', 'salespersonName']
          }
        }
      },
      temperature: 0
    });

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      jobNameKeywords: dedupeStrings(parsed.jobNameKeywords, MAX_KEYWORDS),
      codeCandidates: dedupeStrings(parsed.codeCandidates, MAX_KEYWORDS),
      clientNameTokens: dedupeStrings(parsed.clientNameTokens, MAX_KEYWORDS),
      salespersonName: normalizeText(parsed.salespersonName || '')
    };
  } catch (err) {
    return {
      jobNameKeywords: fallbackKeywordExtract(poText),
      codeCandidates: [],
      clientNameTokens: [],
      salespersonName: ''
    };
  }
}

async function extractPoText(req) {
  const textFromBody = normalizeText(req.body?.text);
  if (textFromBody) {
    return { poText: textFromBody, source: 'text' };
  }

  const file = req.file;
  if (!file || !file.buffer) {
    throw new Error('Provide text or upload a file.');
  }

  if (isLikelyImage(file)) {
    const poText = await extractImageTextWithVision(file);
    return { poText, source: 'image' };
  }

  if (isLikelyPdf(file)) {
    const parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    if (typeof parser.destroy === 'function') await parser.destroy();
    return { poText: normalizeText(parsed?.text), source: 'pdf' };
  }

  return { poText: normalizeText(file.buffer.toString('utf8')), source: 'text-file' };
}

async function executeSearchAttempts({ pool, hints, topN }) {
  const dynamic = buildDynamicConditions(hints);
  const { baseOrClause, params: baseParams } = dynamic;
  const jobAttempts = buildJobNameAttempts(hints.jobNameKeywords);

  const attemptsToRun = jobAttempts.length ? jobAttempts : [{ mode: 'none', keywords: [] }];

  if (!willApplySearchPredicate(hints, dynamic)) {
    return { rows: [], attempt: null, sql: null, skippedReason: 'no_search_criteria' };
  }

  for (let i = 0; i < attemptsToRun.length; i += 1) {
    const attempt = attemptsToRun[i];
    const { query, params } = buildQuery({ attempt, baseOrClause, topN });
    assertReadOnlySelect(query);

    const request = pool.request();
    for (const p of [...params, ...baseParams]) {
      request.input(p.name, p.type, p.value);
    }

    const result = await request.query(query);
    const rows = result.recordset || [];
    if (rows.length > 0) {
      return {
        rows,
        attempt: {
          index: i + 1,
          mode: attempt.mode,
          keywords: attempt.keywords
        },
        sql: query
      };
    }
  }

  return { rows: [], attempt: null, sql: null };
}

function splitBatches(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

function normalizeRowForScoring(row) {
  const idStr =
    row.ProductMasterID !== undefined && row.ProductMasterID !== null
      ? String(row.ProductMasterID)
      : '';
  return {
    productMasterId: idStr,
    productMasterCode: row.ProductMasterCode || '',
    refProductMasterCode: row.RefProductMasterCode || '',
    productCode: row.ProductCode || '',
    bookingNo: row.BookingNo || '',
    jobName: row.JobName || '',
    orderQuantity: row.OrderQuantity ?? null,
    criticalInstructions: row.CriticalInstructions || '',
    remark: row.Remark || '',
    closedJobSize: row.ClosedJobSize || '',
    jobType: row.JobType || '',
    jobReference: row.JobReference || '',
    deliveryDate: row.DeliveryDate || null,
    quoteDate: row.QuoteDate || null,
    clientName: row.ClientLedgerName || row.ClientTradeName || '',
    salesName: row.SalesLedgerName || row.SalesTradeName || ''
  };
}

async function scoreBatch(poText, batch) {
  const completion = await openai.chat.completions.create({
    model: SCORE_MODEL,
    messages: [
      {
        role: 'system',
        content: [
          'You score match quality between current PO text and historical product records.',
          'Return strict JSON only.',
          'For each candidate record, return matchPercent from 0 to 100.',
          'Do not skip any candidate in the batch.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          poText,
          candidates: batch
        })
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'po_product_match_scores',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scores: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productMasterId: { type: 'string' },
                  matchPercent: { type: 'number' },
                  reason: { type: 'string' }
                },
                required: ['productMasterId', 'matchPercent', 'reason']
              }
            }
          },
          required: ['scores']
        }
      }
    },
    temperature: 0
  });

  const raw = completion?.choices?.[0]?.message?.content || '{"scores":[]}';
  return JSON.parse(raw);
}

async function scoreCandidates(poText, rows) {
  const normalized = rows.map(normalizeRowForScoring);
  const batches = splitBatches(normalized, SCORE_BATCH_SIZE);
  const scoreById = new Map();

  for (const batch of batches) {
    const scored = await scoreBatch(poText, batch);
    for (const item of scored.scores || []) {
      const idStr = String(item.productMasterId ?? '').trim();
      if (!idStr) continue;
      const matchPercent = Math.max(0, Math.min(100, Number(item.matchPercent) || 0));
      const reason = String(item.reason || '');
      scoreById.set(idStr, { matchPercent, reason });
    }
  }

  const enriched = rows.map((row) => {
    const idStr =
      row.ProductMasterID !== undefined && row.ProductMasterID !== null
        ? String(row.ProductMasterID)
        : '';
    const scored = scoreById.get(idStr) || {
      matchPercent: 0,
      reason: 'No score returned by model.'
    };
    return {
      productMasterId: idStr,
      matchPercent: scored.matchPercent,
      reason: scored.reason,
      row
    };
  });

  enriched.sort((a, b) => b.matchPercent - a.matchPercent);
  return enriched;
}

router.post('/po-product-match/search', upload.single('file'), async (req, res) => {
  try {
    const database = String(req.body?.database || '').toUpperCase();
    if (database !== 'KOL' && database !== 'AHM') {
      return res.status(400).json({ error: 'database is required and must be KOL or AHM.' });
    }

    const topNInput = Number(req.body?.topN);
    const topN = Number.isFinite(topNInput) && topNInput > 0
      ? Math.min(Math.floor(topNInput), MAX_TOP_N)
      : DEFAULT_TOP_N;

    const { poText, source } = await extractPoText(req);
    if (!poText) {
      return res.status(400).json({ error: 'PO text could not be extracted.' });
    }

    const hints = await extractHints(poText);
    if (!hints.jobNameKeywords.length) {
      hints.jobNameKeywords = fallbackKeywordExtract(poText);
    }

    if (!hasSearchableCriteria(hints)) {
      return res.json({
        source,
        database,
        extractedPoText: poText,
        hints,
        searchAttempt: null,
        sql: null,
        skippedReason: 'no_searchable_hints',
        results: []
      });
    }

    const pool = await getPool(database);
    const searched = await executeSearchAttempts({ pool, hints, topN });

    if (searched.skippedReason === 'no_search_criteria') {
      return res.json({
        source,
        database,
        extractedPoText: poText,
        hints,
        searchAttempt: null,
        sql: null,
        skippedReason: searched.skippedReason,
        results: []
      });
    }

    if (!searched.rows.length) {
      return res.json({
        source,
        database,
        extractedPoText: poText,
        hints,
        searchAttempt: searched.attempt,
        sql: searched.sql,
        results: []
      });
    }

    const scored = await scoreCandidates(poText, searched.rows);

    return res.json({
      source,
      database,
      extractedPoText: poText,
      hints,
      searchAttempt: searched.attempt,
      sql: searched.sql,
      results: scored
    });
  } catch (error) {
    console.error('[po-product-match] search failed:', error);
    return res.status(500).json({ error: error?.message || 'Product match search failed' });
  }
});

export default router;

