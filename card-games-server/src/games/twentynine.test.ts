import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../../shared/types.js';
import { seededRng } from './deck.js';
import type { EngineContext } from './engine.js';
import {
  cardPoints,
  handValue,
  MIN_BID,
  ROUND_BREAK_MS,
  target,
  trickWinner,
  twentyNineEngine as E,
  type TwentyNineState,
} from './twentynine.js';

const P = ['s0', 's1', 's2', 's3'];
const ctx = (now = 1000, seed = 1): EngineContext => ({ now, rng: seededRng(seed) });
const c = (rank: Rank, suit: Suit): Card => ({ id: `${rank}${suit}`, rank, suit });
const ALL: Rank[] = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
const suitOf = (suit: Suit, ranks = ALL) => ranks.map((r) => c(r, suit));

function ok(r: ReturnType<typeof E.apply>): TwentyNineState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}
const code = (r: ReturnType<typeof E.apply>) => (r.ok ? null : r.error.code);
const act = (s: TwentyNineState, seat: number, a: Record<string, unknown>) => ok(E.apply(s, P[seat]!, a, ctx()));
const play = (s: TwentyNineState, seat: number, id: string) => act(s, seat, { type: 't9:play', cardId: id });

/** Dealer is seat 3, so seat 0 (dealer's right) bids and leads first. */
function fresh(): TwentyNineState {
  return { ...E.init(P, {}, ctx()), dealerSeat: 3, turnSeat: 0, auction: { early: 0, queue: [1, 2, 3] } };
}

/** Seat 0 has bid and chosen `trump` (still hidden); play is about to start with seat 0 to lead. */
function playing(hands: Card[][], trump: Suit, o: Partial<TwentyNineState> = {}): TwentyNineState {
  const bid = o.highestBid?.amount ?? 16;
  return {
    ...fresh(),
    phase: 'playing',
    hands,
    stock: [],
    bids: [{ seat: 0, amount: bid }],
    passed: [false, true, true, true],
    highestBid: { seat: 0, amount: bid },
    trumpMode: 'normal',
    trumpSuit: trump,
    turnSeat: 0,
    ...o,
  };
}

/** Bid 16 at seat 0, everyone else passes. */
function wonBid(amount = 16): TwentyNineState {
  let s = act(fresh(), 0, { type: 't9:bid', amount });
  if (s.phase === 'bidding') for (const seat of [1, 2, 3]) s = act(s, seat, { type: 't9:bid', pass: true });
  return s;
}

describe('setup', () => {
  it('the deck holds 28 points; 4 cards each to start, 16 kept back', () => {
    const s = E.init(P, {}, ctx());
    const all = [...s.hands.flat(), ...s.stock];
    expect(all).toHaveLength(32);
    expect(all.reduce((n, x) => n + cardPoints(x), 0)).toBe(28);
    expect(s.hands.map((h) => h.length)).toEqual([4, 4, 4, 4]);
    expect(s.turnSeat).toBe((s.dealerSeat + 1) % 4);
  });

  it('hand values: normal 1, 7th card 2, single 3, single with 7th card 6', () => {
    expect([handValue('normal', false), handValue('seventh', false), handValue('normal', true), handValue('seventh', true)]).toEqual([
      1, 2, 3, 6,
    ]);
  });
});

