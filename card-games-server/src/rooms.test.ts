import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BluffPublicState, GameStatePayload, HandPayload, RoomState } from '../shared/types.js';
import { seededRng } from './games/deck.js';
import { EMPTY_ROOM_MS, HOLD_MS, RoomManager, type Transport } from './rooms.js';

interface Sent {
  to: string;
  event: string;
  payload: unknown;
}

/** Records every emit, keyed by channel ("room:CODE" or "player:ID"). */
function recorder() {
  const sent: Sent[] = [];
  const channels = new Map<string, Set<string>>(); // socketId -> channels
  const transport: Transport = {
    toRoom: (code) => ({ emit: (event, payload) => void sent.push({ to: `room:${code}`, event, payload }) }),
    toPlayer: (id) => ({ emit: (event, payload) => void sent.push({ to: `player:${id}`, event, payload }) }),
    attach: (playerId, code, socketId) => void channels.set(socketId, new Set([`room:${code}`, `player:${playerId}`])),
    detach: (playerId, _code, socketId, reason) => {
      if (socketId) channels.delete(socketId);
      if (reason) sent.push({ to: `socket:${socketId}`, event: 'room:kicked', payload: { reason } });
    },
  };
  const last = <T>(event: string, to?: string): T => {
    const m = sent.filter((x) => x.event === event && (!to || x.to === to)).at(-1);
    if (!m) throw new Error(`no ${event} to ${to ?? 'anyone'}`);
    return m.payload as T;
  };
  return { sent, channels, transport, last };
}

let rec: ReturnType<typeof recorder>;
let rooms: RoomManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  rec = recorder();
  rooms = new RoomManager(rec.transport, { rng: seededRng(5) });
});

afterEach(() => {
  rooms.close();
  vi.useRealTimers();
});

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** A room with `n` players; returns their ids and sessions in join order. */
function setup(game: 'bluff' | '29', n: number) {
  const host = must(rooms.create(game, 'Host', 'sock0'));
  const players = [host];
  for (let i = 1; i < n; i++) players.push(must(rooms.join(host.code, `P${i}`, undefined, `sock${i}`)));
  return { code: host.code, players, ids: players.map((p) => p.playerId) };
}

describe('create and join', () => {
  it('creates a 6-character room and seats the host', () => {
    const r = must(rooms.create('bluff', '  Manu  ', 's'));
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const st = rec.last<RoomState>('room:state');
    expect(st).toMatchObject({ code: r.code, hostId: r.playerId, game: 'bluff', status: 'lobby' });
    expect(st.players).toEqual([{ id: r.playerId, name: 'Manu', seat: 0, connected: true }]);
  });

  it('never broadcasts session ids', () => {
    const { players } = setup('bluff', 4);
    const json = JSON.stringify(rec.sent);
    for (const p of players) expect(json).not.toContain(p.sessionId);
  });

  it('seats in join order and accepts lower-case codes', () => {
    const { code } = setup('bluff', 2);
    must(rooms.join(code.toLowerCase(), 'Late', undefined, 'x'));
    expect(rec.last<RoomState>('room:state').players.map((p) => [p.name, p.seat])).toEqual([
      ['Host', 0],
      ['P1', 1],
      ['Late', 2],
    ]);
  });

  it('rejects bad names, unknown rooms, full rooms and started games', () => {
    const { code } = setup('29', 4);
    const e = (r: { ok: boolean; error?: { code: string } }) => r.error?.code;
    expect(e(rooms.create('bluff', '   ', 's'))).toBe('BAD_NAME');
    expect(e(rooms.create('poker', 'A', 's'))).toBe('BAD_GAME');
    expect(e(rooms.join('ZZZZZZ', 'A', undefined, 's'))).toBe('ROOM_NOT_FOUND');
    expect(e(rooms.join(code, 'Fifth', undefined, 's'))).toBe('ROOM_FULL');
  });
});

