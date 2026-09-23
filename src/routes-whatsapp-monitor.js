/**
 * WhatsApp Office-Group Monitor - dashboard API
 *
 * Mounted at `/api/whatsapp-monitor`, behind the same CDC Bills JWT auth the
 * other tools use, so the team has one login rather than a separate password.
 * Writes additionally require an admin role.
 *
 * Read routes:
 *   GET   /health                    monitor status, last run age, error count
 *   GET   /groups                    every group, with open-concern counts
 *   GET   /groups/:id                one group: summaries, concerns, messages
 *   GET   /concerns                  filterable by status/category/group
 *   GET   /concerns/:id              one concern: its messages and alert log
 *   GET   /runs                      last 100 runs
 *   GET   /owners                    owners and routing rules
 *
 * Write routes (admin):
 *   PATCH /groups/:id                monitored / department / joinedAt
 *   POST  /concerns/:id/acknowledge  from the dashboard rather than by DM
 *   POST  /concerns/:id/resolve
 *   PUT   /owners/:phone             upsert an owner
 *   DELETE /owners/:phone
 *   PUT   /routing                   upsert a routing rule
 *   DELETE /routing
 *
 * Every handler runs through `handle`, which turns a thrown error into a 500
 * with a logged cause rather than a hung request.
 */
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { requireCdcBillsAuth, requireCdcBillsAdmin } from './middleware/cdc-bills-auth.js';
import { config } from './whatsapp-monitor/config.js';
import { logger } from './whatsapp-monitor/logger.js';
import {
  connect,
  groups,
  messages,
  concerns,
  alerts,
  summaries,
  owners,
  routing,
  runs,
} from './whatsapp-monitor/db.js';
import { whatsappMonitorHealth } from './whatsapp-monitor/index.js';
import { CONCERN_CATEGORIES, GROUP_KINDS } from './whatsapp-monitor/llm/types.js';
import { threadQueryFor } from './whatsapp-monitor/detector/threads.js';
import { importGroups } from './whatsapp-monitor/maytapi/import.js';
import { LIVE_STATUSES } from './whatsapp-monitor/concerns-live.js';

const router = Router();

