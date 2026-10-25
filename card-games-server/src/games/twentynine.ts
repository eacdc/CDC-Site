import {
  SUITS,
  type Card,
  type Rank,
  type Suit,
  type TrickCard,
  type TwentyNineOptions,
  type TwentyNinePublicState,
  type TwentyNineRoundResult,
} from '../../shared/types.js';
import { deal, deck29, shuffle } from './deck.js';
import { fail, isRecord, type EngineContext, type EngineResult, type GameEngine } from './engine.js';

export const MIN_BID = 16;
export const MAX_BID = 28;
export const WIN_GAME_POINTS = 6;
/** How long the round summary shows before the next deal. */
export const ROUND_BREAK_MS = 8000;

/** Strength high to low: J, 9, A, 10, K, Q, 8, 7. */
const STRENGTH: Rank[] = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
const POINTS: Partial<Record<Rank, number>> = { J: 3, '9': 2, A: 1, '10': 1 };

export const cardPoints = (c: Card): number => POINTS[c.rank] ?? 0;
/** Higher is stronger. */
export const cardStrength = (c: Card): number => STRENGTH.length - STRENGTH.indexOf(c.rank);
export const teamOf = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;
/** Play passes one seat at a time; seat + 1 is "to the right". */
const next = (seat: number): number => (seat + 1) % 4;

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
  /** The 16 cards dealt after the trump is chosen. */
  stock: Card[];
  bids: { seat: number; amount: number | 'pass' }[];
  passed: boolean[];
  highestBid?: { seat: number; amount: number };
  /** Hidden until revealed; never sent in public state before that. */
  trumpSuit?: Suit;
  trumpRevealed: boolean;
  revealedBySeat?: number;
  currentTrick: PlayedCard[];
  lastTrick?: { cards: TrickCard[]; winnerSeat: number; points: number };
  tricksWon: [number, number];
  pointsTaken: [number, number];
  gamePoints: [number, number];
  roundResult?: TwentyNineRoundResult;
  nextRoundAt?: number;
  winnerTeam?: 0 | 1;
}

/** Shuffle and deal 4 cards each, starting at the dealer's right, then open the bidding. */
function newRound(base: Omit<TwentyNineState, 'hands' | 'stock'>, dealerSeat: number, ctx: EngineContext): TwentyNineState {
  const first = next(dealerSeat);
  const dealt = deal(shuffle(deck29(), ctx.rng), 4, 4);
  const hands: Card[][] = [[], [], [], []];
  dealt.hands.forEach((h, k) => (hands[(first + k) % 4] = h));
  return {
    ...base,
    phase: 'bidding',
    dealerSeat,
    turnSeat: first,
    hands,
    stock: dealt.rest,
    bids: [],
    passed: [false, false, false, false],
    highestBid: undefined,
    trumpSuit: undefined,
    trumpRevealed: false,
    revealedBySeat: undefined,
    currentTrick: [],
    lastTrick: undefined,
    tricksWon: [0, 0],
    pointsTaken: [0, 0],
    roundResult: undefined,
    nextRoundAt: undefined,
  };
}

function bid(s: TwentyNineState, seat: number, action: Record<string, unknown>, ctx: EngineContext): EngineResult<TwentyNineState> {
  if (s.phase !== 'bidding') return fail('WRONG_PHASE', 'Bidding is over.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn to bid.');

  const passed = s.passed.slice();
  let highestBid = s.highestBid;
  let entry: TwentyNineState['bids'][number];
  if (action.pass === true) {
    passed[seat] = true;
    entry = { seat, amount: 'pass' };
  } else {
    const amount = action.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('BAD_ACTION', 'Bid a whole number or pass.');
    const min = highestBid ? highestBid.amount + 1 : MIN_BID;
    if (amount < min || amount > MAX_BID) return fail('BAD_BID', `Bid between ${min} and ${MAX_BID}, or pass.`);
    highestBid = { seat, amount };
    entry = { seat, amount };
  }
  const bids = [...s.bids, entry];
  const passCount = passed.filter(Boolean).length;

  if (passCount === 4) {
    // Nobody bid: re-deal, and the deal moves one seat.
    const redealt = newRound(s, next(s.dealerSeat), ctx);
    return { ok: true, state: redealt };
  }
  if (passCount === 3 && highestBid) {
    return { ok: true, state: { ...s, bids, passed, highestBid, phase: 'trumpSelect', turnSeat: highestBid.seat } };
  }
  let turn = next(seat);
  while (passed[turn]) turn = next(turn);
  return { ok: true, state: { ...s, bids, passed, highestBid, turnSeat: turn } };
}

