import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../../shared/types.js';
import { seededRng } from './deck.js';
import type { EngineContext } from './engine.js';
import { cardPoints, MIN_BID, ROUND_BREAK_MS, trickWinner, twentyNineEngine as E, type TwentyNineState } from './twentynine.js';

const P = ['s0', 's1', 's2', 's3'];
const ctx = (now = 1000, seed = 1): EngineContext => ({ now, rng: seededRng(seed) });
const c = (rank: Rank, suit: Suit): Card => ({ id: `${rank}${suit}`, rank, suit });

function ok(r: ReturnType<typeof E.apply>): TwentyNineState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}
const code = (r: ReturnType<typeof E.apply>) => (r.ok ? null : r.error.code);

/** Dealer is seat 3, so seat 0 (dealer's right) bids and leads first. */
function fresh(): TwentyNineState {
  const s = E.init(P, {}, ctx());
  return { ...s, dealerSeat: 3, turnSeat: 0 };
}

/** A playing-phase state with chosen hands. Bidder is seat 0 at `bid`, trump hidden. */
function playing(hands: Card[][], trump: Suit, bid = 16): TwentyNineState {
  return {
    ...fresh(),
    phase: 'playing',
    hands,
    stock: [],
    bids: [{ seat: 0, amount: bid }],
    passed: [false, true, true, true],
    highestBid: { seat: 0, amount: bid },
    trumpSuit: trump,
    turnSeat: 0,
  };
}

describe('scoring basics', () => {
  it('the deck holds 28 points', () => {
    const s = E.init(P, {}, ctx());
    const all = [...s.hands.flat(), ...s.stock];
    expect(all).toHaveLength(32);
    expect(all.reduce((n, x) => n + cardPoints(x), 0)).toBe(28);
  });

  it('deals 4 each and keeps 16 back', () => {
    const s = E.init(P, {}, ctx());
    expect(s.hands.map((h) => h.length)).toEqual([4, 4, 4, 4]);
    expect(s.stock).toHaveLength(16);
    expect(s.phase).toBe('bidding');
    expect(s.turnSeat).toBe((s.dealerSeat + 1) % 4);
  });
});

describe('bidding', () => {
  it('starts at the dealer’s right; bids must rise from 16 to 28', () => {
    const s = fresh();
    expect(code(E.apply(s, 's1', { type: 't9:bid', amount: 16 }, ctx()))).toBe('NOT_YOUR_TURN');
    expect(code(E.apply(s, 's0', { type: 't9:bid', amount: MIN_BID - 1 }, ctx()))).toBe('BAD_BID');
    expect(code(E.apply(s, 's0', { type: 't9:bid', amount: 29 }, ctx()))).toBe('BAD_BID');
    const a = ok(E.apply(s, 's0', { type: 't9:bid', amount: 17 }, ctx()));
    expect(a.turnSeat).toBe(1);
    expect(code(E.apply(a, 's1', { type: 't9:bid', amount: 17 }, ctx()))).toBe('BAD_BID');
  });

  it('passed players are skipped and cannot bid again; 3 passes end it', () => {
    let s = fresh();
    s = ok(E.apply(s, 's0', { type: 't9:bid', amount: 16 }, ctx()));
    s = ok(E.apply(s, 's1', { type: 't9:bid', pass: true }, ctx()));
    s = ok(E.apply(s, 's2', { type: 't9:bid', amount: 18 }, ctx()));
    s = ok(E.apply(s, 's3', { type: 't9:bid', pass: true }, ctx()));
    expect(s.turnSeat).toBe(0);
    s = ok(E.apply(s, 's0', { type: 't9:bid', amount: 19 }, ctx()));
    expect(s.turnSeat).toBe(2); // s1 and s3 passed
    s = ok(E.apply(s, 's2', { type: 't9:bid', pass: true }, ctx()));
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid).toEqual({ seat: 0, amount: 19 });
    expect(s.turnSeat).toBe(0);
  });

  it('if the first three pass the fourth may still bid', () => {
    let s = fresh();
    for (const p of ['s0', 's1', 's2']) s = ok(E.apply(s, p, { type: 't9:bid', pass: true }, ctx()));
    expect(s.phase).toBe('bidding');
    s = ok(E.apply(s, 's3', { type: 't9:bid', amount: 16 }, ctx()));
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid?.seat).toBe(3);
  });

  it('all four pass: re-deal, dealer moves one seat', () => {
    let s = fresh();
    for (const p of P) s = ok(E.apply(s, p, { type: 't9:bid', pass: true }, ctx()));
    expect(s.phase).toBe('bidding');
    expect(s.dealerSeat).toBe(0);
    expect(s.turnSeat).toBe(1);
    expect(s.bids).toEqual([]);
    expect(s.hands.map((h) => h.length)).toEqual([4, 4, 4, 4]);
  });
});

