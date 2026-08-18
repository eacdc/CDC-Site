// ============================================================================
//  OVER-BILLING ATTRIBUTION  —  READ ONLY
//
//  fix-pending-qty.js er Section C bolechhe koto ta beshi bill hoyeche.
//  Ei script bole KE korechhe — kon bill gulo dayi.
//
//  Duto poddhoti:
//    1) Protita live bill er jonno hisheb: oi bill ta bad dile koto ta excess
//       kome jay. Je bill er number sobcheye upore, seta i prodhan sondehovajon.
//    2) HUBAHU DUPLICATE line: ekei (job, operation, rate, qty) ekadhik live
//       bill e ache — eta duplicate billing er sobcheye sposhto proman.
//
//  Niyom: delete na kora bill i final truth. Packaging segment e job qty er
//  5% porjonto overshoot boidho, tai oi tuku bad diye hisheb kora hoy.
//
//  ⚠  EI SCRIPT KICHUI CHANGE KORE NA.
//
//  Chalanor niyom:
//    mongosh "<URI>" --file scripts/analyse-overbilling.js > overbilling.txt
// ============================================================================

// ---------------------------------------------------------------- settings --
const DB_NAME    = 'Contractor_PO';
const JOB_FILTER = '';    // ekta job dekhte: 'J07542_25_26'.  '' = sob
const TOL        = 0.5;
const SHOW_BILLS = 30;    // koto ta bill ranking e dekhabe
const SHOW_ROWS  = 60;    // duplicate list e koto ta line dekhabe
const PACKAGING_ALLOWANCE_PCT = 5;
const CSV        = false; // true = duplicate line gulo CSV te
// ----------------------------------------------------------------------------

const d = db.getSiblingDB(DB_NAME);

const r2   = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s == null ? '' : s).trim();
const dstr = v => (v ? new Date(v).toISOString().slice(0, 10) : '-');

const out = [];
const say = l => out.push(l);

// -------------------------------------------------- 1. operation naam map ---
const opById = {};
d.getCollection('operations').find({}, { opsName: 1 }).forEach(o => {
  opById[String(o._id)] = norm(o.opsName);
});

// ------------------------------------- 2. JobopsMaster: total + allowance ---
// key: job|opsName|rate  ->  { total, segment, allowance }
const opTotals = {};
d.getCollection('JobopsMaster').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).forEach(j => {
  const jid = norm(j.jobId);
  const segment = norm(j.segmentName);
  const jobQty = Number(j.totalQty || 0);
  (j.ops || []).forEach(o => {
    const total = Number(o.totalOpsQty || 0);
    const basis = jobQty > 0 ? jobQty : total;
    const k = [jid, opById[norm(o.opId)] || '(op doc nei)', r2(o.valuePerBook)].join('|');
    // Ekei key te ekadhik op thakle boro total tai rakha hoy (nirapod dik)
    if (!opTotals[k] || total > opTotals[k].total) {
      opTotals[k] = {
        total: total,
        segment: segment,
        allowance: segment === 'Packaging' ? Math.round(basis * PACKAGING_ALLOWANCE_PCT / 100) : 0
      };
    }
  });
});

// ------------------------------------------- 3. live bill er line gulo tola --
// key -> [{ billNumber, contractor, qty, value, date, paid }]
const lines = {};
const billInfo = {};
let liveBills = 0;

d.getCollection('Bills').find({}).forEach(b => {
  if (Number(b.isDeleted || 0) === 1) return;
  liveBills++;
  const bn = norm(b.billNumber);
  billInfo[bn] = {
    billNumber: bn,
    contractor: norm(b.contractorName),
    date: dstr(b.createdAt),
    paid: norm(b.paymentStatus) === 'Yes',
    lines: 0,
    value: 0
  };

  (b.jobs || []).forEach(j => {
    if (j.isAdhoc) return;
    const jn = norm(j.jobNumber);
    if (JOB_FILTER && jn !== JOB_FILTER) return;
    (j.ops || []).forEach(op => {
      const k = [jn, norm(op.opsName), r2(op.rate)].join('|');
      if (!lines[k]) lines[k] = [];
      const qty = Number(op.qtyCompleted || 0);
      const val = Number(op.totalValue || 0);
      lines[k].push({
        billNumber: bn,
        contractor: norm(b.contractorName),
        qty: qty,
        value: val,
        rate: r2(op.rate),
        date: billInfo[bn].date,
        paid: billInfo[bn].paid
      });
      billInfo[bn].lines++;
      billInfo[bn].value = r2(billInfo[bn].value + val);
    });
  });
});

