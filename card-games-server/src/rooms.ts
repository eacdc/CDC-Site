import { randomBytes, randomInt } from 'node:crypto';
import {
  PLAYER_LIMITS,
  type GameErrorPayload,
  type GameId,
  type GameOptions,
  type GameOverResult,
  type GameStatePayload,
  type HandPayload,
  type PublicPlayer,
  type RoomState,
  type RoomStatus,
  type ServerToClientEvents,
} from '../shared/types.js';
import { bluffEngine } from './games/bluff.js';
import type { Rng } from './games/deck.js';
import type { EngineContext, GameEngine, ScheduledAction } from './games/engine.js';
import { twentyNineEngine } from './games/twentynine.js';

export const HOLD_MS = 60_000;
export const EMPTY_ROOM_MS = 30 * 60_000;
export const NAME_MAX = 20;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENGINES: Record<GameId, GameEngine<any, any, any>> = { bluff: bluffEngine, '29': twentyNineEngine };

export type Emit = <E extends keyof ServerToClientEvents>(event: E, payload: Parameters<ServerToClientEvents[E]>[0]) => void;

/** How the room manager reaches clients. Socket.IO in production, a recorder in tests. */
export interface Transport {
  toRoom(code: string): { emit: Emit };
  toPlayer(playerId: string): { emit: Emit };
  /** Put a socket on a player's channels (their room, and their private one). */
  attach(playerId: string, code: string, socketId: string): void;
  /** Take a socket off a player's channels, telling it why if a reason is given. */
  detach(playerId: string, code: string, socketId: string | undefined, reason?: 'kicked' | 'replaced'): void;
}

interface Player {
  id: string;
  sessionId: string;
  name: string;
  seat: number;
  connected: boolean;
  socketId?: string;
  holdUntil?: number;
  holdTimer?: NodeJS.Timeout;
  /** Join order; seats are reassigned from it when someone leaves the lobby. */
  joinedAt: number;
}

interface Room {
  code: string;
  hostId: string;
  game: GameId;
  status: RoomStatus;
  players: Player[];
  options: GameOptions;
  engineState?: unknown;
  timer?: NodeJS.Timeout;
  paused: { since: number; awaitingHostDecision: boolean } | null;
  result?: GameOverResult;
  emptySince?: number;
}

export type RoomResult<T = object> = ({ ok: true } & T) | { ok: false; error: GameErrorPayload };

export interface JoinResult {
  code: string;
  playerId: string;
  sessionId: string;
}

const err = (code: string, message: string): { ok: false; error: GameErrorPayload } => ({ ok: false, error: { code, message } });

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return name.length > 0 ? name : null;
}

export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === CODE_LENGTH ? code : null;
}

const isGameId = (g: unknown): g is GameId => g === 'bluff' || g === '29';

