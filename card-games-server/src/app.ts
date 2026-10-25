import cors from 'cors';
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Ack, ClientToServerEvents, GameErrorPayload, JoinAck, ServerToClientEvents } from '../shared/types.js';
import { config, livekitConfigured } from './config.js';
import { livekitRouter } from './livekit.js';
import { RateLimiter } from './rateLimit.js';
import { RoomManager, type Emit, type RoomResult, type Transport } from './rooms.js';

interface SocketData {
  playerId?: string;
  actions: RateLimiter;
  rooms: RateLimiter;
}

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const roomChannel = (code: string) => `room:${code}`;
const playerChannel = (id: string) => `player:${id}`;
const RATE_LIMITED: GameErrorPayload = { code: 'RATE_LIMITED', message: 'Slow down a little.' };

const reply = (r: RoomResult<{ code: string; playerId: string; sessionId: string }>): JoinAck =>
  r.ok ? { ok: true, code: r.code, playerId: r.playerId, sessionId: r.sessionId } : r;

/** Builds the HTTP server, Socket.IO and the room manager, without listening. */
export function createApp(): { http: HttpServer; io: IO; rooms: RoomManager } {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.clientOrigins }));
  app.use(express.json({ limit: '10kb' }));

  const http = createServer(app);
  const io: IO = new Server(http, { cors: { origin: config.clientOrigins }, maxHttpBufferSize: 10_000 });

  const channel = (name: string) => ({
    emit: ((event: keyof ServerToClientEvents, payload: unknown) => void io.to(name).emit(event, payload as never)) as Emit,
  });
  const transport: Transport = {
    toRoom: (code) => channel(roomChannel(code)),
    toPlayer: (id) => channel(playerChannel(id)),
    attach: (playerId, code, socketId) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;
      void s.join([roomChannel(code), playerChannel(playerId)]);
      s.data.playerId = playerId;
    },
    detach: (playerId, code, socketId, reason) => {
      const s = socketId ? io.sockets.sockets.get(socketId) : undefined;
      if (!s) return;
      if (reason) s.emit('room:kicked', { reason });
      void s.leave(roomChannel(code));
      void s.leave(playerChannel(playerId));
      if (s.data.playerId === playerId) s.data.playerId = undefined;
    },
  };
  const rooms = new RoomManager(transport);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.roomCount(), video: livekitConfigured() });
  });
  app.use('/api', livekitRouter(rooms));

  io.on('connection', (socket) => {
    socket.data.actions = new RateLimiter(10, 5);
    socket.data.rooms = new RateLimiter(5, 0.5);

    socket.on('room:create', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!socket.data.rooms.take()) return ack({ ok: false, error: RATE_LIMITED });
      // A socket holds one seat at a time.
      if (socket.data.playerId) rooms.leave(socket.data.playerId);
      ack(reply(rooms.create(p?.game, p?.name, socket.id)));
    });

    socket.on('room:join', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!socket.data.rooms.take()) return ack({ ok: false, error: RATE_LIMITED });
      const previous = socket.data.playerId;
      const r = rooms.join(p?.code, p?.name, p?.sessionId, socket.id);
      if (r.ok && previous && previous !== r.playerId) rooms.leave(previous);
      ack(reply(r));
    });

    /** Wrap a host/room request: must be seated, reply through the ack if one was given. */
    const handle = (fn: (playerId: string) => RoomResult) => (_p: unknown, ack?: (r: Ack) => void) => {
      const id = socket.data.playerId;
      const r: Ack = id ? fn(id) : { ok: false, error: { code: 'NOT_IN_ROOM', message: 'You are not in a room.' } };
      if (typeof ack === 'function') ack(r.ok ? { ok: true } : r);
      else if (!r.ok) socket.emit('game:error', r.error);
    };

    socket.on(
      'room:leave',
      handle((id) => {
        const r = rooms.leave(id);
        socket.data.playerId = undefined;
        return r;
      }),
    );
    socket.on('room:setGame', (p, ack) => handle((id) => rooms.setGame(id, p?.game))(p, ack));
    socket.on('room:setOptions', (p, ack) => handle((id) => rooms.setOptions(id, p?.options))(p, ack));
    socket.on('room:kick', (p, ack) => handle((id) => rooms.kick(id, p?.playerId))(p, ack));
    socket.on('room:start', (p, ack) => handle((id) => rooms.start(id, p?.options))(p, ack));
    socket.on('room:hostDecision', (p, ack) => handle((id) => rooms.hostDecision(id, p?.decision))(p, ack));
    socket.on('room:reset', (p, ack) => handle((id) => rooms.reset(id))(p, ack));

    socket.on('game:action', (action) => {
      if (!socket.data.actions.take()) return void socket.emit('game:error', RATE_LIMITED);
      const id = socket.data.playerId;
      if (!id) return void socket.emit('game:error', { code: 'NOT_IN_ROOM', message: 'You are not in a room.' });
      const r = rooms.action(id, action);
      if (!r.ok) socket.emit('game:error', r.error);
    });

    socket.on('disconnect', () => {
      if (socket.data.playerId) rooms.disconnect(socket.data.playerId, socket.id);
    });
  });

  return { http, io, rooms };
}
