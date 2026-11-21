/**
 * The item and supplier dashboards on the review page (index.html). It uses
 * that page's helpers ($, esc, api, money, store, site, openQuote) and reads
 * /dashboard/* only: nothing here changes a quote or a decision.
 *
 * Charts are drawn as SVG at the width they are shown at, and drawn again
 * when the window is resized. Supplier colours follow the supplier (sorted by
 * name), never its rank, so a filter does not repaint the rest.
 */

let tab = ['review', 'item', 'supplier'].includes(store.get('spTab')) ? store.get('spTab') : 'review';
let dashItem = store.get('spDashItem');
let dashSupplier = store.get('spDashSupplier');
let redraw = null; // draws the charts on screen again, at the new width
let itemData = null;
let supplierData = null;
let suppliersCache = null;

const STATUS = {
  APPROVED: { label: 'Approved', colour: 'var(--ok)' },
  PENDING: { label: 'Pending', colour: 'var(--warn)' },
  UNMAPPED: { label: 'No item yet', colour: 'var(--s-other)' },
  REJECTED: { label: 'Rejected', colour: 'var(--bad)' },
};
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const perUnit = (v, uom) => (v == null ? '—' : `${money(v)}${uom ? `<small class="muted" style="display:inline">/${esc(uom)}</small>` : ''}`);
const asQuoted = (r) => esc(r.rateText || (r.rate != null ? `${r.rate}${r.uom ? ` / ${r.uom}` : ''}` : '—'));
const chip = (status) => `<span class="chip ${status}">${STATUS[status].label}</span>`;
const plain = (s) => String(s ?? '').replace(/<[^>]*>/g, '');

/** "▲ 12% above last paid", coloured: dearer is bad for a buyer. */
function gap(g, what) {
  if (g == null) return '';
  const dir = g > 0 ? 'up' : g < 0 ? 'down' : '';
  return `<span class="${dir}">${g > 0 ? '▲' : g < 0 ? '▼' : '='} ${Math.abs(g)}% ${g > 0 ? 'above' : g < 0 ? 'below' : 'same as'} ${what}</span>`;
}

/* ---------- Tabs ---------- */

function showTab(t) {
  tab = t; store.set('spTab', t);
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === t)));
  $('tabs').hidden = false;
  $('app').hidden = t !== 'review';
  $('dash').hidden = t === 'review';
  redraw = null;
  if (t === 'item') itemTab();
  if (t === 'supplier') supplierTab();
}
document.querySelectorAll('[data-tab]').forEach((b) => {
  b.onclick = () => { if (b.dataset.tab !== tab) { showTab(b.dataset.tab); window.scrollTo(0, 0); } };
});

/** Item IDs differ between the plants' databases; a supplier is the same supplier. */
function dashSiteChanged() {
  dashItem = null; store.set('spDashItem', null); itemData = null; supplierData = null; suppliersCache = null;
  if (tab !== 'review') showTab(tab);
}

/** Open a quote line on the Review tab, scrolled to and lit up. */
async function openLine(quoteId, lineId) {
  showTab('review');
  await openQuote(quoteId);
  lineFilter = 'ALL'; applyFilter();
  const el = $(`pick-${lineId}`)?.closest('.line');
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

/* ---------- Tooltip: hover on a desktop, tap on a phone ---------- */

function showTip(e, target) {
  const t = $('tip');
  t.innerHTML = target.dataset.tip; t.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 8);
  const y = e.clientY + 14 + t.offsetHeight > window.innerHeight ? e.clientY - t.offsetHeight - 10 : e.clientY + 14;
  t.style.left = `${Math.max(8, x)}px`; t.style.top = `${y}px`;
}
$('dash').addEventListener('pointermove', (e) => {
  const target = e.target.closest('[data-tip]');
  if (target) showTip(e, target); else $('tip').hidden = true;
});
$('dash').addEventListener('pointerleave', () => { $('tip').hidden = true; });
$('dash').addEventListener('click', (e) => { const target = e.target.closest('[data-tip]'); if (target) showTip(e, target); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw?.(), 150); });

/* ---------- Charts ---------- */

