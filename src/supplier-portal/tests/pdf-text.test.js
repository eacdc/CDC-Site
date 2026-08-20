/**
 * PDF text-layer tests.
 *
 * The fixture is the text layer of the real Print Sales quotation of
 * 10-07-2026, as `pdfPageTexts` read it. Keeping the extracted text rather than
 * the PDF is deliberate: the assertions here are about what the layer must
 * carry into the prompt, and a binary fixture would make a failure unreadable
 * in a diff.
 *
 * What is being defended is the reason for reading a text layer at all —
 * `382.44` must not become `38244`, and `w.e.f. 15-07-2026` must not become
 * some other plausible date. Both are the kind of error a vision model makes
 * occasionally and nobody notices, because the wrong answer looks exactly like
 * a right one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPageTexts, textLayerInstruction, looksLikePdf } from '../services/extraction/pdf-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.join(HERE, 'fixtures', 'print-sales-10072026.txt'), 'utf8',
);

/** The fixture, split back into the three pages it was read from. */
const PAGES = FIXTURE.split(/^--- PAGE \d+ ---$/m).map((p) => p.trim()).filter(Boolean);

test('the fixture is the three pages of the real quote', () => {
  assert.equal(PAGES.length, 3);
});

test('the text layer carries every field identification needs', () => {
  // Each of these is read by a different rule, and each is on a different part
  // of the document — which is the point: no single region of the page is
  // enough to identify a quote.
  assert.match(PAGES[0], /Date: 10-07-2026/, 'the document date, page 1');
  assert.match(PAGES[0], /Sub: QUOTATION w\.e\.f\. 15-07-2026\./, 'the effective date, in the subject line');
  assert.match(PAGES[0], /CDC PRINTERS \(P\)\. LTD\./, 'the addressee');
  assert.match(PAGES[0], /45, Radhanath Chowdhuri Road/, 'the address that means Tangra, and therefore Kolkata');

  const last = PAGES[PAGES.length - 1];
  assert.match(last, /PRINT SALES PRIVATE LIMITED/, 'the sender, named only in the signature block');
  assert.match(last, /Rina Das/, 'the signatory');
  assert.match(last, /\+91-7596986452/, 'the phone number beneath it');
  assert.match(last, /The rate is subject to market fluctuation/, 'the sentence that makes this a soft quote');
  assert.match(last, /Payment: As per agreed terms\./);
  assert.match(last, /GST will be charged extra as applicable/);
  assert.match(last, /Delivery: Free to your work\./);
});

test('rates survive with their decimal points intact', () => {
  // The whole argument for the text layer in two assertions. A vision model
  // reading 382.44 off a rendered table occasionally returns 38244, and 38244
  // is not obviously wrong to anything downstream.
  assert.match(PAGES[0], /790 x 1030 x 0\.28mm 382\.44/);
  assert.match(PAGES[0], /576 x 889 x 0\.28mm 240\.67/);
  assert.match(PAGES[0], /RADICURE INTENSE 9000 PRO YELLOW 830\.00/);
  assert.match(PAGES[0], /\(470\.00\/m²\)/, 'the rate basis stated above the plate table');
});

test('the prompt block tells the model the text wins on characters', () => {
  const block = textLayerInstruction({ pages: PAGES });
  assert.match(block, /TEXT LAYER/);
  assert.match(block, /the text\s+below is right/i);
  // And that it does NOT win on structure — a flattened table has lost its
  // columns, and a model told to trust it for layout would read the price list
  // as a stream of words.
  assert.match(block, /Use the images for layout/);
  assert.match(block, /--- PAGE 1 ---/);
  assert.match(block, /--- PAGE 3 ---/);
  assert.ok(block.includes('PRINT SALES PRIVATE LIMITED'));
});

test('an empty layer produces no block rather than an empty heading', () => {
  assert.equal(textLayerInstruction({ pages: [], text: '' }), null);
  assert.equal(textLayerInstruction({}), null);
});

test('only PDFs are tried', () => {
  assert.ok(looksLikePdf({ mimeType: 'application/pdf' }));
  assert.ok(looksLikePdf({ originalFilename: 'Print_Sales_10072026.PDF' }));
  assert.equal(looksLikePdf({ mimeType: 'image/jpeg', originalFilename: 'scan.jpg' }), false);
  assert.equal(looksLikePdf({}), false);
});

// ── Thin layers: the case that reads as success and returns nothing ─────────

test('the real Print Sales quote is nowhere near thin', () => {
  // The regression guard for the whole thin-layer rule. This document is
  // born-digital and its text accounts for its pages, so it must keep being
  // read from text alone — rendering it to images would buy transcription risk
  // on every rate for nothing.
  //
  // Measured off the fixture text rather than a PDF, because what is committed
  // is the layer this file already extracted from the real quote.
  const dense = FIXTURE.replace(/^--- PAGE \d+ ---$/gm, '').replace(/\s/g, '').length;
  const charsPerPage = Math.round(dense / PAGES.length);
  assert.ok(charsPerPage > 300, `expected a dense page, got ${charsPerPage}`);
});

test('a typed letterhead over photographed pages counts as thin', async () => {
  // The dangerous shape: it clears the 40-character has-a-layer bar easily, so
  // without `isThin` it would be read text-only and come back confident and
  // empty — every rate lived in the picture nobody sent.
  const layer = await pdfPageTexts(await makeThinPdf(5));
  assert.equal(layer.hasTextLayer, true, 'a letterhead is a real text layer');
  assert.equal(layer.isThin, true, 'but it does not account for five pages');
});

test('a PDF with no text at all is thin and has no layer', async () => {
  const layer = await pdfPageTexts(await makeThinPdf(2, { text: false }));
  assert.equal(layer.hasTextLayer, false);
  assert.equal(layer.isThin, true);
  // Not asserted as exactly zero: a PDF with no drawn text still yields a
  // handful of stray characters from its structure. That is precisely why
  // `hasTextLayer` has a floor instead of testing for emptiness.
  assert.ok(layer.charsPerPage < 40, `expected noise, got ${layer.charsPerPage} chars/page`);
});

test('unreadable bytes report thin rather than pretending to have text', async () => {
  const layer = await pdfPageTexts(Buffer.from('not a pdf'));
  assert.equal(layer.hasTextLayer, false);
  assert.equal(layer.isThin, true);
});

/** A letterhead line on each of `pages` pages, and nothing else. */
async function makeThinPdf(pages, { text = true } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([595, 842]);
    // Stands in for the photographed price table: ink, but no characters.
    page.drawRectangle({ x: 40, y: 80, width: 500, height: 620, color: rgb(0.9, 0.9, 0.9) });
    if (text) page.drawText('PRINT SALES PRIVATE LIMITED', { x: 60, y: 780, size: 14, font });
  }

  return Buffer.from(await doc.save());
}
