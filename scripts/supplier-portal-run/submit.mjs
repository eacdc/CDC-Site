/**
 * Step 5 of a run: post one quote's payload, then file the original.
 *
 *   node --env-file=<env> submit.mjs <Work/xxxx/payload.json>
 *
 * The payload is checked against the server's own schema first, so a mistake
 * is caught here rather than as a 400. On success the Inbox file moves to
 * Done; on a duplicate, to Done as well; on any other failure it stays put
 * for the next run and the error is printed.
 */

import { readFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DIRS, api, imp, readJson, contentTypeOf } from './common.mjs';
import { findManifestItem } from './manifest.mjs';

const { RunPayloadSchema } = await imp('supplier-portal/services/proposals.js');

const file = process.argv[2];
if (!file) { console.error('usage: submit.mjs <payload.json>'); process.exit(2); }
const payload = RunPayloadSchema.parse(readJson(file));
const item = findManifestItem(payload.sha256);
if (!item) throw new Error(`No prepared file for ${payload.sha256.slice(0, 8)} in Work/manifest.json`);

for (const l of payload.lines) {
  if (l.proposal.method === 'JUDGEMENT' && !l.proposal.rationale) {
    throw new Error(`Line ${l.lineNo}: a judged line needs its reason in proposal.rationale.`);
  }
  if (!l.proposal.itemId && l.proposal.method !== 'NONE') {
    throw new Error(`Line ${l.lineNo}: method ${l.proposal.method} with no item; use NONE and a question.`);
  }
}

const form = new FormData();
form.append('payload', JSON.stringify(payload));
form.append('file', new Blob([readFileSync(item.file)], { type: contentTypeOf(item.fileName) }), item.fileName);

const fileAway = (prefix = '') => {
  const from = item.source?.inbox;
  if (from && existsSync(from)) renameSync(from, path.join(DIRS.done, `${prefix}${path.basename(from)}`));
};

try {
  const res = await api('/quotes', { method: 'POST', form });
  fileAway();
  console.log(`SUBMITTED ${payload.fileName}: ${res.lines} lines, quote ${res.autoQuoteId}`);
} catch (err) {
  if (err.status === 409) {
    fileAway('duplicate - ');
    console.log(`ALREADY READ ${payload.fileName}`);
  } else {
    console.error(`FAILED ${payload.fileName}: ${err.message}${err.data?.issues ? ` ${JSON.stringify(err.data.issues)}` : ''}`);
    process.exit(1);
  }
}
process.exit(0);
