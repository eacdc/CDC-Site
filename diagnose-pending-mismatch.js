// ============================================================================
//  JobopsMaster pending-qty mismatch DRILL-DOWN  —  READ ONLY
//
//  diagnose-contractor-wd.js er "F" section e je 5283 ta mismatch peyechilam,
//  ei script tar KARON ber kore. Protita mismatch ke evidence dekhe category
//  te bhag kore, tarpor kon karon ta dominant seta summary te dekhay.
//
//  Chalanor niyom:
//    mongosh "<CONNECTION_STRING>" --file scripts/diagnose-pending-mismatch.js > mismatch.txt
// ============================================================================

const DB_NAME    = 'Contractor_PO';
const JOB_FILTER = '';   // ekta job dekhte: 'J03362/25-26'.  '' = sob
const SHOW_ROWS  = 25;   // prottek category te koto ta example dekhabe
const TOL        = 0.5;  // eto tuku diff ignore kora hobe

const d = db.getSiblingDB(DB_NAME);

const r2   = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s == null ? '' : s).trim();
const unsaved = od => norm(od && od.savedInBill) === 'No';
const dstr = v => (v ? new Date(v).toISOString().slice(0, 10) : '-');
const tms  = v => (v ? new Date(v).getTime() : 0);

const out = [];
const say = l => out.push(l);

// ------------------------------------------------- 1. operations collection --
const opById = {};              // opId -> opsName
const opIdsByName = {};         // opsName -> [opId, ...]   (duplicate naam dhorar jonno)
d.getCollection('operations').find({}, { opsName: 1 }).forEach(o => {
  const id = String(o._id), nm = norm(o.opsName);
  opById[id] = nm;
  if (!opIdsByName[nm]) opIdsByName[nm] = [];
  opIdsByName[nm].push(id);
});
const dupNames = Object.keys(opIdsByName).filter(n => opIdsByName[n].length > 1);

// ------------------------------------------------------------- 2. contractors --
const nameById = {};
d.getCollection('Contractor').find({}, { contractorId: 1, name: 1 }).forEach(c => {
  nameById[norm(c.contractorId)] = norm(c.name);
});

// ------------------------------------------------------------------ 3. Bills --
// jobNumber|opsName|rate -> { live: qty, dead: qty, liveBills: [], deadBills: [] }
const billQty = {};
d.getCollection('Bills').find({}).forEach(b => {
  const dead = Number(b.isDeleted || 0) === 1;
  (b.jobs || []).forEach(j => {
    if (j.isAdhoc) return;
    const jn = norm(j.jobNumber);
    (j.ops || []).forEach(op => {
      const k = [jn, norm(op.opsName), r2(op.rate)].join('|');
      if (!billQty[k]) billQty[k] = { live: 0, dead: 0, liveBills: [], deadBills: [] };
      const q = Number(op.qtyCompleted || 0);
      if (dead) { billQty[k].dead += q; billQty[k].deadBills.push(b.billNumber); }
      else      { billQty[k].live += q; billQty[k].liveBills.push(b.billNumber); }
    });
  });
});

// --------------------------------------------------------- 4. Contractor_WD --
// jobId|opId -> { total, billed, unsaved, rows, contractors:Set }
const wdByJobOp = {};
d.getCollection('Contractor_WD').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).forEach(doc => {
  if (doc.isAdhoc === true) return;
  const jid = norm(doc.jobId);
  if (!jid) return;
  (doc.opsDone || []).forEach(od => {
    const oid = norm(od.opsId);
    if (!oid || oid === 'null') return;
    const k = jid + '|' + oid;
    if (!wdByJobOp[k]) wdByJobOp[k] = { total: 0, billed: 0, unsaved: 0, rows: 0, contractors: {} };
    const q = Number(od.opsDoneQty || 0);
    wdByJobOp[k].total += q;
    wdByJobOp[k].rows++;
    if (unsaved(od)) wdByJobOp[k].unsaved += q; else wdByJobOp[k].billed += q;
    wdByJobOp[k].contractors[nameById[norm(doc.contractorId)] || norm(doc.contractorId)] = true;
  });
});

