// Types shared by the game server and the client.
//
// The client keeps an identical copy at liarsdeck/src/shared/types.ts. The two
// repos are separate, so a change here must be copied there by hand.

// ---------- Cards ----------

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

/** `id` is unique per physical card, including across decks. */
export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  deck?: number;
}

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];
export const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// ---------- Rooms ----------

export type GameId = 'bluff' | '29';
export type RoomStatus = 'lobby' | 'playing' | 'over';

export interface BluffOptions {
  /** 1 or 2 standard decks. Defaults to 1 for 4-5 players, 2 for 6-10. */
  decks?: 1 | 2;
  /** Max cards in one play. Defaults to 4 per deck in play. */
  maxCardsPerTurn?: number;
  /** Seconds others have to press Bluff! after a play. Default 5. */
  callWindowSec?: number;
}

/** 29 has no host options in v1. */
export type TwentyNineOptions = Record<string, never>;

export type GameOptions = BluffOptions | TwentyNineOptions;

export const PLAYER_LIMITS: Record<GameId, { min: number; max: number }> = {
  bluff: { min: 4, max: 10 },
  '29': { min: 4, max: 4 },
};

/**
 * A player as everyone else sees them. The sessionId is deliberately absent:
 * it is the secret that reclaims a seat, so only its owner ever receives it.
 */
export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
  /** Server timestamp (ms) at which a disconnected player's seat is released. */
  holdUntil?: number;
}

export interface PauseInfo {
  /** Players the game is waiting on. */
  waitingFor: string[];
  /** True once every hold has run out; the host may then wait longer or end the game. */
  awaitingHostDecision: boolean;
}

export interface RoomState {
  code: string;
  hostId: string;
  game: GameId;
  status: RoomStatus;
  players: PublicPlayer[];
  options: GameOptions;
  paused: PauseInfo | null;
  serverNow: number;
}

// ---------- Bluff ----------

export type BluffPhase = 'turn' | 'callWindow' | 'reveal' | 'over';

export interface BluffPublicState {
  phase: BluffPhase;
  turnPlayerId: string;
  requiredRank: Rank;
  /** Number of cards in the pile, never which. */
  pileCount: number;
  handCounts: Record<string, number>;
  lastPlay?: { playerId: string; count: number; claimedRank: Rank };
  /** Server timestamp (ms) at which the call window closes. */
  callDeadline?: number;
  reveal?: { cards: Card[]; wasBluff: boolean; callerId: string; takerId: string; playerId: string };
  /** Server timestamp (ms) at which the reveal ends and play continues. */
  revealUntil?: number;
  winnerId?: string;
  maxCardsPerTurn: number;
  callWindowSec: number;
  decks: number;
}

export type BluffAction = { type: 'bluff:play'; cardIds: string[] } | { type: 'bluff:call' };

// ---------- 29 ----------

/**
 * bidding → trumpSelect → doubling (opponents may double) → redoubling (only
 * after a double) → playing → roundOver, until a team reaches +6 or -6 (over).
 */
export type TwentyNinePhase = 'bidding' | 'trumpSelect' | 'doubling' | 'redoubling' | 'playing' | 'roundOver' | 'over';

/** How trump was set: a card the bidder chose ("normal"), or the 7th card, unknown even to the bidder. */
export type TrumpMode = 'normal' | 'seventh';

export interface TrickCard {
  seat: number;
  card: Card;
}

export interface TwentyNineBid {
  seat: number;
  amount: number | 'pass';
  /** A 28 bid declared as single hand. */
  single?: boolean;
  /** The dealer's automatic 16 after the other three passed. */
  forced?: boolean;
}

export interface TwentyNineRoundResult {
  round: number;
  bidderSeat: number;
  biddingTeam: 0 | 1;
  bid: number;
  /** Card points the bidding team needed, after any pair. Single hand needs every trick instead. */
  target: number;
  pointsTaken: [number, number];
  tricksWon: [number, number];
  trumpMode: TrumpMode;
  single: boolean;
  /** 0 none, 1 doubled, 2 redoubled. */
  doubled: 0 | 1 | 2;
  pair?: { seat: number; team: 0 | 1 };
  made: boolean;
  /** Game points to the bidding team: + if made, - if not. */
  delta: number;
}

