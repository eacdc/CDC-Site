// ============================================================================
//  JobopsMaster pendingOpsQty CLEANUP
//
//  NIYOM (business rule): delete na kora bill gulo i final source of truth —
//  oi qty er payment hoye gechhe.
//
//    kaj hoye gechhe = live bill er qty  +  save hoyeche kintu ekhono bill hoyni (savedInBill:'No')
//    pendingOpsQty   = totalOpsQty - oi duto,  0 ar totalOpsQty er majhe clamp
//
//  Contractor_WD er 'Yes' row gulo alada kore gona hoy na — oi kaj to live
//  bill eii ache. Jekhane WD ar bill mile na, sekhane BILL i sothik dhora hoy.
//
//  DEFAULT E KICHUI CHANGE HOY NA (APPLY = false).
//
//  Chalanor niyom:
//    1) DRY RUN:   mongosh "<URI>" --file scripts/fix-pending-qty.js > fix-preview.txt
//    2) APPLY:     niche APPLY = true kore abar cholan
//    3) ROLLBACK:  niche ROLLBACK = true kore cholan
//
//  ⚠  APPLY korar somoy keu jeno system use na kore. Age Atlas e snapshot nin.
// ============================================================================

// ---------------------------------------------------------------- settings --
const DB_NAME       = 'Contractor_PO';
const APPLY         = false;  // false = sudhu report.  true = data bodlabe.
const ROLLBACK      = false;  // true = backup collection theke purono value phirie ana
const FIX_INCREASES = false;  // niche section C dekhun
const JOB_FILTER    = '';     // ekta job e seemabodhho rakhte: 'J04070_25_26'
const TOL           = 0.5;    // eto tuku difference ignore kora hobe
const MAX_CHANGES   = 100000; // safety cap — er beshi hole kichui apply hobe na
const SHOW_ROWS     = 60;     // report e koto ta line dekhabe
const BACKUP_COLLECTION = 'JobopsMaster_pending_backup';
// ----------------------------------------------------------------------------

const d = db.getSiblingDB(DB_NAME);

const r2   = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s == null ? '' : s).trim();

const out = [];
const say = l => out.push(l);

// ============================================================================
//  ROLLBACK MODE
// ============================================================================
if (ROLLBACK) {
  const backups = d.getCollection(BACKUP_COLLECTION).find({}).toArray();

  say('');
  say('='.repeat(112));
  say('  ROLLBACK  —  backup collection: ' + BACKUP_COLLECTION);
  say('='.repeat(112));
  say('  backup entries: ' + backups.length);

  if (backups.length === 0) {
    say('  Kichu nei — rollback korar moto kono backup pawa jayni.');
  } else {
    const byDoc = {};
    backups.forEach(b => {
      if (!byDoc[String(b.docId)]) byDoc[String(b.docId)] = [];
      byDoc[String(b.docId)].push(b);
    });

    let restored = 0;
    Object.keys(byDoc).forEach(docIdStr => {
      const entries = byDoc[docIdStr];
      const setDoc = {};
      entries.forEach(e => { setDoc['ops.' + e.opIndex + '.pendingOpsQty'] = e.oldPending; });
      d.getCollection('JobopsMaster').updateOne({ _id: entries[0].docId }, { $set: setDoc });
      restored += entries.length;
    });

    say('  restored operations: ' + restored);
    say('');
    say('  Backup collection ta MUCHE FELA HOYNI. Santushto hole nije muchun:');
    say('    db.getSiblingDB("' + DB_NAME + '").' + BACKUP_COLLECTION + '.drop()');
  }
  say('='.repeat(112));
  say('');
  print(out.join('\n'));
} else {

// ============================================================================
//  NORMAL MODE  (dry run / apply)
// ============================================================================

// ------------------------------------------------- 1. operation naam map ----
const opById = {};
d.getCollection('operations').find({}, { opsName: 1 }).forEach(o => {
  opById[String(o._id)] = norm(o.opsName);
});

// ------------------------------------- 2. Contractor_WD (job|opId onujayi) --
// Sudhu savedInBill:'No' qty ta dorkar — 'Yes' gulo to live bill eii ache.
const wdByJobOp = {};
d.getCollection('Contractor_WD').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).forEach(doc => {
  if (doc.isAdhoc === true) return;              // ad-hoc alada collection e
  const jid = norm(doc.jobId);
  if (!jid) return;
  (doc.opsDone || []).forEach(od => {
    const oid = norm(od.opsId);
    if (!oid || oid === 'null') return;
    const k = jid + '|' + oid;
    if (!wdByJobOp[k]) wdByJobOp[k] = { total: 0, billed: 0, unsaved: 0 };
    const q = Number(od.opsDoneQty || 0);
    wdByJobOp[k].total += q;
    if (norm(od.savedInBill) === 'No') wdByJobOp[k].unsaved += q;
    else wdByJobOp[k].billed += q;
  });
});