describe('bidding: duels with the hold rule', () => {
  const bid = (s: TwentyNineState, seat: number, amount: number, single = false) => act(s, seat, { type: 't9:bid', amount, single });
  const pass = (s: TwentyNineState, seat: number) => act(s, seat, { type: 't9:bid', pass: true });
  const bidErr = (s: TwentyNineState, seat: number, amount: number) => code(E.apply(s, P[seat]!, { type: 't9:bid', amount }, ctx()));

  it("opens at the dealer's right with 16 to 28", () => {
    const s = fresh();
    expect(bidErr(s, 1, 16)).toBe('NOT_YOUR_TURN');
    expect(bidErr(s, 0, MIN_BID - 1)).toBe('BAD_BID');
    expect(bidErr(s, 0, 29)).toBe('BAD_BID');
    expect(E.publicState(s).minBid).toBe(16);
  });

  it('the later bidder must go higher; the earlier one may hold (match) the bid', () => {
    let s = bid(fresh(), 0, 16); // A opens 16
    expect(s.turnSeat).toBe(1);
    expect(bidErr(s, 1, 16)).toBe('BAD_BID'); // B cannot match
    s = bid(s, 1, 17); // B goes higher
    expect(s.turnSeat).toBe(0); // back to A
    expect(E.publicState(s)).toMatchObject({ holderSeat: 0, minBid: 17 });
    expect(bidErr(s, 0, 16)).toBe('BAD_BID');
    s = bid(s, 0, 17); // A holds at 17
    expect(s.highestBid).toEqual({ seat: 0, amount: 17 });
    expect(s.turnSeat).toBe(1);
    expect(bidErr(s, 1, 17)).toBe('BAD_BID'); // B must say 18 or more
    s = bid(s, 1, 19);
    s = bid(s, 0, 20); // A may also go higher than needed
    expect(s.turnSeat).toBe(1);
  });

  it('whoever passes is out, and the next seat challenges the one still in', () => {
    let s = bid(fresh(), 0, 16);
    s = bid(s, 1, 17);
    s = pass(s, 0); // A drops: B now holds, C challenges
    expect(s.turnSeat).toBe(2);
    expect(bidErr(s, 2, 17)).toBe('BAD_BID');
    s = bid(s, 2, 18);
    expect(s.turnSeat).toBe(1); // B (earlier than C) may hold
    s = bid(s, 1, 18);
    s = pass(s, 2); // C drops: D challenges B
    expect(s.turnSeat).toBe(3);
    s = pass(s, 3);
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid).toEqual({ seat: 1, amount: 18 });
    expect(s.turnSeat).toBe(1);
  });

  it('if the opener passes, the next seat opens', () => {
    let s = pass(fresh(), 0);
    expect(s.turnSeat).toBe(1);
    s = bid(s, 1, 16);
    expect(s.turnSeat).toBe(2);
  });

  it('if the first three pass, the dealer is forced to bid 16', () => {
    let s = fresh();
    for (const seat of [0, 1, 2]) s = pass(s, seat);
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid).toEqual({ seat: 3, amount: 16 });
    expect(s.bids.at(-1)).toEqual({ seat: 3, amount: 16, forced: true });
    expect(s.turnSeat).toBe(3);
  });

  it('28 can be held; once the earlier bidder holds 28 the auction is over', () => {
    let s = bid(fresh(), 0, 20);
    s = bid(s, 1, 28);
    expect(s.phase).toBe('bidding');
    expect(s.turnSeat).toBe(0);
    s = bid(s, 0, 28);
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid).toEqual({ seat: 0, amount: 28 });
  });

  it('a 28 that is not held wins straight away; nobody else can go higher', () => {
    let s = bid(fresh(), 0, 20);
    s = bid(s, 1, 28, true);
    s = pass(s, 0);
    expect(s.phase).toBe('trumpSelect');
    expect(s.highestBid).toEqual({ seat: 1, amount: 28 });
    expect(s.single).toBe(true);
    expect(E.publicState(s).sittingOutSeat).toBe(3);
  });

  it('single hand is declared with a 28 bid, and only with 28', () => {
    expect(code(E.apply(fresh(), 's0', { type: 't9:bid', amount: 20, single: true }, ctx()))).toBe('BAD_BID');
    let s = bid(fresh(), 0, 28, true);
    expect(s.turnSeat).toBe(1); // still challengeable in principle, but nobody can beat 28
    s = pass(s, 1);
    expect(s.phase).toBe('trumpSelect');
    expect(s.single).toBe(true);
  });

  it('the opener bidding 28 ends it once the challenger passes; a holder matching a single 28 plays normally', () => {
    let s = bid(fresh(), 0, 16);
    s = bid(s, 1, 28, true);
    s = bid(s, 0, 28); // A holds 28 without declaring single
    expect(s.highestBid).toEqual({ seat: 0, amount: 28 });
    expect(s.single).toBe(false);
  });
});

