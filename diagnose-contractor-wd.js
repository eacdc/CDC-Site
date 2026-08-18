// ============================================================================
//  Contractor_WD diagnostic  —  READ ONLY, kono data change kore na.
//
//  Ki kore:
//    Contractor_WD er protita savedInBill:'No' row ke Bills / JobopsMaster er
//    sathe cross-check kore, tarpor category onujayi report dey.
//
//  Kivabe chalabo:
//    mongosh "<CONNECTION_STRING>" --file scripts/diagnose-contractor-wd.js
//
//    Report file e rakhte:
//    mongosh "<CONNECTION_STRING>" --file scripts/diagnose-contractor-wd.js > report.txt
//
//    CSV chaile niche CSV = true kore din, tarpor:
//    mongosh "<CONNECTION_STRING>" --file scripts/diagnose-contractor-wd.js > report.csv
// ============================================================================

// ---------------------------------------------------------------- settings --
const DB_NAME    = 'Contractor_PO';
const JOB_FILTER = '';    // ekta job dekhte chaile: 'J06364_25_26'.  '' = sob job
const SHOW_ROWS  = 40;    // prottek category te koto ta row print hobe
const CSV        = false; // true = CSV output, false = pora jaoar moto report
// ----------------------------------------------------------------------------

const d = db.getSiblingDB(DB_NAME);

const r2     = v => Math.round((Number(v) || 0) * 100) / 100;
const norm   = s => String(s == null ? '' : s).trim();
const unsaved = od => norm(od && od.savedInBill) === 'No';
const dstr   = v => (v ? new Date(v).toISOString().slice(0, 10) : '-');

const out = [];
const say = line => out.push(line);

// ---------------------------------------------- 1. contractorId -> naam ----
const nameById = {};
d.getCollection('Contractor').find({}, { contractorId: 1, name: 1 }).forEach(c => {
  nameById[norm(c.contractorId)] = norm(c.name);
});

// ------------------------------------------------------- 2. Bills index ----
// key = contractorName | reference | opsName | rate
const billIdx = {};
let billCount = 0;
d.getCollection('Bills').find({}).forEach(b => {
  billCount++;
  const cn = norm(b.contractorName);
  (b.jobs || []).forEach(j => {
    const ref = j.isAdhoc ? 'ADHOC:' + norm(j.adhocOrderId) : norm(j.jobNumber);
    (j.ops || []).forEach(op => {
      const key = [cn, ref, norm(op.opsName), r2(op.rate)].join('|');
      if (!billIdx[key]) billIdx[key] = [];
      billIdx[key].push({
        billNumber: b.billNumber,
        deleted: Number(b.isDeleted || 0) === 1,
        paid: norm(b.paymentStatus) === 'Yes',
        qty: Number(op.qtyCompleted || 0),
        date: b.createdAt
      });
    });
  });
});

// ------------------------------------------------- 3. operation naam map ----
const opNameById = {};
d.getCollection('operations').find({}, { opsName: 1 }).forEach(o => {
  opNameById[String(o._id)] = norm(o.opsName);
});

// -------------------------------------------------- 4. JobopsMaster load ----
const jobOps = {};   // jobId -> { segmentName, totalQty, ops: {opId: op} }
d.getCollection('JobopsMaster').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).forEach(j => {
  const ops = {};
  (j.ops || []).forEach(o => { ops[String(o.opId)] = o; });
  jobOps[norm(j.jobId)] = {
    segmentName: norm(j.segmentName),
    totalQty: Number(j.totalQty || 0),
    ops: ops
  };
});

// ---------------------------------------------------- 5. Contractor_WD -----
const wdFilter = JOB_FILTER ? { jobId: JOB_FILTER } : {};

const cat = {                 // category buckets
  activeBill:   [],           // A - already billed, tobu pending -> DOUBLE BILLING
  deletedBill:  [],           // B - deleted bill theke resurrect hoyeche
  noBill:       [],           // C - kono bill nei, sotti pending
  missingOpsId: [],           // D - opsId nei/null -> edit-qty er signature
  dupOpsId:     []            // E - ekei doc e ekei opsId multiple bar
};

let docCount = 0, rowCount = 0, unsavedCount = 0, legacyCount = 0;
const completedByJobOp = {};  // jobId|opId -> sob contractor er total opsDoneQty

