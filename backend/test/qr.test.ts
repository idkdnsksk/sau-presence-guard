import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { issueQrToken, verifyQrToken } from '../src/security/qr.js';

const secret = 'test-qr-secret-that-is-longer-than-thirty-two-bytes';

describe('signed dynamic QR', () => {
  it('contains the session, host and server issue time', () => {
    const issued = issueQrToken({ sessionId: 'session-1', hostId: 'host-1', ttlSeconds: 15, secret, keyId: 'v1', nowMs: 1_000_000 });
    const claims = verifyQrToken(issued.token, secret, 'v1', 1_005_000);
    expect(claims.sessionId).toBe('session-1');
    expect(claims.hostId).toBe('host-1');
    expect(claims.expiresAt - claims.issuedAt).toBe(15);
  });

  it('rejects a forwarded screenshot after the configured TTL', () => {
    const issued = issueQrToken({ sessionId: 'session-1', hostId: 'host-1', ttlSeconds: 15, secret, keyId: 'v1', nowMs: 1_000_000 });
    expect(() => verifyQrToken(issued.token, secret, 'v1', 1_016_000)).toThrowError(
      expect.objectContaining<AppError>({ code: 'QR_EXPIRED' })
    );
  });

  it('rejects any client-side modification', () => {
    const issued = issueQrToken({ sessionId: 'session-1', hostId: 'host-1', ttlSeconds: 15, secret, keyId: 'v1', nowMs: 1_000_000 });
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyQrToken(tampered, secret, 'v1', 1_005_000)).toThrowError(
      expect.objectContaining<AppError>({ code: 'QR_SIGNATURE_INVALID' })
    );
  });
});
