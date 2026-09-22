/**
 * Re-resolves the owner of open concerns that have nobody to alert.
 *
 *   npm run whatsapp:reroute            # show what would change
 *   npm run whatsapp:reroute -- --apply
 *
 * The owner is worked out once, when the concern is raised. So a concern
 * raised while the routing table was empty - no rule, no person on the group,
 * no DEFAULT_OWNER_PHONE - carries `ownerId: null` for ever and can never be
 * alerted, however the configuration changes afterwards.
 *
 * Only touches concerns that are still `open` and have never been alerted:
 * something already sent, acknowledged or resolved keeps the owner it had, or
 * the record of who was told stops matching who was told.
 */
import { connect, concerns, groups, routing, close } from '../src/whatsapp-monitor/db.js';
import { resolveRouting } from '../src/whatsapp-monitor/router/resolve.js';
import { config } from '../src/whatsapp-monitor/config.js';

const apply = process.argv.includes('--apply');

await connect();

const stranded = await concerns()
  .find({ status: 'open', alertedAt: null, $or: [{ ownerId: null }, { ownerId: { $exists: false } }] })
  .sort({ createdAt: 1 })
  .toArray();

if (stranded.length === 0) {
  console.log('No open concerns are missing an owner.');
} else {
  console.log(`${stranded.length} open concern(s) with nobody to alert.\n`);

  const groupById = new Map(
    (await groups().find({ _id: { $in: [...new Set(stranded.map((c) => c.groupId))] } }).toArray())
      .map((g) => [g._id, g]),
  );
  const routes = await routing().find({}).toArray();

  let fixed = 0;
  for (const c of stranded) {
    const group = groupById.get(c.groupId);
    const route = resolveRouting(c.groupId, c.category, routes, {
      groupOwnerPhone: group?.ownerPhone,
      groupLadder: group?.escalationTo,
      ownerPhone: config.defaultOwnerPhone,
      cooldownMin: config.defaultCooldownMin,
      escalateAfterMin: config.defaultEscalateAfterMin,
    });

    if (!route) {
      console.log(`  still nobody: ${c.summary}`);
      console.log(`      ${group?.name ?? c.groupId} / ${c.category}`);
      continue;
    }

    console.log(`  ${apply ? 'alerting' : 'would alert'} ${route.ownerPhone} (${route.matched}): ${c.summary}`);
    if (apply) {
      // Guarded on the owner still being absent, so this cannot overwrite a
      // concern the poller picked up while this script was running.
      const res = await concerns().updateOne(
        { _id: c._id, alertedAt: null, $or: [{ ownerId: null }, { ownerId: { $exists: false } }] },
        { $set: { ownerId: route.ownerPhone }, $unset: { alertNobodyLogged: '' } },
      );
      fixed += res.modifiedCount;
    }
  }

  console.log(
    apply
      ? `\n${fixed} concern(s) given an owner. They alert on the next poll cycle if their window has passed.`
      : '\nNothing written. Re-run with --apply.',
  );
}

await close();
