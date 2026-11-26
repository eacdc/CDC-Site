/**
 * The review page's Upload tab, and an approver's supplier correction on a
 * quote.
 *
 * An upload is stored, not read: the portal makes no model calls. The hourly
 * run picks it up (/automation/portal-uploads), keeps a copy in the quotes
 * folder, and its lines appear on Review. Who sent it is the uploader's to
 * say if they know; the run checks that against the document.
 *
 * A correction is a new record beside the quote (sp_supplierCorrections); the
 * quote and its lines keep what the run read.
 *
 * A classic script after index.html's and dashboard.js's: it shares their
 * top-level helpers ($, esc, api, API, store, site, user, toast, openQuote,
 * loadQuotes, showTab).
 */

const UPLOAD_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.csv,.docx,.txt,image/jpeg,image/png,image/webp';
const READABLE_FILE = /\.(pdf|jpe?g|png|webp|xlsx|xls|csv|docx|txt)$/i;
const UPLOAD_MAX_MB = 25;
const SITE_NAME = { KOL: 'Kolkata', AHM: 'Ahmedabad' };
const PLANT = { KOL: 'KOLKATA', AHM: 'AHMEDABAD' }; // a QuoteDocument's plantScope
const hasRole = (...roles) => roles.some((r) => user?.roles?.includes(r)) || user?.roles?.includes('ADMIN');

let upFiles = []; // { file, state: READY | SENDING | DONE | DUPLICATE | FAILED, message }
let upSupplier = null; // { supplierGroupId, name, gstins } picked, or { name, typed: true }
let upSending = false;

/**
 * A type-ahead over the portal's suppliers (synced from Indus ledgers). With
 * `allowTyped`, a name not in the list can be used as it was typed.
 */
