import type { Card, GameErrorPayload, Suit } from '../../shared/types.js';
import type { Rng } from './deck.js';

/** What every engine call may depend on besides state and action. Passing it in keeps engines pure. */
export interface EngineContext {
  now: number;
  rng: Rng;
}

export type EngineResult<S> = { ok: true; state: S } | { ok: false; error: GameErrorPayload };

/** An action the server applies on its own when a timer runs out. */
export interface ScheduledAction {
  at: number;
  action: { type: string };
}

/**
 * A game as a set of pure functions. No sockets, no timers: the room layer
 * owns those, and asks `nextTimer` which system action to schedule.
 */
export interface GameEngine<S, O, P> {
  init(playerIds: string[], options: O, ctx: EngineContext): S;
  /** `playerId` is null for system actions (timer expiries). */
  apply(state: S, playerId: string | null, action: unknown, ctx: EngineContext): EngineResult<S>;
  publicState(state: S): P;
  hand(state: S, playerId: string): { cards: Card[]; secretTrump?: Suit };
  nextTimer(state: S): ScheduledAction | null;
  /** Push every deadline back by `ms`, used when a paused game resumes. */
  shiftDeadlines(state: S, ms: number): S;
  isOver(state: S): boolean;
}

export function fail<S>(code: string, message: string): EngineResult<S> {
  return { ok: false, error: { code, message } };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