describe('trump selection', () => {
  const won = () => {
    let s = fresh();
    s = ok(E.apply(s, 's0', { type: 't9:bid', amount: 20 }, ctx()));
    for (const p of ['s1', 's2', 's3']) s = ok(E.apply(s, p, { type: 't9:bid', pass: true }, ctx()));
    return s;
  };

  it('only the highest bidder picks, then everyone gets 8 cards', () => {
    const s = won();
    expect(code(E.apply(s, 's1', { type: 't9:setTrump', suit: 'H' }, ctx()))).toBe('NOT_BIDDER');
    expect(code(E.apply(s, 's0', { type: 't9:setTrump', suit: 'X' }, ctx()))).toBe('BAD_ACTION');
    const n = ok(E.apply(s, 's0', { type: 't9:setTrump', suit: 'H' }, ctx()));
    expect(n.phase).toBe('playing');
    expect(n.hands.map((h) => h.length)).toEqual([8, 8, 8, 8]);
    expect(n.turnSeat).toBe(0);
  });

  it('keeps trump secret from public state and from everyone but the bidder', () => {
    const n = ok(E.apply(won(), 's0', { type: 't9:setTrump', suit: 'H' }, ctx()));
    const pub = E.publicState(n);
    expect(pub.trumpSuit).toBeUndefined();
    expect(pub.trumpRevealed).toBe(false);
    expect(JSON.stringify(pub)).not.toMatch(/"(trumpSuit|secretTrump)"/);
    expect(E.hand(n, 's0').secretTrump).toBe('H');
    expect(E.hand(n, 's1').secretTrump).toBeUndefined();
    expect(E.hand(n, 's2').secretTrump).toBeUndefined();
  });
});

