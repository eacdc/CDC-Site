// ============================================================================
//  EK JOB ER PURO CHITRO  —  READ ONLY
//
//  Ekta job niye Work Done page e ki dekhabe ar keno, seta ek jaygay dekhay:
//    - JobopsMaster : totalOpsQty, pendingOpsQty, ar sotti koto kaj joma ache
//    - Contractor_WD: protita row, kon contractor, savedInBill, kobe save hoyeche
//    - Bills        : ei job er live ar deleted bill gulo
//    - VERDICT      : Bill Details e kon row keno dekhachhe, seta prottyashito kina
//
//  ⚠  KICHUI CHANGE KORE NA.
//
//  Chalanor niyom:
//    mongosh "<URI>" --file scripts/inspect-job.js > job.txt
//
//  Onno job dekhte niche JOB_NUMBER bodle din.
// ============================================================================

// ---------------------------------------------------------------- settings --
const DB_NAME    = 'Contractor_PO';
const JOB_NUMBER = 'J04307_26_27';   // <-- ei ta bodle onno job dekhun
const PACKAGING_ALLOWANCE_PCT = 5;
const TOL = 0.5;
// ----------------------------------------------------------------------------

const d = db.getSiblingDB(DB_NAME);

const r2   = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s == null ? '' : s).trim();
const dstr = v => (v ? new Date(v).toISOString().slice(0, 19).replace('T', ' ') : '(nei)');
const dayOnly = v => (v ? new Date(v).toISOString().slice(0, 10) : '-');

const out = [];
const say = l => out.push(l);

say('');
say('='.repeat(112));
say('  JOB INSPECT:  ' + JOB_NUMBER + '     db: ' + DB_NAME);
say('='.repeat(112));

// ------------------------------------------------------------ contractors ---
const cName = {};
d.getCollection('Contractor').find({}, { contractorId: 1, name: 1 }).forEach(c => {
  cName[norm(c.contractorId)] = norm(c.name);
});

// ------------------------------------------------------------- operations ---
const opName = {}, opType = {}, opRate = {};
d.getCollection('operations').find({}, { opsName: 1, type: 1, ratePerUnit: 1 }).forEach(o => {
  opName[String(o._id)] = norm(o.opsName);
  opType[String(o._id)] = norm(o.type);
  opRate[String(o._id)] = Number(o.ratePerUnit || 0);
});

// ---------------------------------------------------------- JobopsMaster ----
const master = d.getCollection('JobopsMaster').findOne({ jobId: JOB_NUMBER });

if (!master) {
  say('');
  say('  ⚠  JobopsMaster e "' + JOB_NUMBER + '" paoa jayni.');
  say('     Job number ta hubohu mile kina dekhun — format alada hote pare');
  say('     (J04307_26_27  vs  J04307/26-27). Niche regex diye khoja hocche:');
  const like = JOB_NUMBER.replace(/[^A-Za-z0-9]/g, '');
  d.getCollection('JobopsMaster').find({ jobId: { $regex: '^' + like.slice(0, 6) } }, { jobId: 1 })
    .forEach(j => say('       paoa gelo: ' + j.jobId));
}

const isPackaging = master ? norm(master.segmentName) === 'Packaging' : false;
const jobQty = master ? Number(master.totalQty || 0) : 0;
const allowance = isPackaging && jobQty > 0 ? Math.round(jobQty * PACKAGING_ALLOWANCE_PCT / 100) : 0;

if (master) {
  say('');
  say('  clientName   : ' + norm(master.clientName));
  say('  jobTitle     : ' + norm(master.jobTitle));
  say('  segmentName  : "' + norm(master.segmentName) + '"' + (isPackaging ? '   -> Packaging' : '   -> Packaging NOY'));
  say('  totalQty     : ' + jobQty);
  say('  allowance    : ' + allowance + (isPackaging ? '  (' + PACKAGING_ALLOWANCE_PCT + '% of totalQty)' : '  (Packaging noy, tai 0)'));
  say('  ops count    : ' + (master.ops || []).length);
}

