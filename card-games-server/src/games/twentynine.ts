import {
  SUITS,
  type Card,
  type Rank,
  type Suit,
  type TrickCard,
  type TrumpMode,
  type TwentyNineBid,
  type TwentyNineOptions,
  type TwentyNinePublicState,
  type TwentyNineRoundResult,
} from '../../shared/types.js';
import { deal, deck29, shuffle } from './deck.js';
import { fail, isRecord, type EngineContext, type EngineResult, type GameEngine } from './engine.js';

// House rules: see "29 Card Game — House Rules". Play and deal go anti-clockwise,
// which here is seat + 1 ("to the right").

export const MIN_BID = 16;
export const MAX_BID = 28;
export const WIN_GAME_POINTS = 6;
/** A pair moves the bidding team's target by this many points. */
export const PAIR_SHIFT = 4;
/** How long the hand summary shows before the next deal. */
export const ROUND_BREAK_MS = 12000;

/** Strength high to low: J, 9, A, 10, K, Q, 8, 7. */
const STRENGTH: Rank[] = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
const POINTS: Partial<Record<Rank, number>> = { J: 3, '9': 2, A: 1, '10': 1 };

export const cardPoints = (c: Card): number => POINTS[c.rank] ?? 0;
/** Higher is stronger. */
export const cardStrength = (c: Card): number => STRENGTH.length - STRENGTH.indexOf(c.rank);
export const teamOf = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;
const next = (seat: number): number => (seat + 1) % 4;

/** Game points a hand is worth before doubling: normal 1, 7th card 2, single 3, single with 7th card 6. */
export function handValue(trumpMode: TrumpMode, single: boolean): number {
  return (single ? 3 : 1) * (trumpMode === 'seventh' ? 2 : 1);
}

interface PlayedCard extends TrickCard {
  /** Trump only counts as trump if it was played after the reveal. */
  afterReveal: boolean;
}

export interface TwentyNineState {
  seats: string[];
  phase: TwentyNinePublicState['phase'];
  round: number;
  dealerSeat: number;
  turnSeat: number;
  hands: Card[][];
  /** The 16 cards dealt after trump is set. */
  stock: Card[];
  bids: TwentyNineBid[];
  passed: boolean[];
  highestBid?: { seat: number; amount: number };
  /**
   * The auction is a run of two-player duels in bidding order. `early` bid
   * first and may hold (match the bid); `late` must always go higher. When one
   * passes, the next seat in `queue` steps in as the new `late`.
   */
  auction: { early: number; late?: number; queue: number[] };
  /** The current highest bid was a 28 declared as single hand. */
  singleBid: boolean;
  single: boolean;
  trumpMode?: TrumpMode;
  /** Set once trump is chosen; never sent to clients before the reveal (except the bidder who chose it). */
  trumpSuit?: Suit;
  trumpRevealed: boolean;
  revealedBySeat?: number;
  mustTrumpSeat?: number;
  doubled: 0 | 1 | 2;
  doubleAnswered: number[];
  pair?: { seat: number; team: 0 | 1 };
  currentTrick: PlayedCard[];
  lastTrick?: { cards: TrickCard[]; winnerSeat: number; points: number };
  tricksWon: [number, number];
  pointsTaken: [number, number];
  gamePoints: [number, number];
  roundResult?: TwentyNineRoundResult;
  history: TwentyNineRoundResult[];
  nextRoundAt?: number;
  winnerTeam?: 0 | 1;
}

const bidderSeat = (s: TwentyNineState) => s.highestBid!.seat;
const biddingTeam = (s: TwentyNineState) => teamOf(bidderSeat(s));
/** In single hand the bidder's partner sits out. */
export const sittingOut = (s: TwentyNineState): number | undefined => (s.single && s.highestBid ? (s.highestBid.seat + 2) % 4 : undefined);
/** The next seat after `seat` that is playing this hand. */
const nextActive = (s: TwentyNineState, seat: number): number => {
  let n = next(seat);
  if (n === sittingOut(s)) n = next(n);
  return n;
};
const activeCount = (s: TwentyNineState) => (s.single ? 3 : 4);

