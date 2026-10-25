# Card games server (Bluff + 29)

Game server for the video card games app: Express, Socket.IO and LiveKit tokens. The client is a separate repo, [`eacdc/liarsdeck`](https://github.com/eacdc/liarsdeck).

This folder is self-contained. It has its own `package.json`, shares no code with the CDC backend around it, and deploys as its own service. The CDC backend's `npm install` and `npm start` at the repo root never touch it.

## Run it locally

Needs Node 22 or later.

```bash
cd card-games-server
npm install
cp .env.example .env      # LiveKit keys optional: without them video is off, games still work
npm run dev               # http://localhost:3000, restarts on change
```

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with reload (tsx) |
| `npm test` | Vitest: engines, room manager, and a real Socket.IO round trip |
| `npm run simulate:29` | Four random bots play 300 games of 29 while an independent referee checks every rule (set `SIM_GAMES` for more) |
| `npm run typecheck` / `npm run lint` | tsc / ESLint |
| `npm run build` then `npm start` | Compile to `dist/` and run it (production) |

## Layout

```
shared/types.ts        Types shared with the client (Card, RoomState, events). The client keeps a copy.
src/index.ts           Starts the server
src/app.ts             Express + Socket.IO wiring, per-socket rate limits
src/rooms.ts           Rooms: create/join/leave, 60s seat hold, pause/resume, host decisions, timers
src/livekit.ts         POST /api/livekit-token
src/games/deck.ts      Cards, shuffle, deal
src/games/bluff.ts     Bluff engine (pure)
src/games/twentynine.ts 29 engine (pure)
src/games/*.test.ts    Engine tests
```

Each engine is a set of pure functions: `apply(state, playerId, action, { now, rng }) => newState | error`. The engine never touches sockets or timers. It tells the room layer which system action to fire and when (`nextTimer`), e.g. "close the call window at T". The room layer owns the single `setTimeout` per room.

## Environment

| Variable | Example | Notes |
|---|---|---|
| `PORT` | `3000` | Render/Railway set this for you |
| `CLIENT_ORIGIN` | `https://liarsdeck.onrender.com` | Comma-separated list. Only these origins may connect (HTTP and WebSocket) |
| `LIVEKIT_URL` | `wss://your-project.livekit.cloud` | From LiveKit Cloud |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | | Stay on the server only |

## Deploy on Render

New **Web Service** from this repo:

- **Root Directory:** `card-games-server`
- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/health`
- Environment: the variables above, and Node 22 (set `NODE_VERSION=22`)

Rooms live in memory, so run a single instance. A restart or redeploy ends every game in progress. On Render's free tier the service sleeps when idle, and the first visit after that takes about a minute.

## Protocol

Client to server (all `room:*` take an ack callback that receives `{ ok: true }` or `{ ok: false, error }`):

| Event | Payload | Who |
|---|---|---|
| `room:create` | `{ game, name }` | anyone; ack has `{ code, playerId, sessionId }` |
| `room:join` | `{ code, name, sessionId? }` | anyone; a known `sessionId` reclaims the seat |
| `room:leave` | `{}` | |
| `room:setGame` / `room:setOptions` / `room:kick` | `{ game }` / `{ options }` / `{ playerId }` | host, in the lobby |
| `room:start` | `{ options? }` | host |
| `room:hostDecision` | `{ decision: 'wait' \| 'end' }` | host, once a dropped player's 60s hold has run out |
| `room:reset` | `{}` | host, after a game: back to the lobby |
| `game:action` | `{ type, ... }` | see `BluffAction` / `TwentyNineAction` in `shared/types.ts` |

Server to client: `room:state` (everyone), `game:state` (public state, everyone), `game:hand` (each player's own private channel only), `game:error`, `game:over`, `room:kicked`. Every payload with a deadline also carries `serverNow`, so clients can correct for clock skew in countdowns.

`POST /api/livekit-token` takes `{ roomCode, sessionId }` and returns `{ token, url, identity }`. Identity is the player ID. The token lasts 2 hours, is for that room only, and can publish camera and microphone only.

## Where this differs from the spec, and why

- **Token request takes `sessionId`, not `playerName`.** With only a room code and a name, anyone who saw the link could get into the video call. The session ID proves the caller holds a seat.
- **`sessionId` is issued by the server** in the create/join ack, and never appears in any broadcast. Anyone holding it could take that seat.
- **Node 22, not 20.** Node 20 reached end of life in April 2026, and current Vitest needs 22.
- **Rules the spec left open, decided here:**
  - Turn order runs up the seats (0, 1, 2, 3, ...). In 29, "the dealer's right" is the dealer's seat + 1.
  - In Bluff, a random player starts, and the deal starts with them, so any extra cards go to the earliest turns.
  - In 29, a trump played before the reveal counts as a plain card of its suit, even in the trick where the reveal happens. When trump is the suit led, it is simply the lead suit.
  - 29 follows the house rules document: duel bidding where the earlier bidder may hold (match) and the later must go higher, forced 16 for the dealer, trump as a suit the bidder names from their four cards (the cards stay in hand), or the suit of their 7th card (unmarked in hand, unknown even to them), double/redouble, pair, single hand, and game points 1/2/3/6 (x2 doubled, x4 redoubled).
  - The hidden trump is shown to everyone when a round ends.
  - The game pauses whenever any seated player is disconnected. After the 60-second hold, the host chooses to wait another 60 seconds or end the game. If the host is the one missing, the role passes to the next connected player.
