/**
 * Step 1 of a run: find what is new, and lay each file out for reading.
 *
 *   node --env-file=<env> prepare.mjs
 *
 * New means: in the Inbox, unchanged for a minute (so a file still being
 * copied is left for the next run), and not already read (its sha256 is not
 * known to the API); or uploaded through the portal and not yet read.
 *
 * For each one, Work/<sha8>/ gets the file, its text layer or worksheet rows,
 * and page images to look at. Work/manifest.json lists them. No model calls.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, sha256, contentTypeOf, api, imp } from './common.mjs';

const { pdfPageTexts } = await imp('supplier-portal/services/extraction/pdf-text.js');
const { pdfPageImages } = await imp('supplier-portal/services/extraction/pdf-render.js');
const { extractWorkbook } = await imp('supplier-portal/services/extraction/xlsx-extract.js');
const { docxTextLayer } = await imp('supplier-portal/services/extraction/docx-text.js');

const SETTLE_MS = 60 * 1000;
ensureDirs();

async function layOut({ buffer, fileName, source }) {
  const hash = sha256(buffer);
  const dir = path.join(DIRS.work, hash.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  // basename: a portal upload's name is the uploader's, and must not climb out of dir.
  const stored = path.join(dir, path.basename(fileName));
  writeFileSync(stored, buffer);
  const ext = path.extname(fileName).toLowerCase();
  const out = {
    sha256: hash, fileName, file: stored, dir, source, contentType: contentTypeOf(fileName),
    pages: [], text: null, sheet: null,
  };
  try {
    if (ext === '.pdf') {
      const layer = await pdfPageTexts(buffer).catch(() => null);
      if (layer?.hasTextLayer) {
        out.text = path.join(dir, 'text.txt');
        writeFileSync(out.text, layer.text);
      }
      const shot = await pdfPageImages(buffer).catch(() => null);
      for (const p of shot?.pages || []) {
        const img = path.join(dir, `page-${p.pageNo}.jpg`);
        writeFileSync(img, Buffer.from(p.base64, 'base64'));
        out.pages.push(img);
      }
    } else if (ext === '.xlsx' || ext === '.xls') {
      out.sheet = path.join(dir, 'sheet.json');
      writeFileSync(out.sheet, JSON.stringify(extractWorkbook(buffer), null, 1));
    } else if (ext === '.docx') {
      out.text = path.join(dir, 'text.txt');
      writeFileSync(out.text, docxTextLayer(buffer).text || '');
    } else if (ext === '.csv' || ext === '.txt') {
      out.text = path.join(dir, 'text.txt');
      writeFileSync(out.text, buffer.toString('utf8'));
    } else {
      out.pages.push(stored);
    }
  } catch (err) { out.prepareError = err.message; }
  return out;
}

/** Portal/<YYYY-MM>/<date> <name>: the local copy of a portal upload. Kept once; a failed copy never stops the run. */
function keepPortalCopy(buffer, u) {
  try {
    const at = new Date(u.uploadedAt || Date.now());
    const month = path.join(DIRS.portal, at.toISOString().slice(0, 7));
    mkdirSync(month, { recursive: true });
    const safe = String(u.fileName || 'upload').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150);
    const target = path.join(month, `${at.toISOString().slice(0, 10)} ${String(u.sha256).slice(0, 8)} ${safe}`);
    if (!existsSync(target)) writeFileSync(target, buffer);
  } catch (err) { skipped.push({ name: u.fileName, why: `kept for reading, but the local copy failed (${err.message})` }); }
}

const items = [];
const skipped = [];

for (const name of readdirSync(DIRS.inbox)) {
  const full = path.join(DIRS.inbox, name);
  const st = statSync(full);
  if (!st.isFile() || name.startsWith('~$') || name.startsWith('.')) continue;
  if (!contentTypeOf(name)) {
    skipped.push({ name, why: 'not a quote file type; moved to Failed' });
    renameSync(full, path.join(DIRS.failed, name));
    continue;
  }
  if (Date.now() - st.mtimeMs < SETTLE_MS) { skipped.push({ name, why: 'still arriving; next run' }); continue; }
  const buffer = readFileSync(full);
  const { seen } = await api(`/seen/${sha256(buffer)}`);
  if (seen) {
    skipped.push({ name, why: 'already read; moved to Done' });
    renameSync(full, path.join(DIRS.done, `duplicate - ${name}`));
    continue;
  }
  items.push(await layOut({ buffer, fileName: name, source: { inbox: full } }));
}

const { uploads } = await api('/portal-uploads');
for (const u of uploads) {
  const { seen } = await api(`/seen/${u.sha256}`);
  if (seen) continue;
  const res = await fetch(u.downloadUrl);
  if (!res.ok) { skipped.push({ name: u.fileName, why: `portal file download failed (${res.status})` }); continue; }
  const buffer = Buffer.from(await res.arrayBuffer());
  keepPortalCopy(buffer, u);
  items.push(await layOut({
    buffer, fileName: u.fileName,
    source: {
      portalDocumentId: String(u.portalDocumentId), plantScope: u.plantScope,
      uploadedBy: u.uploadedBy || null, supplier: u.supplier || null, note: u.note || null,
    },
  }));
}

writeFileSync(path.join(DIRS.work, 'manifest.json'), JSON.stringify({ preparedAt: new Date().toISOString(), items, skipped }, null, 2));
for (const s of skipped) console.log(`SKIP ${s.name}: ${s.why}`);
for (const i of items) {
  console.log(`NEW ${i.sha256.slice(0, 8)} ${i.fileName} dir=${i.dir} pages=${i.pages.length} text=${Boolean(i.text)} sheet=${Boolean(i.sheet)}${i.prepareError ? ` error=${i.prepareError}` : ''}`);
}
if (!items.length) console.log('NOTHING NEW');
process.exit(0);
