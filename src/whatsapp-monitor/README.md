# WhatsApp Office-Group Monitor

Reads CDC's WhatsApp work groups through [Maytapi](https://maytapi.com), flags
messages that signal a problem, and DMs the responsible person. **It never posts
into a group** — alerts go out as 1:1 DMs only.

Runs inside this backend process, gated by `WHATSAPP_MONITOR_ENABLED`. With that
unset or `false` the module does nothing at all: no Mongo connection, no cron, no
Maytapi calls. The rest of the backend is unaffected either way — a startup
failure here is logged and swallowed rather than stopping the server.

Status: **Phase 2** (poller + detector + router/alerts). Phases 3–6
(escalation/ACK, summariser, dashboard API, deploy) are not built yet. The
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
npm run whatsapp:seed-routing                  # owners + routing (edit the script first)
npm run whatsapp:poll-once                     # one cycle: fetch, classify, alert
npm run whatsapp:classify-once -- "<groupId>"  # classify now, skip the fetch
npm run whatsapp:dump-messages -- "<id>"       # raw Maytapi response
npm test:whatsapp                              # unit tests
```

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

`getMessages` has **no pagination** and needs none — it returns whatever history
the WhatsApp-Web session has lazily loaded, and that set grows between calls (51
then 101 on two consecutive polls of the same group). Messages cannot be lost by
the window sliding past them, so `possible_gap` should stay silent. The cost is
that the fetched count climbs over time; worth capping before many groups are
monitored.

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
router/resolve.js      routing precedence (pure, unit tested)
router/alert.js        DM formatting and delivery logging
index.js               start/stop + health, called from server.js
```

No phone numbers, group ids or model names are hard-coded — they live in env or
Mongo.
