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
  /** Connected players' ids the game is waiting on (dropped, within their 60-second hold). */
  waitingFor: string[];
  /** True while a seat is empty; anyone with the link can take it. The host may end the game at any pause. */
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
  /** Seats left empty mid-game, and who sat there. Anyone joining by link takes the first one. */
  openSeats: { seat: number; name: string }[];
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

/** How trump was set: a suit the bidder chose ("normal"), or the suit of their 7th card, unknown even to them. */
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
  /** The team that took all 28 card points, which makes the hand worth 2. */
  allPointsTeam?: 0 | 1;
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
  /** Trump has been chosen but not yet revealed. */
  trumpHidden: boolean;
  /**
   * The spare 2-5 of the trump suit lying face down in front of the bidder.
   * Its suit appears once trump is asked for, and it stays face up until the hand ends.
   */
  trumpMarker?: { rank: Rank; suit?: Suit };
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
  /** Normal trump: name a suit you hold among your first four cards. The cards stay in your hand. */
  | { type: 't9:setTrump'; suit: Suit }
  /** 7th card: trump is the suit of your 7th card, which stays in your hand unmarked; nobody knows it until asked. */
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
  /** Host, in the lobby: swap two players' seats (in 29, this sets the partners). */
  'room:swapSeats': (p: { a: string; b: string }, ack?: (r: Ack) => void) => void;
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
