/**
 * Rendering a scanned PDF's pages to images.
 *
 * The portal used to refuse a scan outright — "upload its pages as images
 * (JPEG or PNG) so they can be read" — which handed the buyer a chore the
 * server can do in about a second. These pin the rendering that replaced it,
 * and in particular the two things that make it safe to run on real uploads:
 * the output is small enough to actually send, and a long document is capped
 * rather than allowed to build a request that times out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfPageImages, MAX_RENDER_PAGES } from '../services/extraction/pdf-render.js';

/**
 * A PDF built in memory rather than a committed binary fixture: the page count
 * is what several of these tests vary, and a fixture per count would be four
 * opaque blobs nobody can edit.
 */
async function makePdf(pageCount, { text = true } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([595, 842]);
    // Something with ink on it — a blank page can legitimately render to
    // almost nothing, which would make the size assertions meaningless.
    page.drawRectangle({ x: 40, y: 600, width: 500, height: 180, color: rgb(0.85, 0.88, 0.92) });
    if (text) {
      page.drawText('PRINT SALES PRIVATE LIMITED', { x: 60, y: 740, size: 18, font });
      page.drawText(`Page ${i + 1} — 790 x 1030 x 0.28mm  382.44/PC`, { x: 60, y: 700, size: 12, font });
    }
  }

  return Buffer.from(await doc.save());
}

test('a PDF renders to one JPEG data URL per page', async () => {
  const { pages, total, rendered, truncated } = await pdfPageImages(await makePdf(3));

  assert.equal(total, 3);
  assert.equal(rendered, 3);
  assert.equal(truncated, false);
  assert.deepEqual(pages.map((p) => p.pageNo), [1, 2, 3]);

  for (const page of pages) {
    assert.equal(page.mimeType, 'image/jpeg');
    assert.match(page.url, /^data:image\/jpeg;base64,/);
    assert.ok(page.base64.length > 0);
  }
});

test('pages come out JPEG, not the PNG the rasteriser emits', async () => {
  // Checked at the bytes rather than the declared mime type: a mislabelled PNG
  // would still be several megabytes and would still blow up the request, and
  // the label is the part that cannot fail loudly.
  const { pages } = await pdfPageImages(await makePdf(1));
  const bytes = Buffer.from(pages[0].base64, 'base64');
  assert.equal(bytes[0], 0xff, 'JPEG starts FF D8');
  assert.equal(bytes[1], 0xd8);
});

test('a page is small enough to actually send', async () => {
  // The reason this exists: the rasteriser emits lossless PNG, which for a
  // photographed page runs to several megabytes before base64 adds a third
  // again. Three of those is a request that times out on its own.
  const { pages } = await pdfPageImages(await makePdf(1));
  assert.ok(pages[0].bytes < 900_000, `page is ${pages[0].bytes} bytes, too large to send`);
});

test('a long document is capped, and says it was capped', async () => {
  // A 60-page scan is somebody uploading the wrong file. Rendering all of it
  // spends a minute discovering that.
  const { pages, total, rendered, truncated } = await pdfPageImages(
    await makePdf(MAX_RENDER_PAGES + 4),
  );

  assert.equal(total, MAX_RENDER_PAGES + 4);
  assert.equal(rendered, MAX_RENDER_PAGES);
  assert.equal(pages.length, MAX_RENDER_PAGES);
  assert.equal(truncated, true, 'a silent cap reads as a complete extraction');
});

test('an explicit lower cap is honoured', async () => {
  const { rendered, truncated } = await pdfPageImages(await makePdf(5), { maxPages: 2 });
  assert.equal(rendered, 2);
  assert.equal(truncated, true);
});

test('a page with no text still renders — that is the whole point', async () => {
  // A scan has no characters anywhere. Rendering must not depend on finding
  // any, which is the assumption the text-layer path makes.
  const { pages, rendered } = await pdfPageImages(await makePdf(1, { text: false }));
  assert.equal(rendered, 1);
  assert.ok(pages[0].bytes > 0);
});

test('empty input is refused rather than returning nothing', async () => {
  // Returning `{pages: []}` here would surface downstream as "the model read no
  // lines", blaming the model for a file that was never sent.
  await assert.rejects(() => pdfPageImages(Buffer.alloc(0)), /No PDF bytes/);
});

test('bytes that are not a PDF fail loudly', async () => {
  await assert.rejects(() => pdfPageImages(Buffer.from('this is not a pdf at all')));
});
