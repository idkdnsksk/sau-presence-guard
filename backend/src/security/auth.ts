import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db.js';
import { AppError } from '../errors.js';
import type { Actor, Role } from '../types.js';

interface AuthClaims {
  sub: string;
  exp: number;
}

function b64(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function issueAuthToken(actorId: string, secret: string, nowMs: number, ttlSeconds = 3600): string {
  const payload = b64(JSON.stringify({ sub: actorId, exp: Math.floor(nowMs / 1000) + ttlSeconds } satisfies AuthClaims));
  return `${payload}.${sign(payload, secret)}`;
}

export function authenticate(
  request: FastifyRequest,
  db: AppDatabase,
  config: AppConfig,
  roles: Role[],
  nowMs: number
): Actor {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'AUTH_REQUIRED', 'Требуется авторизация');
  const token = header.slice(7);
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new AppError(401, 'AUTH_INVALID', 'Недействительный токен');
  const expected = sign(payload, config.authSecret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AppError(401, 'AUTH_INVALID', 'Недействительная подпись токена');
  }
  let claims: AuthClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthClaims;
  } catch {
    throw new AppError(401, 'AUTH_INVALID', 'Недействительный токен');
  }
  if (!claims.sub || claims.exp <= Math.floor(nowMs / 1000)) throw new AppError(401, 'AUTH_EXPIRED', 'Сессия истекла');
  const actor = db.actor(claims.sub);
  if (!actor) throw new AppError(401, 'AUTH_UNKNOWN_USER', 'Пользователь не найден');
  if (!roles.includes(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN', 'Недостаточно прав');
  return actor;
}
