import { config } from '../config.js';
import { logger } from '../logger.js';
import { messages, summaries, groups } from '../db.js';
import { llm } from '../llm/index.js';
import { istDayBounds, tsRange } from './window.js';
import { isEmptySummary } from './parse.js';

const toLlm = (m) => ({ senderName: m.senderName, ts: m.ts, text: m.text });

/** Media with no caption carries no signal and costs tokens. */
const withText = (list) => list.filter((m) => (m.text ?? '').trim().length > 0);

async function latest(groupId, kind) {
  return summaries().find({ groupId, kind }).sort({ periodEnd: -1 }).limit(1).next();
}

/**
 * Rolling summaries: every ROLLING_SUMMARY_CRON, per group with new messages.
 *
 * Messages are selected by **receivedAt**, not ts. Every message is ingested
 * exactly once, so a receivedAt cursor guarantees each is summarised at least
 * once and none are skipped. Selecting by ts would silently lose late arrivals
 * — a message whose ts falls inside an already-summarised window would never
 * qualify again. This is the "re-summarise tolerantly" requirement.
 */
export async function runRollingSummaries() {
  let written = 0;

  try {
    const monitored = await groups().find({ monitored: true }).toArray();

    for (const group of monitored) {
      try {
        const previous = await latest(group._id, 'rolling');
        const since = previous?.lastReceivedAt ?? null;

        const query = { groupId: group._id };
        if (since) query.receivedAt = { $gt: since };

        const batch = withText(await messages().find(query).sort({ ts: 1 }).toArray());
        if (batch.length === 0) continue;

        const range = tsRange(batch);
        const { bullets, model } = await llm().summarise({
          groupName: group.name,
          messages: batch.map(toLlm),
          previous: previous?.bullets ?? null,
          periodStart: previous?.periodEnd ?? range.start,
          periodEnd: range.end,
        });

        // The cursor advances even when the window held nothing worth saying,
        // otherwise a quiet stretch would be re-sent to the model every 4 hours.
        const lastReceivedAt = batch.reduce((a, m) => (m.receivedAt > a ? m.receivedAt : a), batch[0].receivedAt);

        if (isEmptySummary(bullets) && previous) {
          await summaries().updateOne({ _id: previous._id }, { $set: { lastReceivedAt } });
          logger.info({ groupId: group._id, messages: batch.length }, 'rolling window had nothing to report');
          continue;
        }

        await summaries().insertOne({
          groupId: group._id,
          kind: 'rolling',
          periodStart: previous?.periodEnd ?? range.start,
          periodEnd: range.end,
          lastReceivedAt,
          bullets,
          messageCount: batch.length,
          generatedAt: new Date(),
          model,
        });
        written += 1;

        logger.info({ groupId: group._id, messages: batch.length, model }, 'rolling summary written');
      } catch (err) {
        // One group's failure must not stop the others.
        logger.error({ groupId: group._id, err: String(err) }, 'rolling summary failed');
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'rolling summary pass failed');
  }

  return written;
}

/**
 * Daily summaries at DAILY_SUMMARY_TIME, covering that IST day up to now.
 *
 * Keyed by IST day and upserted, so re-running (a retry, a manual run, a
 * restart at 20:05) replaces the day's summary instead of adding a second one.
 */
export async function runDailySummaries(now = new Date()) {
  let written = 0;

  try {
    const { dayKey, start, end } = istDayBounds(now);
    const monitored = await groups().find({ monitored: true }).toArray();

    for (const group of monitored) {
      try {
        const batch = withText(
          await messages()
            .find({ groupId: group._id, ts: { $gte: start, $lte: end } })
            .sort({ ts: 1 })
            .toArray(),
        );
        if (batch.length === 0) continue;

        const { bullets, model } = await llm().summarise({
          groupName: group.name,
          messages: batch.map(toLlm),
          previous: null, // a day stands on its own
          periodStart: start,
          periodEnd: end,
        });

        await summaries().updateOne(
          { groupId: group._id, kind: 'daily', dayKey },
          {
            $set: {
              periodStart: start,
              periodEnd: end,
              bullets,
              messageCount: batch.length,
              generatedAt: new Date(),
              model,
            },
          },
          { upsert: true },
        );
        written += 1;

        logger.info({ groupId: group._id, dayKey, messages: batch.length, model }, 'daily summary written');
      } catch (err) {
        logger.error({ groupId: group._id, err: String(err) }, 'daily summary failed');
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'daily summary pass failed');
  }

  return written;
}
