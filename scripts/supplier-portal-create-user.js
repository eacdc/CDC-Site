/**
 * Create (or update) a Supplier Portal internal login.
 *
 * There is no other way to get a first user into `sp_users`: the portal has no
 * self-registration, so a fresh MONGODB_URI_SupplierPortal database has zero
 * accounts and every /api/supplier-portal/auth/login returns 401. Run this once
 * per environment before trying to sign in.
 *
 * Usage:
 *   node scripts/supplier-portal-create-user.js \
 *     --email you@example.com --password 'secret' \
 *     [--name 'Your Name'] [--roles ADMIN,BUYER,STORE] \
 *     [--sites KOL,AHM] [--default-site KOL] \
 *     [--employee-ledger-id 123] [--warehouse-id 4] [--erp-user-id 7]
 *
 * Re-running with the same email updates that account (password included),
 * so it doubles as a password reset.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import { ensureSupplierPortalReady, User, closeSupplierPortal } from '../src/supplier-portal/db/mongo.js';
import { SITES } from '../src/supplier-portal/config/constants.js';

function arg(name, fallback) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

function list(value) {
  return String(value || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function num(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}".`);
  return n;
}

async function main() {
  const email = String(arg('email') || '').toLowerCase().trim();
  const password = arg('password');
  if (!email || !password) {
    throw new Error('Both --email and --password are required.');
  }

  const roles = list(arg('roles', 'ADMIN'));
  const allowedSites = list(arg('sites', 'KOL,AHM'));
  const defaultSite = list(arg('default-site', allowedSites[0] || 'KOL'))[0];

  for (const site of [...allowedSites, defaultSite]) {
    if (!SITES.includes(site)) throw new Error(`Unknown site "${site}". Known sites: ${SITES.join(', ')}.`);
  }
  if (!allowedSites.includes(defaultSite)) {
    throw new Error(`--default-site ${defaultSite} is not in --sites ${allowedSites.join(',')}.`);
  }

  await ensureSupplierPortalReady();

  const update = {
    email,
    passwordHash: await bcrypt.hash(String(password), 10),
    displayName: arg('name', email.split('@')[0]),
    roles,
    defaultSite,
    allowedSites,
    isActive: true,
  };
  const employeeLedgerId = num(arg('employee-ledger-id'));
  const warehouseId = num(arg('warehouse-id'));
  const erpUserId = num(arg('erp-user-id'));
  if (employeeLedgerId !== undefined) update.employeeLedgerId = employeeLedgerId;
  if (warehouseId !== undefined) update.warehouseId = warehouseId;
  if (erpUserId !== undefined) update.erpUserId = erpUserId;

  const existing = await User.findOne({ email });
  await User.updateOne({ email }, { $set: update }, { upsert: true });

  console.log(`${existing ? 'Updated' : 'Created'} ${email}`);
  console.log(`  roles:        ${roles.join(', ')}`);
  console.log(`  sites:        ${allowedSites.join(', ')} (default ${defaultSite})`);
  if (employeeLedgerId !== undefined) console.log(`  employeeLedgerId: ${employeeLedgerId}`);
  if (warehouseId !== undefined) console.log(`  warehouseId:      ${warehouseId}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSupplierPortal().catch(() => {});
  });
