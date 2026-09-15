# WhatsApp Office-Group Monitor

Reads CDC's WhatsApp work groups through [Maytapi](https://maytapi.com), flags
messages that signal a problem, and DMs the responsible person. **It never posts
into a group** — alerts go out as 1:1 DMs only.

Runs inside this backend process, gated by `WHATSAPP_MONITOR_ENABLED`. With that
unset or `false` the module does nothing at all: no Mongo connection, no cron, no
Maytapi calls. The rest of the backend is unaffected either way — a startup
failure here is logged and swallowed rather than stopping the server.

Status: **Phase 5** (poller, detector, alerts, escalation/ACK, summariser,
dashboard API). Phase 6 (tests/backfill/deploy config) is not built yet. The
dashboard itself lives in the separate `WhatsAppSummarizer` repo and will talk
to JSON routes added here, behind this backend's existing JWT auth.

## Its own database

`MONGODB_URI_WA`, a separate connection following the same pattern as
`db-voice-notes.js`. Mongoose opens the connection; everything below uses the
**native driver's collections** — no schemas, no models — because these
documents are plain objects. Collections: `groups`, `messages`, `concerns`,
`alerts`, `summaries`, `owners`, `routing`, `runs`.

`messages` expires 60 days after `receivedAt` via a TTL index. Nothing else is
TTL'd. Timestamps are stored as BSON `Date`, never numbers — a TTL index on a
number does nothing.

## Commands

```bash
npm run whatsapp:seed                          # indexes + import groups (all off)
npm run whatsapp:groups                        # list groups and their state
npm run whatsapp:groups -- "<groupId>" on      # start watching a group
npm run whatsapp:groups -- "<id>" on --since <ISO>  # ...from an earlier point
npm run whatsapp:seed-routing                  # owners + routing (edit the script first)
npm run whatsapp:poll-once                     # one cycle: fetch, classify, alert
npm run whatsapp:classify-once -- "<groupId>"  # classify now, skip the fetch
npm run whatsapp:dump-messages -- "<id>"       # raw Maytapi response
npm run whatsapp:probe                         # which Maytapi endpoints are healthy
npm run whatsapp:probe -- "<groupId>"          # ...including both message routes
npm run whatsapp:concerns                      # open + acknowledged concerns
npm run whatsapp:concerns -- all               # including resolved
npm run whatsapp:close -- "<id>" resolve       # resolve without the dashboard
npm run whatsapp:close -- all resolve          # clear the board
npm run whatsapp:backfill-threads              # thread roots for older messages
npm run whatsapp:escalate-once                 # one ack + escalation pass
npm run whatsapp:summarise                     # rolling summaries now
npm run whatsapp:summarise -- daily            # today's daily summary
npm run whatsapp:summarise -- both
npm run whatsapp:summaries                     # print the latest summaries
npm run whatsapp:smoke                         # end-to-end check of every stage
npm run test:whatsapp                          # unit tests
```

### The smoke test

`whatsapp:smoke` runs the whole pipeline once — Maytapi, Mongo, OpenAI and a
real WhatsApp DM — and prints PASS/FAIL per stage: fetch, normalise, ingest,
idempotence, TTL, classify, alert, ACK, escalation, summaries, dashboard API.
Every stage calls the function the poller calls, so a pass means the production
path works rather than a parallel copy of it.

Two things it does deliberately:

- It **inserts one synthetic message** into `messages` (never into the group) so
  the alert chain always has a concern to work with. Ten real messages may be
  pure chatter, and stages that silently had nothing to do would report a false
  pass.
- It **lowers `joinedAt`** to cover the messages it fetched, because by design
  nothing older than `joinedAt` is ingested. The floor is not raised back — the
  messages are real and belong in the shadow-run data.

It pauses once for you to reply `ACK` to the DM (`--yes` skips that), and
cleans up its own rows afterwards (`--keep` leaves them).

`GET /health` reports the monitor's status alongside the backend's.

## Adding a group

The CDC number must already be a member. `npm run whatsapp:seed` to import, then
turn it on. Turning a group on sets `joinedAt` — a **permanent floor**. Messages
sent before that moment are never ingested, on any run, ever. That is what makes
it safe to point at a group with years of history.

## How the cursor works

Per group we keep `lastTs` and `lastMsgId`. Each run keeps messages with
`ts >= joinedAt` **and** `ts > lastTs - 60s`. The 60-second overlap is
deliberate; duplicates are dropped by the unique index on `msgId`
(`insertMany` is unordered and duplicate-key errors are swallowed).

