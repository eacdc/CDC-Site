import { RANKS, type BluffOptions, type BluffPublicState, type Card, type Rank } from '../../shared/types.js';
import { deal, shuffle, standardDeck } from './deck.js';
import { fail, isRecord, type EngineContext, type EngineResult, type GameEngine } from './engine.js';

/** How long the revealed cards stay on screen after a call. */
export const REVEAL_MS = 3500;

export interface ResolvedBluffOptions {
  decks: 1 | 2;
  maxCardsPerTurn: number;
  callWindowSec: number;
}

export interface BluffState {
  /** Player IDs in seat order. */
  players: string[];
  hands: Record<string, Card[]>;
  pile: Card[];
  phase: BluffPublicState['phase'];
  turnIdx: number;
  requiredRank: Rank;
  lastPlay?: { playerId: string; cards: Card[]; claimedRank: Rank };
  callDeadline?: number;
  reveal?: NonNullable<BluffPublicState['reveal']>;
  revealUntil?: number;
  winnerId?: string;
  options: ResolvedBluffOptions;
}

export function resolveBluffOptions(playerCount: number, opts: BluffOptions = {}): ResolvedBluffOptions {
  const decks: 1 | 2 = opts.decks === 1 || opts.decks === 2 ? opts.decks : playerCount <= 5 ? 1 : 2;
  const maxAllowed = 4 * decks;
  const max = Number.isInteger(opts.maxCardsPerTurn) ? opts.maxCardsPerTurn! : maxAllowed;
  const win = typeof opts.callWindowSec === 'number' && Number.isFinite(opts.callWindowSec) ? opts.callWindowSec : 5;
  return {
    decks,
    maxCardsPerTurn: Math.min(Math.max(max, 1), maxAllowed),
    callWindowSec: Math.min(Math.max(Math.round(win), 2), 30),
  };
}

export function nextRank(rank: Rank): Rank {
  return RANKS[(RANKS.indexOf(rank) + 1) % RANKS.length]!;
}

/** The first seat after `idx` whose player still holds cards. */
function nextWithCards(s: BluffState, idx: number): number {
  for (let k = 1; k <= s.players.length; k++) {
    const j = (idx + k) % s.players.length;
    if (s.hands[s.players[j]!]!.length > 0) return j;
  }
  return idx;
}

/** Move on after a play that was not called, or after a call's reveal. */
function advanceTurn(s: BluffState): BluffState {
  const playedIdx = s.players.indexOf(s.lastPlay!.playerId);
  return {
    ...s,
    phase: 'turn',
    turnIdx: nextWithCards(s, playedIdx),
    requiredRank: nextRank(s.requiredRank),
    callDeadline: undefined,
  };
}

function play(s: BluffState, playerId: string, action: Record<string, unknown>, ctx: EngineContext): EngineResult<BluffState> {
  if (s.phase !== 'turn') return fail('WRONG_PHASE', 'Wait for the call window to close.');
  if (s.players[s.turnIdx] !== playerId) return fail('NOT_YOUR_TURN', 'It is not your turn.');
  const ids = action.cardIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) {
    return fail('BAD_ACTION', 'Pick at least one card.');
  }
  if (new Set(ids).size !== ids.length) return fail('BAD_ACTION', 'A card was picked twice.');
  if (ids.length > s.options.maxCardsPerTurn) {
    return fail('TOO_MANY_CARDS', `You can place at most ${s.options.maxCardsPerTurn} cards.`);
  }
  const hand = s.hands[playerId]!;
  const picked = ids.map((id) => hand.find((c) => c.id === id));
  if (picked.some((c) => c === undefined)) return fail('NOT_YOUR_CARD', 'You do not hold that card.');

  const cards = picked as Card[];
  const keep = hand.filter((c) => !ids.includes(c.id));
  return {
    ok: true,
    state: {
      ...s,
      hands: { ...s.hands, [playerId]: keep },
      pile: [...s.pile, ...cards],
      phase: 'callWindow',
      lastPlay: { playerId, cards, claimedRank: s.requiredRank },
      callDeadline: ctx.now + s.options.callWindowSec * 1000,
      reveal: undefined,
      revealUntil: undefined,
    },
  };
}

function call(s: BluffState, callerId: string, ctx: EngineContext): EngineResult<BluffState> {
  if (s.phase !== 'callWindow' || !s.lastPlay) return fail('WRONG_PHASE', 'There is nothing to call right now.');
  if (s.lastPlay.playerId === callerId) return fail('OWN_PLAY', 'You cannot call your own play.');
  if (s.callDeadline !== undefined && ctx.now > s.callDeadline) return fail('TOO_LATE', 'The call window has closed.');
  if (s.pile.length === 0) return fail('EMPTY_PILE', 'The pile is empty.');

  const { playerId, cards, claimedRank } = s.lastPlay;
  const wasBluff = cards.some((c) => c.rank !== claimedRank);
  const takerId = wasBluff ? playerId : callerId;
  const hands = { ...s.hands, [takerId]: [...s.hands[takerId]!, ...s.pile] };
  const reveal = { cards, wasBluff, callerId, takerId, playerId };

  // An honest play that empties the hand has survived its call: that player wins.
  if (!wasBluff && s.hands[playerId]!.length === 0) {
    return { ok: true, state: { ...s, hands, pile: [], phase: 'over', reveal, winnerId: playerId, callDeadline: undefined } };
  }
  return {
    ok: true,
    state: { ...s, hands, pile: [], phase: 'reveal', reveal, revealUntil: ctx.now + REVEAL_MS, callDeadline: undefined },
  };
}