/**
 * The monitor owns its own Mongo connection, and it is only opened at boot when
 * WHATSAPP_MONITOR_ENABLED is true. The dashboard must work regardless - someone
 * reading yesterday's concerns does not care whether the poller is running - so
 * each request ensures the connection itself. connect() is idempotent.
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await connect();
      await fn(req, res);
    } catch (err) {
      logger.error({ path: req.path, err: String(err) }, 'dashboard api error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  };
}

/** Mongo ids arrive as strings from the client and are not necessarily valid. */
function toObjectId(value) {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

// `possibly_resolved` is a view of open concerns, not a stored status - the
// resolution hint is advisory and only a human moves a concern out of `open`.
const STATUSES = ['open', 'possibly_resolved', 'acknowledged', 'resolved'];

// ---------------------------------------------------------------- reads

router.get('/health', requireCdcBillsAuth, handle(async (_req, res) => {
  res.json(await whatsappMonitorHealth());
}));

router.get('/groups', requireCdcBillsAuth, handle(async (_req, res) => {
  const all = await groups().find({}).sort({ monitored: -1, name: 1 }).toArray();

  // One grouped count beats a query per group; this list is rendered on the
  // dashboard's front page and is the most frequently hit route.
  const counts = await concerns()
    .aggregate([
      { $match: { status: { $in: LIVE_STATUSES } } },
      { $group: { _id: { groupId: '$groupId', status: '$status' }, n: { $sum: 1 } } },
    ])
    .toArray();

  const byGroup = new Map();
  for (const c of counts) {
    const entry = byGroup.get(c._id.groupId) ?? { open: 0, acknowledged: 0 };
    entry[c._id.status] = c.n;
    byGroup.set(c._id.groupId, entry);
  }

  const latest = await summaries()
    .aggregate([
      { $match: { kind: 'rolling' } },
      { $sort: { periodEnd: -1 } },
      { $group: { _id: '$groupId', summary: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const summaryByGroup = new Map(latest.map((s) => [s._id, s.summary]));

  res.json({
    groups: all.map((g) => ({
      ...g,
      concernCounts: byGroup.get(g._id) ?? { open: 0, acknowledged: 0 },
      rollingSummary: summaryByGroup.get(g._id) ?? null,
    })),
  });
}));

router.get('/groups/:id', requireCdcBillsAuth, handle(async (req, res) => {
  const group = await groups().findOne({ _id: req.params.id });
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const [daily, rolling, groupConcerns, recent] = await Promise.all([
    summaries().find({ groupId: group._id, kind: 'daily' }).sort({ periodEnd: -1 }).limit(30).toArray(),
    summaries().find({ groupId: group._id, kind: 'rolling' }).sort({ periodEnd: -1 }).limit(1).next(),
    concerns()
      .find({ groupId: group._id, status: { $in: LIVE_STATUSES } })
      .sort({ createdAt: -1 })
      .toArray(),
    messages().find({ groupId: group._id }).sort({ ts: -1 }).limit(50).toArray(),
  ]);

  res.json({
    group,
    dailySummaries: daily,
    rollingSummary: rolling,
    concerns: groupConcerns,
    messages: recent.reverse(), // oldest first reads like a conversation
  });
}));

router.get('/concerns', requireCdcBillsAuth, handle(async (req, res) => {
  const { status, category, groupId, limit } = req.query;

  const query = {};
  if (status === 'possibly_resolved') {
    query.status = 'open';
    query.resolutionHint = { $exists: true };
  } else if (status && STATUSES.includes(status)) {
    query.status = status;
  }
  if (category && CONCERN_CATEGORIES.includes(category)) query.category = category;
  if (groupId) query.groupId = groupId;

  const cap = Math.min(Number(limit) || 100, 500);
  const rows = await concerns().find(query).sort({ createdAt: -1 }).limit(cap).toArray();

  const names = new Map(
    (await groups().find({ _id: { $in: [...new Set(rows.map((r) => r.groupId))] } }).toArray())
      .map((g) => [g._id, g.name]),
  );

  res.json({
    concerns: rows.map((c) => ({ ...c, groupName: names.get(c.groupId) ?? c.groupId })),
    categories: CONCERN_CATEGORIES,
    statuses: STATUSES,
  });
}));

router.get('/concerns/:id', requireCdcBillsAuth, handle(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Invalid concern id' });

  const concern = await concerns().findOne({ _id });
  if (!concern) return res.status(404).json({ error: 'Concern not found' });

  // The whole reply thread, not just the messages the classifier cited: the
  // question a person opens this page to answer is "what happened", and a
  // conversation with its replies removed does not answer it.
  const threadQuery = threadQueryFor(concern);

  const [group, thread, alertLog] = await Promise.all([
    groups().findOne({ _id: concern.groupId }),
    messages().find(threadQuery).sort({ ts: 1 }).toArray(),
    alerts().find({ concernId: _id }).sort({ sentAt: 1 }).toArray(),
  ]);

  const cited = new Set(concern.messageIds ?? []);

  res.json({
    concern,
    groupName: group?.name ?? concern.groupId,
    // Messages may already have aged out under the 60-day TTL while the concern
    // itself lives on, so this can legitimately be shorter than messageIds.
    messages: thread.map((m) => ({ ...m, triggered: cited.has(m.msgId) })),
    alerts: alertLog,
  });
}));

router.get('/runs', requireCdcBillsAuth, handle(async (_req, res) => {
  res.json({ runs: await runs().find({}).sort({ startedAt: -1 }).limit(100).toArray() });
}));

router.get('/owners', requireCdcBillsAuth, handle(async (_req, res) => {
  const [ownerRows, routingRows] = await Promise.all([
    owners().find({}).sort({ name: 1 }).toArray(),
    routing().find({}).sort({ groupId: 1, category: 1 }).toArray(),
  ]);
  res.json({
    owners: ownerRows,
    routing: routingRows,
    groupKinds: GROUP_KINDS,
    alertAfterMin: config.alertAfterMin,
    categories: CONCERN_CATEGORIES,
    defaults: {
      ownerPhone: config.defaultOwnerPhone || null,
      cooldownMin: config.defaultCooldownMin,
      escalateAfterMin: config.defaultEscalateAfterMin,
    },
  });
}));

// --------------------------------------------------------------- writes

/**
 * Pulls the group list from WhatsApp again, so a group the CDC number was just
 * added to shows up without anyone running a script on a machine they may not
 * have.
 *
 * New groups arrive OFF. A button that silently started monitoring - and
 * paying to classify - a thirteenth group would be the wrong kind of helpful.
 */
router.post('/groups/refresh', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  let summary;
  try {
    summary = await importGroups();
  } catch (err) {
    // 502 and the real message: "the session is logged out" is something an
    // admin can act on, and "Internal error" is not.
    logger.error({ err: String(err) }, 'group refresh failed');
    return res.status(502).json({ error: `WhatsApp did not answer: ${String(err.message ?? err)}` });
  }

  logger.info(
    {
      found: summary.found,
      added: summary.added.length,
      renamed: summary.renamed.length,
      missing: summary.missing.length,
      by: req.cdcBillsUser?.userKey,
    },
    'groups refreshed from whatsapp',
  );
  res.json(summary);
}));

/**
 * Removes a group and its stored messages.
 *
 * Its concerns, their alerts and the summaries stay: those are the record of
 * what happened and who was told, while the messages are the bulk of the
 * storage. A concern whose group is gone falls back to showing the raw group
 * id, and refreshing the group back restores the name.
 *
 * Refuses while concerns are still live. Deleting is a tidy-up - anything the
 * number is still in comes back on the next refresh - and a tidy-up must not
 * quietly erase a breakdown somebody is being alerted about.
 */
router.delete('/groups/:id', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const group = await groups().findOne({ _id: req.params.id });
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const live = await concerns().countDocuments({
    groupId: group._id,
    status: { $in: LIVE_STATUSES },
  });
  if (live > 0) {
    return res.status(409).json({
      error:
        `${live} concern${live === 1 ? ' is' : 's are'} still open in this group - ` +
        'resolve them first, or delete it from the command line with --force.',
      openConcerns: live,
    });
  }

  const { deletedCount } = await messages().deleteMany({ groupId: group._id });
  await groups().deleteOne({ _id: group._id });

  logger.info(
    { groupId: group._id, name: group.name, deletedMessages: deletedCount, by: req.cdcBillsUser?.userKey },
    'group deleted from dashboard',
  );
  res.json({ deleted: group.name, deletedMessages: deletedCount });
}));

