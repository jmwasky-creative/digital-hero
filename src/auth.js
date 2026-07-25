import { createHash, randomBytes, randomUUID } from 'node:crypto';

const SESSION_COOKIE = 'digital_hero_session';
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
    }),
  );
}

export function createSession(db, playerId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(`
    INSERT INTO player_sessions(id, player_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), playerId, hashToken(token), expiresAt, now, now);
  return { token, expiresAt };
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt),
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
}

export function resolvePlayer(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const now = Date.now();
  const session = db.prepare(`
    SELECT players.* FROM player_sessions
    JOIN players ON players.id = player_sessions.player_id
    WHERE player_sessions.token_hash = ? AND player_sessions.expires_at > ?
  `).get(hashToken(token), now);

  if (!session) return null;
  db.prepare('UPDATE player_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hashToken(token));
  return session;
}

export function requirePlayer(db, errorResponse) {
  return (req, res, next) => {
    const player = resolvePlayer(db, req);
    if (!player) {
      return errorResponse(res, req.requestId, 401, 'UNAUTHENTICATED', '请先创建小英雄。');
    }
    req.player = player;
    next();
  };
}

export function playerDto(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    avatarId: player.avatar_id,
    level: player.level,
    exp: player.exp,
    gold: player.gold,
    completedRunCount: player.completed_run_count,
  };
}
