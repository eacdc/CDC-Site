import { describe, expect, it } from 'vitest';
import type { Card, Rank } from '../../shared/types.js';
import { bluffEngine, nextRank, resolveBluffOptions, REVEAL_MS, type BluffState } from './bluff.js';
import { seededRng } from './deck.js';
import type { EngineContext } from './engine.js';

const P = ['p0', 'p1', 'p2', 'p3'];
const ctx = (now = 1000): EngineContext => ({ now, rng: seededRng(42) });
const c = (rank: Rank, suit: Card['suit'] = 'S'): Card => ({ id: `${rank}${suit}`, rank, suit });

/** A hand-built state where p0 is to play A. */
function state(hands: Record<string, Card[]>, over: Partial<BluffState> = {}): BluffState {
  return {
    players: P,
    hands,
    pile: [],
    phase: 'turn',
    turnIdx: 0,
    requiredRank: 'A',
    options: { decks: 1, maxCardsPerTurn: 4, callWindowSec: 5 },
    ...over,
  };
}

function ok(r: ReturnType<typeof bluffEngine.apply>): BluffState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}

const basicHands = () => ({
  p0: [c('A'), c('A', 'H'), c('5')],
  p1: [c('2'), c('3')],
  p2: [c('4'), c('6')],
  p3: [c('7'), c('8')],
});

describe('options', () => {
  it('defaults to 1 deck for 4-5 players and 2 for 6-10, 4 cards per deck', () => {
    expect(resolveBluffOptions(5)).toEqual({ decks: 1, maxCardsPerTurn: 4, callWindowSec: 5 });
    expect(resolveBluffOptions(6)).toEqual({ decks: 2, maxCardsPerTurn: 8, callWindowSec: 5 });
  });

  it('honours and clamps host options', () => {
    expect(resolveBluffOptions(8, { decks: 1, maxCardsPerTurn: 9, callWindowSec: 100 })).toEqual({
      decks: 1,
      maxCardsPerTurn: 4,
      callWindowSec: 30,
    });
  });

  it('cycles ranks A..K then A', () => {
    expect(nextRank('10')).toBe('J');
    expect(nextRank('K')).toBe('A');
  });
});

describe('init', () => {
  it('deals every card and starts on A', () => {
    const s = bluffEngine.init(['a', 'b', 'c', 'd', 'e', 'f'], {}, ctx());
    const all = Object.values(s.hands).flat();
    expect(all).toHaveLength(104);
    expect(new Set(all.map((x) => x.id)).size).toBe(104);
    expect(s.requiredRank).toBe('A');
    expect(s.phase).toBe('turn');
    // The starting player is dealt first and so holds at least as many as anyone.
    const counts = Object.values(s.hands).map((h) => h.length);
    expect(s.hands[s.players[s.turnIdx]!]!.length).toBe(Math.max(...counts));
  });
});

describe('play', () => {
  it('moves the cards to the pile and opens the call window', () => {
    const s = ok(bluffEngine.apply(state(basicHands()), 'p0', { type: 'bluff:play', cardIds: ['AS', 'AH'] }, ctx(1000)));
    expect(s.phase).toBe('callWindow');
    expect(s.pile).toHaveLength(2);
    expect(s.hands.p0).toEqual([c('5')]);
    expect(s.callDeadline).toBe(6000);
    expect(bluffEngine.publicState(s).lastPlay).toEqual({ playerId: 'p0', count: 2, claimedRank: 'A' });
  });

  it('rejects out of turn, unowned, duplicate, empty and too many cards', () => {
    const s = state(basicHands());
    const err = (pid: string, ids: unknown) => {
      const r = bluffEngine.apply(s, pid, { type: 'bluff:play', cardIds: ids }, ctx());
      return r.ok ? null : r.error.code;
    };
    expect(err('p1', ['2S'])).toBe('NOT_YOUR_TURN');
    expect(err('p0', ['2S'])).toBe('NOT_YOUR_CARD');
    expect(err('p0', ['AS', 'AS'])).toBe('BAD_ACTION');
    expect(err('p0', [])).toBe('BAD_ACTION');
    expect(err('p0', 'AS')).toBe('BAD_ACTION');
    const tight = { ...s, options: { ...s.options, maxCardsPerTurn: 1 } };
    const r = bluffEngine.apply(tight, 'p0', { type: 'bluff:play', cardIds: ['AS', 'AH'] }, ctx());
    expect(r.ok ? null : r.error.code).toBe('TOO_MANY_CARDS');
  });

  it('cannot play while the call window is open', () => {
    const s = ok(bluffEngine.apply(state(basicHands()), 'p0', { type: 'bluff:play', cardIds: ['AS'] }, ctx()));
    const r = bluffEngine.apply(s, 'p0', { type: 'bluff:play', cardIds: ['AH'] }, ctx());
    expect(r.ok).toBe(false);
  });
});