/** The bidding team's card-point target, after any pair (never below 16 or above 28). */
export function target(s: Pick<TwentyNineState, 'highestBid' | 'pair'>): number | undefined {
  if (!s.highestBid) return undefined;
  const bid = s.highestBid.amount;
  if (!s.pair) return bid;
  return s.pair.team === teamOf(s.highestBid.seat) ? Math.max(MIN_BID, bid - PAIR_SHIFT) : Math.min(MAX_BID, bid + PAIR_SHIFT);
}

type RoundBase = Pick<TwentyNineState, 'seats' | 'round' | 'gamePoints' | 'history'>;

/** Shuffle and deal 4 cards each, starting at the dealer's right, then open the bidding there. */
function newRound(base: RoundBase, dealerSeat: number, round: number, ctx: EngineContext): TwentyNineState {
  const first = next(dealerSeat);
  const dealt = deal(shuffle(deck29(), ctx.rng), 4, 4);
  const hands: Card[][] = [[], [], [], []];
  dealt.hands.forEach((h, k) => (hands[(first + k) % 4] = h));
  return {
    seats: base.seats,
    gamePoints: base.gamePoints,
    history: base.history,
    round,
    phase: 'bidding',
    dealerSeat,
    turnSeat: first,
    hands,
    stock: dealt.rest,
    bids: [],
    passed: [false, false, false, false],
    auction: { early: first, queue: [1, 2, 3].map((k) => (first + k) % 4) },
    singleBid: false,
    single: false,
    trumpRevealed: false,
    doubled: 0,
    doubleAnswered: [],
    currentTrick: [],
    tricksWon: [0, 0],
    pointsTaken: [0, 0],
  };
}

// ---------- Bidding ----------

/**
 * The lowest bid the player on turn may make: 16 to open, the current bid to
 * hold (the earlier bidder in a duel), or one more (the later bidder).
 */
export function minBidFor(s: Pick<TwentyNineState, 'highestBid' | 'auction' | 'turnSeat'>): number {
  if (!s.highestBid) return MIN_BID;
  return s.turnSeat === s.auction.early ? s.highestBid.amount : s.highestBid.amount + 1;
}

function bid(s: TwentyNineState, seat: number, action: Record<string, unknown>): EngineResult<TwentyNineState> {
  if (s.phase !== 'bidding') return fail('WRONG_PHASE', 'Bidding is over.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn to bid.');
  const { early, late } = s.auction;
  const queue = s.auction.queue.slice();
  const passed = s.passed.slice();
  const isEarly = seat === early;

  const end = (st: TwentyNineState): EngineResult<TwentyNineState> => ({
    ok: true,
    state: { ...st, phase: 'trumpSelect', turnSeat: st.highestBid!.seat, single: st.singleBid },
  });

  if (action.pass === true) {
    passed[seat] = true;
    const bids = [...s.bids, { seat, amount: 'pass' as const }];
    if (!s.highestBid) {
      // Nobody has bid yet: the next seat opens instead.
      const opener = queue.shift()!;
      const base = { ...s, bids, passed, auction: { early: opener, queue }, turnSeat: opener };
      if (queue.length > 0) return { ok: true, state: base };
      // The first three passed: the dealer is forced to bid 16.
      return end({
        ...base,
        bids: [...bids, { seat: opener, amount: MIN_BID, forced: true }],
        highestBid: { seat: opener, amount: MIN_BID },
        singleBid: false,
      });
    }
    // The early bidder passing hands the lead to the late bidder, whose raise is the current bid.
    const holder = isEarly ? late! : early;
    // Against a 28 nobody can go higher, so the auction is over.
    if (s.highestBid.amount === MAX_BID) return end({ ...s, bids, passed, auction: { early: holder, queue: [] } });
    const challenger = queue.shift();
    const st = { ...s, bids, passed, auction: { early: holder, late: challenger, queue } };
    if (challenger === undefined) return end(st);
    return { ok: true, state: { ...st, turnSeat: challenger } };
  }

  const amount = action.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('BAD_ACTION', 'Bid a whole number or pass.');
  const min = minBidFor(s);
  if (amount < min || amount > MAX_BID) {
    const why = !s.highestBid
      ? `Open with ${MIN_BID} to ${MAX_BID}`
      : isEarly
        ? `Hold at ${min} or bid higher`
        : `Bid more than ${s.highestBid.amount}`;
    return fail('BAD_BID', amount > MAX_BID ? `The highest bid is ${MAX_BID}.` : `${why}, or pass.`);
  }
  const single = action.single === true;
  if (single && amount !== MAX_BID) return fail('BAD_BID', 'Single hand is declared with a bid of 28.');
  const entry: TwentyNineBid = single ? { seat, amount, single } : { seat, amount };
  const st: TwentyNineState = { ...s, bids: [...s.bids, entry], passed, highestBid: { seat, amount }, singleBid: single };

  if (!s.highestBid) {
    // An opening bid: the next seat challenges it.
    const challenger = queue.shift();
    const opened = { ...st, auction: { early: seat, late: challenger, queue } };
    if (challenger === undefined) return end(opened);
    return { ok: true, state: { ...opened, turnSeat: challenger } };
  }
  if (!isEarly) return { ok: true, state: { ...st, turnSeat: early } }; // the early bidder may hold or go higher
  // The early bidder held or raised. At 28 nobody can go higher, so the auction is over.
  if (amount === MAX_BID) return end({ ...st, auction: { early, queue: [] } });
  return { ok: true, state: { ...st, turnSeat: late! } };
}