// ------------------------------------------------------- 5. jobId format check --
// same job number, alada format (J03362/25-26 vs J03362_25_26)
const byNormJob = {};
const allJobIds = [];
d.getCollection('JobopsMaster').find({}, { jobId: 1 }).forEach(j => {
  const raw = norm(j.jobId);
  allJobIds.push(raw);
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!byNormJob[key]) byNormJob[key] = {};
  byNormJob[key][raw] = true;
});
const formatClashes = Object.keys(byNormJob)
  .map(k => Object.keys(byNormJob[k]))
  .filter(v => v.length > 1);

// ---------------------------------------------------- 6. mismatch classify ----
const cats = {
  MISSING_OP_DOC:        { rows: [], why: 'JobopsMaster er opId er jonno Operation document nei -> opsName "Unknown" hoye jay. save/jobopsmaster (routes.js:9636) ar bill delete (routes.js:11094) dutoi naam diye match kore, tai duto i vul row e lage.' },
  DUP_OPS_NAME:          { rows: [], why: 'Ei opsName operations collection e ekadhik bar ache. Bill delete route Operation.findOne({opsName}) kore (routes.js:11094) -> ARBITRARY opId paay -> vul op e pending restore hoy ar Contractor_WD row khuje pay na.' },
  DELETED_BILL:          { rows: [], why: 'Ei job+op er ekta DELETED bill ache. Delete route pending restore korechhe kintu Contractor_WD row ta thik moto komay ni.' },
  PENDING_NEVER_REDUCED: { rows: [], why: 'pending == total, othocho kaj record ache. Op ta abar toiri/re-add hoyeche (POST /jobs/jobopsmaster e pendingOpsQty = totalOpsQty boshiye dey, routes.js:7325), othoba pending puro restore hoye geche.' },
  PARTIAL_OFF:           { rows: [], why: 'Onno kono karone pending ar record kora kaj mile na.' }
};

let opsScanned = 0, missingOpDocCount = 0;

d.getCollection('JobopsMaster').find(JOB_FILTER ? { jobId: JOB_FILTER } : {}).forEach(j => {
  const jid = norm(j.jobId);
  const seg = norm(j.segmentName);
  (j.ops || []).forEach(o => {
    opsScanned++;
    const oid     = norm(o.opId);
    const opsName = opById[oid];
    const rate    = r2(o.valuePerBook);
    const total   = Number(o.totalOpsQty || 0);
    const pending = Number(o.pendingOpsQty || 0);
    const expDone = total - pending;

    const wd      = wdByJobOp[jid + '|' + oid] || { total: 0, billed: 0, unsaved: 0, rows: 0, contractors: {} };
    const actDone = wd.total;
    const diff    = r2(actDone - expDone);

    if (opsName === undefined) missingOpDocCount++;
    if (Math.abs(diff) <= TOL) return;

    const bk  = [jid, norm(opsName), rate].join('|');
    const bq  = billQty[bk] || { live: 0, dead: 0, liveBills: [], deadBills: [] };

    const rec = {
      job: jid,
      seg: seg || '-',
      opsName: opsName === undefined ? '(OP DOC NEI: ' + oid + ')' : opsName,
      rate: rate,
      total: total,
      pending: pending,
      expDone: expDone,
      actDone: actDone,
      diff: diff,
      wdBilled: wd.billed,
      wdUnsaved: wd.unsaved,
      wdRows: wd.rows,
      billLive: bq.live,
      billDead: bq.dead,
      deadBills: bq.deadBills.join(','),
      created: dstr(o.creationDate),
      updated: dstr(o.lastUpdatedDate),
      contractors: Object.keys(wd.contractors).slice(0, 2).join(', ')
    };

    // --- classification: sobcheye jorali evidence age ---
    if (opsName === undefined)                          cats.MISSING_OP_DOC.rows.push(rec);
    else if (opIdsByName[opsName] && opIdsByName[opsName].length > 1) cats.DUP_OPS_NAME.rows.push(rec);
    else if (bq.dead > 0)                               cats.DELETED_BILL.rows.push(rec);
    else if (Math.abs(total - pending) <= TOL && actDone > TOL) cats.PENDING_NEVER_REDUCED.rows.push(rec);
    else                                                cats.PARTIAL_OFF.rows.push(rec);
  });
});