// ------------------------------ 4. kon op e koto excess, ar ke koto dayi ----
const overBilled = [];
const billBlame = {};   // billNumber -> { excessQty, excessValue, ops }

Object.keys(lines).forEach(k => {
  const info = opTotals[k];
  if (!info) return;                       // JobopsMaster e nei — bad
  const parts = k.split('|');
  const billed = lines[k].reduce((s, x) => s + x.qty, 0);
  const allowedMax = info.total + info.allowance;
  const excess = r2(billed - allowedMax);
  if (excess <= TOL) return;

  const rate = Number(parts[2]) || 0;
  const rec = {
    jobId: parts[0],
    opsName: parts[1],
    rate: rate,
    segment: info.segment || '-',
    total: info.total,
    allowance: info.allowance,
    billed: billed,
    excess: excess,
    excessPct: info.total > 0 ? r2(excess / info.total * 100) : 0,
    excessValue: r2(excess * rate),
    entries: lines[k].slice().sort((a, b) => b.qty - a.qty)
  };
  overBilled.push(rec);

  // Kon bill ta bad dile koto ta excess kome — oi bill er "blame"
  rec.entries.forEach(e => {
    const removes = Math.min(e.qty, excess);
    if (removes <= TOL) return;
    if (!billBlame[e.billNumber]) billBlame[e.billNumber] = { excessQty: 0, excessValue: 0, ops: 0, fixes: 0 };
    billBlame[e.billNumber].excessQty += removes;
    billBlame[e.billNumber].excessValue = r2(billBlame[e.billNumber].excessValue + removes * rate);
    billBlame[e.billNumber].ops++;
    if (e.qty >= excess - TOL) billBlame[e.billNumber].fixes++;   // eka i puro excess mitiye dey
  });
});

// ------------------------------------------------ 5. hubahu duplicate line --
// ekei job + operation + rate + qty, ekadhik live bill e
const duplicates = [];
Object.keys(lines).forEach(k => {
  const byQty = {};
  lines[k].forEach(e => {
    const kk = e.contractor + '|' + e.qty;
    if (!byQty[kk]) byQty[kk] = [];
    byQty[kk].push(e);
  });
  Object.keys(byQty).forEach(kk => {
    const grp = byQty[kk].slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (grp.length < 2) return;
    const parts = k.split('|');
    duplicates.push({
      jobId: parts[0],
      opsName: parts[1],
      rate: Number(parts[2]) || 0,
      contractor: grp[0].contractor,
      qty: grp[0].qty,
      times: grp.length,
      // Date onujayi sajano — prothom ta i mul, porer gulo duplicate hoar sombhabona beshi
      bills: grp.map((g, i) => g.billNumber + ' ' + g.date + (g.paid ? '(PAID)' : '') +
                               (i === 0 ? ' <- age' : '')).join('   |   '),
      extraValue: r2(grp[0].value * (grp.length - 1))
    });
  });
});