### Pagination

`getMessages` takes **`count`** (how many of the most recent messages to return)
and **`page`** (walk backwards through older ones). The parameter is `count`, not
`limit` — a `limit` is accepted and silently ignored, which is worth knowing
because it looks like it is working.

Without `count` the response grows on every call as the WhatsApp-Web session
lazily loads more history: one group went 51 → 101 → 148 across three
consecutive polls and would have kept climbing. `MAYTAPI_MESSAGE_COUNT`
(default 100) keeps each response bounded.

A bounded page can miss messages when a group is busier than one page per
interval, so `fetchBackToCursor` walks back a page at a time until a page holds
something at or older than the cursor — at which point nothing older is missing.
It stops at `MAYTAPI_MAX_PAGES` (default 5), and reaching that limit is the real
`possible_gap`: messages arrived faster than we could page back.

The first poll never pages back. There is no cursor to close a gap against, and
paging would drag in exactly the history `joinedAt` exists to keep out.

### Timing

A successful `getMessages` against a real group measures **12–14 seconds**, so
`MAYTAPI_TIMEOUT_MS` defaults to 45s. At the original 20s a slightly slow
response was aborted mid-flight and retried, turning a call that would have
worked into three slow failures — and only under load, which is when nobody is
watching.

`MAYTAPI_GROUP_BUDGET_MS` (default 120s) caps how long one group may take in a
cycle. Without it, retries across `maxPages` can occupy the whole poll interval;
the "previous poll still running" guard then skips tick after tick and the
monitor quietly stops keeping up. Hitting the budget surfaces as `possible_gap`
rather than silent truncation. The first page always runs, so a slow group still
gets its most recent messages.

The `group polled` log line reports `ms`, so the cost of each group is visible
without adding instrumentation later.

### When Maytapi is unwell

`getMessages` runs against a live WhatsApp-Web session, so it fails in ways a
database-backed API would not. Both of these were seen in one afternoon:

- **504 from Cloudflare**, ~50s — the session is wedged, typically while a phone
  instance is being re-paired or redeployed. *Every* endpoint hangs, `/status`
  included.
- **500 `"Connection to Api is failed."`**, ~16s — Maytapi's API layer cannot
  reach the session worker. `/status` and `/getGroups` keep returning 200 while
  every `getMessages` fails, for large and small groups alike.

Neither is caused by group size and no client setting fixes either. Check
`/status` first: if the lightweight endpoints fail too, it is the session rather
than your request. `GET /{phone_id}/redeploy` restarts the worker, which is the
usual cure — have the handset to hand in case it needs re-pairing.

```bash
npm run whatsapp:probe                 # session + group list
npm run whatsapp:probe -- "<groupId>"  # also both message-fetch routes
```

`whatsapp:probe` calls each endpoint in turn and prints status, size and
timing. It exists to separate the three failures that look identical from the
outside — wrong credentials, a wedged session, and one broken endpoint — which
otherwise take an afternoon of hand-built curl commands to tell apart.

**There are two routes to the same messages.**
`getConversations/{conversation_id}` returns the identical payload to
`getMessages`, with the same `count`/`page` parameters. The client exposes it as
`getConversationMessages`. It is not used by the poller: if the probe ever shows
`getMessages` failing while `getConversationMessages` succeeds, that is the
moment to wire it in as a fallback — and not before, since it is untested
against a real instance.

## How a concern becomes an alert

One LLM call per group per run over that group's unclassified messages — not one
per message. The previous 15 classified messages ride along as context so a
reply like "still down" is intelligible; they are never re-flagged.

**Two tiers.** `LLM_MODEL_FAST` judges first. The batch re-runs on
`LLM_MODEL_STRONG` if the fast model flagged anything **high severity** or
returned **malformed JSON**. High severity is what interrupts someone's evening,
so it gets a second opinion.

**Messages are marked `classified` whatever happens next** — including when
routing is missing or the DM fails. Otherwise a permanent misconfiguration would
re-send the same batch to the LLM every five minutes forever, at real cost.

**De-duplication.** A candidate is absorbed by a live (`open` or `acknowledged`)
concern of the same group and category raised within `cooldownMin` (default 30):
its message ids are appended and **no second alert is sent**. One machine going
down generates a dozen messages; that is one problem. A `resolved` concern never
absorbs — a recurrence deserves a fresh alert.