// ---------- Trump ----------

/**
 * Deal the last 4 cards each, from the dealer's right. Every card goes into a
 * hand: trump is only a suit, and the card that set it stays with the bidder.
 * Returns the bidder's 7th card (the first of their second four).
 */
function dealRest(s: TwentyNineState, ctx: EngineContext): { hands: Card[][]; seventh: Card } {
  const first = next(s.dealerSeat);
  const rest = deal(s.stock, 4, 4).hands;
  const hands = s.hands.map((h) => h.slice());
  let seventh: Card | undefined;
  rest.forEach((h, k) => {
    const seat = (first + k) % 4;
    if (seat === bidderSeat(s)) {
      seventh = h[0];
      // Mixed up, so nobody (the bidder included) can tell which of the four was the 7th card.
      hands[seat]!.push(...shuffle(h, ctx.rng));
    } else {
      hands[seat]!.push(...h);
    }
  });
  return { hands, seventh: seventh! };
}

function toDoubling(s: TwentyNineState, hands: Card[][], trumpSuit: Suit, trumpMode: TrumpMode): EngineResult<TwentyNineState> {
  return { ok: true, state: { ...s, hands, stock: [], trumpSuit, trumpMode, phase: 'doubling', doubleAnswered: [] } };
}

/** Normal trump: the bidder names a suit they hold among their four cards. The cards stay in hand. */
function setTrump(s: TwentyNineState, seat: number, action: Record<string, unknown>, ctx: EngineContext): EngineResult<TwentyNineState> {
  if (s.phase !== 'trumpSelect') return fail('WRONG_PHASE', 'It is not time to set trump.');
  if (bidderSeat(s) !== seat) return fail('NOT_BIDDER', 'Only the bidder sets trump.');
  const suit = action.suit as Suit;
  if (!SUITS.includes(suit)) return fail('BAD_ACTION', 'Pick a suit.');
  if (!s.hands[seat]!.some((c) => c.suit === suit)) return fail('NO_SUCH_SUIT', 'Trump must be a suit you hold among your four cards.');
  return toDoubling(s, dealRest(s, ctx).hands, suit, 'normal');
}

/** 7th card: trump is the suit of the bidder's 7th card, which stays in their hand unmarked. */
function seventhCard(s: TwentyNineState, seat: number, ctx: EngineContext): EngineResult<TwentyNineState> {
  if (s.phase !== 'trumpSelect') return fail('WRONG_PHASE', 'It is not time to set trump.');
  if (bidderSeat(s) !== seat) return fail('NOT_BIDDER', 'Only the bidder sets trump.');
  const { hands, seventh } = dealRest(s, ctx);
  return toDoubling(s, hands, seventh.suit, 'seventh');
}

// ---------- Double / redouble ----------

