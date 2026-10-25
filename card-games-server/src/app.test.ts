import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientToServerEvents, GameStatePayload, HandPayload, JoinAck, RoomState, ServerToClientEvents } from '../shared/types.js';
import { createApp } from './app.js';
import { config } from './config.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let url = '';
const app = createApp();
const clients: Client[] = [];

beforeAll(async () => {
  await new Promise<void>((r) => app.http.listen(0, r));
  url = `http://localhost:${(app.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  app.rooms.close();
  await app.io.close();
});

function client(): Client {
  const c: Client = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  return c;
}

/** Collects every event a client receives. */
function inbox(c: Client) {
  const got: { event: string; payload: unknown }[] = [];
  c.onAny((event, payload) => got.push({ event, payload }));
  return {
    got,
    last: <T>(event: string) => got.filter((x) => x.event === event).at(-1)?.payload as T | undefined,
    waitFor: <T>(event: string, pred: (p: T) => boolean = () => true) =>
      new Promise<T>((resolve, reject) => {
        const seen = got.find((x) => x.event === event && pred(x.payload as T));
        if (seen) return resolve(seen.payload as T);
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 2000);
        const check = (e: string, p: unknown) => {
          if (e === event && pred(p as T)) {
            clearTimeout(t);
            c.offAny(check);
            resolve(p as T);
          }
        };
        c.onAny(check);
      }),
  };
}

const ack = <T>(fn: (cb: (r: T) => void) => void) => new Promise<T>((r) => fn(r));

describe('socket flow', () => {
  it('create, join, start: each player receives only their own hand', async () => {
    const socks = [client(), client(), client(), client()];
    const boxes = socks.map(inbox);
    const host = await ack<JoinAck>((cb) => socks[0]!.emit('room:create', { game: 'bluff', name: 'Host' }, cb));
    if (!host.ok) throw new Error('create failed');
    const joined: JoinAck[] = [host];
    for (let i = 1; i < 4; i++)
      joined.push(await ack<JoinAck>((cb) => socks[i]!.emit('room:join', { code: host.code, name: `P${i}` }, cb)));
    expect(joined.every((j) => j.ok)).toBe(true);

    // Everyone, including the last to join, has the full room.
    const st = await boxes[3]!.waitFor<RoomState>('room:state', (s) => s.players.length === 4);
    expect(st.players.map((p) => p.name)).toEqual(['Host', 'P1', 'P2', 'P3']);

    const started = await ack<{ ok: boolean }>((cb) => socks[0]!.emit('room:start', {}, cb));
    expect(started.ok).toBe(true);
    await Promise.all(boxes.map((b) => b.waitFor<GameStatePayload>('game:state')));
    const hands = await Promise.all(boxes.map((b) => b.waitFor<HandPayload>('game:hand')));
    const ids = hands.map((h) => h.cards.map((c) => c.id));
    // Four disjoint hands of 13, and each socket got exactly one hand.
    expect(new Set(ids.flat()).size).toBe(52);
    boxes.forEach((b) => expect(b.got.filter((x) => x.event === 'game:hand')).toHaveLength(1));

    // An invalid action gets a game:error.
    socks[0]!.emit('game:action', { type: 'bluff:play', cardIds: ['not-a-card'] });
    const e = await boxes[0]!.waitFor<{ code: string }>('game:error');
    expect(['NOT_YOUR_TURN', 'NOT_YOUR_CARD']).toContain(e.code);
  });

  it('a reconnecting socket gets its seat and hand back', async () => {
    const socks = [client(), client(), client(), client()];
    const host = await ack<JoinAck>((cb) => socks[0]!.emit('room:create', { game: '29', name: 'A' }, cb));
    if (!host.ok) throw new Error('create failed');
    const joins: JoinAck[] = [host];
    for (let i = 1; i < 4; i++) joins.push(await ack<JoinAck>((cb) => socks[i]!.emit('room:join', { code: host.code, name: `B${i}` }, cb)));
    const b2 = inbox(socks[2]!);
    await ack((cb) => socks[0]!.emit('room:start', {}, cb));
    const hand = await b2.waitFor<HandPayload>('game:hand');

    socks[2]!.close();
    const fresh = client();
    const box = inbox(fresh);
    const j2 = joins[2]!;
    if (!j2.ok) throw new Error('join failed');
    const again = await ack<JoinAck>((cb) => fresh.emit('room:join', { code: host.code, name: 'x', sessionId: j2.sessionId }, cb));
    expect(again).toMatchObject({ ok: true, playerId: j2.playerId });
    expect(await box.waitFor<HandPayload>('game:hand')).toEqual(hand);
    const gs = await box.waitFor<GameStatePayload>('game:state');
    expect(gs.game).toBe('29');
  });

  it('rejects a join with a bad code through the ack', async () => {
    const r = await ack<JoinAck>((cb) => client().emit('room:join', { code: 'nope', name: 'x' }, cb));
    expect(r).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  });
});

describe('livekit token endpoint', () => {
  it('is refused without LiveKit configured', async () => {
    const res = await fetch(`${url}/api/livekit-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(503);
  });

  it('issues a 2-hour, camera+mic-only token for a seated player, and refuses strangers', async () => {
    Object.assign(config.livekit, { url: 'wss://test.livekit.cloud', apiKey: 'key', apiSecret: 'secret-secret-secret-secret-secret' });
    try {
      const c = client();
      const host = await ack<JoinAck>((cb) => c.emit('room:create', { game: 'bluff', name: 'Host' }, cb));
      if (!host.ok) throw new Error('create failed');
      const post = (body: unknown) =>
        fetch(`${url}/api/livekit-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

      expect((await post({ roomCode: host.code, sessionId: 'guess' })).status).toBe(403);
      const res = await post({ roomCode: host.code, sessionId: host.sessionId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; url: string; identity: string };
      expect(body.url).toBe('wss://test.livekit.cloud');
      expect(body.identity).toBe(host.playerId);
      const claims = JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64url').toString());
      expect(claims.sub).toBe(host.playerId);
      expect(claims.name).toBe('Host');
      expect(claims.exp - claims.nbf).toBe(2 * 3600);
      expect(claims.video).toMatchObject({ room: host.code, roomJoin: true, canPublish: true, canPublishData: false });
      expect(claims.video.canPublishSources).toEqual(['camera', 'microphone']);
    } finally {
      Object.assign(config.livekit, { url: '', apiKey: '', apiSecret: '' });
    }
  });
});