function setTrump(s: TwentyNineState, seat: number, action: Record<string, unknown>): EngineResult<TwentyNineState> {
  if (s.phase !== 'trumpSelect') return fail('WRONG_PHASE', 'It is not time to pick trump.');
  if (s.highestBid?.seat !== seat) return fail('NOT_BIDDER', 'Only the highest bidder picks trump.');
  const suit = action.suit;
  if (typeof suit !== 'string' || !SUITS.includes(suit as Suit)) return fail('BAD_ACTION', 'Pick a suit.');

  // Deal the remaining 4 cards each, starting at the dealer's right.
  const first = next(s.dealerSeat);
  const rest = deal(s.stock, 4, 4).hands;
  const hands = s.hands.map((h) => h.slice());
  rest.forEach((h, k) => hands[(first + k) % 4]!.push(...h));
  return { ok: true, state: { ...s, hands, stock: [], trumpSuit: suit as Suit, phase: 'playing', turnSeat: first } };
}

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
  const bidder = s.highestBid!;
  const biddingTeam = teamOf(bidder.seat);
  const made = s.pointsTaken[biddingTeam] >= bidder.amount;
  const delta = made ? 1 : -1;
  const gamePoints: [number, number] = [...s.gamePoints];
  gamePoints[biddingTeam] += delta;
  const roundResult: TwentyNineRoundResult = { biddingTeam, bid: bidder.amount, pointsTaken: s.pointsTaken, made, delta };

  let winnerTeam: 0 | 1 | undefined;
  if (gamePoints[biddingTeam] >= WIN_GAME_POINTS) winnerTeam = biddingTeam;
  else if (gamePoints[biddingTeam] <= -WIN_GAME_POINTS) winnerTeam = biddingTeam === 0 ? 1 : 0;

  if (winnerTeam !== undefined) return { ...s, gamePoints, roundResult, winnerTeam, phase: 'over', trumpRevealed: true };
  return { ...s, gamePoints, roundResult, phase: 'roundOver', trumpRevealed: true, nextRoundAt: ctx.now + ROUND_BREAK_MS };
}

function playCard(s: TwentyNineState, seat: number, action: Record<string, unknown>, ctx: EngineContext): EngineResult<TwentyNineState> {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', 'It is not time to play a card.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn.');
  const hand = s.hands[seat]!;
  const card = hand.find((c) => c.id === action.cardId);
  if (!card) return fail('NOT_YOUR_CARD', 'You do not hold that card.');
  const lead = s.currentTrick[0]?.card.suit;
  if (lead && card.suit !== lead && hand.some((c) => c.suit === lead)) {
    return fail('MUST_FOLLOW_SUIT', 'You must follow the lead suit.');
  }

  const hands = s.hands.map((h, k) => (k === seat ? h.filter((c) => c.id !== card.id) : h));
  const trick = [...s.currentTrick, { seat, card, afterReveal: s.trumpRevealed }];
  if (trick.length < 4) return { ok: true, state: { ...s, hands, currentTrick: trick, turnSeat: next(seat) } };

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
    lastTrick: { cards: trick.map(({ seat: st, card: c }) => ({ seat: st, card: c })), winnerSeat, points },
    tricksWon,
    pointsTaken,
    turnSeat: winnerSeat,
  };
  return { ok: true, state: tricksWon[0] + tricksWon[1] === 8 ? endRound(done, ctx) : done };
}