function niceTicks(lo, hi, n = 4) {
  const raw = (hi - lo) / n || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
const short = (v) => (v >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : String(Number(v.toFixed(2))));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Supplier → colour, by name, so a supplier keeps its colour in every chart. */
function supplierColours(rows) {
  const names = [...new Map(rows.map((r) => [r.supplier.key, r.supplier.name || r.supplier.key])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  return new Map(names.map(([k], i) => [k, i < 7 ? `var(--s${i + 1})` : 'var(--s-other)']));
}

/** Rates over time: one line per supplier, solid dots approved, hollow pending; dashed, what CDC paid. */
function timeChart(el, { series, paid, uom }) {
  const all = [...series.flatMap((s) => s.points), ...paid];
  if (!all.length) { el.innerHTML = '<div class="none">No rate on a common unit to plot yet.</div>'; return; }
  const W = Math.max(300, el.clientWidth); const H = 250;
  const m = { l: 52, r: 14, t: 12, b: 28 };
  const ts = all.map((p) => +new Date(p.date));
  let x0 = Math.min(...ts); let x1 = Math.max(...ts);
  if (x1 - x0 < 864e5 * 30) { x0 -= 864e5 * 15; x1 += 864e5 * 15; }
  const vs = all.map((p) => p.rate);
  const pad = (Math.max(...vs) - Math.min(...vs)) * 0.15 || Math.max(...vs) * 0.1 || 1;
  const y0 = Math.max(0, Math.min(...vs) - pad); const y1 = Math.max(...vs) + pad;
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const yt = niceTicks(y0, y1, 4);
  const months = Math.max(1, Math.min(6, Math.floor((W - m.l) / 90)));
  const xt = Array.from({ length: months + 1 }, (_, i) => x0 + ((x1 - x0) * i) / months);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Rates per ${esc(uom || 'unit')} over time">`;
  svg += yt.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">₹${short(v)}</text>`).join('');
  svg += xt.map((t, i) => `<text x="${X(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}">${new Date(t).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })}</text>`).join('');
  const line = (pts, attrs) => (pts.length > 1 ? `<polyline fill="none" ${attrs} points="${pts.map((p) => `${X(+new Date(p.date))},${Y(p.rate)}`).join(' ')}"/>` : '');
  const byDate = (a, b) => new Date(a.date) - new Date(b.date);
  const po = [...paid].sort(byDate);
  svg += line(po, 'stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".7"');
  svg += po.map((p) => `<circle cx="${X(+new Date(p.date))}" cy="${Y(p.rate)}" r="2.5" fill="var(--ink)" opacity=".7"/>`).join('');
  for (const s of series) svg += line([...s.points].sort(byDate), `stroke="${s.colour}" stroke-width="2" stroke-linejoin="round"`);
  for (const s of series) {
    for (const p of s.points) {
      const cx = X(+new Date(p.date)); const cy = Y(p.rate);
      svg += p.pending
        ? `<circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--panel)" stroke="${s.colour}" stroke-width="2"/>`
        : `<circle cx="${cx}" cy="${cy}" r="5" fill="${s.colour}" stroke="var(--panel)" stroke-width="2"/>`;
    }
  }
  // Hit targets bigger than the marks.
  for (const s of series) for (const p of s.points) svg += `<circle cx="${X(+new Date(p.date))}" cy="${Y(p.rate)}" r="12" fill="transparent" data-tip="${esc(p.tip)}"/>`;
  for (const p of po) svg += `<circle cx="${X(+new Date(p.date))}" cy="${Y(p.rate)}" r="10" fill="transparent" data-tip="${esc(p.tip)}"/>`;
  el.innerHTML = `${svg}</svg>`;
}

/** Horizontal bars from zero, labelled at the end; an optional dashed reference line. */
function barChart(el, { bars, ref = null, refLabel = '', format = (v) => String(v) }) {
  if (!bars.length) { el.innerHTML = '<div class="none">Nothing to show yet.</div>'; return; }
  const W = Math.max(300, el.clientWidth); const rowH = 30; const top = ref != null ? 20 : 4;
  const H = top + bars.length * rowH + 4;
  const labelW = Math.min(170, Math.round(W * 0.34)); const valueW = 92;
  const max = Math.max(...bars.map((b) => b.value), ref ?? 0) * 1.02 || 1;
  const X = (v) => labelW + (v / max) * (W - labelW - valueW);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
  // The reference line goes under the bars, so their labels stay readable.
  if (ref != null) {
    svg += `<line x1="${X(ref)}" x2="${X(ref)}" y1="${top - 4}" y2="${H}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".7"/>`;
    svg += `<text x="${X(ref)}" y="11" text-anchor="${X(ref) > W - 120 ? 'end' : 'middle'}" style="fill:var(--ink)">${esc(refLabel)}</text>`;
  }
  bars.forEach((b, i) => {
    const y = top + i * rowH;
    const w = Math.max(2, X(b.value) - labelW);
    svg += `<text x="${labelW - 8}" y="${y + 17}" text-anchor="end">${esc(clip(b.label, Math.floor(labelW / 6.5)))}</text>`;
    svg += `<path d="M${labelW},${y + 6} h${w - 4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${b.colour}"${b.faint ? ' opacity=".45"' : ''}/>`;
    svg += `<text x="${labelW + w + 6}" y="${y + 17}" style="fill:var(--ink)">${esc(format(b.value))}${b.note ? `<tspan style="fill:var(--muted)"> ${esc(b.note)}</tspan>` : ''}</text>`;
    svg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent" data-tip="${esc(b.tip || `${b.label}: ${format(b.value)}`)}"/>`;
  });
  el.innerHTML = `${svg}</svg>`;
}

/** Columns over time, one series. */
function columnChart(el, { cols, colour = 'var(--s1)' }) {
  const W = Math.max(300, el.clientWidth); const H = 190; const m = { l: 28, r: 8, t: 16, b: 24 };
  const max = Math.max(1, ...cols.map((c) => c.value));
  const yt = niceTicks(0, max, Math.min(4, max));
  const slot = (W - m.l - m.r) / cols.length; const bw = Math.max(4, Math.min(28, slot - 6));
  const Y = (v) => m.t + (1 - v / yt.at(-1)) * (H - m.t - m.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
  svg += yt.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const every = Math.ceil(cols.length / Math.floor((W - m.l) / 44));
  cols.forEach((c, i) => {
    const x = m.l + i * slot + (slot - bw) / 2; const h = Y(0) - Y(c.value);
    if (c.value) svg += `<path d="M${x},${Y(0)} v${-(h - 4)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${h - 4} z" fill="${colour}"/><text x="${x + bw / 2}" y="${Y(c.value) - 4}" text-anchor="middle" style="fill:var(--ink)">${c.value}</text>`;
    if (i % every === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(c.label)}</text>`;
    svg += `<rect x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${H - m.t - m.b}" fill="transparent" data-tip="${esc(c.tip)}"/>`;
  });
  el.innerHTML = `${svg}</svg>`;
}

/** A donut of parts of a whole, with a 2px gap between segments and the total inside. */
function donut(el, parts) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) { el.innerHTML = '<div class="none">No lines yet.</div>'; return; }
  const S = 170; const r = 64; const c = 2 * Math.PI * r;
  let at = 0;
  let svg = `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" style="width:${S}px;flex:none"><g transform="rotate(-90 ${S / 2} ${S / 2})">`;
  for (const p of parts.filter((x) => x.value)) {
    const len = (p.value / total) * c;
    svg += `<circle cx="${S / 2}" cy="${S / 2}" r="${r}" fill="none" stroke="${p.colour}" stroke-width="22" stroke-dasharray="${Math.max(0, len - 2)} ${c}" stroke-dashoffset="${-at}" data-tip="${esc(`${p.label}: ${p.value} (${Math.round((p.value / total) * 100)}%)`)}"/>`;
    at += len;
  }
  svg += `</g><text x="${S / 2}" y="${S / 2}" text-anchor="middle" style="fill:var(--ink);font-size:22px;font-weight:650">${total}</text><text x="${S / 2}" y="${S / 2 + 18}" text-anchor="middle">lines</text></svg>`;
  const legend = parts.map((p) => `<div><i style="background:${p.colour}"></i>${esc(p.label)} <strong style="color:var(--ink)">${p.value}</strong> <span>${Math.round((p.value / total) * 100)}%</span></div>`).join('');
  el.innerHTML = `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">${svg}<div class="legend" style="display:grid;gap:6px">${legend}</div></div>`;
}

/* ---------- Search boxes ---------- */

function searchBox(host, { label, placeholder, value = '', onInput }) {
  host.innerHTML = `<div class="panel dash-search"><label for="dashQ" style="font-weight:600">${esc(label)}</label>
    <input type="search" id="dashQ" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off"><div class="dash-hits" id="dashHits"></div></div>
    <div id="dashBody" style="display:grid;gap:16px"></div>`;
  let timer = null; let seq = 0;
  $('dashQ').oninput = () => {
    clearTimeout(timer);
    const mine = ++seq;
    timer = setTimeout(() => onInput($('dashQ').value.trim(), () => mine === seq), 250);
  };
}

/* ---------- Item dashboard ---------- */

function itemTab() {
  searchBox($('dash'), {
    label: 'Find an Indus item', placeholder: 'Item name, code or ID',
    onInput: async (q, current) => {
      if (q.length < 2) { $('dashHits').innerHTML = ''; return; }
      try {
        const { results } = await api(`/items/search?q=${encodeURIComponent(q)}&limit=20`);
        if (!current()) return;
        $('dashHits').innerHTML = results.length ? results.map((it) => `<button class="ghost" data-item="${esc(it.ItemID)}"><span><strong>${esc(it.ItemID)}</strong> ${esc(it.ItemName)}
          <small>${[it.ItemGroupName, it.GSM && `${it.GSM} GSM`, it.Manufecturer].filter(Boolean).map(esc).join(' · ')}</small></span></button>`).join('')
          : '<span class="muted">No Indus item matches.</span>';
        $('dashHits').querySelectorAll('[data-item]').forEach((b) => { b.onclick = () => { $('dashHits').innerHTML = ''; $('dashQ').value = ''; loadItem(b.dataset.item); }; });
      } catch (e) { if (current()) $('dashHits').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    },
  });
  if (dashItem) loadItem(dashItem);
  else $('dashBody').innerHTML = '<div class="panel empty">Search an Indus item to see every supplier quote for it, approved and pending.</div>';
}

let itemSeq = 0;
async function loadItem(id) {
  dashItem = String(id); store.set('spDashItem', dashItem);
  if (itemData?.item?.itemId === Number(id)) return renderItem(itemData);
  const mine = ++itemSeq;
  $('dashBody').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const data = await api(`/dashboard/item/${encodeURIComponent(id)}`);
    if (mine === itemSeq && tab === 'item') renderItem(itemData = data);
  } catch (e) { if (mine === itemSeq && tab === 'item') $('dashBody').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; }
}

const itemFilter = { status: 'LIVE', rejected: false };

function renderItem(d) {
  const { item, summary: s, rows, poHistory } = d;
  const u = s.uom;
  const size = item.sizeW ? `${item.sizeW}${item.sizeL ? ` × ${item.sizeL}` : ''}` : null;
  const facts = [`ID ${item.itemId}`, item.itemCode && `Code ${item.itemCode}`, item.group, item.quality, item.gsm && `${item.gsm} GSM`, size, item.mill, item.unit && `Stock unit ${item.unit}`].filter(Boolean);
  const paid = s.lastPaid;
  const kpi = (k, v, sub = '') => `<div class="panel kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('dashBody').innerHTML = `
    <div class="panel dash-title"><h2>${esc(item.itemName)}</h2><div class="meta">${facts.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></div>
    <div class="kpis">
      ${kpi('Best approved rate', s.best ? perUnit(s.best.rate, u) : '—', s.best ? `${esc(s.best.supplier)}<br>${gap(s.bestVsPaid, 'last paid')}` : 'No approved quote yet')}
      ${kpi('Best pending quote', s.bestPending ? perUnit(s.bestPending.rate, u) : '—', s.bestPending ? `${esc(s.bestPending.supplier)} · not yet approved<br>${gap(s.bestPendingVsPaid, 'last paid')}` : 'None waiting')}
      ${kpi('Last paid on a PO', paid ? perUnit(paid.rate, paid.uom) : '—', paid ? `${esc(paid.supplierName || '')}<br>${day(paid.date)} · ${esc(paid.voucherNo || '')}` : 'No PO in Indus')}
      ${kpi('Suppliers quoting', s.suppliers.total, `${s.suppliers.approved} approved · ${s.suppliers.pending} pending`)}
      ${kpi('Lines waiting', s.pending, s.pending ? 'for a decision on the Review tab' : 'Nothing waiting')}
      ${kpi('Fastest delivery', s.fastest ? (s.fastest.days === 0 ? 'Ready stock' : `${s.fastest.days} day${s.fastest.days === 1 ? '' : 's'}`) : '—', s.fastest ? esc(s.fastest.supplier) : 'No approved quote states one')}
      ${kpi('Spread', s.spread != null ? `${s.spread}%` : '—', s.spread != null ? 'cheapest to dearest approved' : 'Needs two approved quotes')}
    </div>
    <div class="charts">
      <div class="panel chart"><h3>Rates over time</h3><div class="sub">₹ per ${esc(u || 'unit')}, by date received</div><div id="chTime"></div><div class="legend" id="lgTime"></div></div>
      <div class="panel chart"><h3>Latest rate by supplier</h3><div class="sub">₹ per ${esc(u || 'unit')}, cheapest first, with delivery days</div><div id="chBars"></div><div class="legend" id="lgBars"></div></div>
    </div>
    <div class="panel dash-table">
      <div class="head"><h3>Every quote line for this item</h3>
        <div class="seg" role="group" aria-label="Show">${[['LIVE', 'Approved and pending'], ['APPROVED', 'Approved'], ['PENDING', 'Pending']].map(([k, l]) => `<button type="button" data-ist="${k}" aria-pressed="${itemFilter.status === k}">${l}</button>`).join('')}</div>
        <label class="muted"><input type="checkbox" id="showRej"${itemFilter.rejected ? ' checked' : ''}> Show rejected</label>
      </div>
      <div class="dt-wrap"><table class="dt"><thead><tr>
        <th>Supplier</th><th>Quoted as</th><th class="num">Rate as quoted</th><th class="num">₹ per unit</th><th>Status</th>
        <th>Received</th><th>Delivery</th><th class="wide">Credit</th><th class="wide">Freight · GST</th><th class="wide">Decision</th><th></th>
      </tr></thead><tbody id="itemRows"></tbody></table></div>
    </div>`;

  const priced = rows.filter((r) => (r.status === 'APPROVED' || r.status === 'PENDING') && r.comparable != null && r.uom === u);
  const colours = supplierColours(priced);
  const series = [...colours.keys()].map((key) => ({
    colour: colours.get(key),
    points: priced.filter((r) => r.supplier.key === key).map((r) => ({
      date: r.receivedAt, rate: r.comparable, pending: r.status === 'PENDING',
      tip: `<strong>${esc(r.supplier.name)}</strong><br>${money(r.comparable)}/${esc(u)} · ${r.status === 'PENDING' ? 'pending' : 'approved'}<br>${day(r.receivedAt)}${r.quote?.delivery ? ` · ${esc(r.quote.delivery)}` : ''}`,
    })),
  }));
  const paidPts = poHistory.map((h) => ({ date: h.date, rate: h.rate, tip: `<strong>PO ${esc(h.voucherNo || '')}</strong><br>${money(h.rate)}/${esc(h.uom)} paid${h.uomAsPaid && h.uomAsPaid.toUpperCase() !== h.uom ? ` (₹${h.rateAsPaid}/${esc(h.uomAsPaid)})` : ''}<br>${esc(h.supplierName || '')} · ${day(h.date)}` }));
  const names = new Map(priced.map((r) => [r.supplier.key, r.supplier.name]));
  const supplierLegend = [...colours.entries()].map(([k, c]) => `<span><i style="background:${c}"></i>${esc(names.get(k))}</span>`).join('');
  $('lgTime').innerHTML = `${supplierLegend}<span><i style="background:var(--muted)"></i>Approved</span><span><i class="hollow"></i>Pending</span>${paidPts.length ? '<span><i class="dash"></i>Paid on POs</span>' : ''}`;

  const latest = latestEach(priced).sort((a, b) => a.comparable - b.comparable);
  const bars = latest.map((r) => ({
    label: r.supplier.name || r.supplier.key, value: r.comparable, colour: colours.get(r.supplier.key), faint: r.status === 'PENDING',
    note: [r.quote?.deliveryDays != null && (r.quote.deliveryDays === 0 ? 'stock' : `${r.quote.deliveryDays}d`), r.status === 'PENDING' && 'pending'].filter(Boolean).join(' · '),
    tip: `<strong>${esc(r.supplier.name)}</strong><br>${money(r.comparable)}/${esc(u)} · ${r.status === 'PENDING' ? 'pending' : 'approved'}<br>${day(r.receivedAt)}${r.quote?.delivery ? `<br>Delivery: ${esc(r.quote.delivery)}` : ''}`,
  }));
  const ref = paid && paid.uom === u ? paid.rate : null;
  $('lgBars').innerHTML = latest.length ? `<span><i style="background:var(--muted)"></i>Approved</span><span><i style="background:var(--muted);opacity:.45"></i>Pending</span>${ref != null ? '<span><i class="dash"></i>Last paid</span>' : ''}` : '';

  redraw = () => {
    timeChart($('chTime'), { series, paid: paidPts, uom: u });
    barChart($('chBars'), { bars, ref, refLabel: ref != null ? `Last paid ${plain(money(ref))}` : '', format: (v) => plain(money(v)) });
  };
  redraw();

  const drawRows = () => {
    const shown = rows.filter((r) => (r.status === 'REJECTED' ? itemFilter.rejected
      : itemFilter.status === 'LIVE' ? true : r.status === itemFilter.status));
    $('itemRows').innerHTML = shown.map((r) => `<tr class="${r.status === 'REJECTED' ? 'rej' : ''}">
      <td><strong>${esc(r.supplier.name || '—')}</strong>${r.supplier.gstin ? `<small>${esc(r.supplier.gstin)}</small>` : ''}</td>
      <td>${esc(r.productName)}${r.via === 'BAND' ? `<small>Through the band: ${esc(r.band)}</small>` : ''}</td>
      <td class="num">${asQuoted(r)}</td>
      <td class="num">${perUnit(r.comparable, r.uom)}${r.comparable != null && ref != null && r.uom === u ? `<small>${gap(Math.round(((r.comparable - ref) / ref) * 1000) / 10, 'paid')}</small>` : ''}</td>
      <td>${chip(r.status)}</td>
      <td>${day(r.receivedAt)}${r.quote?.effectiveFrom ? `<small>Effective ${esc(r.quote.effectiveFrom)}</small>` : ''}</td>
      <td>${esc(r.quote?.delivery || '—')}</td>
      <td class="wide">${esc(r.quote?.credit || '—')}</td>
      <td class="wide">${esc([r.quote?.freight, r.quote?.gst].filter(Boolean).join(' · ') || '—')}</td>
      <td class="wide">${r.decidedBy ? `${esc(r.decidedBy)}<small>${day(r.decidedAt)}${r.note ? ` · ${esc(r.note)}` : ''}</small>` : '—'}</td>
      <td><button class="link" data-open="${esc(r.quoteId)}" data-line="${esc(r.id)}">Open</button></td>
    </tr>`).join('') || `<tr><td colspan="11" class="muted">${rows.length ? 'No line matches this filter.' : 'No supplier quote is mapped to this item yet.'}</td></tr>`;
    $('itemRows').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openLine(b.dataset.open, b.dataset.line); });
  };
  drawRows();
  document.querySelectorAll('[data-ist]').forEach((b) => {
    b.onclick = () => { itemFilter.status = b.dataset.ist; document.querySelectorAll('[data-ist]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawRows(); };
  });
  $('showRej').onchange = () => { itemFilter.rejected = $('showRej').checked; drawRows(); };
}

/** Each supplier's newest line, approved before pending. */
function latestEach(rows) {
  const latest = new Map();
  const order = (a, b) => ((a.status === 'APPROVED' ? 0 : 1) - (b.status === 'APPROVED' ? 0 : 1)) || (new Date(b.receivedAt) - new Date(a.receivedAt));
  for (const r of [...rows].sort(order)) if (!latest.has(r.supplier.key)) latest.set(r.supplier.key, r);
  return [...latest.values()];
}

/* ---------- Supplier dashboard ---------- */

async function supplierTab() {
  searchBox($('dash'), {
    label: 'Find a supplier', placeholder: 'Supplier name or GSTIN',
    onInput: (q) => listSuppliers(q),
  });
  if (dashSupplier) { $('dashHits').innerHTML = ''; loadSupplier(dashSupplier); }
  else { $('dashBody').innerHTML = ''; listSuppliers(''); }
}

async function listSuppliers(q) {
  try {
    if (!suppliersCache) ({ suppliers: suppliersCache } = await api('/dashboard/suppliers?limit=200'));
    const needle = q.toUpperCase();
    const shown = suppliersCache.filter((s) => !needle || `${s.name || ''} ${s.gstin || ''}`.toUpperCase().includes(needle));
    $('dashHits').innerHTML = shown.length ? shown.map((s) => `<button class="ghost" data-sup="${esc(s.key)}"><span><strong>${esc(s.name || s.key)}</strong>
      <small>${[s.gstin, `${s.quotes} quote${s.quotes === 1 ? '' : 's'}`, `${s.lines} lines`, s.pending && `${s.pending} waiting`, `last ${day(s.lastAt)}`].filter(Boolean).map(esc).join(' · ')}</small></span></button>`).join('')
      : `<span class="muted">${suppliersCache.length ? 'No supplier matches.' : 'No supplier quote at this site yet.'}</span>`;
    $('dashHits').querySelectorAll('[data-sup]').forEach((b) => { b.onclick = () => { $('dashHits').innerHTML = ''; $('dashQ').value = ''; loadSupplier(b.dataset.sup); }; });
  } catch (e) { $('dashHits').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function loadSupplier(key) {
  dashSupplier = key; store.set('spDashSupplier', key);
  if (supplierData?.supplier?.key === key) return renderSupplier(supplierData);
  $('dashBody').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const data = await api(`/dashboard/supplier/${encodeURIComponent(key)}`);
    if (tab === 'supplier' && dashSupplier === key) renderSupplier(supplierData = data);
  } catch (e) {
    if (tab !== 'supplier' || dashSupplier !== key) return;
    dashSupplier = null; store.set('spDashSupplier', null);
    $('dashBody').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
    listSuppliers('');
  }
}

const supplierFilter = { status: 'ALL', q: '' };

function renderSupplier(d) {
  const { supplier, summary: s, rows } = d;
  const kpi = (k, v, sub = '') => `<div class="panel kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  // Approved lines when there are any; until then the pending ones, said so.
  const [g, n, which] = s.vsPaidLines ? [s.vsPaid, s.vsPaidLines, 'approved'] : [s.vsPaidPending, s.vsPaidPendingLines, 'pending'];
  const vsPaid = n ? `<span class="${g > 0 ? 'up' : g < 0 ? 'down' : ''}">${g > 0 ? '▲' : g < 0 ? '▼' : ''} ${Math.abs(g)}%</span>` : '—';
  const vsPaidSub = n ? `${g > 0 ? 'above' : g < 0 ? 'below' : 'same as'} CDC's last PO rate, on average over ${n} ${which} line${n === 1 ? '' : 's'}` : 'No line to compare yet';
  $('dashBody').innerHTML = `
    <div class="panel dash-title"><div class="title-row"><h2>${esc(supplier.name || supplier.key)}</h2><button class="ghost" id="otherSup">Another supplier</button></div>
      <div class="meta">${supplier.gstin ? `<span class="chip">GSTIN ${esc(supplier.gstin)}</span>` : ''}<span class="chip">Last quote ${day(s.lastQuoteAt)}</span></div></div>
    <div class="kpis">
      ${kpi('Quotes received', s.quotes, `${s.lines} lines in all`)}
      ${kpi('Lines approved', s.status.APPROVED, `${s.status.PENDING} pending · ${s.status.UNMAPPED} no item yet · ${s.status.REJECTED} rejected`)}
      ${kpi('Items covered', s.items, 'approved or pending')}
      ${kpi('Cheapest on', s.cheapest.compared ? `${s.cheapest.count} of ${s.cheapest.compared}` : '—', s.cheapest.compared ? 'approved items others also quote' : 'No approved item others quote yet')}
      ${kpi('Rates against last paid', vsPaid, vsPaidSub)}
      ${kpi('Delivery', s.avgDeliveryDays != null ? `${s.avgDeliveryDays} days` : '—', s.avgDeliveryDays != null ? 'average promised' : 'Not stated on the quotes')}
      ${kpi('Usual credit', s.credit ? esc(s.credit) : '—', s.credit ? 'most quotes' : 'Not stated')}
    </div>
    <div class="charts">
      <div class="panel chart"><h3>Lines by status</h3><div id="chStatus"></div></div>
      <div class="panel chart"><h3>Rank against other suppliers</h3><div class="sub">Approved lines, by where the rate stands among other suppliers' approved rates</div><div id="chRank"></div></div>
      <div class="panel chart"><h3>Quotes per month</h3><div class="sub">Last 12 months, by date received</div><div id="chMonths"></div></div>
    </div>
    <div class="panel dash-table">
      <div class="head"><h3>Every line quoted</h3>
        <input type="search" id="supQ" placeholder="Filter by item or wording" value="${esc(supplierFilter.q)}" style="min-width:200px">
        <div class="seg" role="group" aria-label="Show">${[['ALL', 'All'], ['APPROVED', 'Approved'], ['PENDING', 'Pending'], ['UNMAPPED', 'No item'], ['REJECTED', 'Rejected']].map(([k, l]) => `<button type="button" data-sst="${k}" aria-pressed="${supplierFilter.status === k}">${l}</button>`).join('')}</div>
      </div>
      <div class="dt-wrap"><table class="dt"><thead><tr>
        <th>Indus item</th><th>Quoted as</th><th class="num">Rate as quoted</th><th class="num">₹ per unit</th><th>Rank</th>
        <th class="num">Against the others</th><th class="num">Last paid</th><th>Status</th><th>Received</th><th class="wide">Delivery</th><th></th>
      </tr></thead><tbody id="supRows"></tbody></table></div>
    </div>`;
  $('otherSup').onclick = () => { dashSupplier = null; store.set('spDashSupplier', null); $('dashBody').innerHTML = ''; $('dashQ').focus(); listSuppliers(''); };

  const ranked = [['first', 'Cheapest'], ['second', '2nd cheapest'], ['third', '3rd or dearer'], ['alone', 'Only quote']];
  const anyRank = ranked.some(([k]) => s.ranks[k]);
  redraw = () => {
    donut($('chStatus'), ['APPROVED', 'PENDING', 'UNMAPPED', 'REJECTED'].map((k) => ({ label: STATUS[k].label, value: s.status[k], colour: STATUS[k].colour })));
    if (anyRank) barChart($('chRank'), { bars: ranked.map(([k, l]) => ({ label: l, value: s.ranks[k], colour: 'var(--s1)', tip: `${l}: ${s.ranks[k]} line${s.ranks[k] === 1 ? '' : 's'}` })) });
    else $('chRank').innerHTML = '<div class="none">No approved line to rank yet.</div>';
    columnChart($('chMonths'), {
      cols: s.byMonth.map((m) => {
        const label = new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
        return { label, value: m.quotes, tip: `${label} ${m.month.slice(0, 4)}: ${m.quotes} quote${m.quotes === 1 ? '' : 's'}` };
      }),
    });
  };
  redraw();

  const drawRows = () => {
    const q = supplierFilter.q.toLowerCase();
    const shown = rows.filter((r) => (supplierFilter.status === 'ALL' || r.status === supplierFilter.status)
      && (!q || `${r.itemId || ''} ${r.itemName || ''} ${r.band || ''} ${r.productName}`.toLowerCase().includes(q)));
    $('supRows').innerHTML = shown.map((r) => {
      const what = r.itemId ? `<button class="link" data-item="${esc(r.itemId)}" style="text-align:left;white-space:normal">${esc(r.itemId)} ${esc(r.itemName || '')}</button>`
        : r.band ? `Band: ${esc(r.band)}` : '<span class="muted">No item yet</span>';
      const rank = r.rank ? (r.rank.of === 1 ? 'Only quote' : `${r.rank.rank} of ${r.rank.of}`) : '—';
      return `<tr class="${r.status === 'REJECTED' ? 'rej' : ''}">
        <td>${what}</td>
        <td>${esc(r.productName)}</td>
        <td class="num">${asQuoted(r)}</td>
        <td class="num">${perUnit(r.comparable, r.uom)}</td>
        <td>${rank}${r.rank && r.status === 'PENDING' ? '<small>if approved</small>' : ''}</td>
        <td class="num">${r.rank?.gapToCheapest != null ? gap(r.rank.gapToCheapest, r.rank.rank === 1 ? 'next cheapest' : 'cheapest') : '—'}</td>
        <td class="num">${r.lastPaid ? `${perUnit(r.lastPaid.rate, r.lastPaid.uom)}<small>${gap(r.paidGap, 'paid')}</small>` : '—'}</td>
        <td>${chip(r.status)}</td>
        <td>${day(r.receivedAt)}</td>
        <td class="wide">${esc(r.quote?.delivery || '—')}</td>
        <td><button class="link" data-open="${esc(r.quoteId)}" data-line="${esc(r.id)}">Open</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="11" class="muted">No line matches this filter.</td></tr>';
    $('supRows').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openLine(b.dataset.open, b.dataset.line); });
    $('supRows').querySelectorAll('[data-item]').forEach((b) => {
      b.onclick = () => { dashItem = b.dataset.item; store.set('spDashItem', dashItem); showTab('item'); window.scrollTo(0, 0); };
    });
  };
  drawRows();
  document.querySelectorAll('[data-sst]').forEach((b) => {
    b.onclick = () => { supplierFilter.status = b.dataset.sst; document.querySelectorAll('[data-sst]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawRows(); };
  });
  $('supQ').oninput = () => { supplierFilter.q = $('supQ').value.trim(); drawRows(); };
}