function supplierPicker(host, { onPick, onCancel = null, allowTyped = true, focus = true }) {
  host.innerHTML = `<div class="picker" style="margin:0">
    <input type="search" placeholder="Search supplier name" aria-label="Search supplier">
    <div class="results"><small>Type two letters or more.</small></div>
    ${onCancel ? '<div><button type="button" class="ghost" data-cancel>Cancel</button></div>' : ''}
  </div>`;
  const input = host.querySelector('input');
  const out = host.querySelector('.results');
  host.querySelector('[data-cancel]')?.addEventListener('click', onCancel);
  let seq = 0;
  let timer = null;
  const search = async () => {
    const q = input.value.replace(/\s+/g, ' ').trim();
    const mine = ++seq;
    if (q.length < 2) { out.innerHTML = '<small>Type two letters or more.</small>'; return; }
    out.innerHTML = '<small>Searching…</small>';
    try {
      const groups = await api(`/suppliers/search?q=${encodeURIComponent(q)}&limit=12`);
      if (mine !== seq) return;
      const typed = allowTyped && !groups.some((g) => g.name.trim().toLowerCase() === q.toLowerCase());
      out.innerHTML = groups.map((g, i) => `<button type="button" class="ghost" data-i="${i}"><span class="who-sup"><strong>${esc(g.name)}</strong>
          <small>${g.gstins?.length ? `GSTIN ${esc(g.gstins.join(', '))}` : 'No GSTIN on file'}</small></span></button>`).join('')
        + (typed ? `<button type="button" class="ghost" data-typed><span class="who-sup"><strong>Use “${esc(q)}”</strong><small>A supplier not in the list</small></span></button>` : '')
        || '<small>No supplier matches.</small>';
      out.querySelectorAll('[data-i]').forEach((b) => {
        const g = groups[Number(b.dataset.i)];
        b.onclick = () => onPick({ supplierGroupId: g._id, name: g.name, gstins: g.gstins || [] });
      });
      out.querySelector('[data-typed]')?.addEventListener('click', () => onPick({ name: q, typed: true, gstins: [] }));
    } catch (e) { if (mine === seq) out.innerHTML = `<small class="err">${esc(e.message)}</small>`; }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
  if (focus) setTimeout(() => input.focus(), 0);
}

/* ---------- Upload tab ---------- */

function uploadTab() {
  const d = $('dash');
  const may = hasRole('BUYER', 'APPROVER');
  d.innerHTML = `
    <section class="panel up-pane">
      <div>
        <h2>Upload supplier quotes</h2>
        <span class="muted">For ${esc(SITE_NAME[site] || site)}. The hourly run reads them (9 am to 7 pm, Monday to Saturday) and their lines appear on Review for approval.</span>
      </div>
      ${may ? `
      <label class="drop" id="drop">
        <input type="file" id="upInput" multiple accept="${UPLOAD_ACCEPT}">
        <strong>Drop files here, or choose them</strong>
        <small>PDF, photos (JPG, PNG, WEBP), Excel or CSV, Word (.docx), text. Up to ${UPLOAD_MAX_MB} MB each.</small>
      </label>
      <div id="upQueue" class="up-queue"></div>
      <div class="up-field"><span class="up-label">Supplier <small>optional: the run reads it from the document if left empty</small></span><div id="upSupplier"></div></div>
      <label class="up-field"><span class="up-label">Note for the reader <small>optional</small></span>
        <textarea id="upNote" maxlength="1000" placeholder="For example: rates from 1 Dec, Ahmedabad only"></textarea></label>
      <div class="up-actions"><button class="primary" id="upGo" type="button">Upload</button><span class="muted" id="upHint"></span></div>`
    : '<p class="muted">Uploading needs the BUYER or APPROVER role. Ask an admin to add it.</p>'}
    </section>
    <section class="panel up-pane">
      <div class="up-actions"><strong>Recent uploads</strong><button class="ghost" id="upRefresh" type="button">Refresh</button></div>
      <div id="upList"><div class="skeleton"></div></div>
    </section>`;
  $('upRefresh').onclick = loadUploads;
  loadUploads();
  if (!may) return;

  const input = $('upInput');
  input.onchange = () => { addFiles(input.files); input.value = ''; };
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('upGo').onclick = sendAll;
  renderUpSupplier();
  renderQueue();
}

function addFiles(list) {
  for (const file of list || []) {
    if (upFiles.some((f) => f.state !== 'DONE' && f.file.name === file.name && f.file.size === file.size)) continue;
    const bad = !READABLE_FILE.test(file.name) ? 'The run cannot read this type of file.'
      : file.size > UPLOAD_MAX_MB * 1024 * 1024 ? `Over ${UPLOAD_MAX_MB} MB.` : null;
    upFiles.push({ file, state: bad ? 'FAILED' : 'READY', message: bad });
  }
  renderQueue();
}

const UP_STATE = {
  READY: ['', 'Ready'], SENDING: ['UNAPPROVED', 'Uploading…'], DONE: ['APPROVED', 'Uploaded'],
  DUPLICATE: ['', 'Already uploaded'], FAILED: ['REJECTED', 'Not uploaded'],
};
const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function renderQueue() {
  const box = $('upQueue');
  if (!box) return;
  box.innerHTML = upFiles.map((f, i) => `<div class="up-file">
      <div class="up-name"><strong>${esc(f.file.name)}</strong><small>${sizeText(f.file.size)}${f.message ? ` · ${esc(f.message)}` : ''}</small></div>
      <span class="chip ${UP_STATE[f.state][0]}">${UP_STATE[f.state][1]}</span>
      ${['READY', 'FAILED', 'DUPLICATE'].includes(f.state) && !upSending ? `<button type="button" class="ghost" data-drop="${i}" aria-label="Remove ${esc(f.file.name)}">✕</button>` : '<span></span>'}
    </div>`).join('');
  box.querySelectorAll('[data-drop]').forEach((b) => { b.onclick = () => { upFiles.splice(Number(b.dataset.drop), 1); renderQueue(); }; });
  const ready = upFiles.filter((f) => f.state === 'READY').length;
  $('upGo').disabled = upSending || !ready;
  $('upGo').textContent = ready > 1 ? `Upload ${ready} files` : 'Upload';
  $('upHint').textContent = upFiles.length ? '' : 'Choose one or more files first.';
}

function renderUpSupplier() {
  const box = $('upSupplier');
  if (!box) return;
  if (!upSupplier) {
    supplierPicker(box, { onPick: (s) => { upSupplier = s; renderUpSupplier(); }, focus: false });
    return;
  }
  box.innerHTML = `<div class="up-chosen"><span class="who-sup"><strong>${esc(upSupplier.name)}</strong>
      <small>${upSupplier.typed ? 'Not in the supplier list: the run checks it against the document' : (upSupplier.gstins?.length ? `GSTIN ${esc(upSupplier.gstins.join(', '))}` : 'No GSTIN on file')}</small></span>
      <button type="button" class="ghost" id="upSupClear">Change</button></div>`;
  $('upSupClear').onclick = () => { upSupplier = null; renderUpSupplier(); $('upSupplier').querySelector('input')?.focus(); };
}

async function sendOne(f, note) {
  const form = new FormData();
  form.append('file', f.file, f.file.name);
  form.append('plantScope', JSON.stringify([PLANT[site]]));
  if (upSupplier?.supplierGroupId) form.append('supplierGroupId', upSupplier.supplierGroupId);
  else if (upSupplier?.name) form.append('supplierName', upSupplier.name);
  if (note) form.append('note', note);
  const res = await fetch(`${API}/quotes/file`, {
    method: 'POST',
    headers: { 'X-SP-Site': site, ...(store.get('spToken') ? { Authorization: `Bearer ${store.get('spToken')}` } : {}) },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signedOut(); throw new Error('Please sign in again.'); }
  if (res.status === 409) return { state: 'DUPLICATE', message: 'This exact file was uploaded before.' };
  if (!res.ok) return { state: 'FAILED', message: data.error || `Upload failed (${res.status})` };
  return { state: 'DONE', message: null };
}

async function sendAll() {
  const ready = upFiles.filter((f) => f.state === 'READY');
  if (!ready.length || upSending) return;
  upSending = true;
  const note = $('upNote').value.trim();
  for (const f of ready) {
    f.state = 'SENDING'; f.message = null; renderQueue();
    try { Object.assign(f, await sendOne(f, note)); } catch (e) { f.state = 'FAILED'; f.message = e.message; }
    renderQueue();
  }
  upSending = false;
  const done = ready.filter((f) => f.state === 'DONE').length;
  if (done) {
    toast(`${done} file${done > 1 ? 's' : ''} uploaded. The next run reads ${done > 1 ? 'them' : 'it'}.`);
    upFiles = upFiles.filter((f) => f.state !== 'DONE');
    $('upNote').value = '';
    upSupplier = null; renderUpSupplier();
  }
  renderQueue();
  loadUploads();
}

let uploadsSeq = 0;
async function loadUploads() {
  const box = $('upList');
  if (!box) return;
  const mine = ++uploadsSeq;
  try {
    const { uploads } = await api('/proposals/uploads?limit=50');
    if (mine !== uploadsSeq || !$('upList')) return;
    renderUploads(uploads);
  } catch (e) { if (mine === uploadsSeq && $('upList')) $('upList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function uploadState(u) {
  if (u.state === 'READ') {
    const corrected = u.quote.supplier?.name && u.supplier?.name && u.quote.supplier.name !== u.supplier.name;
    return `<span class="chip APPROVED">Read</span> <small>${esc(u.quote.lineCount ?? 0)} line${u.quote.lineCount === 1 ? '' : 's'} · ${when(u.quote.readAt)}${corrected ? ` · as ${esc(u.quote.supplier.name)}` : ''}</small>`;
  }
  if (u.state === 'REJECTED') return '<span class="chip REJECTED">Rejected</span>';
  const hours = (Date.now() - new Date(u.uploadedAt)) / 36e5;
  return `<span class="chip UNAPPROVED">Waiting for the run</span>${hours > 3 ? '<small>Not read after 3 hours: the run may have failed on it. Tell whoever looks after the run.</small>' : ''}`;
}

function renderUploads(uploads) {
  const box = $('upList');
  if (!uploads.length) { box.innerHTML = '<div class="empty">Nothing uploaded here yet.</div>'; return; }
  box.innerHTML = `<div class="dt-wrap"><table class="dt up-table">
    <thead><tr><th>File</th><th class="wide">Supplier given</th><th>Uploaded</th><th>Status</th><th></th></tr></thead>
    <tbody>${uploads.map((u) => `<tr>
      <td style="word-break:break-word"><strong>${esc(u.fileName)}</strong>${u.note ? `<small>${esc(u.note)}</small>` : ''}</td>
      <td class="wide">${u.supplier ? `${esc(u.supplier.name)}${u.supplier.picked ? '' : '<small>typed</small>'}` : '<small>Read from the document</small>'}</td>
      <td>${when(u.uploadedAt)}<small>${esc(u.uploadedBy || '')}</small></td>
      <td>${uploadState(u)}</td>
      <td>${u.quote ? `<button type="button" data-open="${esc(u.quote._id)}">Open</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { showTab('review'); openQuote(b.dataset.open); }; });
}

/* ---------- Supplier correction, on a quote (APPROVER) ---------- */

/** The chip under a corrected quote's name: who changed it, when, and from what. */
function correctedChip(quote) {
  const c = quote.supplierCorrected;
  if (!c) return '';
  const was = c.previous?.name ? ` · was ${c.previous.name}` : '';
  return `<span class="chip" title="${esc(c.note || '')}">Supplier changed by ${esc(c.by)}, ${esc(when(c.at))}${esc(was)}</span>`;
}

async function openSupplierFix(quote) {
  const dlg = $('supDlg');
  let chosen = null;
  const body = $('supDlgBody');
  const now = `${quote.supplier?.name || 'Unknown supplier'}${quote.supplier?.gstin ? ` (GSTIN ${quote.supplier.gstin})` : ''}`;
  const draw = () => {
    body.innerHTML = `
      <h3>Change the supplier</h3>
      <p class="muted">Now: ${esc(now)}. Every line of this quote, and the dashboards, will show the new supplier. The run's reading is kept, and so is this change.</p>
      <div id="supPick"></div>
      ${chosen ? `
        <div class="up-field"><span class="up-label">GSTIN</span>
          ${chosen.gstins?.length > 1
    ? `<select id="supGstin">${chosen.gstins.map((g) => `<option${g === quote.supplier?.gstin ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`
    : chosen.typed ? '<input id="supGstin" maxlength="20" placeholder="Optional, 15 letters and digits" autocomplete="off">'
      : `<span>${esc(chosen.gstins?.[0] || 'None on file')}</span>`}
        </div>
        <label class="up-field"><span class="up-label">Why <small>optional</small></span><textarea id="supNote" maxlength="1000" placeholder="For example: the letterhead is the trader's, the mill quoted"></textarea></label>` : ''}
      <div id="supHist"></div>
      <div class="buttons"><button type="button" id="supCancel">Cancel</button><button type="button" class="primary" id="supSave"${chosen ? '' : ' disabled'}>Save</button></div>`;
    const pick = $('supPick');
    if (chosen) {
      pick.innerHTML = `<div class="up-chosen"><span class="who-sup"><strong>${esc(chosen.name)}</strong><small>${chosen.typed ? 'Not in the supplier list' : 'From the supplier list'}</small></span><button type="button" class="ghost" id="supChange">Change</button></div>`;
      $('supChange').onclick = () => { chosen = null; draw(); };
    } else {
      supplierPicker(pick, { onPick: (s) => { chosen = s; draw(); } });
    }
    $('supCancel').onclick = () => dlg.close();
    $('supSave').onclick = save;
    history();
  };
  const history = async () => {
    try {
      const { corrections } = await api(`/proposals/quotes/${quote._id}/supplier`);
      if (!corrections.length || !$('supHist')) return;
      $('supHist').innerHTML = `<details><summary class="muted">Earlier changes (${corrections.length})</summary>
        ${corrections.map((c) => `<small>${esc(when(c.createdAt))} · ${esc(c.by)}: ${esc(c.previous?.name || 'unknown')} → <strong>${esc(c.supplier.name)}</strong>${c.note ? ` · ${esc(c.note)}` : ''}</small>`).join('')}</details>`;
    } catch { /* history is a nicety */ }
  };
  const save = async () => {
    const btn = $('supSave');
    btn.disabled = true;
    try {
      const gstin = $('supGstin')?.value?.trim() || null;
      const { supplier } = await api(`/proposals/quotes/${quote._id}/supplier`, {
        method: 'POST',
        body: chosen.typed
          ? { name: chosen.name, gstin, note: $('supNote')?.value.trim() || null }
          : { supplierGroupId: chosen.supplierGroupId, gstin, note: $('supNote')?.value.trim() || null },
      });
      dlg.close();
      toast(`Supplier changed to ${supplier.name}`);
      suppliersCache = null; supplierData = null; itemData = null;
      await openQuote(String(quote._id), { keepScroll: true });
      loadQuotes();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
  draw();
  dlg.showModal();
}