function revealTrump(s: TwentyNineState, seat: number): EngineResult<TwentyNineState> {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', 'It is not time to play.');
  if (s.turnSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn.');
  if (s.trumpRevealed) return fail('ALREADY_REVEALED', 'Trump is already revealed.');
  const lead = s.currentTrick[0]?.card.suit;
  if (!lead) return fail('CANNOT_REVEAL', 'You can only ask for trump when you cannot follow the lead suit.');
  if (s.hands[seat]!.some((c) => c.suit === lead)) return fail('CANNOT_REVEAL', 'You can still follow suit.');
  return { ok: true, state: { ...s, trumpRevealed: true, revealedBySeat: seat } };
}

export const twentyNineEngine: GameEngine<TwentyNineState, TwentyNineOptions, TwentyNinePublicState> = {
  init(playerIds, _options, ctx) {
    if (playerIds.length !== 4) throw new Error('29 needs exactly 4 players');
    const dealer = Math.floor(ctx.rng() * 4);
    const base = {
      seats: playerIds.slice(),
      phase: 'bidding' as const,
      round: 1,
      dealerSeat: dealer,
      turnSeat: next(dealer),
      bids: [],
      passed: [false, false, false, false],
      trumpRevealed: false,
      currentTrick: [],
      tricksWon: [0, 0] as [number, number],
      pointsTaken: [0, 0] as [number, number],
      gamePoints: [0, 0] as [number, number],
    };
    return newRound(base, dealer, ctx);
  },

  apply(s, playerId, action, ctx) {
    if (s.phase === 'over') return fail('GAME_OVER', 'The game is over.');
    if (!isRecord(action) || typeof action.type !== 'string') return fail('BAD_ACTION', 'Malformed action.');
    if (playerId === null) {
      if (action.type !== 't9:nextRound') return fail('BAD_ACTION', `Unknown system action ${action.type}.`);
      if (s.phase !== 'roundOver') return fail('WRONG_PHASE', 'The round is not over.');
      if (s.nextRoundAt !== undefined && ctx.now < s.nextRoundAt) return fail('TOO_EARLY', 'The round break is not over.');
      return { ok: true, state: { ...newRound(s, next(s.dealerSeat), ctx), round: s.round + 1 } };
    }
    const seat = s.seats.indexOf(playerId);
    if (seat < 0) return fail('NOT_IN_GAME', 'You are not in this game.');
    switch (action.type) {
      case 't9:bid':
        return bid(s, seat, action, ctx);
      case 't9:setTrump':
        return setTrump(s, seat, action);
      case 't9:play':
        return playCard(s, seat, action, ctx);
      case 't9:revealTrump':
        return revealTrump(s, seat);
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
      trumpRevealed: s.trumpRevealed,
      trumpSuit: s.trumpRevealed ? s.trumpSuit : undefined,
      revealedBySeat: s.revealedBySeat,
      currentTrick: s.currentTrick.map(({ seat, card }) => ({ seat, card })),
      lastTrick: s.lastTrick,
      tricksWon: s.tricksWon,
      pointsTaken: s.pointsTaken,
      gamePoints: s.gamePoints,
      handCounts: s.hands.map((h) => h.length),
      round: s.round,
      roundResult: s.roundResult,
      nextRoundAt: s.nextRoundAt,
      winnerTeam: s.winnerTeam,
    };
  },

  hand(s, playerId) {
    const seat = s.seats.indexOf(playerId);
    if (seat < 0) return { cards: [] };
    const isBidder = s.highestBid?.seat === seat && s.trumpSuit !== undefined;
    return isBidder ? { cards: s.hands[seat]!, secretTrump: s.trumpSuit } : { cards: s.hands[seat]! };
  },

  nextTimer(s) {
    return s.phase === 'roundOver' && s.nextRoundAt !== undefined ? { at: s.nextRoundAt, action: { type: 't9:nextRound' } } : null;
  },

  shiftDeadlines(s, ms) {
    return s.nextRoundAt === undefined ? s : { ...s, nextRoundAt: s.nextRoundAt + ms };
  },

  isOver: (s) => s.phase === 'over',
};