describe('trick play', () => {
  const hands = () => [
    [c('J', 'S'), c('7', 'S'), c('9', 'H')],
    [c('9', 'S'), c('7', 'D')],
    [c('A', 'D'), c('8', 'H')],
    [c('K', 'S'), c('Q', 'C')],
  ];

  it('must follow the lead suit if able', () => {
    let s = playing(hands(), 'H');
    s = ok(E.apply(s, 's0', { type: 't9:play', cardId: 'JS' }, ctx()));
    expect(code(E.apply(s, 's1', { type: 't9:play', cardId: '7D' }, ctx()))).toBe('MUST_FOLLOW_SUIT');
    expect(code(E.apply(s, 's1', { type: 't9:play', cardId: 'KS' }, ctx()))).toBe('NOT_YOUR_CARD');
    s = ok(E.apply(s, 's1', { type: 't9:play', cardId: '9S' }, ctx()));
    // s2 has no spades and may play anything.
    s = ok(E.apply(s, 's2', { type: 't9:play', cardId: 'AD' }, ctx()));
    s = ok(E.apply(s, 's3', { type: 't9:play', cardId: 'KS' }, ctx()));
    expect(s.currentTrick).toEqual([]);
    expect(s.lastTrick).toMatchObject({ winnerSeat: 0, points: 3 + 2 + 1 });
    expect(s.tricksWon).toEqual([1, 0]);
    expect(s.pointsTaken).toEqual([6, 0]);
    expect(s.turnSeat).toBe(0);
  });

  it('before the reveal, trump is just a card of its suit', () => {
    let s = playing(hands(), 'D');
    s = ok(E.apply(s, 's0', { type: 't9:play', cardId: '7S' }, ctx()));
    s = ok(E.apply(s, 's1', { type: 't9:play', cardId: '9S' }, ctx()));
    s = ok(E.apply(s, 's2', { type: 't9:play', cardId: 'AD' }, ctx())); // a hidden trump
    s = ok(E.apply(s, 's3', { type: 't9:play', cardId: 'KS' }, ctx()));
    expect(s.lastTrick?.winnerSeat).toBe(1);
  });

  it('reveal is only allowed when you cannot follow suit, and makes trump public', () => {
    let s = playing(hands(), 'D');
    expect(code(E.apply(s, 's0', { type: 't9:revealTrump' }, ctx()))).toBe('CANNOT_REVEAL'); // nothing led
    s = ok(E.apply(s, 's0', { type: 't9:play', cardId: '7S' }, ctx()));
    expect(code(E.apply(s, 's1', { type: 't9:revealTrump' }, ctx()))).toBe('CANNOT_REVEAL'); // holds 9S
    s = ok(E.apply(s, 's1', { type: 't9:play', cardId: '9S' }, ctx()));
    expect(code(E.apply(s, 's3', { type: 't9:revealTrump' }, ctx()))).toBe('NOT_YOUR_TURN');
    s = ok(E.apply(s, 's2', { type: 't9:revealTrump' }, ctx()));
    expect(E.publicState(s)).toMatchObject({ trumpRevealed: true, trumpSuit: 'D', revealedBySeat: 2 });
    expect(code(E.apply(s, 's2', { type: 't9:revealTrump' }, ctx()))).toBe('ALREADY_REVEALED');
    s = ok(E.apply(s, 's2', { type: 't9:play', cardId: 'AD' }, ctx()));
    s = ok(E.apply(s, 's3', { type: 't9:play', cardId: 'KS' }, ctx()));
    expect(s.lastTrick?.winnerSeat).toBe(2); // the trump played after the reveal wins
    expect(s.pointsTaken).toEqual([2 + 1, 0]);
  });

  it('highest trump wins among trumps played after the reveal', () => {
    const t = (seat: number, card: Card, afterReveal: boolean) => ({ seat, card, afterReveal });
    const trick = [t(0, c('J', 'S'), false), t(1, c('7', 'H'), true), t(2, c('9', 'H'), true), t(3, c('A', 'S'), true)];
    expect(trickWinner(trick, 'H')).toBe(2);
    // A trump played before the reveal does not count as trump.
    const early = [t(0, c('7', 'S'), false), t(1, c('J', 'H'), false), t(2, c('8', 'S'), true), t(3, c('Q', 'S'), true)];
    expect(trickWinner(early, 'H')).toBe(3);
    // Trump led: it is simply the lead suit, highest wins.
    const led = [t(0, c('J', 'H'), false), t(1, c('9', 'H'), true), t(2, c('7', 'S'), true), t(3, c('A', 'H'), true)];
    expect(trickWinner(led, 'H')).toBe(0);
  });
});

