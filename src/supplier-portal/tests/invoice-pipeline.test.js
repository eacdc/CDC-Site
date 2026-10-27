/**
 * The reader around the provider: pages turned upright and sent with a
 * close-up, and one retry when the answer is provably wrong. The provider is
 * a stand-in; the images are drawn here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { preparePages, readInvoice } from '../services/extraction/invoice-pipeline.js';

async function page(width = 400, height = 600) {
  const png = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
  return { url: `data:image/png;base64,${png.toString('base64')}`, pageNo: 1 };
}

const GOOD = {
  invoiceNo: 'A/1', subTotal: '100.00', taxable: '100.00', cgst: '9.00', sgst: '9.00', grandTotal: '118.00',
  lines: [{ lineNo: 1, qty: '10', rate: '10.00', amount: '100.00' }],
};
const SLID = { ...GOOD, lines: [{ lineNo: 1, qty: '1', rate: '10.00', amount: '100.00' }] };

function provider({ answers, turnIndex = 0 }) {
  const calls = [];
  return {
    calls,
    async detectOrientation() { return turnIndex; },
    async extractInvoice(args) { calls.push(args); return answers[calls.length - 1]; },
  };
}

test('each page goes as the whole page and four overlapping close-ups, enlarged to what the model keeps', async () => {
  const { pages } = await preparePages(provider({ answers: [] }), [await page(1080, 1414)]);
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map((p) => [p.detail, Boolean(p.closeUp)]),
    [['high', false], ['high', true], ['high', true], ['high', true], ['high', true]]);
  const size = (p) => sharp(Buffer.from(p.url.split(',')[1], 'base64')).metadata();
  const full = await size(pages[0]);
  assert.deepEqual([full.width, full.height], [1080, 1414]);
  // A strip is 32% of the page: 1080 x 452, scaled up to 768 on its short side.
  for (const strip of pages.slice(1)) {
    const m = await size(strip);
    assert.deepEqual([m.width, m.height], [1835, 768]);
  }
});

test('the close-ups cover the page from top to bottom, each overlapping the next', async () => {
  // Bands of colour down the page; each strip's top and bottom rows show where it was cut.
  const W = 200; const H = 1000;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) raw.fill(Math.floor((y / H) * 250), y * W * 3, (y + 1) * W * 3);
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const { pages } = await preparePages(provider({ answers: [] }), [{ url: `data:image/png;base64,${png.toString('base64')}`, pageNo: 1 }]);
  const rows = [];
  for (const strip of pages.slice(1)) {
    const buf = Buffer.from(strip.url.split(',')[1], 'base64');
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const at = (y) => Math.round((data[y * info.width + Math.floor(info.width / 2)] / 250) * H);
    rows.push([at(2), at(info.height - 3)]);
  }
  assert.ok(rows[0][0] <= 15, `the first strip starts at the top (${rows[0][0]})`);
  assert.ok(rows.at(-1)[1] >= H - 15, `the last strip reaches the bottom (${rows.at(-1)[1]})`);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i][0] < rows[i - 1][1] - 50, `strip ${i + 1} overlaps strip ${i}`);
});

test('a page the model says is sideways is turned before it is read', async () => {
  const p = provider({ answers: [], turnIndex: 1 });
  const { pages, notes } = await preparePages(p, [await page(400, 600)]);
  const full = await sharp(Buffer.from(pages[0].url.split(',')[1], 'base64')).metadata();
  assert.deepEqual([full.width, full.height], [600, 400]);
  assert.deepEqual(notes, ['page 1 was turned 90 degrees to read upright']);
});

test('something that is not an image passes through untouched', async () => {
  const pdf = { url: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`, pageNo: 1 };
  const { pages } = await preparePages(provider({ answers: [] }), [pdf]);
  assert.deepEqual(pages, [pdf]);
});

test('a clean answer is read once', async () => {
  const p = provider({ answers: [GOOD] });
  const x = await readInvoice(p, { pages: [await page()] });
  assert.equal(p.calls.length, 1);
  assert.equal(x._review.retried, false);
  assert.match(p.calls[0].hints.notes.join(' '), /4 close-ups of that SAME page/);
});

test('a provably wrong answer is read again with the problem named, and the better one kept', async () => {
  const p = provider({ answers: [SLID, GOOD] });
  const x = await readInvoice(p, { pages: [await page()] });
  assert.equal(p.calls.length, 2);
  assert.match(p.calls[1].hints.notes.at(-1), /Line 1: quantity 1 x rate 10\.00 = 10/);
  assert.equal(x.lines[0].qty, '10');
  assert.equal(x._review.kept, 'second');
  assert.deepEqual(x._review.problemsAfter, []);
});

test('a second answer no better than the first is not taken', async () => {
  const p = provider({ answers: [SLID, SLID] });
  const x = await readInvoice(p, { pages: [await page()] });
  assert.equal(x._review.kept, 'first');
  assert.equal(x._review.problemsAfter.length, 1);
});

test('fields the two reads answered differently are reported', async () => {
  const p = provider({ answers: [{ ...SLID, gateEntryNo: '5212' }, { ...GOOD, gateEntryNo: '25712' }] });
  const x = await readInvoice(p, { pages: [await page()] });
  assert.deepEqual(x._review.disagreements.map((d) => d.field).sort(), ['gateEntryNo', 'lines.1.qty']);
});
