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

test('each page goes as the whole page and a close-up of its top, at high detail', async () => {
  const { pages } = await preparePages(provider({ answers: [] }), [await page()]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => [p.detail, Boolean(p.closeUp)]), [['high', false], ['high', true]]);
  const full = await sharp(Buffer.from(pages[0].url.split(',')[1], 'base64')).metadata();
  const top = await sharp(Buffer.from(pages[1].url.split(',')[1], 'base64')).metadata();
  assert.equal(top.width, full.width);
  assert.equal(top.height, Math.round(full.height * 0.45));
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
  assert.match(p.calls[0].hints.notes.join(' '), /close-up of the top/);
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