d.getCollection('Contractor_WD').find(wdFilter).forEach(doc => {
  docCount++;
  const cid  = norm(doc.contractorId);
  const cname = nameById[cid] || '(unknown: ' + cid + ')';
  const isAdhoc = doc.isAdhoc === true;
  const ref  = isAdhoc ? 'ADHOC:' + norm(doc.adhocOrderId) : norm(doc.jobId);
  const rows = doc.opsDone || [];

  // duplicate opsId detection
  const seen = {};
  rows.forEach(od => {
    const oid = norm(od.opsId);
    if (!oid || oid === 'null') return;
    seen[oid] = (seen[oid] || 0) + 1;
  });
  Object.keys(seen).forEach(oid => {
    if (seen[oid] > 1) {
      const sample = rows.filter(od => norm(od.opsId) === oid);
      cat.dupOpsId.push({
        contractor: cname, ref: ref, opsName: norm(sample[0].opsName),
        copies: seen[oid],
        states: sample.map(s => norm(s.savedInBill) || '(missing)').join(','),
        qtys: sample.map(s => Number(s.opsDoneQty || 0)).join(','),
        note: 'ekei opsId ' + seen[oid] + ' bar'
      });
    }
  });

  rows.forEach(od => {
    rowCount++;

    // job-op wise total completed (pending consistency check er jonno)
    if (!isAdhoc && norm(doc.jobId) && norm(od.opsId)) {
      const k = norm(doc.jobId) + '|' + norm(od.opsId);
      completedByJobOp[k] = (completedByJobOp[k] || 0) + Number(od.opsDoneQty || 0);
    }

    if (od.savedInBill === undefined || norm(od.savedInBill) === '') { legacyCount++; return; }
    if (!unsaved(od)) return;
    unsavedCount++;

    const opsName = norm(od.opsName);
    const rate    = r2(od.valuePerBook);
    const qty     = Number(od.opsDoneQty || 0);
    const oid     = norm(od.opsId);

    const rec = {
      contractor: cname,
      contractorId: cid,
      ref: ref,
      opsId: oid || '(missing)',
      opsName: opsName,
      qty: qty,
      rate: rate,
      value: r2(qty * rate),
      date: dstr(od.completionDate)
    };

    if (!oid || oid === 'null') cat.missingOpsId.push(rec);

    const hits = billIdx[[cname, ref, opsName, rate].join('|')] || [];
    const live = hits.filter(h => !h.deleted);
    const dead = hits.filter(h => h.deleted);

    if (live.length) {
      rec.bills = live.map(h => h.billNumber + (h.paid ? '(PAID)' : '') + ' qty=' + h.qty + ' ' + dstr(h.date)).join(' ; ');
      cat.activeBill.push(rec);
    } else if (dead.length) {
      rec.bills = dead.map(h => h.billNumber + ' qty=' + h.qty + ' ' + dstr(h.date)).join(' ; ');
      cat.deletedBill.push(rec);
    } else {
      rec.bills = '-';
      cat.noBill.push(rec);
    }
  });
});

// ------------------------------- 6. JobopsMaster pending consistency check --
const pendingMismatch = [];
Object.keys(jobOps).forEach(jobId => {
  const j = jobOps[jobId];
  Object.keys(j.ops).forEach(opId => {
    const o = j.ops[opId];
    const total   = Number(o.totalOpsQty || 0);
    const pending = Number(o.pendingOpsQty || 0);
    const expectedDone = total - pending;
    const actualDone   = completedByJobOp[jobId + '|' + opId] || 0;
    const diff = r2(actualDone - expectedDone);
    if (Math.abs(diff) > 0.5) {
      pendingMismatch.push({
        ref: jobId,
        segment: j.segmentName || '-',
        opsName: opNameById[opId] || '(unknown op)',
        total: total,
        pending: pending,
        expectedDone: expectedDone,
        actualDone: actualDone,
        diff: diff
      });
    }
  });
});

// ------------------------------------------------------------- 7. output ----
const sumQty   = a => a.reduce((s, x) => s + (x.qty || 0), 0);
const sumValue = a => r2(a.reduce((s, x) => s + (x.value || 0), 0));