// ------------------------------------------------------------------ output ----
const sumDiff = a => a.reduce((s, x) => s + Math.abs(x.diff), 0);

say('');
say('='.repeat(112));
say('  JobopsMaster PENDING MISMATCH DRILL-DOWN   db: ' + DB_NAME + (JOB_FILTER ? '   job: ' + JOB_FILTER : '   (sob job)'));
say('='.repeat(112));
say('  JobopsMaster operations scanned : ' + opsScanned);
say('  Operation doc missing (opId er) : ' + missingOpDocCount);
say('  operations collection e naam    : ' + Object.keys(opIdsByName).length + '  (er moddhe DUPLICATE naam: ' + dupNames.length + ')');
say('  Bills documents                 : ' + d.getCollection('Bills').countDocuments());

// -- duplicate operation names
say('');
say('-'.repeat(112));
say('1)  operations COLLECTION E DUPLICATE opsName  —  ei gulo naam-based matching ke bhange');
say('-'.repeat(112));
if (!dupNames.length) say('  (kichu nei)');
dupNames.slice(0, SHOW_ROWS).forEach(n => {
  say('  ' + String(n).slice(0, 50).padEnd(52) + opIdsByName[n].length + ' ta different opId');
});
if (dupNames.length > SHOW_ROWS) say('  ... aro ' + (dupNames.length - SHOW_ROWS) + ' ta');

// -- jobId format clashes
say('');
say('-'.repeat(112));
say('2)  EKEI JOB NUMBER, ALADA FORMAT  (J03362/25-26  vs  J03362_25_26)');
say('-'.repeat(112));
if (!formatClashes.length) say('  (kichu nei)');
formatClashes.slice(0, SHOW_ROWS).forEach(v => say('  ' + v.join('   <->   ')));
if (formatClashes.length > SHOW_ROWS) say('  ... aro ' + (formatClashes.length - SHOW_ROWS) + ' ta');

// -- categories
Object.keys(cats).forEach(name => {
  const c = cats[name];
  say('');
  say('-'.repeat(112));
  say('3.' + name + '   —   ' + c.rows.length + ' operation,  mot diff qty ' + r2(sumDiff(c.rows)));
  say('-'.repeat(112));
  say('  ' + c.why);
  if (!c.rows.length) { say(''); say('  (kichu nei)'); return; }
  say('');
  c.rows.slice(0, SHOW_ROWS).forEach(r => {
    say('  ' + r.job.padEnd(17) + String(r.opsName).slice(0, 26).padEnd(28) +
        'total=' + String(r.total).padEnd(10) + 'pend=' + String(r.pending).padEnd(10) +
        'expDone=' + String(r.expDone).padEnd(10) + 'actDone=' + String(r.actDone).padEnd(10) +
        'diff=' + String(r.diff).padEnd(10));
    say('        wd[billed=' + r.wdBilled + ' unsaved=' + r.wdUnsaved + ' rows=' + r.wdRows + ']' +
        '  bill[live=' + r.billLive + ' deleted=' + r.billDead + (r.deadBills ? ' #' + r.deadBills : '') + ']' +
        '  created=' + r.created + ' updated=' + r.updated +
        (r.contractors ? '  [' + r.contractors + ']' : ''));
  });
  if (c.rows.length > SHOW_ROWS) say('  ... aro ' + (c.rows.length - SHOW_ROWS) + ' ta');
});

say('');
say('='.repeat(112));
say('  SUMMARY  —  kon karon ta dominant');
say('='.repeat(112));
const ranked = Object.keys(cats).map(n => ({ n: n, c: cats[n].rows.length, q: r2(sumDiff(cats[n].rows)) }))
                     .sort((a, b) => b.c - a.c);
ranked.forEach(r => say('  ' + r.n.padEnd(26) + String(r.c).padStart(6) + ' operation      diff qty ' + r.q));
say('');
say('  duplicate opsName (operations)  : ' + dupNames.length);
say('  jobId format clash              : ' + formatClashes.length);
say('  Operation doc missing           : ' + missingOpDocCount);
say('');
say('  NOTE: ei script kichui change kore na — sudhu pore ar report dey.');
say('='.repeat(112));
say('');

print(out.join('\n'));