// ------------------------------------------------------------------ output --
if (CSV) {
  say('job,operation,rate,contractor,qty,timesBilled,bills,extraValue');
  duplicates.sort((a, b) => b.extraValue - a.extraValue).forEach(r => {
    const esc = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, "'") + '"' : s;
    };
    say([r.jobId, r.opsName, r.rate, r.contractor, r.qty, r.times, r.bills, r.extraValue].map(esc).join(','));
  });
} else {
  const totalExcessValue = r2(overBilled.reduce((s, r) => s + r.excessValue, 0));
  const totalDupValue = r2(duplicates.reduce((s, r) => s + r.extraValue, 0));

  say('');
  say('='.repeat(120));
  say('  OVER-BILLING ATTRIBUTION   db: ' + DB_NAME + (JOB_FILTER ? '   job: ' + JOB_FILTER : '   (sob job)'));
  say('='.repeat(120));
  say('  live (delete na kora) bill      : ' + liveBills);
  say('  over-billed operation           : ' + overBilled.length +
      '   (Packaging allowance bad diye)');
  say('  mot excess value                : ' + totalExcessValue);
  say('  hubahu duplicate line           : ' + duplicates.length + '   extra value ' + totalDupValue);

  // --- ranking
  const ranked = Object.keys(billBlame).map(bn => ({
    billNumber: bn,
    contractor: (billInfo[bn] || {}).contractor || '?',
    date: (billInfo[bn] || {}).date || '-',
    paid: (billInfo[bn] || {}).paid,
    billValue: (billInfo[bn] || {}).value || 0,
    billLines: (billInfo[bn] || {}).lines || 0,
    ops: billBlame[bn].ops,
    fixes: billBlame[bn].fixes,
    excessQty: r2(billBlame[bn].excessQty),
    excessValue: billBlame[bn].excessValue
  })).sort((a, b) => b.excessValue - a.excessValue);

  say('');
  say('-'.repeat(120));
  say('1)  KON BILL KOTO TA DAYI  —  oi bill ta bad dile koto excess kome jay');
  say('-'.repeat(120));
  say('  "ops"   = koyta over-billed operation e ei bill er hat ache');
  say('  "fixes" = koyta operation e ei bill ta EKAI puro excess ta mitiye dey');
  say('            (fixes ar ops kachakachi hole oi bill tai prodhan sondehovajon)');
  say('');
  if (!ranked.length) say('  (kichu nei)');
  ranked.slice(0, SHOW_BILLS).forEach(r => {
    say('  bill ' + r.billNumber + (r.paid ? ' (PAID)' : '        ') + '  ' + r.date + '  ' +
        String(r.contractor).slice(0, 26).padEnd(28) +
        'ops=' + String(r.ops).padEnd(7) + 'fixes=' + String(r.fixes).padEnd(7) +
        'excessValue=' + String(r.excessValue).padEnd(12) +
        'bill e mot ' + r.billLines + ' line, value ' + r.billValue);
  });
  if (ranked.length > SHOW_BILLS) say('  ... aro ' + (ranked.length - SHOW_BILLS) + ' ta bill');

  // --- duplicates
  say('');
  say('-'.repeat(120));
  say('2)  HUBAHU DUPLICATE LINE  —  ekei contractor, job, operation, rate ar qty, ekadhik live bill e');
  say('-'.repeat(120));
  say('  Eta duplicate billing er sobcheye sposhto proman. Ekei kaj duibar bill hoyeche.');
  say('');
  if (!duplicates.length) say('  (kichu nei)');
  duplicates.sort((a, b) => b.extraValue - a.extraValue).slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.jobId.padEnd(17) + String(r.opsName).slice(0, 28).padEnd(30) +
        String(r.contractor).slice(0, 22).padEnd(24) +
        'qty=' + String(r.qty).padEnd(10) + r.times + ' bar  extra=' + r.extraValue);
    say('        bills: ' + r.bills);
  });
  if (duplicates.length > SHOW_ROWS) say('  ... aro ' + (duplicates.length - SHOW_ROWS) + ' ta');

  // --- worst operations
  say('');
  say('-'.repeat(120));
  say('3)  SOBCHEYE BESHI EXCESS JE OPERATION GULO TE');
  say('-'.repeat(120));
  if (!overBilled.length) say('  (kichu nei)');
  overBilled.slice().sort((a, b) => b.excessValue - a.excessValue).slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.jobId.padEnd(17) + String(r.opsName).slice(0, 28).padEnd(30) +
        'total=' + String(r.total).padEnd(10) + 'billed=' + String(r.billed).padEnd(10) +
        'excess=' + String(r.excess).padEnd(10) + '(' + r.excessPct + '%)  value=' + r.excessValue);
    say('        segment=' + r.segment + (r.allowance ? '  allowance=' + r.allowance : '') +
        '   ' + r.entries.map(e => e.billNumber + ':' + e.qty).join('  '));
  });
  if (overBilled.length > SHOW_ROWS) say('  ... aro ' + (overBilled.length - SHOW_ROWS) + ' ta');

  say('');
  say('='.repeat(120));
  say('  ER POR KI');
  say('='.repeat(120));
  say('  1. Ranking er sobar upor er bill ta khule dekhun (print-contractor-bill page e).');
  say('     Oi bill er line gulo jodi purono bill er hubahu copy hoy, tahole oi ta duplicate.');
  say('  2. Duplicate bill ta niye ki korben seta ACCOUNTING siddhanto — ei script kichu kore na.');
  say('     Mone rakhben: bill delete korle Contractor_WD ar pending o bodlabe.');
  say('  3. Sob thik hoye gele fix-pending-qty.js abar dry run cholan.');
  say('');
  say('  NOTE: ei script kichui change kore ni.');
  say('='.repeat(120));
  say('');
}

print(out.join('\n'));
