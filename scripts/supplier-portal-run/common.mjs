/**
 * Shared by the scheduled run's scripts.
 *
 * The run is a Claude session started hourly on CDC's PC. These scripts do
 * the mechanical parts - find new files, render them, apply the matching
 * rules, post the result - and call no model. Reading a page and judging a
 * line the rules could not settle is the session's own work.
 *
 * Writes go to the backend's /automation API only. Nothing here writes to
 * Mongo; reads of bill history and Indus are read-only.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND = path.resolve(HERE, '..', '..');
export const SRC = path.join(BACKEND, 'src');
export const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

export const ROOT = process.env.SP_QUOTES_DIR || 'C:/CDC Quotes';
export const DIRS = {
  inbox: path.join(ROOT, 'Inbox'),
  done: path.join(ROOT, 'Done'),
  failed: path.join(ROOT, 'Failed'),
  work: path.join(ROOT, 'Work'),
  // A copy of every file uploaded on the review page, by month: CDC's own
  // folder of what was sent, beside the Inbox. Nothing reads from it.
  portal: path.join(ROOT, 'Portal'),
};
export function ensureDirs() {
  for (const d of Object.values(DIRS)) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv', '.txt': 'text/plain',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
export const contentTypeOf = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] || null;

/**
 * The version of the rules a reading was made with: the backend commit, plus
 * a mark when the checkout has changes not yet committed.
 */
export function rulesVersion() {
  try {
    const head = execFileSync('git', ['-C', BACKEND, 'rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', BACKEND, 'status', '--porcelain', '--', 'src/supplier-portal', 'scripts/supplier-portal-run'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}+local` : head;
  } catch { return 'unknown'; }
}

export function runId() {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/** The backend's automation API. SP_API_BASE and SP_AUTOMATION_KEY come from the env file. */
export async function api(pathname, { method = 'GET', body, form } = {}) {
  const base = String(process.env.SP_API_BASE || '').replace(/\/$/, '');
  const key = process.env.SP_AUTOMATION_KEY;
  if (!base || !key) throw new Error('SP_API_BASE and SP_AUTOMATION_KEY must be set for the scheduled run.');
  const res = await fetch(`${base}/api/supplier-portal/automation${pathname}`, {
    method,
    headers: { 'X-SP-Automation-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
