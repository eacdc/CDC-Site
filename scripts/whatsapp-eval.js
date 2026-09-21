/**
 * Runs the classifier over labelled cases and reports what it got wrong.
 *
 *   npm run whatsapp:eval
 *   npm run whatsapp:eval -- --verbose    # also print the summaries it wrote
 *
 * The cases in detector/eval-cases.json are real CDC traffic, labelled by hand.
 * Without this, tuning the prompt is changing words and hoping: a tweak that
 * stops flagging announcements might also stop flagging breakdowns, and the
 * only way to find out would be a week of missed alerts.
 *
 * Costs a few cents per run - one fast-model call per case - and touches no
 * database. It reads the same prompt.md the poller uses, so a pass here means
 * the live classifier behaves the same way.
 */
import { readFileSync } from 'node:fs';
import { llm } from '../src/whatsapp-monitor/llm/index.js';

const verbose = process.argv.includes('--verbose');
const { cases } = JSON.parse(
  readFileSync(new URL('../src/whatsapp-monitor/detector/eval-cases.json', import.meta.url), 'utf8'),
);

const byKind = (k) => cases.filter((c) => (c.kind ?? 'internal') === k).length;
console.log(`${cases.length} case(s) - ${byKind('internal')} internal, ${byKind('client')} client\n`);

const failures = [];

for (const testCase of cases) {
  const expectConcern = testCase.expect.concern;

  let result;
  try {
    result = await llm().classify({
      groupName: testCase.group,
      // Which prompt this case is judged by. Both are exercised in one run, so
      // tightening the internal prompt cannot quietly loosen the client one.
      groupKind: testCase.kind ?? 'internal',
      newMessages: testCase.messages.map((m) => ({ ...m, ts: new Date(), replyTo: m.replyTo ?? null })),
      contextMessages: [],
    });
  } catch (err) {
    console.log(`ERROR ${testCase.name}\n      ${err.message}\n`);
    failures.push({ name: testCase.name, reason: err.message });
    continue;
  }

  const got = result.concerns.length > 0;
  const ok = got === expectConcern;

  // A wrongly-categorised real concern is worth knowing about but is not a
  // failure: the alert still reaches a human, which is the job.
  const category = result.concerns[0]?.category;
  const categoryNote =
    ok && expectConcern && testCase.expect.category && category !== testCase.expect.category
      ? `  (category ${category}, expected ${testCase.expect.category})`
      : '';

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${testCase.name}\n` +
      `      expected ${expectConcern ? 'a concern' : 'nothing'}, got ${got ? `${result.concerns.length}` : 'nothing'}` +
      `${categoryNote}`,
  );

  if (!ok) {
    failures.push({ name: testCase.name, why: testCase.expect.why });
    // The summary is the clearest statement of what the model thought it saw.
    for (const c of result.concerns) console.log(`      -> "${c.summary}"`);
    if (testCase.expect.why) console.log(`      it should not: ${testCase.expect.why}`);
  } else if (verbose) {
    for (const c of result.concerns) console.log(`      -> "${c.summary}"`);
  }
  console.log();
}

const missed = failures.filter((f) => cases.find((c) => c.name === f.name)?.expect.concern);
const falsePositives = failures.length - missed.length;

console.log(`${cases.length - failures.length}/${cases.length} correct`);
if (falsePositives) console.log(`${falsePositives} false positive(s) - noise that would reach a phone`);
if (missed.length) console.log(`${missed.length} MISSED - a real problem nobody would hear about`);

// A miss is the worse failure, so it is what decides the exit code for CI.
process.exit(failures.length === 0 ? 0 : 1);
