import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';
import type { QrClaims } from '../types.js';

interface QrHeader {
  alg: 'HS256';
  typ: 'SAU-ATTENDANCE-QR';
  kid: string;
  v: 1;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function issueQrToken(input: {
  sessionId: string;
  hostId: string;
  ttlSeconds: number;
  secret: string;
  keyId: string;
  nowMs: number;
}): { token: string; claims: QrClaims } {
  const claims: QrClaims = {
    version: 1,
    tokenId: randomBytes(16).toString('base64url'),
    sessionId: input.sessionId,
    hostId: input.hostId,
    issuedAt: Math.floor(input.nowMs / 1000),
    expiresAt: Math.floor(input.nowMs / 1000) + input.ttlSeconds
  };
  const header: QrHeader = { alg: 'HS256', typ: 'SAU-ATTENDANCE-QR', kid: input.keyId, v: 1 };
  const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return { token: `${unsigned}.${sign(unsigned, input.secret)}`, claims };
}

export function verifyQrToken(token: string, secret: string, expectedKeyId: string, nowMs: number): QrClaims {
  const [encodedHeader, encodedPayload, signature, extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature || extra) throw new AppError(422, 'QR_MALFORMED', 'QR-код повреждён');
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = Buffer.from(sign(unsigned, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(422, 'QR_SIGNATURE_INVALID', 'Подпись QR-кода недействительна');
  }
  let header: QrHeader;
  let claims: QrClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as QrHeader;
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as QrClaims;
  } catch {
    throw new AppError(422, 'QR_MALFORMED', 'QR-код повреждён');
  }
  if (header.alg !== 'HS256' || header.typ !== 'SAU-ATTENDANCE-QR' || header.v !== 1 || header.kid !== expectedKeyId) {
    throw new AppError(422, 'QR_FORMAT_UNSUPPORTED', 'Версия QR-кода не поддерживается');
  }
  if (claims.version !== 1 || !claims.tokenId || !claims.sessionId || !claims.hostId) {
    throw new AppError(422, 'QR_CLAIMS_INVALID', 'QR-код не содержит обязательные данные');
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (claims.issuedAt > nowSeconds + 5) throw new AppError(422, 'QR_ISSUED_IN_FUTURE', 'Время QR-кода некорректно');
  if (claims.expiresAt <= nowSeconds) throw new AppError(422, 'QR_EXPIRED', 'QR-код истёк — отсканируйте новый');
  if (claims.expiresAt - claims.issuedAt > 120) throw new AppError(422, 'QR_TTL_INVALID', 'Срок действия QR-кода некорректен');
  return claims;
}

export function unsafeTokenId(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<QrClaims>).tokenId ?? null;
  } catch {
    return null;
  }
}