router.patch('/groups/:id', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const group = await groups().findOne({ _id: req.params.id });
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const { monitored, department, joinedAt, kind, ownerPhone, escalationTo } = req.body ?? {};
  const update = {};

  if (kind !== undefined) {
    if (!GROUP_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${GROUP_KINDS.join(', ')}` });
    }
    update.kind = kind;
  }

  // The one person alerted for everything in this group. Cleared with null or
  // an empty string, which is how the Admin dropdown says "no-one in
  // particular" and falls back to the category routing rules.
  if (ownerPhone !== undefined) {
    if (!ownerPhone) {
      update.ownerPhone = null;
    } else if (!PHONE.test(ownerPhone)) {
      return res.status(400).json({ error: 'ownerPhone must be 10-15 digits, no + or spaces' });
    } else if (!(await owners().findOne({ _id: ownerPhone }))) {
      // Alerting a number with no owner doc would send a DM signed "unknown"
      // and give the escalation chain nowhere to go next.
      return res.status(400).json({ error: `Add ${ownerPhone} as a person first` });
    } else {
      update.ownerPhone = ownerPhone;
    }
  }

  if (typeof monitored === 'boolean') {
    update.monitored = monitored;
    // Same rule as the CLI: turning a group on for the first time sets the
    // ingest floor to now, and toggling off/on again does not move it.
    if (monitored && !group.joinedAt) update.joinedAt = new Date();
  }
  if (department !== undefined) update.department = department || null;

  if (joinedAt !== undefined) {
    const parsed = new Date(joinedAt);
    if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid joinedAt' });
    update.joinedAt = parsed;
  }

  // The group's escalation ladder, in order. Replaced whole rather than
  // patched entry by entry, so there is one validation path and no way to end
  // up half-applied.
  if (escalationTo !== undefined) {
    if (!Array.isArray(escalationTo)) {
      return res.status(400).json({ error: 'escalationTo must be a list of phone numbers' });
    }
    if (escalationTo.length > MAX_LADDER) {
      return res.status(400).json({ error: `At most ${MAX_LADDER} people in the ladder` });
    }
    if (new Set(escalationTo).size !== escalationTo.length) {
      return res.status(400).json({ error: 'The same person appears twice in the ladder' });
    }

    for (const phone of escalationTo) {
      if (typeof phone !== 'string' || !PHONE.test(phone)) {
        return res.status(400).json({ error: `"${phone}" is not a phone number` });
      }
      if (!(await owners().findOne({ _id: phone }))) {
        return res.status(400).json({ error: `Add ${phone} as a person first` });
      }
    }
    update.escalationTo = escalationTo;
  }

  // Checked against the state this request would leave behind, not just the
  // field it happened to touch - otherwise moving the alerted person onto their
  // own ladder slips through by changing the other end of the pair.
  //
  // Told rather than silently dropped: in Admin this is almost always a
  // mistake, and quietly ignoring it leaves someone believing the ladder is one
  // person longer than it is.
  const finalOwner = update.ownerPhone !== undefined ? update.ownerPhone : group.ownerPhone;
  const finalLadder = update.escalationTo ?? group.escalationTo ?? [];

  if (finalOwner && finalLadder.includes(finalOwner)) {
    if (update.ownerPhone !== undefined) {
      // Naming someone as the person alerted while they sit on the ladder is a
      // promotion, not a mistake: they now get the first DM instead of a later
      // one. Rejecting it left a group whose only two people were both on the
      // ladder with no valid choice on the screen at all.
      update.escalationTo = finalLadder.filter((phone) => phone !== finalOwner);
    } else {
      // The other direction - adding the alerted person to their own ladder -
      // is a mistake, and saying so beats silently dropping the entry and
      // leaving somebody believing the ladder is one person longer.
      return res.status(400).json({ error: 'The person alerted cannot also be on the ladder' });
    }
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await groups().updateOne({ _id: group._id }, { $set: update });
  logger.info({ groupId: group._id, update, by: req.cdcBillsUser?.userKey }, 'group updated from dashboard');
  res.json({ group: await groups().findOne({ _id: group._id }) });
}));

/**
 * Acknowledge and resolve are guarded on the current status, so two people
 * clicking at once cannot double-apply, and the response says whether this
 * request was the one that changed it.
 */
async function transition(req, res, { from, to, stamp }) {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Invalid concern id' });

  const now = new Date();
  const result = await concerns().findOneAndUpdate(
    { _id, status: { $in: from } },
    { $set: { status: to, [stamp]: now, [`${stamp}By`]: req.cdcBillsUser?.userKey ?? null } },
    { returnDocument: 'after' },
  );

  if (!result) {
    const existing = await concerns().findOne({ _id });
    if (!existing) return res.status(404).json({ error: 'Concern not found' });
    return res.status(409).json({ error: `Concern is already ${existing.status}`, concern: existing });
  }

  logger.info({ concernId: String(_id), to, by: req.cdcBillsUser?.userKey }, 'concern transitioned from dashboard');
  res.json({ concern: result });
}

router.post('/concerns/:id/acknowledge', requireCdcBillsAuth, handle((req, res) =>
  transition(req, res, { from: ['open'], to: 'acknowledged', stamp: 'acknowledgedAt' }),
));

router.post('/concerns/:id/resolve', requireCdcBillsAuth, handle((req, res) =>
  transition(req, res, { from: ['open', 'acknowledged'], to: 'resolved', stamp: 'resolvedAt' }),
));

/** Phones are stored bare (no "+", no spaces) because that is what Maytapi wants. */
const PHONE = /^\d{10,15}$/;
// A ladder longer than this is not an escalation path, it is a mailing list.
const MAX_LADDER = 10;

router.put('/owners/:phone', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const phone = String(req.params.phone).trim();
  if (!PHONE.test(phone)) {
    return res.status(400).json({ error: 'Phone must be digits only, international format, no + or spaces' });
  }

  const { name, role, department, escalationTo } = req.body ?? {};
  if (escalationTo && !PHONE.test(String(escalationTo))) {
    return res.status(400).json({ error: 'escalationTo must be digits only' });
  }
  if (escalationTo && String(escalationTo) === phone) {
    // Self-escalation would make the chain a no-op that looks configured.
    return res.status(400).json({ error: 'An owner cannot escalate to themselves' });
  }

  await owners().updateOne(
    { _id: phone },
    {
      $set: {
        name: name ?? null,
        role: role ?? null,
        department: department ?? null,
        escalationTo: escalationTo ? String(escalationTo) : null,
      },
    },
    { upsert: true },
  );
  res.json({ owner: await owners().findOne({ _id: phone }) });
}));

router.delete('/owners/:phone', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const phone = String(req.params.phone).trim();
  const inUse = await routing().countDocuments({ ownerPhone: phone });
  if (inUse > 0) {
    // Deleting them would silently break every rule pointing at them.
    return res.status(409).json({ error: `${inUse} routing rule(s) still point at this owner` });
  }
  const { deletedCount } = await owners().deleteOne({ _id: phone });
  if (deletedCount === 0) return res.status(404).json({ error: 'Owner not found' });
  res.json({ deleted: phone });
}));

router.put('/routing', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const { groupId, category, ownerPhone, cooldownMin, escalateAfterMin } = req.body ?? {};

  if (!groupId) return res.status(400).json({ error: 'groupId is required ("*" for any group)' });
  if (!CONCERN_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CONCERN_CATEGORIES.join(', ')}` });
  }
  if (!PHONE.test(String(ownerPhone ?? ''))) {
    return res.status(400).json({ error: 'ownerPhone must be digits only' });
  }
  if (!(await owners().findOne({ _id: String(ownerPhone) }))) {
    // A rule pointing at a non-existent owner routes alerts into a void.
    return res.status(400).json({ error: 'No owner exists with that phone - add the owner first' });
  }

  const row = { groupId, category, ownerPhone: String(ownerPhone) };
  if (cooldownMin !== undefined) row.cooldownMin = Number(cooldownMin) || undefined;
  if (escalateAfterMin !== undefined) row.escalateAfterMin = Number(escalateAfterMin) || undefined;

  await routing().updateOne({ groupId, category }, { $set: row }, { upsert: true });
  res.json({ routing: await routing().findOne({ groupId, category }) });
}));

router.delete('/routing', requireCdcBillsAuth, requireCdcBillsAdmin, handle(async (req, res) => {
  const { groupId, category } = req.query;
  if (!groupId || !category) return res.status(400).json({ error: 'groupId and category are required' });

  const { deletedCount } = await routing().deleteOne({ groupId, category });
  if (deletedCount === 0) return res.status(404).json({ error: 'Routing rule not found' });
  res.json({ deleted: { groupId, category } });
}));

export default router;
