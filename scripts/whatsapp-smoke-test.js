/**
 * End-to-end smoke test: Maytapi -> Mongo -> OpenAI -> WhatsApp DM, in one run.
 *
 *   npm run whatsapp:smoke                      # every monitored group
 *   npm run whatsapp:smoke -- --group "<id>"    # just one
 *   npm run whatsapp:smoke -- --count 20        # messages per group (default 10)
 *   npm run whatsapp:smoke -- --keep            # leave the test rows in Mongo
 *   npm run whatsapp:smoke -- --yes             # don't pause for the ACK reply
 *
 * Every stage calls the same exported function the poller calls, so a pass
 * means the production path works - not that a parallel copy of it does.
 *
 * This sends real DMs to DEFAULT_OWNER_PHONE and spends real OpenAI tokens. It
 * does NOT post anything to any WhatsApp group.
 */
import { createInterface } from 'node:readline/promises';
import { config, assertConfigured } from '../src/whatsapp-monitor/config.js';
import {
  connect,
  ensureIndexes,
  close,
  groups,
  messages,
  concerns,
  alerts,
  owners,
  summaries,
} from '../src/whatsapp-monitor/db.js';
import { maytapi } from '../src/whatsapp-monitor/maytapi/client.js';
import { normaliseMessages } from '../src/whatsapp-monitor/maytapi/normalise.js';
import { checkSession, fetchBackToCursor, pollGroup } from '../src/whatsapp-monitor/poller/poll.js';
import { detectForGroup } from '../src/whatsapp-monitor/detector/detect.js';
import { runAckPoll } from '../src/whatsapp-monitor/router/acknowledge.js';
import { runEscalations } from '../src/whatsapp-monitor/router/escalate.js';
import { runFirstAlerts } from '../src/whatsapp-monitor/router/first-alert.js';
import {
  runRollingSummaries,
  runDailySummaries,
} from '../src/whatsapp-monitor/summariser/summarise.js';
import { istDayKey } from '../src/whatsapp-monitor/summariser/window.js';
import { buildSmokeMessage, tally, SMOKE_MARKER } from '../src/whatsapp-monitor/smoke.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const onlyGroup = value('--group', null);
const count = Number(value('--count', '10'));
const keep = flag('--keep');
const assumeYes = flag('--yes');

const runId = Date.now().toString(36);
/** The owner phone the escalation hop points at, so the chain has somewhere to go. */
const SMOKE_OWNER = `smoke-owner-${runId}`;

// fetchBackToCursor reads the page size from config, not from an argument. This
// is a one-shot script, so narrowing it here is simpler than threading an
// override through the production signature for the sake of a test.
config.maytapi.messageCount = count;

const results = [];
const fetchedByGroup = new Map();
let selected = [];

function line(state, name, reason) {
  const pad = state.padEnd(4);
  console.log(`${pad} ${name}${reason ? ` - ${reason}` : ''}`);
}

/** A stage never aborts the run: you want the whole picture, not the first failure. */
async function stage(name, fn) {
  let outcome;
  try {
    outcome = (await fn()) ?? { state: 'PASS' };
  } catch (err) {
    outcome = { state: 'FAIL', reason: err instanceof Error ? err.message : String(err) };
  }
  results.push({ name, ...outcome });
  line(outcome.state, name, outcome.reason);
  return outcome;
}

const fail = (reason) => ({ state: 'FAIL', reason });
const skip = (reason) => ({ state: 'SKIP', reason });
const pass = (reason) => ({ state: 'PASS', reason });