// ------------------------------------------------------ 3. bill er hisheb ---
const billQty = {};
d.getCollection('Bills').find({}).forEach(b => {
  const dead = Number(b.isDeleted || 0) === 1;
  (b.jobs || []).forEach(j => {
    if (j.isAdhoc) return;
    const jn = norm(j.jobNumber);
    (j.ops || []).forEach(op => {
      const k = [jn, norm(op.opsName), r2(op.rate)].join('|');
      if (!billQty[k]) billQty[k] = { live: 0, dead: 0, liveValue: 0, bills: {} };
      const q = Number(op.qtyCompleted || 0);
      if (dead) {
        billQty[k].dead += q;
      } else {
        billQty[k].live += q;
        billQty[k].liveValue += Number(op.totalValue || 0);
        billQty[k].bills[b.billNumber] = true;
      }
    });
  });
});

// ------------------------------------------------- 4. ki ki bodlate hobe ----
const decreases = [];   // pending komano
const increases = [];   // pending barano (default e apply hoy na)
const overBilled = [];  // live bill > totalOpsQty  —  ei tai asol vul
let opsScanned = 0;
let ambiguousCount = 0;

const jobDocs = d.getCollection('JobopsMaster').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).toArray();

// Bill e operation khuje pawa jay (jobNumber, opsName, rate) diye — opId diye noy.
// Tai ekei job e ekei naam+rate er duto op thakle kon bill kar bola jay na;
// oi khetre bill bad diye Contractor_WD er puro hisheb dhora hobe.
const opKeyCount = {};
jobDocs.forEach(j => {
  const jid = norm(j.jobId);
  (j.ops || []).forEach(o => {
    const k = [jid, opById[norm(o.opId)] || '(op doc nei)', r2(o.valuePerBook)].join('|');
    opKeyCount[k] = (opKeyCount[k] || 0) + 1;
  });
});

jobDocs.forEach(j => {
  const jid = norm(j.jobId);
  const segment = norm(j.segmentName);

  (j.ops || []).forEach((o, idx) => {
    opsScanned++;
    const oid     = norm(o.opId);
    const total   = Number(o.totalOpsQty || 0);
    const pending = Number(o.pendingOpsQty || 0);
    const rate    = r2(o.valuePerBook);
    const wd      = wdByJobOp[jid + '|' + oid] || { total: 0, billed: 0, unsaved: 0 };

    const opsName = opById[oid] || '(op doc nei)';
    const billKey = [jid, opsName, rate].join('|');
    const bq = billQty[billKey] || { live: 0, dead: 0, liveValue: 0, bills: {} };
    const ambiguous = (opKeyCount[billKey] || 0) > 1;
    if (ambiguous) ambiguousCount++;

    // Live bill = truth. Tar sathe je gulo save hoyeche kintu bill hoyni.
    // Ambiguous hole bill ta kar seta bola jay na, tai Contractor_WD dhora hoy.
    const doneBilled = ambiguous ? wd.billed : bq.live;
    const doneTotal  = doneBilled + wd.unsaved;

    // live bill totalOpsQty er cheye beshi — ei tai asol vul, hate dekha dorkar
    if (!ambiguous && bq.live > total + TOL) {
      overBilled.push({
        jobId: jid,
        segment: segment || '-',
        opsName: opsName,
        rate: rate,
        total: total,
        liveBilled: bq.live,
        excess: r2(bq.live - total),
        excessPct: total > 0 ? r2((bq.live - total) / total * 100) : 0,
        liveValue: r2(bq.liveValue),
        excessValue: r2((bq.live - total) * rate),
        bills: Object.keys(bq.bills).join(',')
      });
    }

    // Packaging segment e job er totalQty er 5% porjonto beshi record kora
    // boidho (work-done.html: maxForRow = packagingTotalQty * 0.05 + pending).
    // Oi tuku overshoot ke "kaj beshi hoye gechhe" na dhore, pending 0 e clamp
    // kora hoy — ta na hole allowance er qty tuku ke bhul mone hoto.
    const newPending = Math.max(0, Math.min(total, total - doneTotal));
    const delta = r2(newPending - pending);
    if (Math.abs(delta) <= TOL) return;

    const rec = {
      docId: j._id,
      jobId: jid,
      opId: oid,
      opIndex: idx,
      opsName: opsName,
      total: total,
      oldPending: pending,
      newPending: newPending,
      delta: delta,
      liveBilled: bq.live,
      deadBilled: bq.dead,
      wdBilled: wd.billed,
      wdUnsaved: wd.unsaved,
      ambiguous: ambiguous
    };

    if (delta < 0) decreases.push(rec); else increases.push(rec);
  });
});