/** A crypto-backed Rng in [0, 1). */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private byPlayer = new Map<string, Room>();
  private joinSeq = 0;
  private readonly now: () => number;
  private readonly rng: Rng;

  constructor(
    private readonly transport: Transport,
    opts: { now?: () => number; rng?: Rng } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? cryptoRng;
  }

  // ---------- Lookups ----------

  roomOf(playerId: string): Room | undefined {
    return this.byPlayer.get(playerId);
  }

  /** The player holding this session in this room, for the LiveKit token endpoint. */
  playerBySession(code: string, sessionId: string): { id: string; name: string } | null {
    const p = this.rooms.get(code)?.players.find((x) => x.sessionId === sessionId);
    return p ? { id: p.id, name: p.name } : null;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  // ---------- Create / join / leave ----------

  create(gameRaw: unknown, nameRaw: unknown, socketId: string): RoomResult<JoinResult> {
    if (!isGameId(gameRaw)) return err('BAD_GAME', 'Pick Bluff or 29.');
    const name = cleanName(nameRaw);
    if (!name) return err('BAD_NAME', 'Enter a name.');
    const code = this.newCode();
    const player = this.newPlayer(name, 0, socketId);
    const room: Room = { code, hostId: player.id, game: gameRaw, status: 'lobby', players: [player], options: {}, paused: null };
    this.rooms.set(code, room);
    this.byPlayer.set(player.id, room);
    this.transport.attach(player.id, code, socketId);
    this.broadcastRoom(room);
    return { ok: true, code, playerId: player.id, sessionId: player.sessionId };
  }

  join(codeRaw: unknown, nameRaw: unknown, sessionId: unknown, socketId: string): RoomResult<JoinResult> {
    const code = cleanCode(codeRaw);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return err('ROOM_NOT_FOUND', 'No room with that code.');

    const existing = typeof sessionId === 'string' ? room.players.find((p) => p.sessionId === sessionId) : undefined;
    if (existing) return this.reconnect(room, existing, socketId);

    const name = cleanName(nameRaw);
    if (!name) return err('BAD_NAME', 'Enter a name.');
    if (room.status !== 'lobby') return err('GAME_IN_PROGRESS', 'A game is already in progress in this room.');
    if (room.players.length >= PLAYER_LIMITS[room.game].max) return err('ROOM_FULL', 'This room is full.');

    const player = this.newPlayer(name, room.players.length, socketId);
    room.players.push(player);
    room.emptySince = undefined;
    this.byPlayer.set(player.id, room);
    this.transport.attach(player.id, room.code, socketId);
    this.broadcastRoom(room);
    return { ok: true, code: room.code, playerId: player.id, sessionId: player.sessionId };
  }

  private reconnect(room: Room, p: Player, socketId: string): RoomResult<JoinResult> {
    // Another tab (or a socket that has not noticed it dropped) loses the seat to this one.
    if (p.socketId && p.socketId !== socketId) this.transport.detach(p.id, room.code, p.socketId, 'replaced');
    this.transport.attach(p.id, room.code, socketId);
    p.socketId = socketId;
    p.connected = true;
    p.holdUntil = undefined;
    clearTimeout(p.holdTimer);
    room.emptySince = undefined;
    this.refreshPause(room);
    this.broadcastRoom(room);
    this.sendSnapshot(room, p);
    return { ok: true, code: room.code, playerId: p.id, sessionId: p.sessionId };
  }

  /** The socket closed. Only acts if it is still the player's current socket (a refresh may already have replaced it). */
  disconnect(playerId: string, socketId: string): void {
    const room = this.byPlayer.get(playerId);
    const p = room?.players.find((x) => x.id === playerId);
    if (!room || !p || p.socketId !== socketId) return;
    this.startHold(room, p);
  }

  /** Leaving on purpose. In the lobby the seat is freed at once; mid-game it is held like a dropped connection. */
  leave(playerId: string): RoomResult {
    const room = this.byPlayer.get(playerId);
    const p = room?.players.find((x) => x.id === playerId);
    if (!room || !p) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (room.status === 'playing') {
      this.transport.detach(p.id, room.code, p.socketId);
      p.socketId = undefined;
      this.startHold(room, p);
    } else {
      this.transport.detach(p.id, room.code, p.socketId);
      this.removePlayer(room, p);
    }
    return { ok: true };
  }

  private startHold(room: Room, p: Player): void {
    p.connected = false;
    p.holdUntil = this.now() + HOLD_MS;
    clearTimeout(p.holdTimer);
    p.holdTimer = setTimeout(() => this.holdExpired(room, p.id), HOLD_MS);
    if (!room.players.some((x) => x.connected)) room.emptySince = this.now();
    this.refreshPause(room);
    this.broadcastRoom(room);
  }

  private holdExpired(room: Room, playerId: string): void {
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.connected || this.rooms.get(room.code) !== room) return;
    if (room.status === 'playing') {
      // The seat stays (the game needs it); the host now decides whether to keep waiting.
      if (room.hostId === p.id) this.passHost(room);
      this.refreshPause(room);
      this.broadcastRoom(room);
    } else {
      this.removePlayer(room, p);
    }
  }

  private removePlayer(room: Room, p: Player): void {
    clearTimeout(p.holdTimer);
    room.players = room.players.filter((x) => x.id !== p.id);
    this.byPlayer.delete(p.id);
    if (room.players.length === 0) {
      this.deleteRoom(room);
      return;
    }
    room.players.sort((a, b) => a.joinedAt - b.joinedAt).forEach((x, i) => (x.seat = i));
    if (room.hostId === p.id) this.passHost(room);
    this.broadcastRoom(room);
  }

  /** Hand the host role to the first connected player by seat, if any. */
  private passHost(room: Room): void {
    const next = room.players.filter((x) => x.connected).sort((a, b) => a.seat - b.seat)[0];
    if (next) room.hostId = next.id;
  }

  // ---------- Host controls ----------

  setGame(playerId: string, game: unknown): RoomResult {
    const room = this.hostRoom(playerId, 'lobby');
    if (!room.ok) return room;
    if (!isGameId(game)) return err('BAD_GAME', 'Pick Bluff or 29.');
    if (room.room.game !== game) {
      room.room.game = game;
      room.room.options = {};
    }
    this.broadcastRoom(room.room);
    return { ok: true };
  }

  setOptions(playerId: string, options: unknown): RoomResult {
    const room = this.hostRoom(playerId, 'lobby');
    if (!room.ok) return room;
    room.room.options = sanitizeOptions(room.room.game, options);
    this.broadcastRoom(room.room);
    return { ok: true };
  }

  kick(playerId: string, targetId: unknown): RoomResult {
    const r = this.hostRoom(playerId);
    if (!r.ok) return r;
    if (r.room.status === 'playing') return err('WRONG_STATUS', 'You cannot remove players mid-game.');
    const target = r.room.players.find((x) => x.id === targetId);
    if (!target) return err('NO_SUCH_PLAYER', 'That player is not in the room.');
    if (target.id === playerId) return err('BAD_TARGET', 'You cannot remove yourself.');
    this.transport.detach(target.id, r.room.code, target.socketId, 'kicked');
    this.removePlayer(r.room, target);
    return { ok: true };
  }

  start(playerId: string, options?: unknown): RoomResult {
    const r = this.hostRoom(playerId, 'lobby');
    if (!r.ok) return r;
    const room = r.room;
    const { min, max } = PLAYER_LIMITS[room.game];
    const n = room.players.length;
    if (n < min || n > max) {
      return err('BAD_PLAYER_COUNT', min === max ? `This game needs exactly ${min} players.` : `This game needs ${min}-${max} players.`);
    }
    if (room.players.some((x) => !x.connected)) return err('PLAYER_DISCONNECTED', 'Wait for everyone to reconnect.');
    if (options !== undefined) room.options = sanitizeOptions(room.game, options);

    const seated = room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((x) => x.id);
    room.engineState = ENGINES[room.game].init(seated, room.options, this.ctx());
    room.status = 'playing';
    room.result = undefined;
    room.paused = null;
    this.broadcastRoom(room);
    this.broadcastGame(room);
    this.scheduleTimer(room);
    return { ok: true };
  }

  hostDecision(playerId: string, decision: unknown): RoomResult {
    const r = this.hostRoom(playerId, 'playing');
    if (!r.ok) return r;
    const room = r.room;
    if (!room.paused?.awaitingHostDecision) return err('NOT_WAITING', 'There is nothing to decide right now.');
    if (decision === 'wait') {
      // Give everyone still missing another full hold.
      for (const p of room.players.filter((x) => !x.connected)) {
        p.holdUntil = this.now() + HOLD_MS;
        clearTimeout(p.holdTimer);
        p.holdTimer = setTimeout(() => this.holdExpired(room, p.id), HOLD_MS);
      }
      this.refreshPause(room);
      this.broadcastRoom(room);
      return { ok: true };
    }
    if (decision === 'end') {
      this.finish(room, { game: room.game, reason: 'ended', endedBy: playerId });
      return { ok: true };
    }
    return err('BAD_ACTION', 'Choose wait or end.');
  }

  /** Back to the lobby after a game, keeping everyone still here. */
  reset(playerId: string): RoomResult {
    const r = this.hostRoom(playerId, 'over');
    if (!r.ok) return r;
    const room = r.room;
    room.status = 'lobby';
    room.engineState = undefined;
    room.result = undefined;
    room.paused = null;
    // Anyone whose hold already ran out during the game gives up their seat now.
    for (const p of room.players.filter((x) => !x.connected && (x.holdUntil ?? 0) <= this.now())) this.removePlayer(room, p);
    if (this.rooms.get(room.code) === room) this.broadcastRoom(room);
    return { ok: true };
  }

  private hostRoom(playerId: string, status?: RoomStatus): { ok: true; room: Room } | { ok: false; error: GameErrorPayload } {
    const room = this.byPlayer.get(playerId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (room.hostId !== playerId) return err('NOT_HOST', 'Only the host can do that.');
    if (status && room.status !== status)
      return err('WRONG_STATUS', `That can only be done while the room is ${status === 'over' ? 'finished' : `in the ${status}`}.`);
    return { ok: true, room };
  }

  // ---------- Game actions ----------

  action(playerId: string, action: unknown): RoomResult {
    const room = this.byPlayer.get(playerId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (room.status !== 'playing') return err('NOT_PLAYING', 'No game is in progress.');
    if (room.paused) return err('GAME_PAUSED', 'The game is paused until everyone is back.');
    const res = ENGINES[room.game].apply(room.engineState, playerId, action, this.ctx());
    if (!res.ok) return res;
    this.commit(room, res.state);
    return { ok: true };
  }

  private runScheduled(room: Room, t: ScheduledAction): void {
    room.timer = undefined;
    if (this.rooms.get(room.code) !== room || room.status !== 'playing' || room.paused) return;
    // A timer can fire a hair early by the wall clock; the engine compares against `at`.
    const res = ENGINES[room.game].apply(room.engineState, null, t.action, { now: Math.max(this.now(), t.at), rng: this.rng });
    if (res.ok) this.commit(room, res.state);
    else this.scheduleTimer(room);
  }

  private commit(room: Room, state: unknown): void {
    const engine = ENGINES[room.game];
    room.engineState = state;
    this.broadcastGame(room);
    if (engine.isOver(state)) {
      const pub = engine.publicState(state);
      const result: GameOverResult =
        room.game === 'bluff'
          ? { game: 'bluff', reason: 'won', winnerId: pub.winnerId }
          : { game: '29', reason: 'won', winnerTeam: pub.winnerTeam, gamePoints: pub.gamePoints };
      this.finish(room, result);
    } else {
      this.scheduleTimer(room);
    }
  }

  private finish(room: Room, result: GameOverResult): void {
    clearTimeout(room.timer);
    room.timer = undefined;
    room.status = 'over';
    room.paused = null;
    room.result = result;
    this.transport.toRoom(room.code).emit('game:over', result);
    this.broadcastRoom(room);
  }

  private scheduleTimer(room: Room): void {
    clearTimeout(room.timer);
    room.timer = undefined;
    if (room.status !== 'playing' || room.paused) return;
    const t = ENGINES[room.game].nextTimer(room.engineState);
    if (!t) return;
    room.timer = setTimeout(() => this.runScheduled(room, t), Math.max(0, t.at - this.now()));
  }

  /** Pause while anyone is missing; on resume, push every game deadline back by the time spent paused. */
  private refreshPause(room: Room): void {
    if (room.status !== 'playing') return;
    const missing = room.players.filter((x) => !x.connected);
    if (missing.length > 0) {
      const awaitingHostDecision = missing.every((x) => (x.holdUntil ?? 0) <= this.now());
      if (!room.paused) {
        room.paused = { since: this.now(), awaitingHostDecision };
        clearTimeout(room.timer);
        room.timer = undefined;
      } else {
        room.paused.awaitingHostDecision = awaitingHostDecision;
      }
      return;
    }
    if (room.paused) {
      const shift = this.now() - room.paused.since;
      room.paused = null;
      room.engineState = ENGINES[room.game].shiftDeadlines(room.engineState, shift);
      this.broadcastGame(room);
      this.scheduleTimer(room);
    }
  }

  // ---------- Housekeeping ----------

  /** Delete rooms that have had nobody connected for 30 minutes. Call periodically. */
  sweep(): void {
    for (const room of [...this.rooms.values()]) {
      if (room.players.some((x) => x.connected)) {
        room.emptySince = undefined;
      } else if (room.emptySince === undefined) {
        room.emptySince = this.now();
      } else if (this.now() - room.emptySince >= EMPTY_ROOM_MS) {
        this.deleteRoom(room);
      }
    }
  }

  private deleteRoom(room: Room): void {
    clearTimeout(room.timer);
    for (const p of room.players) {
      clearTimeout(p.holdTimer);
      this.byPlayer.delete(p.id);
    }
    this.rooms.delete(room.code);
  }

  /** Clear every timer; used on shutdown and in tests. */
  close(): void {
    for (const room of [...this.rooms.values()]) this.deleteRoom(room);
  }

  // ---------- Output ----------

  roomState(room: Room): RoomState {
    const players: PublicPlayer[] = room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        connected: p.connected,
        ...(p.holdUntil !== undefined && { holdUntil: p.holdUntil }),
      }));
    return {
      code: room.code,
      hostId: room.hostId,
      game: room.game,
      status: room.status,
      players,
      options: room.options,
      paused: room.paused && {
        waitingFor: room.players.filter((x) => !x.connected).map((x) => x.id),
        awaitingHostDecision: room.paused.awaitingHostDecision,
      },
      serverNow: this.now(),
    };
  }

  private broadcastRoom(room: Room): void {
    this.transport.toRoom(room.code).emit('room:state', this.roomState(room));
  }

  private gamePayload(room: Room): GameStatePayload {
    return { game: room.game, state: ENGINES[room.game].publicState(room.engineState), serverNow: this.now() } as GameStatePayload;
  }

  private handPayload(room: Room, playerId: string): HandPayload {
    return ENGINES[room.game].hand(room.engineState, playerId);
  }

  /** Public state to the whole room; each hand only to its owner's private channel. */
  private broadcastGame(room: Room): void {
    if (room.engineState === undefined) return;
    this.transport.toRoom(room.code).emit('game:state', this.gamePayload(room));
    for (const p of room.players) this.transport.toPlayer(p.id).emit('game:hand', this.handPayload(room, p.id));
  }

  /** Everything a (re)joining player needs to redraw the table. */
  private sendSnapshot(room: Room, p: Player): void {
    const to = this.transport.toPlayer(p.id);
    to.emit('room:state', this.roomState(room));
    if (room.engineState === undefined) return;
    to.emit('game:state', this.gamePayload(room));
    to.emit('game:hand', this.handPayload(room, p.id));
    if (room.result) to.emit('game:over', room.result);
  }

  // ---------- Helpers ----------

  private ctx(): EngineContext {
    return { now: this.now(), rng: this.rng };
  }

  private newPlayer(name: string, seat: number, socketId: string): Player {
    return {
      id: randomBytes(9).toString('base64url'),
      sessionId: randomBytes(24).toString('base64url'),
      name,
      seat,
      connected: true,
      socketId,
      joinedAt: ++this.joinSeq,
    };
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}

/** Keep only the options a game understands, with sane types. Engines clamp the values. */
export function sanitizeOptions(game: GameId, raw: unknown): GameOptions {
  if (game !== 'bluff' || typeof raw !== 'object' || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  if (o.decks === 1 || o.decks === 2) out.decks = o.decks;
  if (typeof o.maxCardsPerTurn === 'number' && Number.isInteger(o.maxCardsPerTurn) && o.maxCardsPerTurn > 0)
    out.maxCardsPerTurn = o.maxCardsPerTurn;
  if (typeof o.callWindowSec === 'number' && Number.isFinite(o.callWindowSec))
    out.callWindowSec = Math.min(Math.max(Math.round(o.callWindowSec), 2), 30);
  return out;
}