describe('choosing trump', () => {
  it('normal: the bidder names a suit they hold; every card stays in hand', () => {
    const s = wonBid();
    const suit = s.hands[0]![2]!.suit;
    const missing = (['S', 'H', 'D', 'C'] as Suit[]).find((x) => !s.hands[0]!.some((c) => c.suit === x));
    expect(code(E.apply(s, 's1', { type: 't9:setTrump', suit }, ctx()))).toBe('NOT_BIDDER');
    if (missing) expect(code(E.apply(s, 's0', { type: 't9:setTrump', suit: missing }, ctx()))).toBe('NO_SUCH_SUIT');
    const n = act(s, 0, { type: 't9:setTrump', suit });
    expect(n.phase).toBe('doubling');
    expect(n.hands.map((h) => h.length)).toEqual([8, 8, 8, 8]);
    expect(n.trumpSuit).toBe(suit);
    expect(n.trumpMode).toBe('normal');
  });

  it('normal: only the bidder learns the suit', () => {
    const s = wonBid();
    const suit = s.hands[0]![0]!.suit;
    const n = act(s, 0, { type: 't9:setTrump', suit });
    const pub = E.publicState(n);
    expect(pub.trumpSuit).toBeUndefined();
    expect(pub.trumpHidden).toBe(true);
    expect(E.hand(n, 's0').secretTrump).toBe(suit);
    for (const p of ['s1', 's2', 's3']) expect(E.hand(n, p).secretTrump).toBeUndefined();
  });

  it("7th card: trump is the suit of the bidder's 7th card, which stays in hand unmarked and unknown", () => {
    const before = wonBid();
    const n = act(before, 0, { type: 't9:seventhCard' });
    expect(n.trumpMode).toBe('seventh');
    expect(n.hands.map((h) => h.length)).toEqual([8, 8, 8, 8]);
    expect(new Set(n.hands.flat().map((x) => x.id)).size).toBe(32);
    // The 7th card is the first of the bidder's second four, dealt from the stock in order.
    const bidderBatch = 0; // seat 0 is the dealer's right, so it is dealt first
    expect(n.trumpSuit).toBe(before.stock[bidderBatch * 4]!.suit);
    expect(E.hand(n, 's0').secretTrump).toBeUndefined();
    expect(E.publicState(n).trumpSuit).toBeUndefined();
  });

  it("7th card: the bidder's new cards arrive in a mixed order, so the 7th can't be picked out", () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const base = { ...wonBid(), stock: wonBid().stock };
      const n = ok(E.apply(base, 's0', { type: 't9:seventhCard' }, ctx(1000, seed)));
      const seventh = base.stock[0]!.id;
      orders.add(String(n.hands[0]!.slice(4).findIndex((c) => c.id === seventh)));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('double and redouble', () => {
  const ready = () => act(wonBid(), 0, { type: 't9:setTrump', suit: wonBid().hands[0]![0]!.suit });

  it("only the opponents may double; if both decline, play starts at the dealer's right", () => {
    let s = ready();
    expect(code(E.apply(s, 's2', { type: 't9:double', double: true }, ctx()))).toBe('NOT_OPPONENT');
    s = act(s, 1, { type: 't9:double', double: false });
    expect(s.phase).toBe('doubling');
    expect(code(E.apply(s, 's1', { type: 't9:double', double: false }, ctx()))).toBe('ALREADY_ANSWERED');
    s = act(s, 3, { type: 't9:double', double: false });
    expect(s.phase).toBe('playing');
    expect(s.doubled).toBe(0);
    expect(s.turnSeat).toBe(0);
  });

  it("a double lets the bidder's team redouble", () => {
    let s = act(ready(), 3, { type: 't9:double', double: true });
    expect(s.phase).toBe('redoubling');
    expect(s.doubled).toBe(1);
    expect(code(E.apply(s, 's1', { type: 't9:double', double: true }, ctx()))).toBe('NOT_BIDDING_TEAM');
    s = act(s, 2, { type: 't9:double', double: true });
    expect(s.phase).toBe('playing');
    expect(s.doubled).toBe(2);
  });

  it("stays doubled if the bidder's team both decline to redouble", () => {
    let s = act(ready(), 1, { type: 't9:double', double: true });
    s = act(s, 0, { type: 't9:double', double: false });
    expect(s.phase).toBe('redoubling');
    s = act(s, 2, { type: 't9:double', double: false });
    expect(s.phase).toBe('playing');
    expect(s.doubled).toBe(1);
  });
});

describe('play', () => {
  const hands = () => [
    [c('J', 'S'), c('7', 'S'), c('9', 'H')],
    [c('9', 'S'), c('7', 'D')],
    [c('A', 'D'), c('8', 'H'), c('K', 'D')],
    [c('K', 'S'), c('Q', 'C')],
  ];

  it('must follow the lead suit if able; a hidden trump played without asking is an ordinary card', () => {
    let s = playing(hands(), 'D');
    s = play(s, 0, 'JS');
    expect(code(E.apply(s, 's1', { type: 't9:play', cardId: '7D' }, ctx()))).toBe('MUST_FOLLOW_SUIT');
    s = play(s, 1, '9S');
    s = play(s, 2, 'AD'); // a trump, but trump is still hidden: an ordinary card
    s = play(s, 3, 'KS');
    expect(s.lastTrick).toMatchObject({ winnerSeat: 0, points: 3 + 2 + 1 });
  });

  it('asking for trump announces the suit, and the asker must trump that trick', () => {
    let s = playing(hands(), 'D');
    s = play(s, 0, '7S');
    expect(code(E.apply(s, 's1', { type: 't9:revealTrump' }, ctx()))).toBe('CANNOT_REVEAL'); // holds 9S
    s = play(s, 1, '9S');
    s = act(s, 2, { type: 't9:revealTrump' });
    expect(E.publicState(s)).toMatchObject({
      trumpRevealed: true,
      trumpSuit: 'D',
      revealedBySeat: 2,
      mustTrumpSeat: 2,
      trumpHidden: false,
    });
    expect(s.hands.map((h) => h.length)).toEqual([2, 1, 3, 2]); // nobody's hand changes
    expect(code(E.apply(s, 's2', { type: 't9:play', cardId: '8H' }, ctx()))).toBe('MUST_TRUMP');
    s = play(s, 2, 'KD');
    s = play(s, 3, 'KS');
    expect(s.lastTrick?.winnerSeat).toBe(2);
    expect(s.mustTrumpSeat).toBeUndefined(); // only for that trick
  });

  it('the bidder may reveal trump themselves when they cannot follow, then must play a trump', () => {
    let s = playing(
      [
        [c('9', 'H'), c('8', 'C')],
        [c('J', 'S'), c('7', 'C')],
        [c('A', 'S'), c('8', 'D')],
        [c('K', 'S'), c('Q', 'C')],
      ],
      'H',
      { turnSeat: 1 },
    );
    s = play(s, 1, 'JS');
    s = play(s, 2, 'AS');
    s = play(s, 3, 'KS');
    s = act(s, 0, { type: 't9:revealTrump' });
    expect(s.trumpSuit).toBe('H');
    expect(code(E.apply(s, 's0', { type: 't9:play', cardId: '8C' }, ctx()))).toBe('MUST_TRUMP');
    s = play(s, 0, '9H');
    expect(s.lastTrick?.winnerSeat).toBe(0);
  });

  it('if nobody asks for trump, the whole hand is played with no trumps', () => {
    // Trump is hearts; seat 3's hearts never count as trumps because nobody asks.
    const hearts = suitOf('H', ['J', '9', 'A', '10', 'K', 'Q', '8']);
    let s = playing([suitOf('S'), suitOf('D'), suitOf('C'), [c('7', 'H'), ...hearts]], 'H');
    for (let t = 0; t < 8; t++) for (const seat of [0, 1, 2, 3]) s = play(s, seat, s.hands[seat]![0]!.id);
    expect(s.tricksWon).toEqual([8, 0]);
    expect(s.pointsTaken).toEqual([s.pointsTaken[0], 0]);
    expect(s.phase).toBe('roundOver');
  });

  it('highest trump wins among trumps played after the reveal', () => {
    const t = (seat: number, card: Card, afterReveal: boolean) => ({ seat, card, afterReveal });
    expect(trickWinner([t(0, c('J', 'S'), false), t(1, c('7', 'H'), true), t(2, c('9', 'H'), true), t(3, c('A', 'S'), true)], 'H')).toBe(2);
    expect(trickWinner([t(0, c('7', 'S'), false), t(1, c('J', 'H'), false), t(2, c('8', 'S'), true), t(3, c('Q', 'S'), true)], 'H')).toBe(
      3,
    );
    expect(trickWinner([t(0, c('J', 'H'), false), t(1, c('9', 'H'), true), t(2, c('7', 'S'), true), t(3, c('A', 'H'), true)], 'H')).toBe(0);
  });
});

describe('pair (King + Queen of trump)', () => {
  /** Trump (hearts) already revealed; seat 0 holds K+Q of hearts and leads the winning J of spades. */
  const setup = (bidder = 0, amount = 20) =>
    playing(
      [
        [c('J', 'S'), c('K', 'H'), c('Q', 'H')],
        [c('7', 'S'), c('7', 'C')],
        [c('8', 'S'), c('8', 'C')],
        [c('9', 'S'), c('9', 'C')],
      ],
      'H',
      { trumpRevealed: true, highestBid: { seat: bidder, amount } },
    );
  const afterTrick = (s: TwentyNineState) => play(play(play(play(s, 0, 'JS'), 1, '7S'), 2, '8S'), 3, '9S');

  it('cannot be declared before trump is revealed, or before your side wins a trick', () => {
    const hidden = { ...setup(), trumpRevealed: false };
    expect(code(E.apply(afterTrick(hidden), 's0', { type: 't9:pair' }, ctx()))).toBe('NO_PAIR');
    expect(code(E.apply(setup(), 's0', { type: 't9:pair' }, ctx()))).toBe('NO_PAIR');
  });

  it("by the bidder's team: their target drops by 4 (never below 16)", () => {
    const s = act(afterTrick(setup(0, 20)), 0, { type: 't9:pair' });
    expect(s.pair).toEqual({ seat: 0, team: 0 });
    expect(target(s)).toBe(16);
    expect(target({ highestBid: { seat: 0, amount: 18 }, pair: { seat: 0, team: 0 } })).toBe(16);
    expect(code(E.apply(s, 's0', { type: 't9:pair' }, ctx()))).toBe('PAIR_DONE');
  });

  it("by the opponents: the bidder's target rises by 4 (never above 28)", () => {
    const s = act(afterTrick(setup(1, 20)), 0, { type: 't9:pair' });
    expect(target(s)).toBe(24);
    expect(target({ highestBid: { seat: 1, amount: 26 }, pair: { seat: 0, team: 0 } })).toBe(28);
  });

  it("the partner of the trick's winner may declare too, but not once the next card is led", () => {
    let s = playing(
      [
        [c('J', 'S'), c('8', 'C')],
        [c('7', 'S'), c('7', 'C')],
        [c('8', 'S'), c('K', 'H'), c('Q', 'H')],
        [c('9', 'S'), c('9', 'C')],
      ],
      'H',
      { trumpRevealed: true },
    );
    s = afterTrick(s);
    expect(act(s, 2, { type: 't9:pair' }).pair?.seat).toBe(2);
    const led = play(s, 0, '8C');
    expect(code(E.apply(led, 's2', { type: 't9:pair' }, ctx()))).toBe('NO_PAIR');
  });

  it('needs both cards in hand', () => {
    const s = playing([[c('J', 'S'), c('K', 'H')], [c('7', 'S')], [c('8', 'S')], [c('9', 'S')]], 'H', {
      trumpRevealed: true,
    });
    expect(code(E.apply(afterTrick(s), 's0', { type: 't9:pair' }, ctx()))).toBe('NO_PAIR');
  });
});

describe('single hand', () => {
  /** Seat 0 bid 28 single and holds all eight spades (trump). Seat 2 sits out. */
  const single = (o: Partial<TwentyNineState> = {}) =>
    playing([suitOf('S'), suitOf('H'), suitOf('D'), suitOf('C')], 'S', {
      single: true,
      highestBid: { seat: 0, amount: 28 },
      ...o,
    });

  it('the partner sits out: tricks have three cards and skip them', () => {
    let s = single();
    s = play(s, 0, 'JS');
    expect(s.turnSeat).toBe(1);
    s = play(s, 1, s.hands[1]![0]!.id);
    expect(s.turnSeat).toBe(3);
    s = play(s, 3, s.hands[3]![0]!.id);
    expect(s.tricksWon).toEqual([1, 0]);
    expect(code(E.apply(s, 's2', { type: 't9:play', cardId: s.hands[2]![0]!.id }, ctx()))).toBe('NOT_YOUR_TURN');
  });

  it('winning all 8 tricks scores 3 game points', () => {
    let s = single();
    for (let t = 0; t < 8; t++) {
      s = play(s, 0, s.hands[0]![0]!.id);
      s = play(s, 1, s.hands[1]![0]!.id);
      s = play(s, 3, s.hands[3]![0]!.id);
    }
    expect(s.phase).toBe('roundOver');
    expect(s.roundResult).toMatchObject({ single: true, made: true, delta: 3, tricksWon: [8, 0] });
    expect(s.gamePoints).toEqual([3, 0]);
  });

  it('losing a single trick ends the hand at once; with a 7th card it costs 6', () => {
    let s = single({ trumpMode: 'seventh', dealerSeat: 0, turnSeat: 1 });
    s = play(s, 1, 'JH'); // the dealer's right leads
    s = play(s, 3, 'JC');
    s = play(s, 0, '8S'); // no hearts, no reveal: an ordinary spade
    expect(s.roundResult).toMatchObject({ single: true, made: false, delta: -6 });
    // -6 in one hand: that team has lost the whole game.
    expect(s.phase).toBe('over');
    expect(s.winnerTeam).toBe(1);
  });

  it("if the dealer's right is the sitting-out partner, the next player leads", () => {
    let s = act(fresh(), 0, { type: 't9:bid', amount: 28, single: true });
    s = act(s, 1, { type: 't9:bid', pass: true });
    // Dealer 3, so seat 0 (the bidder) leads anyway; move the deal so the partner (seat 2) would lead.
    s = { ...s, dealerSeat: 1 };
    s = act(s, 0, { type: 't9:setTrump', suit: s.hands[0]![0]!.suit });
    s = act(act(s, 1, { type: 't9:double', double: false }), 3, { type: 't9:double', double: false });
    expect(s.phase).toBe('playing');
    expect(s.turnSeat).toBe(3);
  });
});

describe('scoring', () => {
  /** Seat 0 holds all eight spades (trump) and wins every trick: 28 points. */
  function sweep(o: Partial<TwentyNineState> = {}): TwentyNineState {
    let s = playing([suitOf('S'), suitOf('H'), suitOf('D'), suitOf('C')], 'S', o);
    for (let t = 0; t < 8; t++) for (let k = 0; k < 4; k++) s = play(s, s.turnSeat, s.hands[s.turnSeat]![0]!.id);
    return s;
  }

  it('target met: +1, with the summary and history recorded, then the next deal', () => {
    const s = sweep({ highestBid: { seat: 0, amount: 18 } });
    expect(s.phase).toBe('roundOver');
    expect(s.roundResult).toMatchObject({
      round: 1,
      bidderSeat: 0,
      bid: 18,
      target: 18,
      pointsTaken: [28, 0],
      made: true,
      delta: 1,
      trumpMode: 'normal',
      doubled: 0,
    });
    expect(s.history).toHaveLength(1);
    expect(E.publicState(s).trumpSuit).toBe('S');
    expect(E.nextTimer(s)).toEqual({ at: 1000 + ROUND_BREAK_MS, action: { type: 't9:nextRound' } });
    const n = ok(E.apply(s, null, { type: 't9:nextRound' }, ctx(1000 + ROUND_BREAK_MS)));
    expect(n).toMatchObject({ phase: 'bidding', round: 2, dealerSeat: 0, gamePoints: [1, 0] });
    expect(n.history).toHaveLength(1);
    expect(n.single).toBe(false);
    expect(n.doubled).toBe(0);
  });

  it('7th card, double and redouble multiply the game points', () => {
    expect(sweep({ trumpMode: 'seventh' }).roundResult?.delta).toBe(2);
    expect(sweep({ doubled: 1 }).roundResult?.delta).toBe(2);
    expect(sweep({ doubled: 2, trumpMode: 'seventh' }).roundResult?.delta).toBe(8);
  });

  it('target missed: the bidding team loses the same', () => {
    // The last trick of a hand: team 0 bid 20 and has 10 points going in.
    let s = playing([[c('7', 'S')], [c('8', 'S')], [c('J', 'S')], [c('Q', 'S')]], 'D', {
      highestBid: { seat: 0, amount: 20 },
      doubled: 1,
      tricksWon: [4, 3],
      pointsTaken: [10, 15],
    });
    for (const seat of [0, 1, 2, 3]) s = play(s, seat, s.hands[seat]![0]!.id);
    expect(s.roundResult).toMatchObject({ pointsTaken: [13, 15], made: false, delta: -2 });
    expect(s.gamePoints).toEqual([-2, 0]);
  });

  it('first team to +6 wins; a team at -6 loses', () => {
    const win = sweep({ gamePoints: [5, 0] });
    expect(win.phase).toBe('over');
    expect(win.winnerTeam).toBe(0);
    expect(E.nextTimer(win)).toBeNull();
    let lose = playing([[c('7', 'S')], [c('J', 'S')], [c('8', 'S')], [c('Q', 'S')]], 'D', {
      gamePoints: [-5, 0],
      tricksWon: [0, 7],
      pointsTaken: [0, 25],
    });
    for (const seat of [0, 1, 2, 3]) lose = play(lose, seat, lose.hands[seat]![0]!.id);
    expect(lose.gamePoints).toEqual([-6, 0]);
    expect(lose.winnerTeam).toBe(1);
  });
});

describe('a full random hand', () => {
  it('plays a legal hand with a 7th card and a double to a scored result', () => {
    const at = { now: 0, rng: seededRng(9) };
    let s = E.init(P, {}, at);
    s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:bid', amount: 16 }, at));
    while (s.phase === 'bidding') s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:bid', pass: true }, at));
    s = ok(E.apply(s, P[s.turnSeat]!, { type: 't9:seventhCard' }, at));
    const opp = [0, 1, 2, 3].filter((x) => x % 2 !== s.highestBid!.seat % 2);
    s = ok(E.apply(s, P[opp[0]!]!, { type: 't9:double', double: true }, at));
    for (const seat of [0, 1, 2, 3].filter((x) => !opp.includes(x)))
      if (s.phase === 'redoubling') s = ok(E.apply(s, P[seat]!, { type: 't9:double', double: false }, at));
    while (s.phase === 'playing') {
      const seat = s.turnSeat;
      const hand = s.hands[seat]!;
      const lead = s.currentTrick[0]?.card.suit;
      if (lead && !hand.some((x) => x.suit === lead) && !s.trumpRevealed) s = ok(E.apply(s, P[seat]!, { type: 't9:revealTrump' }, at));
      const h = s.hands[seat]!;
      let legal = lead && h.some((x) => x.suit === lead) ? h.filter((x) => x.suit === lead) : h;
      if (s.mustTrumpSeat === seat && legal.some((x) => x.suit === s.trumpSuit)) legal = legal.filter((x) => x.suit === s.trumpSuit);
      s = ok(E.apply(s, P[seat]!, { type: 't9:play', cardId: legal[0]!.id }, at));
    }
    expect(['roundOver', 'over']).toContain(s.phase);
    expect(s.tricksWon[0] + s.tricksWon[1]).toBe(8);
    expect(s.pointsTaken[0] + s.pointsTaken[1]).toBe(28);
    expect(Math.abs(s.roundResult!.delta)).toBe(4); // 7th card (2) doubled
    expect(s.hands.every((h) => h.length === 0)).toBe(true);
  });
});
