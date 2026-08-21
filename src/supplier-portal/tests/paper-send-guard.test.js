/**
 * What may be sent to a vision model.
 *
 * These exist because of the first live run of the paper interpreter. The route
 * passed signed storage URLs straight to OpenAI, and every real quote is a PDF,
 * so the first click produced:
 *
 *   400 You uploaded an unsupported image. Please make sure your image has one
 *   of the following formats: ['png', 'jpeg', 'gif', 'webp'].
 *
 * That message names neither the document nor the fix, and points at the upload
 * rather than at the missing rasterise step. The guard turns it into our own
 * sentence, before the call, naming the page and what to do.
 *
 * All 297 tests passed while this bug was live, because every one of them
 * stubbed the model. That is the honest lesson: they proved the control flow
 * around the model, not that anything could be sent to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSendableImage } from '../services/paper/openai-send.js';

test('a rendered page is sendable', () => {
  // What pdfPageImages actually produces, verified against Sudarshan's
  // two-page virgin board list.
  assert.equal(isSendableImage({
    pageNo: 1, mimeType: 'image/jpeg', url: 'data:image/jpeg;base64,/9j/2wBDAAYGBgYGB',
  }), true);
});

test('every format the endpoint accepts is accepted here', () => {
  for (const type of ['png', 'jpeg', 'jpg', 'gif', 'webp']) {
    assert.equal(isSendableImage({ url: `data:image/${type};base64,AAAA` }), true, type);
  }
});

test('a PDF is refused — the bug this file is named for', () => {
  // A signed storage URL for a PDF, exactly as the route first produced it.
  assert.equal(isSendableImage({
    pageNo: 1,
    mimeType: 'application/pdf',
    url: 'https://cdc.r2.cloudflarestorage.com/quotes/abc.pdf?X-Amz-Signature=...',
  }), false);
});

test('a PDF data URL is refused too', () => {
  assert.equal(isSendableImage({ url: 'data:application/pdf;base64,JVBERi0x' }), false);
});

test('an image format the endpoint does not take is refused', () => {
  // TIFF and BMP are images and are not on the list. Sending one produces the
  // same unhelpful 400 as a PDF.
  assert.equal(isSendableImage({ mimeType: 'image/tiff', url: 'https://x/y.tif' }), false);
  assert.equal(isSendableImage({ url: 'data:image/bmp;base64,Qk0' }), false);
});

test('a storage URL is judged on its declared type', () => {
  // The URL says nothing about the bytes, so mimeType is all there is.
  assert.equal(isSendableImage({ mimeType: 'image/png', url: 'https://cdc.r2.example/scan' }), true);
  assert.equal(isSendableImage({ mimeType: 'image/jpeg', url: 'https://cdc.r2.example/p1' }), true);
});

test('a page declaring no type at all is refused rather than sent hopefully', () => {
  // The whole point is to fail here with a sentence somebody can act on,
  // instead of at OpenAI with one they cannot.
  assert.equal(isSendableImage({ url: 'https://cdc.r2.example/mystery' }), false);
  assert.equal(isSendableImage({}), false);
  assert.equal(isSendableImage(null), false);
});