**Routing**, most specific first: a `routing` row matching `groupId + category`,
then `"*" + category`, then `DEFAULT_OWNER_PHONE`. If none resolves, the concern
is still recorded and an **error** is logged saying nobody was alerted — silence
there would be the worst possible failure.

**Alerts are written to `alerts` before the send**, then updated with the result,
so a crash mid-send leaves a record that we tried.

## Acknowledgement and escalation

Both run on every poll cycle, **acknowledgements first** — a concern
acknowledged in this cycle must not then be escalated a moment later for being
unacknowledged.

**ACK.** The poller reads the CDC number's 1:1 chat with anyone who has an open
concern assigned or escalated to them, and looks for the word `ACK` as a whole
word, case-insensitive. Their **newest open** concern becomes `acknowledged`,
and they get a one-line confirmation DM — without it, silence looks like
failure and people send the reply again.

`ok`, `done` and `thik hai` are deliberately **not** acknowledgements. They are
the commonest words in any work group, and accepting them would silently
swallow concerns nobody actually picked up. `ack` inside another word ("my back
hurts", "Jack") does not match either.

Each owner has a `lastAckTs` cursor, set to *now* the first time their thread is
read, so an old "ack" typed months ago cannot acknowledge today's concern. Only
messages the owner sent count — the CDC number's own alerts contain the word ACK
in their instruction line, and counting those would acknowledge every concern
the instant it was raised.

Only owners with a live concern are polled, so Maytapi calls stay proportional
to real activity rather than to the size of the owners table.

**Escalation.** An `open` concern still unacknowledged after `escalateAfterMin`
(default 30) is re-sent to the owner's `escalationTo`, then once more up that
person's chain. **Two hops is the cap** — past that, DMing ever more senior
people about something nobody has picked up stops being an alert and becomes
noise; the dashboard is the right place to see it.

The clock restarts at each hop, so every person gets the full window. The
target is recorded before the send, like the first alert, so a crash mid-send
cannot escalate to the same person twice. Escalating to someone already on the
thread is skipped, which also breaks a loop in the config (A escalates to B, B
back to A). When the chain simply ends, that is logged **once** per concern and
flagged with `escalationChainExhausted` rather than repeating every five
minutes for the life of the concern.

## Dashboard API

`src/routes-whatsapp-monitor.js`, mounted at `/api/whatsapp-monitor`, behind
`requireCdcBillsAuth` — the same JWT the other CDC tools use, so the team has one
login rather than another password to circulate. Writes additionally require
`requireCdcBillsAdmin`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | monitor status, last run age, errors |
| GET | `/groups` | all groups + open-concern counts + latest rolling summary |
| GET | `/groups/:id` | daily summaries, rolling summary, live concerns, last 50 messages |
| GET | `/concerns` | `?status=&category=&groupId=&limit=` |
| GET | `/concerns/:id` | the triggering messages and the alert log |
| GET | `/runs` | last 100 runs |
| GET | `/owners` | owners, routing rules, and the env defaults |
| PATCH | `/groups/:id` | admin — `monitored`, `department`, `joinedAt` |
| POST | `/concerns/:id/acknowledge` | |
| POST | `/concerns/:id/resolve` | |
| PUT/DELETE | `/owners/:phone` | admin |
| PUT/DELETE | `/routing` | admin |

Details worth knowing:

- **The API works whether or not the poller is running.** Each request calls the
  idempotent `connect()`, because someone reading yesterday's concerns does not
  care whether `WHATSAPP_MONITOR_ENABLED` is true.
- **Acknowledge and resolve are guarded on current status**, so two people
  clicking at once cannot double-apply; the loser gets a 409 naming the state.
- **Validation refuses configurations that would fail silently**: an owner who
  escalates to themselves, a routing rule pointing at a phone with no owner row,
  deleting an owner that routing rules still reference.
- `/groups` uses one grouped aggregate for the counts rather than a query per
  group — it is the dashboard's front page and the most-hit route.
- `/concerns/:id` can return fewer messages than `messageIds` lists: messages
  age out under the 60-day TTL while the concern itself does not.

`api.test.js` asserts that **every** route returns 401 unauthenticated. These
routes expose every message the monitor has read, so a route added later without
the middleware would leak all of it, and quietly.

## Summaries

Two jobs, both writing to `summaries` with four buckets — `decisions`,
`openIssues`, `blocked` (who is waiting on whom), `notable`. Empty arrays are a
valid summary; a quiet window should produce nothing rather than padding.

**Rolling** (`ROLLING_SUMMARY_CRON`, default every 4 hours) feeds the previous
rolling summary plus the new messages back in, so open issues carry forward
until something settles them.

Messages are selected by **`receivedAt`, not `ts`**. Every message is ingested
exactly once, so a receivedAt cursor guarantees each is summarised at least once
and none are skipped. Selecting by `ts` would silently lose late arrivals — a
message whose `ts` falls inside an already-summarised window would never qualify
again. This is the "re-summarise tolerantly" requirement, and it is the reason
the cursor is `lastReceivedAt` rather than `periodEnd`.

When a window produces nothing worth saying, the cursor still advances (no new
row is written) — otherwise a quiet stretch would be re-sent to the model every
four hours forever.

**Daily** (`DAILY_SUMMARY_TIME`, default 20:00 IST) covers that IST day up to the
run time, not to midnight: a summary cannot cover messages that do not exist
yet, and anything later lands in tomorrow's window. It is keyed by IST day and
**upserted**, so a retry, a manual run, or a restart at 20:05 replaces the day's
summary instead of adding a second — enforced by a unique partial index on
`{groupId, kind, dayKey}`.

Day boundaries are computed from a fixed +5:30 offset rather than the process
timezone, so behaviour is identical on a Kolkata laptop and a UTC server. India
has no daylight saving, so a fixed offset is correct.

Unlike the detector, the summariser escalates to the strong model only on
structurally broken output, never on content. A slightly thin summary is read at
leisure on a dashboard rather than acted on within five minutes, so it does not
warrant a second opinion.

Its prompt is `summariser/prompt.md`, same arrangement as the detector's.

## Changing the prompt

`detector/prompt.md` is the classifier's system prompt — plain Markdown, no code
around it. Edit and restart. It holds the CDC vocabulary (romanised
Hindi/Bengali signals, machine names, what counts as routine chatter) and the
severity definitions.

## Swapping the LLM

`llm/` is the only place a vendor SDK is imported. `LLM_PROVIDER` picks the
implementation, `LLM_MODEL_FAST`/`LLM_MODEL_STRONG` the models. A new provider
is one file implementing `classify()` plus a case in `llm/index.js` — no change
to the detector.

## Maytapi response shape

Pinned against a real response; `normalise.test.js` holds a redacted fixture and
is where a Maytapi change will surface first.

```
{ success, data: {
    users: { "<jid>": { id, name, phone, image? } },
    messages: [ { timestamp, uid, fromMe, message: { id, type, text }, quotedMsg? } ] } }
```

Two traps, both handled in `maytapi/normalise.js` and both easy to reintroduce:

- **The sender is `uid` on the envelope**, and the sender's *name* exists only in
  the `data.users` map, keyed by jid. Nothing on the message body identifies who
  sent it.
- **`message.type === "info"` rows are system events** (`group/add`,
  `group/leave`, `group/name`) with no text field. They are dropped, not stored.

Session status is `/{phone_id}/status`, **not** `/getStatus`.

## Layout

```
config.js              env parsing; assertConfigured() fails with a full list
db.js                  its own Mongo connection + ensureIndexes() (idempotent)
maytapi/client.js      every Maytapi call: retry x3, backoff, timeouts
maytapi/normalise.js   the only file that knows Maytapi's response shape
poller/cursor.js       pure cursor/overlap filtering (unit tested)
poller/poll.js         per-group poll, session check, run recording
llm/                   the only place a vendor SDK is imported
llm/parse.js           validates classifier JSON; throws to trigger escalation
detector/prompt.md     the classifier's system prompt — edit freely
detector/concerns.js   de-duplication rules (pure, unit tested)
detector/detect.js     classify -> de-dup -> open concern -> alert
summariser/prompt.md   the summariser's system prompt — edit freely
summariser/window.js   IST day boundaries and cron parsing (pure, unit tested)
summariser/parse.js    validates the four buckets
summariser/summarise.js rolling + daily runs
router/resolve.js      routing precedence (pure, unit tested)
router/alert.js        DM formatting and delivery logging
router/escalation-rules.js  escalation timing and targets (pure, unit tested)
router/ack-rules.js    ACK matching and target selection (pure, unit tested)
router/escalate.js     the escalation pass
router/acknowledge.js  the 1:1 ACK poll
index.js               start/stop + health, called from server.js
```

No phone numbers, group ids or model names are hard-coded — they live in env or
Mongo.
