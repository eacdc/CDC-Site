/**
 * The text of a Word quotation.
 *
 * Padmavati's IPA quote and SR Graphic's ink list arrived as .docx, and the
 * portal turned both away. A Word file is a zip of XML that holds every
 * character the sender typed, so it is read the way a born-digital PDF's text
 * layer is: exact characters, handed to the same reader. Tables keep their
 * shape - one row per line, cells split by " | " - because a price list is a
 * table and a run of loose words is not.
 *
 * SheetJS's CFB reader opens the zip, so no new dependency is needed.
 */

// CFB is on the CommonJS export only; the ESM namespace leaves it out.
import XLSX from 'xlsx';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The document's text, or null when the file is not a Word document. */
export function docxText(buffer) {
  let container;
  try {
    container = XLSX.CFB.read(buffer, { type: 'buffer' });
  } catch {
    return null;
  }
  const entry = XLSX.CFB.find(container, '/word/document.xml');
  if (!entry?.content) return null;
  return documentXmlText(Buffer.from(entry.content).toString('utf8'));
}

/** word/document.xml to text: paragraphs on lines, table cells joined by " | ". */
export function documentXmlText(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    // A paragraph inside a cell ends the cell's line only when the cell does.
    .replace(/<\/w:p>/g, (m, offset, all) => (insideCell(all, offset) ? ' ' : '\n'))
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/( \| )+$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function insideCell(xml, offset) {
  return xml.lastIndexOf('<w:tc>', offset) > xml.lastIndexOf('</w:tc>', offset)
    || xml.lastIndexOf('<w:tc ', offset) > xml.lastIndexOf('</w:tc>', offset);
}

export function looksLikeWord({ mimeType, originalFilename } = {}) {
  return /wordprocessingml|\.docx\b/i.test(`${mimeType || ''} ${originalFilename || ''}`);
}

/** A text layer in the shape `pdfPageTexts` returns, for the quote reader. */
export function docxTextLayer(buffer) {
  const text = docxText(buffer);
  if (!text) return null;
  return { hasTextLayer: true, isThin: false, pages: [text], text };
}