describe('host controls', () => {
  it('only the host can change game, options, kick and start', () => {
    const { ids } = setup('bluff', 4);
    expect(rooms.setGame(ids[1]!, '29')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect(rooms.start(ids[1]!)).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    must(rooms.setOptions(ids[0]!, { callWindowSec: 8, decks: 2, junk: 1 }));
    expect(rec.last<RoomState>('room:state').options).toEqual({ callWindowSec: 8, decks: 2 });
    must(rooms.setGame(ids[0]!, '29'));
    expect(rec.last<RoomState>('room:state')).toMatchObject({ game: '29', options: {} });
  });

  it('start is refused until the player count is valid', () => {
    const { ids, code } = setup('bluff', 3);
    expect(rooms.start(ids[0]!)).toMatchObject({ ok: false, error: { code: 'BAD_PLAYER_COUNT' } });
    must(rooms.join(code, 'P3', undefined, 's3'));
    must(rooms.start(ids[0]!));
    expect(rec.last<RoomState>('room:state').status).toBe('playing');
  });

  it('kicking removes the player, re-seats the rest and tells the kicked socket', () => {
    const { ids } = setup('bluff', 4);
    must(rooms.kick(ids[0]!, ids[1]!));
    expect(rec.last<RoomState>('room:state').players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(rec.sent.at(-2)).toMatchObject({ to: 'socket:sock1', event: 'room:kicked', payload: { reason: 'kicked' } });
    expect(rooms.roomOf(ids[1]!)).toBeUndefined();
  });
});

describe('game flow through the room', () => {
  it('sends public state to the room and each hand only to its owner', () => {
    const { ids, code } = setup('bluff', 4);
    must(rooms.start(ids[0]!));
    const pub = rec.last<GameStatePayload>('game:state', `room:${code}`);
    expect(pub.game).toBe('bluff');
    for (const id of ids) {
      const hand = rec.last<HandPayload>('game:hand', `player:${id}`);
      expect(hand.cards.length).toBe(13);
    }
    // No hand ever goes to the room channel.
    expect(rec.sent.some((m) => m.event === 'game:hand' && m.to.startsWith('room:'))).toBe(false);
  });

  it('rejects invalid actions with an error and changes nothing', () => {
    const { ids } = setup('bluff', 4);
    must(rooms.start(ids[0]!));
    const before = rec.sent.length;
    const st = rec.last<GameStatePayload>('game:state').state as BluffPublicState;
    const notTurn = ids.find((id) => id !== st.turnPlayerId)!;
    expect(rooms.action(notTurn, { type: 'bluff:play', cardIds: ['nope'] })).toMatchObject({ ok: false });
    expect(rooms.action(st.turnPlayerId, { type: 'bluff:windowClosed' })).toMatchObject({ ok: false });
    expect(rec.sent.length).toBe(before);
  });

  it('closes the call window on the server timer', () => {
    const { ids } = setup('bluff', 4);
    must(rooms.start(ids[0]!));
    const st = rec.last<GameStatePayload>('game:state').state as BluffPublicState;
    const card = rec.last<HandPayload>('game:hand', `player:${st.turnPlayerId}`).cards[0]!;
    must(rooms.action(st.turnPlayerId, { type: 'bluff:play', cardIds: [card.id] }));
    expect((rec.last<GameStatePayload>('game:state').state as BluffPublicState).phase).toBe('callWindow');
    vi.advanceTimersByTime(5000);
    const after = rec.last<GameStatePayload>('game:state').state as BluffPublicState;
    expect(after.phase).toBe('turn');
    expect(after.requiredRank).toBe('2');
  });
});

describe('disconnect and reconnect', () => {
  it('a refresh with the same session returns the same seat and hand', () => {
    const { ids, players, code } = setup('bluff', 4);
    must(rooms.start(ids[0]!));
    const hand = rec.last<HandPayload>('game:hand', `player:${ids[2]}`);
    rooms.disconnect(ids[2]!, 'sock2');
    expect(rec.last<RoomState>('room:state').players[2]).toMatchObject({ connected: false, holdUntil: 1_000_000 + HOLD_MS });
    expect(rec.last<RoomState>('room:state').paused).toEqual({ waitingFor: [ids[2]], awaitingHostDecision: false });

    const again = must(rooms.join(code, 'ignored', players[2]!.sessionId, 'sock2b'));
    expect(again.playerId).toBe(ids[2]);
    expect(rec.last<HandPayload>('game:hand', `player:${ids[2]}`)).toEqual(hand);
    const st = rec.last<RoomState>('room:state');
    expect(st.paused).toBeNull();
    expect(st.players[2]).toEqual({ id: ids[2], name: 'P2', seat: 2, connected: true });
  });

  it('a second tab with the same session takes the seat over', () => {
    const { ids, players, code } = setup('bluff', 4);
    must(rooms.join(code, 'x', players[1]!.sessionId, 'other-tab'));
    expect(rec.sent.find((m) => m.event === 'room:kicked')).toMatchObject({ to: 'socket:sock1', payload: { reason: 'replaced' } });
    // The old socket's disconnect no longer affects the player.
    rooms.disconnect(ids[1]!, 'sock1');
    expect(rec.last<RoomState>('room:state').players[1]!.connected).toBe(true);
  });

  it('pauses timers while someone is away and resumes with the time they had left', () => {
    const { ids, players, code } = setup('bluff', 4);
    must(rooms.start(ids[0]!));
    const st = rec.last<GameStatePayload>('game:state').state as BluffPublicState;
    const card = rec.last<HandPayload>('game:hand', `player:${st.turnPlayerId}`).cards[0]!;
    must(rooms.action(st.turnPlayerId, { type: 'bluff:play', cardIds: [card.id] }));
    vi.advanceTimersByTime(2000); // 3s left in the window
    const away = ids.find((id) => id !== st.turnPlayerId)!;
    const awayIdx = ids.indexOf(away);
    rooms.disconnect(away, `sock${awayIdx}`);
    expect(rooms.action(ids.find((id) => id !== st.turnPlayerId && id !== away)!, { type: 'bluff:call' })).toMatchObject({
      ok: false,
      error: { code: 'GAME_PAUSED' },
    });
    vi.advanceTimersByTime(20_000);
    expect((rec.last<GameStatePayload>('game:state').state as BluffPublicState).phase).toBe('callWindow');
    must(rooms.join(code, '', players[awayIdx]!.sessionId, 'back'));
    const resumed = rec.last<GameStatePayload>('game:state').state as BluffPublicState;
    expect(resumed.callDeadline).toBe(Date.now() + 3000);
    vi.advanceTimersByTime(2999);
    expect((rec.last<GameStatePayload>('game:state').state as BluffPublicState).phase).toBe('callWindow');
    vi.advanceTimersByTime(1);
    expect((rec.last<GameStatePayload>('game:state').state as BluffPublicState).phase).toBe('turn');
  });

  it('after the hold the host decides: wait gives another hold, end finishes the game', () => {
    const { ids } = setup('29', 4);
    must(rooms.start(ids[0]!));
    rooms.disconnect(ids[3]!, 'sock3');
    expect(rooms.hostDecision(ids[0]!, 'end')).toMatchObject({ ok: false, error: { code: 'NOT_WAITING' } });
    vi.advanceTimersByTime(HOLD_MS);
    expect(rec.last<RoomState>('room:state').paused).toEqual({ waitingFor: [ids[3]], awaitingHostDecision: true });
    must(rooms.hostDecision(ids[0]!, 'wait'));
    expect(rec.last<RoomState>('room:state').paused?.awaitingHostDecision).toBe(false);
    vi.advanceTimersByTime(HOLD_MS);
    must(rooms.hostDecision(ids[0]!, 'end'));
    expect(rec.last('game:over')).toEqual({ game: '29', reason: 'ended', endedBy: ids[0] });
    expect(rec.last<RoomState>('room:state').status).toBe('over');
    // Back to the lobby drops the player who never came back.
    must(rooms.reset(ids[0]!));
    const st = rec.last<RoomState>('room:state');
    expect(st.status).toBe('lobby');
    expect(st.players.map((p) => p.id)).toEqual(ids.slice(0, 3));
  });

  it('the host role passes on when the host’s hold runs out', () => {
    const { ids } = setup('bluff', 4);
    rooms.disconnect(ids[0]!, 'sock0');
    vi.advanceTimersByTime(HOLD_MS);
    const st = rec.last<RoomState>('room:state');
    expect(st.hostId).toBe(ids[1]);
    expect(st.players.map((p) => p.id)).toEqual(ids.slice(1));
  });

  it('leaving the lobby frees the seat at once', () => {
    const { ids } = setup('bluff', 4);
    must(rooms.leave(ids[2]!));
    expect(rec.last<RoomState>('room:state').players.map((p) => p.id)).toEqual([ids[0], ids[1], ids[3]]);
  });
});

describe('cleanup', () => {
  it('deletes a room 30 minutes after the last player left', () => {
    const { ids, code, players } = setup('29', 4);
    must(rooms.start(ids[0]!));
    ids.forEach((id, i) => rooms.disconnect(id, `sock${i}`));
    rooms.sweep();
    vi.advanceTimersByTime(EMPTY_ROOM_MS - 1);
    rooms.sweep();
    expect(rooms.roomCount()).toBe(1);
    vi.advanceTimersByTime(1);
    rooms.sweep();
    expect(rooms.roomCount()).toBe(0);
    expect(rooms.join(code, 'x', players[0]!.sessionId, 's')).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  });
});

describe('livekit lookup', () => {
  it('finds a player only by their own session in their own room', () => {
    const { code, players } = setup('bluff', 2);
    expect(rooms.playerBySession(code, players[1]!.sessionId)).toEqual({ id: players[1]!.playerId, name: 'P1' });
    expect(rooms.playerBySession(code, 'guess')).toBeNull();
    expect(rooms.playerBySession('AAAAAA', players[1]!.sessionId)).toBeNull();
  });
});

describe('cryptoRng', () => {
  it('stays in [0, 1)', async () => {
    const { cryptoRng } = await import('./rooms.js');
    for (let i = 0; i < 1000; i++) {
      const x = cryptoRng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