function startPlay(s: TwentyNineState): TwentyNineState {
  // The dealer's right leads; in single hand the sitting-out partner is skipped.
  let lead = next(s.dealerSeat);
  if (lead === sittingOut(s)) lead = next(lead);
  return { ...s, phase: 'playing', turnSeat: lead, doubleAnswered: [] };
}

function double(s: TwentyNineState, seat: number, action: Record<string, unknown>): EngineResult<TwentyNineState> {
  if (typeof action.double !== 'boolean') return fail('BAD_ACTION', 'Say double or not.');
  const team = biddingTeam(s);
  if (s.phase === 'doubling') {
    if (teamOf(seat) === team) return fail('NOT_OPPONENT', 'Only the opponents can double.');
    if (s.doubleAnswered.includes(seat)) return fail('ALREADY_ANSWERED', 'You have already answered.');
    if (action.double) return { ok: true, state: { ...s, doubled: 1, phase: 'redoubling', doubleAnswered: [] } };
    const answered = [...s.doubleAnswered, seat];
    return { ok: true, state: answered.length === 2 ? startPlay(s) : { ...s, doubleAnswered: answered } };
  }
  if (s.phase === 'redoubling') {
    if (teamOf(seat) !== team || seat === sittingOut(s)) return fail('NOT_BIDDING_TEAM', "Only the bidder's team can redouble.");
    if (s.doubleAnswered.includes(seat)) return fail('ALREADY_ANSWERED', 'You have already answered.');
    if (action.double) return { ok: true, state: startPlay({ ...s, doubled: 2 }) };
    const answered = [...s.doubleAnswered, seat];
    return { ok: true, state: answered.length === (s.single ? 1 : 2) ? startPlay(s) : { ...s, doubleAnswered: answered } };
  }
  return fail('WRONG_PHASE', 'It is not time to double.');
}

// ---------- Play ----------

/** Index of the winning card in a complete trick. */
export function trickWinner(trick: PlayedCard[], trumpSuit: Suit | undefined): number {
  const lead = trick[0]!.card.suit;
  // A trump counts only if played after the reveal, unless trump was led (then it is simply the lead suit).
  const isTrump = (p: PlayedCard) => trumpSuit !== undefined && p.card.suit === trumpSuit && (p.afterReveal || lead === trumpSuit);
  const contenders = trick.some(isTrump) ? trick.filter(isTrump) : trick.filter((p) => p.card.suit === lead);
  const best = contenders.reduce((a, b) => (cardStrength(b.card) > cardStrength(a.card) ? b : a));
  return trick.indexOf(best);
}

function endRound(s: TwentyNineState, ctx: EngineContext): TwentyNineState {
  const team = biddingTeam(s);
  const goal = target(s)!;
  const made = s.single ? s.tricksWon[team] === 8 : s.pointsTaken[team] >= goal;
  const value = handValue(s.trumpMode!, s.single) * (s.doubled === 2 ? 4 : s.doubled === 1 ? 2 : 1);
  const delta = made ? value : -value;
  const gamePoints: [number, number] = [...s.gamePoints];
  gamePoints[team] += delta;
  const roundResult: TwentyNineRoundResult = {
    round: s.round,
    bidderSeat: bidderSeat(s),
    biddingTeam: team,
    bid: s.highestBid!.amount,
    target: goal,
    pointsTaken: s.pointsTaken,
    tricksWon: s.tricksWon,
    trumpMode: s.trumpMode!,
    single: s.single,
    doubled: s.doubled,
    ...(s.pair && { pair: s.pair }),
    made,
    delta,
  };
  const history = [...s.history, roundResult];

  let winnerTeam: 0 | 1 | undefined;
  if (gamePoints[team] >= WIN_GAME_POINTS) winnerTeam = team;
  else if (gamePoints[team] <= -WIN_GAME_POINTS) winnerTeam = team === 0 ? 1 : 0;

  // Whatever happened, everyone sees the trump at the end of the hand.
  const shown = { trumpRevealed: true, mustTrumpSeat: undefined };
  if (winnerTeam !== undefined) return { ...s, ...shown, gamePoints, roundResult, history, winnerTeam, phase: 'over' };
  return { ...s, ...shown, gamePoints, roundResult, history, phase: 'roundOver', nextRoundAt: ctx.now + ROUND_BREAK_MS };
}