/** System: the call window ran out with no call. */
function windowClosed(s: BluffState, ctx: EngineContext): EngineResult<BluffState> {
  if (s.phase !== 'callWindow' || !s.lastPlay) return fail('WRONG_PHASE', 'No call window is open.');
  if (s.callDeadline !== undefined && ctx.now < s.callDeadline) return fail('TOO_EARLY', 'The call window is still open.');
  if (s.hands[s.lastPlay.playerId]!.length === 0) {
    return { ok: true, state: { ...s, phase: 'over', winnerId: s.lastPlay.playerId, callDeadline: undefined } };
  }
  return { ok: true, state: advanceTurn(s) };
}

/** System: the reveal has been on screen long enough. */
function revealDone(s: BluffState, ctx: EngineContext): EngineResult<BluffState> {
  if (s.phase !== 'reveal') return fail('WRONG_PHASE', 'Nothing is being revealed.');
  if (s.revealUntil !== undefined && ctx.now < s.revealUntil) return fail('TOO_EARLY', 'The reveal is still showing.');
  return { ok: true, state: { ...advanceTurn(s), revealUntil: undefined } };
}

export const bluffEngine: GameEngine<BluffState, BluffOptions, BluffPublicState> = {
  init(playerIds, options, ctx) {
    const opts = resolveBluffOptions(playerIds.length, options);
    const start = Math.floor(ctx.rng() * playerIds.length);
    // Deal from the starting player, so any extra cards go to the earliest turns.
    const order = playerIds.map((_, k) => playerIds[(start + k) % playerIds.length]!);
    const dealt = deal(shuffle(standardDeck(opts.decks), ctx.rng), playerIds.length);
    const hands: Record<string, Card[]> = {};
    order.forEach((id, k) => (hands[id] = dealt.hands[k]!));
    return { players: playerIds.slice(), hands, pile: [], phase: 'turn', turnIdx: start, requiredRank: 'A', options: opts };
  },

  apply(state, playerId, action, ctx) {
    if (state.phase === 'over') return fail('GAME_OVER', 'The game is over.');
    if (!isRecord(action) || typeof action.type !== 'string') return fail('BAD_ACTION', 'Malformed action.');
    if (playerId === null) {
      if (action.type === 'bluff:windowClosed') return windowClosed(state, ctx);
      if (action.type === 'bluff:revealDone') return revealDone(state, ctx);
      return fail('BAD_ACTION', `Unknown system action ${action.type}.`);
    }
    if (!state.players.includes(playerId)) return fail('NOT_IN_GAME', 'You are not in this game.');
    if (action.type === 'bluff:play') return play(state, playerId, action, ctx);
    if (action.type === 'bluff:call') return call(state, playerId, ctx);
    return fail('BAD_ACTION', `Unknown action ${action.type}.`);
  },

  publicState(s) {
    const handCounts: Record<string, number> = {};
    for (const id of s.players) handCounts[id] = s.hands[id]!.length;
    return {
      phase: s.phase,
      turnPlayerId: s.players[s.turnIdx]!,
      requiredRank: s.requiredRank,
      pileCount: s.pile.length,
      handCounts,
      lastPlay: s.lastPlay && { playerId: s.lastPlay.playerId, count: s.lastPlay.cards.length, claimedRank: s.lastPlay.claimedRank },
      callDeadline: s.callDeadline,
      reveal: s.reveal,
      revealUntil: s.revealUntil,
      winnerId: s.winnerId,
      maxCardsPerTurn: s.options.maxCardsPerTurn,
      callWindowSec: s.options.callWindowSec,
      decks: s.options.decks,
    };
  },

  hand(s, playerId) {
    return { cards: s.hands[playerId] ?? [] };
  },

  nextTimer(s) {
    if (s.phase === 'callWindow' && s.callDeadline !== undefined) return { at: s.callDeadline, action: { type: 'bluff:windowClosed' } };
    if (s.phase === 'reveal' && s.revealUntil !== undefined) return { at: s.revealUntil, action: { type: 'bluff:revealDone' } };
    return null;
  },

  shiftDeadlines(s, ms) {
    return {
      ...s,
      callDeadline: s.callDeadline === undefined ? undefined : s.callDeadline + ms,
      revealUntil: s.revealUntil === undefined ? undefined : s.revealUntil + ms,
    };
  },

  isOver: (s) => s.phase === 'over',
};