const planned = FIX_INCREASES ? decreases.concat(increases) : decreases;

// ---------------------------------------------------------------- report ----
const line = r =>
  '  ' + r.jobId.padEnd(17) + String(r.opsName).slice(0, 26).padEnd(28) +
  'total=' + String(r.total).padEnd(10) +
  'pending ' + String(r.oldPending).padEnd(10) + '-> ' + String(r.newPending).padEnd(10) +
  'billed=' + String(r.liveBilled).padEnd(10) +
  'notyetbilled=' + String(r.wdUnsaved).padEnd(10) +
  (r.ambiguous ? ' <- ekei naam+rate er ekadhik op, bill bad deoa holo' : '');

say('');
say('='.repeat(112));
say('  JobopsMaster pendingOpsQty CLEANUP   db: ' + DB_NAME +
    (JOB_FILTER ? '   job: ' + JOB_FILTER : '   (sob job)'));
say('  MODE: ' + (APPLY ? '*** APPLY — data bodlabe ***' : 'DRY RUN — kichui bodlabe na'));
say('='.repeat(112));
say('  NIYOM: pending = totalOpsQty - (live bill er qty) - (save hoyeche kintu bill hoyni)');
say('');
say('  JobopsMaster operations scanned : ' + opsScanned);
say('  ekei naam+rate er ekadhik op    : ' + ambiguousCount + '  (ei gulo te bill bad diye Contractor_WD dhora hoyeche)');
say('');
say('  A) pending komano dorkar        : ' + decreases.length + '  (apply hobe)');
say('  B) pending barano dorkar        : ' + increases.length +
    (FIX_INCREASES ? '  (apply hobe)' : '  (apply hobe NA — FIX_INCREASES = false)'));
say('  ---------------------------------------------------');
say('  mot je gulo bodlano hobe        : ' + planned.length);
say('');
say('  C) OVER-BILLED (live bill > totalOpsQty) : ' + overBilled.length + '  <-- ei tai asol vul');

say('');
say('-'.repeat(112));
say('A)  PENDING KOMANO HOBE');
say('-'.repeat(112));
say('  Bill + ekhono bill na hoya kaj mile totalOpsQty er kachakachi chole gechhe, kintu');
say('  pending seta dekhachhe na. Tai ekei kaj abar record ar bill kora jachhe.');
say('');
if (!decreases.length) say('  (kichu nei)');
decreases.slice(0, SHOW_ROWS).forEach(r => say(line(r)));
if (decreases.length > SHOW_ROWS) say('  ... aro ' + (decreases.length - SHOW_ROWS) + ' ta');

say('');
say('-'.repeat(112));
say('B)  PENDING BARANO DORKAR' + (FIX_INCREASES ? '   [apply hobe]' : '   [apply hobe NA]'));
say('-'.repeat(112));
say('  Pending barano mane notun kaj record korar sujog toiri kora, tai default e apply hoy na.');
say('  Packaging segment e bill delete korle 5% icche kore rekhe deoa hoy — oi gulo ekhane ashbe,');
say('  kintu segulo bug noy, design onujayi thik.');
say('');
if (!increases.length) say('  (kichu nei)');
increases.slice(0, SHOW_ROWS).forEach(r => say(line(r)));
if (increases.length > SHOW_ROWS) say('  ... aro ' + (increases.length - SHOW_ROWS) + ' ta');