function playCard(s: TwentyNineState, seat: number, action: Record<string, unknown>, ctx: EngineContext): EngineResult<TwentyNineState> {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', 'It is not time to play a card.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn.');
  const hand = s.hands[seat]!;
  const card = hand.find((c) => c.id === action.cardId);
  if (!card) return fail('NOT_YOUR_CARD', 'You do not hold that card.');
  const lead = s.currentTrick[0]?.card.suit;
  if (lead && card.suit !== lead && hand.some((c) => c.suit === lead)) return fail('MUST_FOLLOW_SUIT', 'You must follow the lead suit.');
  if (s.mustTrumpSeat === seat && card.suit !== s.trumpSuit && hand.some((c) => c.suit === s.trumpSuit)) {
    return fail('MUST_TRUMP', 'You asked for trump, so you must play a trump this trick.');
  }

  const hands = s.hands.map((h, k) => (k === seat ? h.filter((c) => c.id !== card.id) : h));
  const trick = [...s.currentTrick, { seat, card, afterReveal: s.trumpRevealed }];
  if (trick.length < activeCount(s)) return { ok: true, state: { ...s, hands, currentTrick: trick, turnSeat: nextActive(s, seat) } };

  const winnerSeat = trick[trickWinner(trick, s.trumpSuit)]!.seat;
  const points = trick.reduce((sum, p) => sum + cardPoints(p.card), 0);
  const team = teamOf(winnerSeat);
  const tricksWon: [number, number] = [...s.tricksWon];
  const pointsTaken: [number, number] = [...s.pointsTaken];
  tricksWon[team] += 1;
  pointsTaken[team] += points;
  const done: TwentyNineState = {
    ...s,
    hands,
    currentTrick: [],
    mustTrumpSeat: undefined,
    lastTrick: { cards: trick.map(({ seat: st, card: c }) => ({ seat: st, card: c })), winnerSeat, points },
    tricksWon,
    pointsTaken,
    turnSeat: winnerSeat,
  };
  const played = tricksWon[0] + tricksWon[1];
  // Single hand is lost the moment the bidder loses a trick: no need to play on.
  if (played === 8 || (s.single && team !== biddingTeam(s))) return { ok: true, state: endRound(done, ctx) };
  return { ok: true, state: done };
}

function revealTrump(s: TwentyNineState, seat: number): EngineResult<TwentyNineState> {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', 'It is not time to play.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn.');
  if (s.trumpRevealed) return fail('ALREADY_REVEALED', 'Trump is already revealed.');
  const lead = s.currentTrick[0]?.card.suit;
  if (!lead) return fail('CANNOT_REVEAL', 'You can only ask for trump when you cannot follow the lead suit.');
  if (s.hands[seat]!.some((c) => c.suit === lead)) return fail('CANNOT_REVEAL', 'You can still follow suit.');
  // The trump suit is announced to everyone.
  return { ok: true, state: { ...s, trumpRevealed: true, revealedBySeat: seat, mustTrumpSeat: seat } };
}

function declarePair(s: TwentyNineState, seat: number): EngineResult<TwentyNineState> {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', 'It is not time to play.');
  if (s.pair) return fail('PAIR_DONE', 'A pair has already been declared this hand.');
  if (!s.trumpRevealed) return fail('NO_PAIR', 'A pair can only be declared after trump is revealed.');
  if (seat === sittingOut(s)) return fail('NO_PAIR', 'You are sitting out this hand.');
  if (s.currentTrick.length > 0 || !s.lastTrick || teamOf(s.lastTrick.winnerSeat) !== teamOf(seat)) {
    return fail('NO_PAIR', 'Declare a pair right after your side wins a trick, before the next lead.');
  }
  const hand = s.hands[seat]!;
  const has = (r: Rank) => hand.some((c) => c.suit === s.trumpSuit && c.rank === r);
  if (!has('K') || !has('Q')) return fail('NO_PAIR', 'You need both the King and Queen of trump.');
  return { ok: true, state: { ...s, pair: { seat, team: teamOf(seat) } } };
}

