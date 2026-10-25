/**
 * Four random bots play whole games of 29 through the room manager (the same
 * server code the sockets use), while a referee written independently of the
 * engine checks every rule after every move. Bots also try illegal moves on
 * purpose, and the server must refuse each one.
 *
 * Run a bigger batch with: SIM_GAMES=2000 npx vitest run src/simulate29.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, HandPayload, Suit, TwentyNinePublicState, TwentyNineRoundResult } from '../shared/types.js';
import { seededRng, type Rng } from './games/deck.js';
import { ROUND_BREAK_MS } from './games/twentynine.js';
import { RoomManager, type Transport } from './rooms.js';

const GAMES = Number(process.env.SIM_GAMES) || 300;

// ---------- The referee's own copy of the rules (deliberately not imported from the engine) ----------

const ORDER = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
const PTS: Record<string, number> = { J: 3, '9': 2, A: 1, '10': 1 };
const pts = (c: Card) => PTS[c.rank] ?? 0;
const beats = (a: Card, b: Card) => ORDER.indexOf(a.rank) < ORDER.indexOf(b.rank);
const team = (seat: number) => seat % 2;

/** Who should win a trick, given each card and whether trump was already turned up when it was played. */
function refWinner(trick: { seat: number; card: Card; afterReveal: boolean }[], trump: Suit | undefined): number {
  const lead = trick[0]!.card.suit;
  const trumps = trick.filter((t) => trump && t.card.suit === trump && (t.afterReveal || lead === trump));
  const pool = trumps.length ? trumps : trick.filter((t) => t.card.suit === lead);
  return pool.reduce((a, b) => (beats(b.card, a.card) ? b : a)).seat;
}

function refResult(r: TwentyNineRoundResult): { target: number; made: boolean; delta: number } {
  const bt = r.biddingTeam;
  let target = r.bid;
  if (r.pair) target = r.pair.team === bt ? Math.max(16, r.bid - 4) : Math.min(28, r.bid + 4);
  const made = r.single ? r.tricksWon[bt] === 8 : r.pointsTaken[bt] >= target;
  const value = (r.single ? 3 : 1) * (r.trumpMode === 'seventh' ? 2 : 1) * [1, 2, 4][r.doubled]!;
  return { target, made, delta: made ? value : -value };
}

// ---------- Harness ----------

interface Sent {
  to: string;
  event: string;
  payload: unknown;
}

function harness() {
  const sent: Sent[] = [];
  const transport: Transport = {
    toRoom: (code) => ({ emit: (event, payload) => void sent.push({ to: `room:${code}`, event, payload }) }),
    toPlayer: (id) => ({ emit: (event, payload) => void sent.push({ to: `player:${id}`, event, payload }) }),
    attach: () => {},
    detach: () => {},
  };
  return { sent, transport };
}