describe('round scoring and game end', () => {
  /** Play out 8 tricks where seat 0 leads and wins every trick with spades. */
  function sweep(trump: Suit, bid: number): TwentyNineState {
    const ranks: Rank[] = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
    const hands = [
      ranks.map((r) => c(r, 'S')),
      ranks.map((r) => c(r, 'H')),
      ranks.map((r) => c(r, 'D')),
      ranks.map((r) => c(r, 'C')),
    ];
    let s = playing(hands, trump, bid);
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 4; k++) {
        const seat = s.turnSeat;
        s = ok(E.apply(s, P[seat]!, { type: 't9:play', cardId: s.hands[seat]![0]!.id }, ctx(5000)));
      }
    }
    return s;
  }

  it('bidding team that reaches its bid gains a game point, and the next round is scheduled', () => {
    const s = sweep('S', 28);
    expect(s.tricksWon).toEqual([8, 0]);
    expect(s.pointsTaken).toEqual([28, 0]);
    expect(s.phase).toBe('roundOver');
    expect(s.roundResult).toEqual({ biddingTeam: 0, bid: 28, pointsTaken: [28, 0], made: true, delta: 1 });
    expect(s.gamePoints).toEqual([1, 0]);
    expect(E.publicState(s).trumpSuit).toBe('S'); // shown at round end
    expect(E.nextTimer(s)).toEqual({ at: 5000 + ROUND_BREAK_MS, action: { type: 't9:nextRound' } });
    const n = ok(E.apply(s, null, { type: 't9:nextRound' }, ctx(5000 + ROUND_BREAK_MS)));
    expect(n.phase).toBe('bidding');
    expect(n.round).toBe(2);
    expect(n.dealerSeat).toBe(0);
    expect(n.gamePoints).toEqual([1, 0]);
    expect(n.tricksWon).toEqual([0, 0]);
    expect(E.publicState(n).trumpSuit).toBeUndefined();
  });

  it('bidding team that falls short loses a game point', () => {
    // The last trick of a round: team 0 bid 20 and has 10 points going in.
    const last = playing([[c('7', 'S')], [c('8', 'S')], [c('J', 'S')], [c('Q', 'S')]], 'D', 20);
    let s = { ...last, tricksWon: [4, 3] as [number, number], pointsTaken: [10, 15] as [number, number] };
    for (const p of P) s = ok(E.apply(s, p, { type: 't9:play', cardId: s.hands[P.indexOf(p)]![0]!.id }, ctx()));
    expect(s.tricksWon).toEqual([5, 3]); // seat 2 (team 0) wins with the J
    expect(s.pointsTaken).toEqual([13, 15]);
    expect(s.phase).toBe('roundOver');
    expect(s.roundResult).toMatchObject({ biddingTeam: 0, made: false, delta: -1 });
    expect(s.gamePoints).toEqual([-1, 0]);
  });

  it('first team to +6 wins; a team at -6 loses', () => {
    const near = playing([[c('J', 'S')], [c('7', 'S')], [c('8', 'S')], [c('Q', 'S')]], 'S', 16);
    let s = { ...near, gamePoints: [5, 0] as [number, number], tricksWon: [7, 0] as [number, number], pointsTaken: [25, 0] as [number, number] };
    for (const p of P) s = ok(E.apply(s, p, { type: 't9:play', cardId: s.hands[P.indexOf(p)]![0]!.id }, ctx()));
    expect(s.phase).toBe('over');
    expect(s.winnerTeam).toBe(0);
    expect(E.isOver(s)).toBe(true);
    expect(E.nextTimer(s)).toBeNull();

    let l = { ...near, gamePoints: [-5, 0] as [number, number], tricksWon: [0, 7] as [number, number], pointsTaken: [0, 25] as [number, number] };
    l = { ...l, hands: [[c('7', 'S')], [c('J', 'S')], [c('8', 'S')], [c('Q', 'S')]] };
    for (const p of P) l = ok(E.apply(l, p, { type: 't9:play', cardId: l.hands[P.indexOf(p)]![0]!.id }, ctx()));
    expect(l.gamePoints).toEqual([-6, 0]);
    expect(l.winnerTeam).toBe(1);
  });
});

describe('a full random round', () => {
  it('plays 8 legal tricks to a scored round', () => {
    const rng = seededRng(9);
    const at = { now: 0, rng };
    let s = E.init(P, {}, at);
    s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:bid', amount: 16 }, at));
    while (s.phase === 'bidding') s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:bid', pass: true }, at));
    s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:setTrump', suit: 'C' }, at));
    while (s.phase === 'playing') {
      const seat = s.turnSeat;
      const hand = s.hands[seat]!;
      const lead = s.currentTrick[0]?.card.suit;
      const legal = lead && hand.some((x) => x.suit === lead) ? hand.filter((x) => x.suit === lead) : hand;
      if (lead && legal === hand && !s.trumpRevealed) s = ok(E.apply(s, P[seat]!, { type: 't9:revealTrump' }, at));
      s = ok(E.apply(s, P[seat]!, { type: 't9:play', cardId: legal[0]!.id }, at));
    }
    expect(['roundOver', 'over']).toContain(s.phase);
    expect(s.tricksWon[0] + s.tricksWon[1]).toBe(8);
    expect(s.pointsTaken[0] + s.pointsTaken[1]).toBe(28);
    expect(s.hands.every((h) => h.length === 0)).toBe(true);
  });
});