// ---------------------------------------------------------- Contractor_WD ---
const wdDocs = d.getCollection('Contractor_WD').find({ jobId: JOB_NUMBER }).toArray();
const wdRows = [];
wdDocs.forEach(doc => {
  (doc.opsDone || []).forEach((od, idx) => {
    wdRows.push({
      contractorId: norm(doc.contractorId),
      contractor: cName[norm(doc.contractorId)] || '(unknown: ' + norm(doc.contractorId) + ')',
      isAdhoc: doc.isAdhoc === true,
      index: idx,
      opsId: norm(od.opsId),
      opsName: norm(od.opsName) || opName[norm(od.opsId)] || '(naam nei)',
      qty: Number(od.opsDoneQty || 0),
      rate: r2(od.valuePerBook),
      savedInBill: od.savedInBill === undefined ? '(field NEI)' : norm(od.savedInBill),
      savedOn: od.completionDate || null
    });
  });
});

const recordedByOp = {};
wdRows.forEach(r => {
  if (r.isAdhoc || !r.opsId) return;
  recordedByOp[r.opsId] = (recordedByOp[r.opsId] || 0) + r.qty;
});

// ----------------------------------------------------------------- Bills ----
const bills = d.getCollection('Bills').find({ 'jobs.jobNumber': JOB_NUMBER }).toArray();
const liveByOpKey = {}, deadByOpKey = {}, billsByOpKey = {};
bills.forEach(b => {
  const dead = Number(b.isDeleted || 0) === 1;
  (b.jobs || []).forEach(j => {
    if (norm(j.jobNumber) !== JOB_NUMBER) return;
    (j.ops || []).forEach(op => {
      const k = norm(op.opsName) + '|' + r2(op.rate);
      const q = Number(op.qtyCompleted || 0);
      if (dead) { deadByOpKey[k] = (deadByOpKey[k] || 0) + q; }
      else {
        liveByOpKey[k] = (liveByOpKey[k] || 0) + q;
        if (!billsByOpKey[k]) billsByOpKey[k] = [];
        billsByOpKey[k].push(norm(b.billNumber) + (norm(b.paymentStatus) === 'Yes' ? '(PAID)' : '') + ' ' + dayOnly(b.createdAt));
      }
    });
  });
});

// -------------------------------------------- 1. Operations Pending panel ---
say('');
say('-'.repeat(112));
say('1)  "OPERATIONS PENDING" panel e ja dekhabe   (pendingOpsQty > 0 hole)');
say('-'.repeat(112));
if (!master) {
  say('  (JobopsMaster nei — panel e "No pending operations" dekhabe)');
} else {
  say('  ' + 'Operation'.padEnd(34) + 'total'.padEnd(10) + 'pending'.padEnd(10) +
      'joma kaj'.padEnd(11) + 'pending howa uchit'.padEnd(20) + 'Qty to Add cap');
  (master.ops || []).forEach(o => {
    const oid = norm(o.opId);
    const nm = opName[oid] || '(op doc NEI)';
    const total = Number(o.totalOpsQty || 0);
    const pending = Number(o.pendingOpsQty || 0);
    const recorded = recordedByOp[oid] || 0;
    const should = Math.max(0, Math.min(total, total - recorded));
    const cap = Math.max(0, Math.round(Math.min(pending + allowance, total + allowance - recorded)));
    const flag = Math.abs(should - pending) > TOL ? '  <-- pending BEMIL' : '';
    const shown = pending > 0 ? '' : '   (pending 0, tai panel e dekhabe na)';
    say('  ' + nm.slice(0, 32).padEnd(34) + String(total).padEnd(10) + String(pending).padEnd(10) +
        String(recorded).padEnd(11) + String(should).padEnd(20) + String(cap) + flag + shown);
  });
}

// ------------------------------------------------ 2. Contractor_WD er row ---
say('');
say('-'.repeat(112));
say('2)  Contractor_WD er SOB row  (ei job e)');
say('-'.repeat(112));
if (wdRows.length === 0) {
  say('  (kono row nei — tar mane Bill Details e ei job er kichu dekhanor kotha NOY)');
} else {
  say('  ' + 'contractor'.padEnd(26) + 'Operation'.padEnd(32) + 'qty'.padEnd(10) +
      'rate'.padEnd(8) + 'savedInBill'.padEnd(13) + 'kobe save hoyeche');
  wdRows.sort((a, b) => String(b.savedOn).localeCompare(String(a.savedOn))).forEach(r => {
    say('  ' + String(r.contractor).slice(0, 24).padEnd(26) + r.opsName.slice(0, 30).padEnd(32) +
        String(r.qty).padEnd(10) + String(r.rate).padEnd(8) + r.savedInBill.padEnd(13) + dstr(r.savedOn) +
        (r.isAdhoc ? '   [AD-HOC]' : ''));
  });
}