say('');
say('-'.repeat(112));
say('C)  OVER-BILLED  —  totalOpsQty er cheye BESHI bill hoye payment hoye gechhe');
say('-'.repeat(112));
say('  EI SCRIPT EI GULO THIK KORE NA — eta accounting er siddhanto, code er noy.');
say('  Packaging segment e 5% porjonto overshoot boidho, tai excessPct dekhe bujhben.');
say('');
if (!overBilled.length) {
  say('  (kichu nei)');
} else {
  const sortedOver = overBilled.slice().sort((a, b) => b.excessValue - a.excessValue);
  const totalExcessValue = r2(sortedOver.reduce((s, r) => s + r.excessValue, 0));
  const beyond5 = sortedOver.filter(r => r.excessPct > 5);
  say('  mot over-billed operation     : ' + sortedOver.length);
  say('  5% er BESHI overshoot          : ' + beyond5.length + '  <-- packaging allowance diyeo bakhya kora jay na');
  say('  mot excess value               : ' + totalExcessValue);
  say('');
  sortedOver.slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.jobId.padEnd(17) + String(r.opsName).slice(0, 26).padEnd(28) +
        'total=' + String(r.total).padEnd(10) +
        'billed=' + String(r.liveBilled).padEnd(10) +
        'excess=' + String(r.excess).padEnd(10) +
        '(' + r.excessPct + '%)  value=' + r.excessValue);
    say('        segment=' + r.segment + '  bills=' + r.bills);
  });
  if (sortedOver.length > SHOW_ROWS) say('  ... aro ' + (sortedOver.length - SHOW_ROWS) + ' ta');
}

// ----------------------------------------------------------------- apply ----
say('');
say('='.repeat(112));

if (!APPLY) {
  say('  DRY RUN sesh — DATABASE E KICHUI BODLANO HOYNI.');
  say('');
  say('  Section A dekhe santushto hole:');
  say('    1. Atlas e ekta snapshot niye rakhun');
  say('    2. keu jeno system use na kore seta nishchit korun');
  say('    3. ei file e APPLY = true korun, tarpor abar cholan');
  say('');
  say('  Apply korle purono value gulo "' + BACKUP_COLLECTION + '" collection e rakha hobe,');
  say('  jate ROLLBACK = true diye phire asa jay.');
  say('');
  say('  Je kaj gulo save hoyeche kintu bill hoyni, tader qty niye suggestion pete cholan:');
  say('    mongosh "<URI>" --file scripts/suggest-unsaved-adjustments.js');
} else if (planned.length === 0) {
  say('  Bodlanor moto kichu nei.');
} else if (planned.length > MAX_CHANGES) {
  say('  THAMANO HOLO: ' + planned.length + ' ta change, kintu MAX_CHANGES = ' + MAX_CHANGES + '.');
  say('  KICHUI APPLY KORA HOYNI. Ei songkhya ta expected kina dekhe MAX_CHANGES baran.');
} else {
  const stamp = new Date();
  const backupDocs = planned.map(r => ({
    docId: r.docId,
    jobId: r.jobId,
    opId: r.opId,
    opIndex: r.opIndex,
    opsName: r.opsName,
    oldPending: r.oldPending,
    newPending: r.newPending,
    totalOpsQty: r.total,
    liveBilled: r.liveBilled,
    notYetBilled: r.wdUnsaved,
    runAt: stamp
  }));
  d.getCollection(BACKUP_COLLECTION).insertMany(backupDocs);

  // Sudhu pendingOpsQty field ta $set kora hoy — puro ops array replace kora
  // hoy na, tai onno kono field e hat pore na.
  const byDoc = {};
  planned.forEach(r => {
    const k = String(r.docId);
    if (!byDoc[k]) byDoc[k] = { _id: r.docId, set: {} };
    byDoc[k].set['ops.' + r.opIndex + '.pendingOpsQty'] = r.newPending;
  });

  const bulk = Object.keys(byDoc).map(k => ({
    updateOne: { filter: { _id: byDoc[k]._id }, update: { $set: byDoc[k].set } }
  }));

  let modified = 0;
  for (let i = 0; i < bulk.length; i += 500) {
    const res = d.getCollection('JobopsMaster').bulkWrite(bulk.slice(i, i + 500));
    modified += res.modifiedCount || 0;
  }

  say('  APPLY sesh.');
  say('    operations bodlano hoyeche : ' + planned.length);
  say('    JobopsMaster document      : ' + modified);
  say('    backup rakha hoyeche       : ' + BACKUP_COLLECTION + ' (' + backupDocs.length + ' entry)');
  say('');
  say('  Phire jete chaile ei file e ROLLBACK = true kore abar cholan.');
}

say('='.repeat(112));
say('');
print(out.join('\n'));

}