describe('call window', () => {
  const played = (ids: string[]) => ok(bluffEngine.apply(state(basicHands()), 'p0', { type: 'bluff:play', cardIds: ids }, ctx(1000)));

  it('with no call, advances the turn and the rank when the timer fires', () => {
    const s = played(['AS']);
    expect(bluffEngine.nextTimer(s)).toEqual({ at: 6000, action: { type: 'bluff:windowClosed' } });
    expect(bluffEngine.apply(s, null, { type: 'bluff:windowClosed' }, ctx(5999)).ok).toBe(false);
    const n = ok(bluffEngine.apply(s, null, { type: 'bluff:windowClosed' }, ctx(6000)));
    expect(n.phase).toBe('turn');
    expect(n.players[n.turnIdx]).toBe('p1');
    expect(n.requiredRank).toBe('2');
    expect(n.pile).toHaveLength(1);
  });

  it('a successful call (it was a bluff) gives the pile to the player who lied', () => {
    // An earlier, uncalled card is already in the pile under this play.
    const s = played(['AS', '5S']);
    const n = ok(bluffEngine.apply({ ...s, pile: [c('9', 'D'), ...s.pile] }, 'p2', { type: 'bluff:call' }, ctx(2000)));
    expect(n.phase).toBe('reveal');
    expect(n.reveal).toMatchObject({ wasBluff: true, callerId: 'p2', takerId: 'p0', playerId: 'p0' });
    expect(n.reveal!.cards.map((x) => x.id)).toEqual(['AS', '5S']);
    expect(n.pile).toHaveLength(0);
    expect(n.hands.p0.map((x) => x.id).sort()).toEqual(['5S', '9D', 'AH', 'AS']);
    expect(n.revealUntil).toBe(2000 + REVEAL_MS);
  });

  it('a failed call (honest play) gives the pile to the caller', () => {
    const s = played(['AS', 'AH']);
    const n = ok(bluffEngine.apply(s, 'p3', { type: 'bluff:call' }, ctx(2000)));
    expect(n.reveal).toMatchObject({ wasBluff: false, takerId: 'p3' });
    expect(n.hands.p3).toHaveLength(4);
  });

  it('after the reveal, play continues with the player after the one who played, next rank', () => {
    const s = ok(bluffEngine.apply(played(['AS', 'AH']), 'p3', { type: 'bluff:call' }, ctx(2000)));
    expect(bluffEngine.nextTimer(s)?.action.type).toBe('bluff:revealDone');
    const n = ok(bluffEngine.apply(s, null, { type: 'bluff:revealDone' }, ctx(2000 + REVEAL_MS)));
    expect(n.phase).toBe('turn');
    expect(n.players[n.turnIdx]).toBe('p1');
    expect(n.requiredRank).toBe('2');
  });

  it('only the first call wins the race; later ones are rejected', () => {
    const s = ok(bluffEngine.apply(played(['AS']), 'p1', { type: 'bluff:call' }, ctx(2000)));
    const r = bluffEngine.apply(s, 'p2', { type: 'bluff:call' }, ctx(2000));
    expect(r.ok ? null : r.error.code).toBe('WRONG_PHASE');
  });

  it('rejects calling your own play, calling late, and calling with nothing played', () => {
    const s = played(['AS']);
    const code = (r: ReturnType<typeof bluffEngine.apply>) => (r.ok ? null : r.error.code);
    expect(code(bluffEngine.apply(s, 'p0', { type: 'bluff:call' }, ctx(2000)))).toBe('OWN_PLAY');
    expect(code(bluffEngine.apply(s, 'p1', { type: 'bluff:call' }, ctx(6001)))).toBe('TOO_LATE');
    expect(code(bluffEngine.apply(state(basicHands()), 'p1', { type: 'bluff:call' }, ctx()))).toBe('WRONG_PHASE');
  });
});