// ------------------------------------------------------------- 3. Bills -----
say('');
say('-'.repeat(112));
say('3)  Ei job er BILL gulo');
say('-'.repeat(112));
if (bills.length === 0) {
  say('  (kono bill nei)');
} else {
  bills.forEach(b => {
    const dead = Number(b.isDeleted || 0) === 1;
    say('  bill ' + norm(b.billNumber) + (dead ? '  [DELETED]' : '          ') +
        (norm(b.paymentStatus) === 'Yes' ? ' PAID' : ' unpaid') +
        '  ' + dayOnly(b.createdAt) + '  ' + norm(b.contractorName));
    (b.jobs || []).forEach(j => {
      if (norm(j.jobNumber) !== JOB_NUMBER) return;
      (j.ops || []).forEach(op => {
        say('        ' + norm(op.opsName).slice(0, 34).padEnd(36) +
            'qty=' + String(Number(op.qtyCompleted || 0)).padEnd(10) + 'rate=' + r2(op.rate));
      });
    });
  });
}

// --------------------------------------------------------- 4. THE VERDICT ---
say('');
say('='.repeat(112));
say('4)  "BILL DETAILS" e ja dekhabe, ar KENO');
say('='.repeat(112));
say('  Bill Details sudhu savedInBill = "No" row gulo dekhay. Onno kichu noy.');
say('');

const unsaved = wdRows.filter(r => r.savedInBill === 'No');
if (unsaved.length === 0) {
  say('  savedInBill = "No" kono row NEI.');
  say('');
  say('  >>> Tar mane ei job search korle Bill Details e ei job er kichu ASAR KOTHA NOY.');
  say('      Tobuo jodi dekhen, tahole:');
  say('        - onno kono job er row hote pare (contractor select korlei tar SOB job er');
  say('          unsubmitted kaj chole ase — job search korar agei). Reference column dekhun.');
  say('        - othoba browser e purono page/cache. Ctrl+F5 diye dekhun.');
} else {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  unsaved.forEach((r, i) => {
    const k = r.opsName + '|' + r.rate;
    const live = liveByOpKey[k] || 0;
    const dead = deadByOpKey[k] || 0;
    const ageDays = r.savedOn
      ? Math.max(0, Math.round((today - new Date(new Date(r.savedOn).setHours(0, 0, 0, 0))) / 86400000))
      : null;

    say('  [' + (i + 1) + ']  ' + r.opsName + '   qty=' + r.qty + '  rate=' + r.rate +
        '  value=' + r2(r.qty * r.rate));
    say('       contractor : ' + r.contractor + '  (' + r.contractorId + ')');
    say('       save hoyeche: ' + dstr(r.savedOn) + (ageDays != null ? '   (' + ageDays + ' din age)' : ''));
    say('       ei op e live bill e ache: ' + live + (dead ? ',  deleted bill e: ' + dead : ''));
    if (live > 0) say('       live bill: ' + (billsByOpKey[k] || []).join(', '));

    if (live > 0) {
      say('       >>> SANDEHOJONOK: ei op ekta LIVE BILL eo ache. Ekei kaj duibar bill hote pare.');
      say('           Amake janan.');
    } else if (ageDays != null && ageDays > 0) {
      say('       >>> PROTTYASHITO: keu ' + ageDays + ' din age SAVE korechilo, SUBMIT kore ni.');
      say('           Bill Details e asa thik ache — eta bill korar opekkhay ache.');
      say('           Deploy hoye gele ei row holud highlight + "Saved On" tarikh + banner dekhabe.');
    } else {
      say('       >>> AJKEI save hoyeche. Keu ajke kaj record korechhe kintu submit kore ni.');
    }
    say('');
  });

  const totalV = r2(unsaved.reduce((s, r) => s + r.qty * r.rate, 0));
  say('  mot ' + unsaved.length + ' ta row,  value ' + totalV);
  say('');
  say('  Ki korben:');
  say('    - Boidho kaj hole  : Bill Details e rekhe SUBMIT korun');
  say('    - Bhul kore hoyeche: oi row er "Delete" tipun (pending qty ferot chole jabe)');
}

say('');
say('  NOTE: ei script kichui change kore ni.');
say('='.repeat(112));
say('');

print(out.join('\n'));