export interface TwentyNinePublicState {
  phase: TwentyNinePhase;
  dealerSeat: number;
  turnSeat: number;
  /** Player IDs indexed by seat. Seats 0+2 are team 0 (A), 1+3 team 1 (B). */
  seats: string[];
  bids: TwentyNineBid[];
  highestBid?: { seat: number; amount: number };
  /** While bidding: the earlier bidder of the current duel, who may hold (match) the bid. */
  holderSeat?: number;
  /** While bidding: the lowest bid the player on turn may make (holding counts). */
  minBid?: number;
  trumpMode?: TrumpMode;
  /** The bidder is playing single hand; their partner sits out. */
  single: boolean;
  sittingOutSeat?: number;
  /** The trump card is lying face down in front of the bidder. */
  trumpCardDown: boolean;
  trumpRevealed: boolean;
  /** Only present once revealed. */
  trumpSuit?: Suit;
  /** Seat that asked for (or made) the reveal. */
  revealedBySeat?: number;
  /** This seat asked for trump and must play a trump in the current trick if they hold one. */
  mustTrumpSeat?: number;
  /** 0 none, 1 doubled, 2 redoubled. */
  doubled: 0 | 1 | 2;
  /** Seats that have already answered the current double / redouble question. */
  doubleAnswered: number[];
  pair?: { seat: number; team: 0 | 1 };
  /** Card points the bidding team needs this hand, after any pair. */
  target?: number;
  currentTrick: TrickCard[];
  /** The trick just completed, kept so everyone can see who won it. */
  lastTrick?: { cards: TrickCard[]; winnerSeat: number; points: number };
  tricksWon: [number, number];
  /** Card points per team this hand. */
  pointsTaken: [number, number];
  gamePoints: [number, number];
  handCounts: number[];
  round: number;
  roundResult?: TwentyNineRoundResult;
  /** Every finished hand so far, oldest first. */
  history: TwentyNineRoundResult[];
  /** Server timestamp (ms) at which the next hand is dealt. */
  nextRoundAt?: number;
  winnerTeam?: 0 | 1;
}

export type TwentyNineAction =
  | { type: 't9:bid'; amount: number; single?: boolean }
  | { type: 't9:bid'; pass: true }
  /** Normal trump: place this card from your four face down. */
  | { type: 't9:setTrump'; cardId: string }
  /** 7th-card trump: the first card of the bidder's second four goes face down, unseen. */
  | { type: 't9:seventhCard' }
  /** In the doubling phase: double or not. In the redoubling phase: redouble or not. */
  | { type: 't9:double'; double: boolean }
  | { type: 't9:play'; cardId: string }
  | { type: 't9:revealTrump' }
  | { type: 't9:pair' };

export type GameAction = BluffAction | TwentyNineAction;

// ---------- Socket events ----------

export type GameStatePayload =
  { game: 'bluff'; state: BluffPublicState; serverNow: number } | { game: '29'; state: TwentyNinePublicState; serverNow: number };

export interface HandPayload {
  cards: Card[];
  /** 29 only: the hidden trump suit, sent to the bidder alone, and only when they chose it (not on a 7th card). */
  secretTrump?: Suit;
  /** 29 only: the bidder's own face-down trump card, so they can see what they put down. */
  trumpCard?: Card;
}

export interface GameErrorPayload {
  code: string;
  message: string;
}

export type GameOverResult =
  | { game: 'bluff'; reason: 'won'; winnerId: string }
  | { game: '29'; reason: 'won'; winnerTeam: 0 | 1; gamePoints: [number, number] }
  | { game: GameId; reason: 'ended'; endedBy: string };

/** Acknowledgement for room:create and room:join. */
export type JoinAck = { ok: true; code: string; playerId: string; sessionId: string } | { ok: false; error: GameErrorPayload };

/** Acknowledgement for every other room:* request. */
export type Ack = { ok: true } | { ok: false; error: GameErrorPayload };

export interface ClientToServerEvents {
  'room:create': (p: { game: GameId; name: string }, ack: (r: JoinAck) => void) => void;
  'room:join': (p: { code: string; name: string; sessionId?: string }, ack: (r: JoinAck) => void) => void;
  'room:leave': (p: Record<string, never>, ack?: (r: Ack) => void) => void;
  'room:setGame': (p: { game: GameId }, ack?: (r: Ack) => void) => void;
  'room:setOptions': (p: { options: GameOptions }, ack?: (r: Ack) => void) => void;
  'room:kick': (p: { playerId: string }, ack?: (r: Ack) => void) => void;
  'room:start': (p: { options?: GameOptions }, ack?: (r: Ack) => void) => void;
  /** While paused and every hold has run out: keep waiting, or end the game. */
  'room:hostDecision': (p: { decision: 'wait' | 'end' }, ack?: (r: Ack) => void) => void;
  /** After a game ends: back to the lobby with the same players. */
  'room:reset': (p: Record<string, never>, ack?: (r: Ack) => void) => void;
  'game:action': (p: GameAction) => void;
}

export interface ServerToClientEvents {
  'room:state': (s: RoomState) => void;
  'room:kicked': (p: { reason: 'kicked' | 'replaced' }) => void;
  'game:state': (s: GameStatePayload) => void;
  'game:hand': (h: HandPayload) => void;
  'game:error': (e: GameErrorPayload) => void;
  'game:over': (r: GameOverResult) => void;
}

/** Body of POST /api/livekit-token. */
export interface LivekitTokenRequest {
  roomCode: string;
  sessionId: string;
}

export interface LivekitTokenResponse {
  token: string;
  url: string;
  identity: string;
}