describe('winning', () => {
  const lastCards = () => ({ ...basicHands(), p0: [c('A'), c('A', 'H')] });

  it('emptying your hand does not win until the call window closes', () => {
    const s = ok(bluffEngine.apply(state(lastCards()), 'p0', { type: 'bluff:play', cardIds: ['AS', 'AH'] }, ctx(1000)));
    expect(s.phase).toBe('callWindow');
    expect(s.winnerId).toBeUndefined();
    const n = ok(bluffEngine.apply(s, null, { type: 'bluff:windowClosed' }, ctx(6000)));
    expect(n.phase).toBe('over');
    expect(n.winnerId).toBe('p0');
    expect(bluffEngine.isOver(n)).toBe(true);
  });

  it('surviving a call on your last cards wins', () => {
    const s = ok(bluffEngine.apply(state(lastCards()), 'p0', { type: 'bluff:play', cardIds: ['AS', 'AH'] }, ctx(1000)));
    const n = ok(bluffEngine.apply(s, 'p1', { type: 'bluff:call' }, ctx(2000)));
    expect(n.phase).toBe('over');
    expect(n.winnerId).toBe('p0');
    expect(n.hands.p1).toHaveLength(4);
  });

  it('a called bluff on your last cards takes the pile and play continues', () => {
    const hands = { ...basicHands(), p0: [c('5'), c('6', 'H')] };
    const s = ok(bluffEngine.apply(state(hands), 'p0', { type: 'bluff:play', cardIds: ['5S', '6H'] }, ctx(1000)));
    const n = ok(bluffEngine.apply(s, 'p1', { type: 'bluff:call' }, ctx(2000)));
    expect(n.phase).toBe('reveal');
    expect(n.winnerId).toBeUndefined();
    expect(n.hands.p0).toHaveLength(2);
  });

  it('rejects every action once the game is over', () => {
    const over = state(basicHands(), { phase: 'over', winnerId: 'p0' });
    expect(bluffEngine.apply(over, 'p0', { type: 'bluff:play', cardIds: ['AS'] }, ctx()).ok).toBe(false);
  });
});

describe('hidden information', () => {
  it('public state never contains the pile or any hand', () => {
    const s = ok(bluffEngine.apply(state(basicHands()), 'p0', { type: 'bluff:play', cardIds: ['5S'] }, ctx()));
    const json = JSON.stringify(bluffEngine.publicState(s));
    expect(json).not.toContain('5S');
    expect(json).not.toContain('2S');
    expect(bluffEngine.publicState(s).pileCount).toBe(1);
  });

  it('hand() returns only that player’s cards', () => {
    expect(bluffEngine.hand(state(basicHands()), 'p1').cards.map((x) => x.id)).toEqual(['2S', '3S']);
  });
});

describe('pause', () => {
  it('shifts deadlines when resuming', () => {
    const s = ok(bluffEngine.apply(state(basicHands()), 'p0', { type: 'bluff:play', cardIds: ['AS'] }, ctx(1000)));
    expect(bluffEngine.shiftDeadlines(s, 500).callDeadline).toBe(6500);
  });
});

describe('a full random game', () => {
  it('always ends with a winner when everyone plays honestly-ish and nobody calls', () => {
    const rng = seededRng(3);
    let s = bluffEngine.init(['a', 'b', 'c', 'd'], {}, { now: 0, rng });
    let now = 0;
    for (let i = 0; i < 1000 && s.phase !== 'over'; i++) {
      now += 10_000;
      if (s.phase === 'turn') {
        const pid = s.players[s.turnIdx]!;
        const hand = s.hands[pid]!;
        const matching = hand.filter((x) => x.rank === s.requiredRank).slice(0, 4);
        const ids = (matching.length ? matching : hand.slice(0, 1)).map((x) => x.id);
        s = ok(bluffEngine.apply(s, pid, { type: 'bluff:play', cardIds: ids }, { now, rng }));
      } else {
        const t = bluffEngine.nextTimer(s)!;
        s = ok(bluffEngine.apply(s, null, t.action, { now: t.at, rng }));
      }
    }
    expect(s.phase).toBe('over');
    expect(s.hands[s.winnerId!]).toHaveLength(0);
  });
});

describe('someone takes over a seat', () => {
  it('the newcomer inherits the hand, the turn and the last play', () => {
    let s = state(basicHands());
    s = ok(bluffEngine.apply(s, 'p0', { type: 'bluff:play', cardIds: ['AS'] }, ctx(1000)));
    const r = bluffEngine.replacePlayer(s, 'p0', 'new');
    expect(r.players[0]).toBe('new');
    expect(r.hands.new!.map((c) => c.id)).toEqual(['AH', '5S']);
    expect(r.hands.p0).toBeUndefined();
    expect(r.lastPlay?.playerId).toBe('new');
    // The newcomer's play can still be called, and they take the pile if it was a lie.
    const called = ok(bluffEngine.apply(r, 'p1', { type: 'bluff:call' }, ctx(2000)));
    expect(called.reveal?.playerId).toBe('new');
  });
});
