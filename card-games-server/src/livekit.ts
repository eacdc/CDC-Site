import { Router } from 'express';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { LivekitTokenResponse } from '../shared/types.js';
import { config, livekitConfigured } from './config.js';
import { cleanCode, type RoomManager } from './rooms.js';

export const TOKEN_TTL = '2h';

/**
 * Mint a LiveKit token for one player in one room. Identity is the player ID,
 * so the client can match each video track to a seat.
 */
export async function mintToken(roomCode: string, playerId: string, playerName: string): Promise<string> {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity: playerId, name: playerName, ttl: TOKEN_TTL });
  at.addGrant({
    roomJoin: true,
    room: roomCode,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

/**
 * POST /api/livekit-token { roomCode, sessionId }
 *
 * The session ID proves the caller holds a seat in that room; a room code
 * alone would let anyone who saw the link into the call.
 */
export function livekitRouter(rooms: RoomManager): Router {
  const router = Router();
  router.post('/livekit-token', async (req, res) => {
    if (!livekitConfigured()) {
      res.status(503).json({ error: 'VIDEO_DISABLED', message: 'Video is not configured on this server.' });
      return;
    }
    const code = cleanCode(req.body?.roomCode);
    const sessionId = req.body?.sessionId;
    const player = code && typeof sessionId === 'string' ? rooms.playerBySession(code, sessionId) : null;
    if (!code || !player) {
      res.status(403).json({ error: 'NOT_IN_ROOM', message: 'Join the room first.' });
      return;
    }
    try {
      const body: LivekitTokenResponse = { token: await mintToken(code, player.id, player.name), url: config.livekit.url, identity: player.id };
      res.json(body);
    } catch (e) {
      console.error('livekit token failed', e);
      res.status(500).json({ error: 'TOKEN_FAILED', message: 'Could not create a video token.' });
    }
  });
  return router;
}
