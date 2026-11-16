import test from 'node:test';
import assert from 'node:assert/strict';
import { documentXmlText, looksLikeWord } from '../services/extraction/docx-text.js';

test('a Word table keeps one row per line', () => {
  const xml = '<w:body><w:p><w:r><w:t>Sub: Quotation</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>INVENTORY ITEMS</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>RATE</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>SKT Enviro Prime Cyan (1)</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>420.00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:t>GST &amp; freight extra</w:t></w:r></w:p></w:body>';
  assert.equal(documentXmlText(xml), 'Sub: Quotation\nINVENTORY ITEMS | RATE\nSKT Enviro Prime Cyan (1) | 420.00\nGST & freight extra');
});

test('Word files are recognised by type or name', () => {
  assert.ok(looksLikeWord({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  assert.ok(looksLikeWord({ originalFilename: 'IPA - NEW QUOTATION.docx' }));
  assert.equal(looksLikeWord({ originalFilename: 'Kodak.pdf' }), false);
});
