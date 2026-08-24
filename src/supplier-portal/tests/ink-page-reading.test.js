/**
 * Reading a long price list without losing half of it.
 *
 * CDC read Print Sales' three-page quotation — about forty-three priced rows
 * across plates, DIC ink, DIC coating, aqua coatings, press chemicals and
 * Boettcher chemicals — and got twenty lines. No error, no warning: the press
 * chemicals and the entire Boettcher section were absent, and the twenty that
 * survived looked perfect.
 *
 * Three separate things had to be wrong for that to happen quietly, and each
 * one has a test here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readEveryPage, mergeReadings, shortfallNote, interpretInkQuote,
} from '../services/ink/interpreter.js';
import { buildInkMessage } from '../services/ink/ink-prompt.js';

const page = (n) => ({ url: `data:image/jpeg;base64,page${n}`, pageNo: n });

// ── One reply cannot hold every row ─────────────────────────────────────────

test('a three-page document is read three times', () => {
  // One reply has to hold every row of every page, and a long list runs out of
  // room. Per page, no page is long.
  const seen = [];
  return readEveryPage({
    send: async ({ message, pages }) => {
      seen.push({ pageCount: pages.length, message });
      return { rowsSeen: 1, payload: { lines: [{ productName: 'X', rate: 1 }] } };
    },
    system: 'S',
    pages: [page(1), page(2), page(3)],
    pageTexts: ['one', 'two', 'three'],
    buildMessage: (perPage) => buildInkMessage(perPage),
  }).then(() => {
    assert.equal(seen.length, 3);
    // Each call carries exactly one page image, not all three.
    assert.deepEqual(seen.map((s) => s.pageCount), [1, 1, 1]);
    assert.match(seen[0].message, /THIS IS PAGE 1 OF 3/);
    assert.match(seen[2].message, /THIS IS PAGE 3 OF 3/);
  });
});

test('a one-page document is still read in one call', async () => {
  // Paging a single page would cost the same and gain nothing.
  let calls = 0;
  await readEveryPage({
    send: async ({ pages }) => { calls += 1; assert.equal(pages.length, 1); return {}; },
    system: 'S',
    pages: [page(1)],
    pageTexts: ['only'],
    buildMessage: (perPage) => buildInkMessage(perPage),
  });
  assert.equal(calls, 1);
});

test('the heading in force carries across the page break', async () => {
  /*
    Print Sales' press chemicals run over two pages and the rows on the second
    carry no heading of their own. Read in isolation every one of them loses its
    rate unit — one of the two ways a rate can be silently wrong.
  */
  const messages = [];
  await readEveryPage({
    send: async ({ message }) => {
      messages.push(message);
      return {
        rowsSeen: 1,
        payload: { lines: [{ productName: 'ECNO WASH KR', section: 'PRESS CHEMICALS RATE PER LTR.' }] },
      };
    },
    system: 'S',
    pages: [page(1), page(2)],
    pageTexts: ['a', 'b'],
    buildMessage: (perPage) => buildInkMessage(perPage),
  });

  assert.doesNotMatch(messages[0], /still in force/);
  assert.match(messages[1], /still in force from the previous page is "PRESS CHEMICALS RATE PER LTR\."/);
});

// ── Merging ─────────────────────────────────────────────────────────────────

test('pages merge into one document, renumbered', () => {
  /*
    Every page numbers its own rows from one. Three lines numbered 1 would
    collide the moment anything keyed on the number.
  */
  const merged = mergeReadings([
    {
      understanding: 'Print Sales, a dealer, quoting DIC and Boettcher.',
      rowsSeen: 14,
      payload: {
        supplierName: 'PRINT SALES PRIVATE LIMITED',
        lines: [{ lineNo: 1, productName: 'RADICURE INTENSE 9000 PRO CYAN' }],
      },
    },
    {
      understanding: 'Page two holds press chemicals.',
      rowsSeen: 21,
      payload: { lines: [{ lineNo: 1, productName: 'ECNO WASH KR (20 LTR)' }] },
    },
    {
      rowsSeen: 8,
      payload: { lines: [{ lineNo: 1, productName: 'CLEANFIX' }] },
    },
  ]);

  assert.deepEqual(merged.payload.lines.map((l) => l.lineNo), [1, 2, 3]);
  assert.equal(merged.payload.supplierName, 'PRINT SALES PRIVATE LIMITED');
  assert.equal(merged.rowsSeen, 43);
  // The first page's description is the one worth keeping: it names the
  // supplier, where later pages describe only their own contents.
  assert.match(merged.understanding, /Print Sales/);
});