const stats = {
  games: 0,
  hands: 0,
  holds: 0,
  forced16: 0,
  singleHands: 0,
  singleMade: 0,
  seventh: 0,
  doubled: 0,
  redoubled: 0,
  reveals: 0,
  revealsByBidder: 0,
  neverRevealed: 0,
  pairsBidderTeam: 0,
  pairsOpponents: 0,
  made: 0,
  failed: 0,
  wonAtPlus6: 0,
  lostAtMinus6: 0,
  illegalRefused: 0,
  tricksChecked: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

function playGame(seed: number) {
  const { sent, transport } = harness();
  const rooms = new RoomManager(transport, { rng: seededRng(seed) });
  const rnd: Rng = seededRng(seed * 7919 + 1);
  const chance = (p: number) => rnd() < p;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const host = rooms.create('29', 'P0', 'x0');
  if (!host.ok) throw new Error('create failed');
  const ids = [host.playerId];
  for (let i = 1; i < 4; i++) {
    const j = rooms.join(host.code, `P${i}`, undefined, `x${i}`);
    if (!j.ok) throw new Error('join failed');
    ids.push(j.playerId);
  }
  expect(rooms.start(ids[0]!).ok).toBe(true);

  let seen = 0; // messages already checked
  let state!: TwentyNinePublicState;
  const hands = new Map<string, HandPayload>();
  let trick: { seat: number; card: Card; afterReveal: boolean }[] = [];
  let doubledSeen = 0;

  /** Read new messages and check the ones that must never leak. */
  const sync = () => {
    for (; seen < sent.length; seen++) {
      const m = sent[seen]!;
      if (m.event === 'game:hand') {
        expect(m.to.startsWith('player:'), 'a hand went to a room channel').toBe(true);
        hands.set(m.to.slice(7), m.payload as HandPayload);
      }
      if (m.event === 'game:state') {
        const st = (m.payload as { state: TwentyNinePublicState }).state;
        // The trump suit is public only once revealed (or the hand is over).
        if (!st.trumpRevealed) expect(st.trumpSuit, 'trump leaked before the reveal').toBeUndefined();
        // Only the bidder who chose trump ever learns it early, never on a 7th card.
        for (const [pid, h] of hands) {
          const seat = st.seats.indexOf(pid);
          if (h.secretTrump !== undefined) {
            expect(seat).toBe(st.highestBid?.seat);
            expect(st.trumpMode).toBe('normal');
          }
        }
        state = st;
      }
    }
  };
  const handOf = (seat: number) => hands.get(state.seats[seat]!)!.cards;

  /** Send a move that must be refused. */
  const illegal = (seat: number, action: Record<string, unknown>, code: string) => {
    const r = rooms.action(state.seats[seat]!, action);
    expect(r.ok, `illegal ${JSON.stringify(action)} was accepted`).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
    stats.illegalRefused++;
  };
  const must = (seat: number, action: Record<string, unknown>) => {
    const r = rooms.action(state.seats[seat]!, action);
    if (!r.ok) throw new Error(`refused ${JSON.stringify(action)} from seat ${seat}: ${r.error.code} ${r.error.message}`);
    sync();
  };

  sync();
  let firstPasses = 0;
  for (let step = 0; step < 20_000; step++) {
    if (state.phase === 'over') break;
    const turn = state.turnSeat;

    if (state.phase === 'roundOver') {
      vi.advanceTimersByTime(ROUND_BREAK_MS);
      sync();
      trick = [];
      firstPasses = 0;
      continue;
    }

    if (state.phase === 'bidding') {
      const cur = state.highestBid?.amount;
      const holding = cur !== undefined && state.holderSeat === turn;
      const min = cur === undefined ? 16 : holding ? cur : cur + 1;
      expect(state.minBid).toBe(min);
      // The later bidder may never match; the earlier one may.
      if (cur !== undefined && !holding && cur < 28) illegal(turn, { type: 't9:bid', amount: cur }, 'BAD_BID');
      if (min <= 28 && chance(0.55)) {
        const amount = Math.min(28, min + Math.floor(rnd() * 3));
        if (holding && amount === cur) stats.holds++;
        must(turn, { type: 't9:bid', amount, single: amount === 28 && chance(0.4) });
      } else {
        if (cur === undefined) firstPasses++;
        must(turn, { type: 't9:bid', pass: true });
        if (firstPasses === 3 && state.phase === 'trumpSelect') {
          // The first three passed: the dealer must be holding a forced 16.
          expect(state.highestBid).toEqual({ seat: state.dealerSeat, amount: 16 });
          expect(state.bids.at(-1)?.forced).toBe(true);
          stats.forced16++;
        }
      }
      continue;
    }

    if (state.phase === 'trumpSelect') {
      expect(handOf(turn)).toHaveLength(4);
      if (chance(0.5)) {
        must(turn, { type: 't9:seventhCard' });
        expect(hands.get(state.seats[turn]!)!.secretTrump, 'the bidder knows a 7th-card trump').toBeUndefined();
      } else {
        const held = handOf(turn).map((c) => c.suit);
        const missing = (['S', 'H', 'D', 'C'] as Suit[]).find((x) => !held.includes(x));
        if (missing) illegal(turn, { type: 't9:setTrump', suit: missing }, 'NO_SUCH_SUIT');
        const suit = pick(held);
        must(turn, { type: 't9:setTrump', suit });
        expect(hands.get(state.seats[turn]!)!.secretTrump).toBe(suit);
      }
      // Trump is only a suit: every card stays in hand, eight each.
      expect(state.handCounts).toEqual([8, 8, 8, 8]);
      expect(state.trumpHidden).toBe(true);
      continue;
    }

    if (state.phase === 'doubling' || state.phase === 'redoubling') {
      const bt = team(state.highestBid!.seat);
      const eligible = [0, 1, 2, 3].filter(
        (s) =>
          !state.doubleAnswered.includes(s) && (state.phase === 'doubling' ? team(s) !== bt : team(s) === bt && s !== state.sittingOutSeat),
      );
      const wrongSide = [0, 1, 2, 3].find((s) => (state.phase === 'doubling' ? team(s) === bt : team(s) !== bt));
      illegal(wrongSide!, { type: 't9:double', double: true }, state.phase === 'doubling' ? 'NOT_OPPONENT' : 'NOT_BIDDING_TEAM');
      must(pick(eligible), { type: 't9:double', double: chance(state.phase === 'doubling' ? 0.25 : 0.3) });
      doubledSeen = state.doubled;
      continue;
    }

    // ---------- playing ----------
    expect(state.phase).toBe('playing');
    expect(turn, 'the sitting-out partner got a turn').not.toBe(state.sittingOutSeat);
    const myHand = handOf(turn);
    const lead = trick[0]?.card.suit;
    const canFollow = lead !== undefined && myHand.some((c) => c.suit === lead);

    // Pair: any eligible player may declare right after their side wins a trick.
    if (state.trumpRevealed && !state.pair && trick.length === 0 && state.lastTrick) {
      for (const seat of [0, 1, 2, 3]) {
        if (seat === state.sittingOutSeat || team(seat) !== team(state.lastTrick.winnerSeat)) continue;
        const h = handOf(seat);
        const has = (r: string) => h.some((c) => c.suit === state.trumpSuit && c.rank === r);
        if (has('K') && has('Q') && chance(0.8)) {
          must(seat, { type: 't9:pair' });
          if (team(seat) === team(state.highestBid!.seat)) stats.pairsBidderTeam++;
          else stats.pairsOpponents++;
          break;
        }
      }
    }

    // Asking for trump only when you cannot follow; then you must trump if you can.
    if (lead && !canFollow && state.trumpHidden && chance(0.5)) {
      must(turn, { type: 't9:revealTrump' });
      stats.reveals++;
      if (turn === state.highestBid!.seat) stats.revealsByBidder++;
      expect(state.mustTrumpSeat).toBe(turn);
    } else if (lead && canFollow && state.trumpHidden) {
      illegal(turn, { type: 't9:revealTrump' }, 'CANNOT_REVEAL');
    }
    // Re-read the hand: a reveal can hand the bidder back a card of the led suit, which they must then follow with.
    const handNow = handOf(turn);
    const followNow = lead !== undefined && handNow.some((c) => c.suit === lead);
    let legal = followNow ? handNow.filter((c) => c.suit === lead) : handNow;
    if (state.mustTrumpSeat === turn && legal.some((c) => c.suit === state.trumpSuit)) {
      const off = legal.find((c) => c.suit !== state.trumpSuit);
      if (off) illegal(turn, { type: 't9:play', cardId: off.id }, 'MUST_TRUMP');
      legal = legal.filter((c) => c.suit === state.trumpSuit);
    }
    if (followNow) {
      const off = handNow.find((c) => c.suit !== lead);
      if (off && chance(0.3)) illegal(turn, { type: 't9:play', cardId: off.id }, 'MUST_FOLLOW_SUIT');
    }
    const card = pick(legal);
    const before = { ...state, tricks: state.tricksWon[0] + state.tricksWon[1] };
    if (before.tricks === 7 && trick.length === 0 && !state.trumpRevealed) stats.neverRevealed++;
    must(turn, { type: 't9:play', cardId: card.id });
    trick.push({ seat: turn, card, afterReveal: before.trumpRevealed });

    const finished = state.tricksWon[0] + state.tricksWon[1] > before.tricks || state.phase !== 'playing';
    if (finished) {
      const size = before.single ? 3 : 4;
      expect(trick).toHaveLength(size);
      const trump = state.trumpSuit ?? (state.phase !== 'playing' ? state.trumpSuit : undefined);
      // Before the reveal nothing is trump; work it out from what was public when each card was played.
      const effectiveTrump = trick.some((t) => t.afterReveal) || trick[0]!.card.suit === trump ? trump : undefined;
      const want = refWinner(trick, effectiveTrump);
      expect(state.lastTrick?.winnerSeat, 'wrong trick winner').toBe(want);
      expect(state.lastTrick?.points).toBe(trick.reduce((n, t) => n + pts(t.card), 0));
      stats.tricksChecked++;
      trick = [];

      if (state.phase === 'roundOver' || state.phase === 'over') {
        const r = state.roundResult!;
        const ref = refResult(r);
        expect(r.target, 'wrong target').toBe(ref.target);
        expect(r.made, 'wrong made/failed').toBe(ref.made);
        expect(r.delta, 'wrong game points').toBe(ref.delta);
        expect(r.doubled).toBe(doubledSeen);
        if (!r.single) expect(r.pointsTaken[0] + r.pointsTaken[1], 'a hand did not hold 28 points').toBe(28);
        if (r.single) {
          stats.singleHands++;
          if (r.made) stats.singleMade++;
          else expect(r.tricksWon[team(r.bidderSeat)], 'single hand went on after a lost trick').toBe(r.tricksWon[0] + r.tricksWon[1] - 1);
        }
        if (r.trumpMode === 'seventh') stats.seventh++;
        if (r.doubled === 1) stats.doubled++;
        if (r.doubled === 2) stats.redoubled++;
        if (r.made) stats.made++;
        else stats.failed++;
        stats.hands++;
        doubledSeen = 0;
      }
    }
  }

  expect(state.phase, 'game never finished').toBe('over');
  const winner = state.winnerTeam!;
  const [a, b] = state.gamePoints;
  // The game ends exactly when a team reaches +6 or -6.
  if (Math.max(a, b) >= 6) {
    expect(winner).toBe(a >= 6 ? 0 : 1);
    stats.wonAtPlus6++;
  } else {
    expect(Math.min(a, b)).toBeLessThanOrEqual(-6);
    expect(winner).toBe(a <= -6 ? 1 : 0);
    stats.lostAtMinus6++;
  }
  // Every hand's history adds up to the final score.
  const sum = [0, 0];
  for (const h of state.history) sum[h.biddingTeam]! += h.delta;
  expect(sum).toEqual(state.gamePoints);
  stats.games++;
  rooms.close();
}

describe(`29 simulation: ${GAMES} random games, every rule refereed`, () => {
  it('plays every game to the end with no rule broken', () => {
    for (let g = 1; g <= GAMES; g++) playGame(g);
    console.log('29 simulation stats:', stats);
    // Every rule was actually exercised, not just possible. (Random bots almost never win
    // all 8 tricks alone, so a successful single hand is covered by the unit tests instead.)
    for (const key of [
      'holds',
      'forced16',
      'singleHands',
      'seventh',
      'doubled',
      'redoubled',
      'reveals',
      'revealsByBidder',
      'neverRevealed',
      'pairsBidderTeam',
      'pairsOpponents',
      'wonAtPlus6',
      'lostAtMinus6',
    ] as const) {
      expect(stats[key], `never exercised: ${key}`).toBeGreaterThan(0);
    }
  }, 600_000);
});