if (CSV) {
  say('category,contractor,reference,opsId,opsName,qty,rate,value,date,bills');
  const dump = (name, arr) => arr.forEach(r => say([
    name, r.contractor, r.ref, r.opsId, r.opsName,
    r.qty, r.rate, r.value, r.date, '"' + String(r.bills || '').replace(/"/g, "'") + '"'
  ].join(',')));
  dump('A_ACTIVE_BILL_DOUBLE_RISK', cat.activeBill);
  dump('B_DELETED_BILL_RESURRECTED', cat.deletedBill);
  dump('C_NO_BILL_GENUINE_PENDING', cat.noBill);
} else {
  const table = (title, arr, extra) => {
    say('');
    say('-'.repeat(100));
    say(title);
    say('-'.repeat(100));
    if (!arr.length) { say('  (kichu nei)'); return; }
    say('  rows: ' + arr.length + '   total qty: ' + sumQty(arr) + '   total value: ' + sumValue(arr));
    if (extra) say('  ' + extra);
    say('');
    arr.slice(0, SHOW_ROWS).forEach(r => {
      say('  ' + r.date + '  ' + r.ref.padEnd(18) + ' ' + String(r.contractor).slice(0, 22).padEnd(23) +
          String(r.opsName).slice(0, 28).padEnd(29) + 'qty=' + String(r.qty).padEnd(9) +
          'rate=' + String(r.rate).padEnd(9) + 'val=' + r.value);
      if (r.bills && r.bills !== '-') say('        bill: ' + r.bills);
    });
    if (arr.length > SHOW_ROWS) say('  ... aro ' + (arr.length - SHOW_ROWS) + ' ta (SHOW_ROWS baran othoba CSV mode use korun)');
  };

  say('');
  say('='.repeat(100));
  say('  CONTRACTOR_WD DIAGNOSTIC  —  db: ' + DB_NAME + (JOB_FILTER ? '   job: ' + JOB_FILTER : '   (sob job)'));
  say('='.repeat(100));
  say('  Contractor_WD documents : ' + docCount);
  say('  opsDone rows (mot)      : ' + rowCount);
  say('  savedInBill = "No"      : ' + unsavedCount + '   <-- egulo Work Done page e Bill Details e dekha jay');
  say('  savedInBill field nei   : ' + legacyCount + '   (legacy row, backend egulo ke billed dhore)');
  say('  Bills documents         : ' + billCount);

  table(
    'A)  ALREADY BILLED, TOBU PENDING  ->  DOUBLE BILLING RISK  [SOBCHEYE JORURI]',
    cat.activeBill,
    'Ei operation gulo ekta active (delete hoyni) bill e ache, tobu Contractor_WD te savedInBill:"No".\n' +
    '  Karon #2 (bill edit-qty) othoba #3 (mark-billed fail). Abar SUBMIT korle dubar taka jabe.'
  );

  table(
    'B)  DELETED BILL THEKE RESURRECT HOYECHE',
    cat.deletedBill,
    'Bill delete route (routes.js:11135) billed row ke abar savedInBill:"No" baniye diyeche.'
  );

  table(
    'C)  KONO BILL NEI  —  sotti kar pending kaj (othoba purono orphan)',
    cat.noBill,
    'Date jodi onek purono hoy, tahole keu save kore submit korte bhule geche.'
  );

  table(
    'D)  opsId NEI / null  —  bill edit-qty route er signature (routes.js:10784)',
    cat.missingOpsId,
    'Ei row gulo Work Done save theke ase ni. Egulo A/B/C teo count hoyeche.'
  );

  say('');
  say('-'.repeat(100));
  say('E)  EKEI opsId EKADHIK BAR EKEI DOCUMENT E  (data corruption)');
  say('-'.repeat(100));
  if (!cat.dupOpsId.length) say('  (kichu nei)');
  cat.dupOpsId.slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.ref.padEnd(18) + String(r.contractor).slice(0, 22).padEnd(23) +
        String(r.opsName).slice(0, 28).padEnd(29) + r.note + '  states=[' + r.states + ']  qtys=[' + r.qtys + ']');
  });
  if (cat.dupOpsId.length > SHOW_ROWS) say('  ... aro ' + (cat.dupOpsId.length - SHOW_ROWS) + ' ta');

  say('');
  say('-'.repeat(100));
  say('F)  JobopsMaster pending qty  vs  Contractor_WD e joma kaj  —  mismatch');
  say('-'.repeat(100));
  say('  expectedDone = totalOpsQty - pendingOpsQty,  actualDone = sob contractor er opsDoneQty er jog');
  say('  Packaging segment e 5% overshoot allowed, tai oi gulo te choto diff normal hote pare.');
  say('');
  if (!pendingMismatch.length) say('  (kichu nei)');
  pendingMismatch.slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.ref.padEnd(18) + String(r.segment).slice(0, 12).padEnd(13) +
        String(r.opsName).slice(0, 26).padEnd(27) +
        'total=' + String(r.total).padEnd(9) + 'pending=' + String(r.pending).padEnd(9) +
        'expDone=' + String(r.expectedDone).padEnd(9) + 'actDone=' + String(r.actualDone).padEnd(9) +
        'diff=' + r.diff);
  });
  if (pendingMismatch.length > SHOW_ROWS) say('  ... aro ' + (pendingMismatch.length - SHOW_ROWS) + ' ta');

  say('');
  say('='.repeat(100));
  say('  SUMMARY');
  say('='.repeat(100));
  say('  A) double billing risk        : ' + cat.activeBill.length + ' row,  value ' + sumValue(cat.activeBill));
  say('  B) deleted bill theke fire ase: ' + cat.deletedBill.length + ' row,  value ' + sumValue(cat.deletedBill));
  say('  C) kono bill nei              : ' + cat.noBill.length + ' row,  value ' + sumValue(cat.noBill));
  say('  D) opsId missing              : ' + cat.missingOpsId.length + ' row');
  say('  E) duplicate opsId            : ' + cat.dupOpsId.length + ' khetre');
  say('  F) pending mismatch           : ' + pendingMismatch.length + ' operation');
  say('');
  say('  NOTE: ei script kichui change kore na — sudhu pore ar report dey.');
  say('='.repeat(100));
  say('');
}

print(out.join('\n'));