test('a document fact stated on any page survives', () => {
  // Validity dates and terms are printed once, sometimes on the last page.
  const merged = mergeReadings([
    { payload: { supplierName: 'PRINT SALES', lines: [] } },
    { payload: { effectiveFrom: '2026-07-15', lines: [] } },
  ]);
  assert.equal(merged.payload.supplierName, 'PRINT SALES');
  assert.equal(merged.payload.effectiveFrom, '2026-07-15');
});

test('a page that failed does not take the others with it', () => {
  const merged = mergeReadings([
    { rowsSeen: 2, payload: { lines: [{ productName: 'A' }, { productName: 'B' }] } },
    null,
  ]);
  assert.equal(merged.payload.lines.length, 2);
});

// ── Counting ────────────────────────────────────────────────────────────────

test('a reading that stops early says so', () => {
  /*
    The heart of it. A short reading is indistinguishable from a short document
    unless something counts — and nothing did, which is why twenty rows looked
    like a complete answer.
  */
  const note = shortfallNote({
    rowsSeen: 43,
    payload: { lines: Array.from({ length: 20 }, (_, i) => ({ productName: `P${i}` })) },
  });

  assert.match(note, /Counted 43 priced rows/);
  assert.match(note, /only read 20/);
  assert.match(note, /23 row\(s\) are missing/);
});

test('a complete reading says nothing', () => {
  assert.equal(shortfallNote({ rowsSeen: 3, payload: { lines: [{}, {}, {}] } }), null);
  // More lines than counted is not a shortfall — a derivation can legitimately
  // expand one printed row into several.
  assert.equal(shortfallNote({ rowsSeen: 3, payload: { lines: [{}, {}, {}, {}] } }), null);
  // And a model that did not count is not accused of anything.
  assert.equal(shortfallNote({ payload: { lines: [{}] } }), null);
});

test('the shortfall leads the notes on the review panel', async () => {
  // It is the one thing on that panel that says the table below is incomplete.
  // Everything else there describes what WAS read.
  const result = await interpretInkQuote({
    pages: [page(1)],
    send: async () => ({
      understanding: 'A three-page quotation.',
      notes: ['GST extra as applicable'],
      rowsSeen: 43,
      payload: {
        supplierName: 'PRINT SALES',
        lines: [{
          lineNo: 1,
          productName: 'RADICURE INTENSE 9000 PRO CYAN',
          rate: 830,
          rateUom: 'KG',
        }],
      },
    }),
  });

  assert.match(result.notes[0], /Counted 43 priced rows but only read 1|Counted 43 priced rows on this document but only read 1/);
  assert.equal(result.notes[1], 'GST extra as applicable');
});

// ── The text layer ──────────────────────────────────────────────────────────

test('the text layer reaches the model as text', () => {
  /*
    It was handed the whole `pdfPageTexts` result — an object — and pushed
    straight into the message, where it rendered as "[object Object]". So the
    reading had no text layer at all and worked from the page images alone,
    which is exactly the condition under which rows get missed.
  */
  const fromString = buildInkMessage({ textLayer: 'ECNO WASH KR (20 LTR) 220.00' });
  assert.match(fromString, /ECNO WASH KR \(20 LTR\) 220\.00/);
  assert.doesNotMatch(fromString, /\[object Object\]/);

  const fromResult = buildInkMessage({ textLayer: { text: 'MET KLEEN (1 LTR) 288.00', pages: [] } });
  assert.match(fromResult, /MET KLEEN \(1 LTR\) 288\.00/);
  assert.doesNotMatch(fromResult, /\[object Object\]/);
});

test('each page gets its own page of text', async () => {
  const messages = [];
  await readEveryPage({
    send: async ({ message }) => { messages.push(message); return {}; },
    system: 'S',
    pages: [page(1), page(2)],
    pageTexts: ['PLATE SIZE RATE PER PC', 'PRESS CHEMICALS RATE PER LTR'],
    buildMessage: (perPage) => buildInkMessage(perPage),
  });

  assert.match(messages[0], /PLATE SIZE RATE PER PC/);
  assert.doesNotMatch(messages[0], /PRESS CHEMICALS/);
  assert.match(messages[1], /PRESS CHEMICALS RATE PER LTR/);
});

test('the model is told to count before it transcribes', () => {
  // Asked first so it is an observation rather than a self-report: a model that
  // has just written twenty lines will say twenty.
  const message = buildInkMessage({});
  assert.match(message, /COUNT THE PRICED ROWS FIRST/);
  assert.match(message, /"rowsSeen"/);
});