async function main() {
  console.log(`\nWhatsApp monitor smoke test - run ${runId}`);
  console.log(`${count} message(s) per group; alerts go to ${config.defaultOwnerPhone || '(nobody)'}\n`);

  await stage('0  preflight', async () => {
    assertConfigured();
    await connect();
    await ensureIndexes();
    if (!config.defaultOwnerPhone) return fail('DEFAULT_OWNER_PHONE is unset - nobody can be alerted');

    const query = onlyGroup ? { _id: onlyGroup } : { monitored: true };
    selected = await groups().find(query).toArray();
    if (selected.length === 0) return fail(onlyGroup ? `no group "${onlyGroup}"` : 'no monitored groups');

    const { ok } = await checkSession();
    if (!ok) return fail('Maytapi session is not logged in');
    return pass(`${selected.length} group(s), session logged in`);
  });

  if (selected.length === 0) return;

  await stage('1  fetch', async () => {
    const notes = [];
    for (const group of selected) {
      const startedAt = Date.now();
      // A null cursor asks for exactly one page - the last `count` messages -
      // rather than paging back through history we are not testing.
      const { fetched, pages } = await fetchBackToCursor(group._id, { joinedAt: null, lastTs: null });
      const ms = Date.now() - startedAt;
      fetchedByGroup.set(group._id, fetched);
      notes.push(`${group.name}: ${fetched.length} in ${pages} page(s), ${ms}ms`);
      if (ms > config.maytapi.groupBudgetMs) return fail(`${group.name} took ${ms}ms, over the budget`);
    }
    const empty = selected.filter((g) => fetchedByGroup.get(g._id).length === 0);
    if (empty.length === selected.length) return fail('every group returned zero messages');
    return pass(notes.join('; '));
  });

  await stage('2  normalise', () => {
    for (const group of selected) {
      for (const m of fetchedByGroup.get(group._id) ?? []) {
        if (!m.msgId) return fail(`${group.name}: a message has no msgId`);
        if (!(m.ts instanceof Date) || Number.isNaN(m.ts.getTime())) {
          return fail(`${group.name}: ${m.msgId} has no usable timestamp`);
        }
        if (m.type === 'info') return fail(`${group.name}: a system "info" row survived normalising`);
      }
    }
    const named = selected
      .flatMap((g) => fetchedByGroup.get(g._id) ?? [])
      .filter((m) => m.senderName).length;
    return pass(`${named} message(s) have a resolved sender name`);
  });

  await stage('3  ingest', async () => {
    const notes = [];
    for (const group of selected) {
      const fetched = fetchedByGroup.get(group._id) ?? [];
      if (fetched.length === 0) continue;

      // Lower the ingest floor to exactly cover what we just fetched. Nothing
      // older than this becomes reachable, and the floor is never raised back -
      // these are real messages and legitimate shadow-run data.
      const oldest = fetched.reduce((a, b) => (b.ts < a.ts ? b : a)).ts;
      const floor = new Date(oldest.getTime() - 1000);
      if (!group.joinedAt || group.joinedAt > floor) {
        await groups().updateOne({ _id: group._id }, { $set: { joinedAt: floor } });
        group.joinedAt = floor;
      }

      const { ingested, error } = await pollGroup(await groups().findOne({ _id: group._id }));
      if (error) return fail(`${group.name}: ${error}`);
      notes.push(`${group.name}: ${ingested}`);
    }
    const stored = await messages().countDocuments({ groupId: { $in: selected.map((g) => g._id) } });
    if (stored === 0) return fail('nothing was stored');
    return pass(`ingested ${notes.join(', ')}; ${stored} message(s) in Mongo`);
  });

  await stage('4  idempotence', async () => {
    let reIngested = 0;
    for (const group of selected) {
      const fresh = await groups().findOne({ _id: group._id });
      const { ingested } = await pollGroup(fresh);
      reIngested += ingested;
    }
    return reIngested === 0
      ? pass('a second identical poll stored nothing')
      : fail(`a second poll stored ${reIngested} message(s) - the unique msgId index is not holding`);
  });

  await stage('5  ttl', async () => {
    const indexes = await messages().indexes();
    const ttl = indexes.find((i) => i.name === 'receivedAt_ttl');
    if (!ttl) return fail('no receivedAt TTL index');
    if (ttl.expireAfterSeconds !== config.messageTtlSeconds) {
      return fail(`TTL is ${ttl.expireAfterSeconds}s, expected ${config.messageTtlSeconds}s`);
    }
    const sample = await messages().findOne({ groupId: selected[0]._id });
    if (sample && !(sample.receivedAt instanceof Date)) {
      return fail('receivedAt is not a Date - a TTL index on a number expires nothing, silently');
    }
    return pass(`${ttl.expireAfterSeconds}s on a BSON Date`);
  });

  const target = selected[0];
  await messages().insertOne(buildSmokeMessage(target._id, runId));

  await stage('6  classify', async () => {
    let raised = 0;
    for (const group of selected) raised += await detectForGroup(group);
    const left = await messages().countDocuments({
      groupId: { $in: selected.map((g) => g._id) },
      classified: false,
    });
    if (left > 0) return fail(`${left} message(s) left unclassified`);

    const mine = await smokeConcern();
    if (!mine) return fail('the synthetic breakdown message did not raise a concern');
    return pass(`${raised} concern(s) raised; the synthetic one came back as ${mine.category}/${mine.severity}`);
  });

  await stage('7  alert', async () => {
    const concern = await smokeConcern();
    if (!concern) return skip('no concern to alert on');
    if (!concern.ownerId) return fail('concern has no owner - routing resolved to nobody');

    // The first DM is no longer sent at detection: a concern waits 15 or 30
    // minutes so the people already in the group can deal with it. Backdating
    // the synthetic one exercises the real path without a half-hour pause.
    await concerns().updateOne(
      { _id: concern._id },
      { $set: { firstMsgTs: new Date(Date.now() - 24 * 60 * 60_000) } },
    );
    await runFirstAlerts();

    const row = await alerts().findOne({ concernId: concern._id, channel: 'owner' });
    if (!row) return fail('no alert row was written');
    if (!row.delivered) return fail(`alert not delivered: ${row.error ?? 'unknown error'}`);
    if (!row.maytapiMsgId) return fail('delivered but Maytapi returned no message id');
    return pass(`DM sent to ${row.toPhone}`);
  });

  await stage('8  ack', async () => {
    const concern = await smokeConcern();
    if (!concern) return skip('no concern to acknowledge');

    // The first look at a DM thread only starts the clock - by design, so that
    // an "ack" typed months ago cannot acknowledge today's concern. Priming it
    // here is what makes the reply below count.
    await runAckPoll();

    if (assumeYes) return skip('--yes given, nobody is there to reply');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`\n     Reply "ACK" to the WhatsApp DM, then press Enter... `);
    rl.close();

    const acknowledged = await runAckPoll();
    const after = await concerns().findOne({ _id: concern._id });
    if (after.status !== 'acknowledged') {
      return fail(`still ${after.status} after ${acknowledged} acknowledgement(s) - did the reply contain the word ACK?`);
    }
    return pass(`acknowledged by ${after.acknowledgedBy}`);
  });

  await stage('9  escalate', async () => {
    // The loop guard in nextEscalationTarget refuses a hop back to the concern's
    // own owner, so escalating to yourself needs a placeholder owner in between:
    // placeholder -> your number. The placeholder is never DMed; only the target
    // is, which is the hop being tested.
    await owners().updateOne(
      { _id: SMOKE_OWNER },
      {
        $set: {
          name: 'Smoke test placeholder',
          escalationTo: config.defaultOwnerPhone,
          lastAckTs: new Date(),
        },
      },
      { upsert: true },
    );

    const overdue = new Date(Date.now() - (config.defaultEscalateAfterMin + 5) * 60_000);
    const { insertedId } = await concerns().insertOne({
      groupId: target._id,
      category: 'machine_breakdown',
      severity: 'high',
      summary: `[SMOKE TEST ${runId}] escalation hop check`,
      ownerId: SMOKE_OWNER,
      messageIds: [],
      firstMsgTs: overdue,
      status: 'open',
      createdAt: overdue,
      acknowledgedAt: null,
      resolvedAt: null,
      escalatedTo: [],
      [SMOKE_MARKER]: runId,
    });

    const escalated = await runEscalations();
    const after = await concerns().findOne({ _id: insertedId });
    if (!(after.escalatedTo ?? []).includes(config.defaultOwnerPhone)) {
      return fail(`not escalated (${escalated} in this pass) - escalatedTo is ${JSON.stringify(after.escalatedTo)}`);
    }
    const row = await alerts().findOne({ concernId: insertedId, channel: 'escalation' });
    if (!row?.delivered) return fail(`escalation DM not delivered: ${row?.error ?? 'no alert row'}`);
    return pass(`hop reached ${config.defaultOwnerPhone}`);
  });

  await stage('10 summaries', async () => {
    const rolling = await runRollingSummaries();
    const daily = await runDailySummaries();
    const ids = selected.map((g) => g._id);

    const rollingRows = await summaries().countDocuments({ groupId: { $in: ids }, kind: 'rolling' });
    if (rollingRows === 0) return fail(`no rolling summary written (${rolling} reported)`);

    const today = istDayKey(new Date());
    const dailyRow = await summaries().findOne({ groupId: { $in: ids }, kind: 'daily', dayKey: today });
    if (!dailyRow) return fail(`no daily summary for IST day ${today} (${daily} reported)`);
    return pass(`${rollingRows} rolling, daily dayKey ${dailyRow.dayKey}`);
  });

  await stage('11 dashboard api', async () => {
    const base = process.env.SMOKE_API_BASE || 'http://localhost:3001';
    const url = `${base}/api/whatsapp-monitor/health`;

    let unauthenticated;
    try {
      unauthenticated = await fetch(url);
    } catch {
      return skip(`${base} is not reachable - start the backend, or set SMOKE_API_BASE`);
    }
    if (unauthenticated.status !== 401) return fail(`health returned ${unauthenticated.status} without a token, expected 401`);

    const user = process.env.CDC_BILLS_ADMIN1_USER;
    const password = process.env.CDC_BILLS_ADMIN1_PASSWORD;
    if (!user || !password) return pass('401 without a token (no admin credentials in env to test the 200)');

    const auth = await fetch(`${base}/api/cdc-bills/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
    });
    if (!auth.ok) return fail(`could not sign in: ${auth.status}`);
    const { token } = await auth.json();

    const headers = { authorization: `Bearer ${token}` };
    for (const path of ['/health', '/groups', '/concerns']) {
      const res = await fetch(`${base}/api/whatsapp-monitor${path}`, { headers });
      if (!res.ok) return fail(`${path} returned ${res.status} with a valid token`);
    }
    return pass('401 without a token, 200 on health, groups and concerns with one');
  });
}

/** The concern raised from the synthetic message, if the classifier caught it. */
async function smokeConcern() {
  return concerns().findOne({ messageIds: `smoke-${runId}` });
}

async function cleanup() {
  if (keep) {
    console.log(`\nLeft in place (--keep): messages/concerns tagged ${SMOKE_MARKER}=${runId}, owner ${SMOKE_OWNER}.`);
    return;
  }
  const concern = await smokeConcern();
  const tagged = await concerns().find({ [SMOKE_MARKER]: runId }).toArray();
  const ids = [...new Set([concern?._id, ...tagged.map((c) => c._id)].filter(Boolean))];

  await alerts().deleteMany({ concernId: { $in: ids } });
  await concerns().deleteMany({ _id: { $in: ids } });
  await messages().deleteMany({ [SMOKE_MARKER]: runId });
  await owners().deleteOne({ _id: SMOKE_OWNER });
  console.log('\nCleaned up the synthetic message, its concerns, alerts and the placeholder owner.');
}

try {
  await main();
} finally {
  try {
    if (selected.length > 0) await cleanup();
  } catch (err) {
    console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await close();
}

const counts = tally(results);
console.log(
  `\n${counts.passed}/${counts.total} passed` +
    (counts.failed ? `, ${counts.failed} FAILED` : '') +
    (counts.skipped ? `, ${counts.skipped} skipped` : ''),
);
process.exit(counts.ok ? 0 : 1);