export const twentyNineEngine: GameEngine<TwentyNineState, TwentyNineOptions, TwentyNinePublicState> = {
  init(playerIds, _options, ctx) {
    if (playerIds.length !== 4) throw new Error('29 needs exactly 4 players');
    const dealer = Math.floor(ctx.rng() * 4);
    return newRound({ seats: playerIds.slice(), round: 1, gamePoints: [0, 0], history: [] }, dealer, 1, ctx);
  },

  apply(s, playerId, action, ctx) {
    if (s.phase === 'over') return fail('GAME_OVER', 'The game is over.');
    if (!isRecord(action) || typeof action.type !== 'string') return fail('BAD_ACTION', 'Malformed action.');
    if (playerId === null) {
      if (action.type !== 't9:nextRound') return fail('BAD_ACTION', `Unknown system action ${action.type}.`);
      if (s.phase !== 'roundOver') return fail('WRONG_PHASE', 'The round is not over.');
      if (s.nextRoundAt !== undefined && ctx.now < s.nextRoundAt) return fail('TOO_EARLY', 'The round break is not over.');
      // The deal moves one seat anti-clockwise.
      return { ok: true, state: newRound(s, next(s.dealerSeat), s.round + 1, ctx) };
    }
    const seat = s.seats.indexOf(playerId);
    if (seat < 0) return fail('NOT_IN_GAME', 'You are not in this game.');
    switch (action.type) {
      case 't9:bid':
        return bid(s, seat, action);
      case 't9:setTrump':
        return setTrump(s, seat, action, ctx);
      case 't9:seventhCard':
        return seventhCard(s, seat, ctx);
      case 't9:double':
        return double(s, seat, action);
      case 't9:play':
        return playCard(s, seat, action, ctx);
      case 't9:revealTrump':
        return revealTrump(s, seat);
      case 't9:pair':
        return declarePair(s, seat);
      default:
        return fail('BAD_ACTION', `Unknown action ${action.type}.`);
    }
  },

  publicState(s) {
    return {
      phase: s.phase,
      dealerSeat: s.dealerSeat,
      turnSeat: s.turnSeat,
      seats: s.seats,
      bids: s.bids,
      highestBid: s.highestBid,
      holderSeat: s.phase === 'bidding' && s.highestBid ? s.auction.early : undefined,
      minBid: s.phase === 'bidding' ? minBidFor(s) : undefined,
      trumpMode: s.trumpMode,
      single: s.single,
      sittingOutSeat: sittingOut(s),
      trumpHidden: s.trumpSuit !== undefined && !s.trumpRevealed,
      trumpRevealed: s.trumpRevealed,
      trumpSuit: s.trumpRevealed ? s.trumpSuit : undefined,
      revealedBySeat: s.revealedBySeat,
      mustTrumpSeat: s.mustTrumpSeat,
      doubled: s.doubled,
      doubleAnswered: s.doubleAnswered,
      pair: s.pair,
      target: target(s),
      currentTrick: s.currentTrick.map(({ seat, card }) => ({ seat, card })),
      lastTrick: s.lastTrick,
      tricksWon: s.tricksWon,
      pointsTaken: s.pointsTaken,
      gamePoints: s.gamePoints,
      handCounts: s.hands.map((h) => h.length),
      round: s.round,
      roundResult: s.roundResult,
      history: s.history,
      nextRoundAt: s.nextRoundAt,
      winnerTeam: s.winnerTeam,
    };
  },

  hand(s, playerId) {
    const seat = s.seats.indexOf(playerId);
    if (seat < 0) return { cards: [] };
    const cards = s.hands[seat]!;
    // Only a bidder who chose trump knows it; on a 7th card nobody does until it is asked for.
    if (s.highestBid?.seat === seat && s.trumpMode === 'normal' && !s.trumpRevealed) return { cards, secretTrump: s.trumpSuit };
    return { cards };
  },

  nextTimer(s) {
    return s.phase === 'roundOver' && s.nextRoundAt !== undefined ? { at: s.nextRoundAt, action: { type: 't9:nextRound' } } : null;
  },

  shiftDeadlines(s, ms) {
    return s.nextRoundAt === undefined ? s : { ...s, nextRoundAt: s.nextRoundAt + ms };
  },

  isOver: (s) => s.phase === 'over',
};
