import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { AppDatabase } from '../src/db.js';
import { issueAuthToken } from '../src/security/auth.js';

const venueLocation = {
  latitude: 43.238293,
  longitude: 76.945465,
  accuracyM: 8,
  recordedAt: '',
  isMocked: false
};

describe('end-to-end anti-fraud attendance', () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let config: AppConfig;
  let clock: Date;

  beforeEach(async () => {
    clock = new Date('2026-11-03T06:00:00.000Z');
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      AUTH_SECRET: 'test-auth-secret-longer-than-thirty-two-characters',
      QR_SIGNING_SECRET: 'test-qr-secret-longer-than-thirty-two-characters',
      QR_SIGNING_KEY_ID: 'test-v1',
      DEMO_MODE: 'true',
      ALLOW_DEMO_ATTESTATION: 'true'
    });
    db = new AppDatabase(':memory:');
    db.seed(clock);
    app = await buildApp({ config, db, now: () => new Date(clock), serveUi: false });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const token = (userId: string) => issueAuthToken(userId, config.authSecret, clock.getTime(), 3600);

  async function issueQr(sessionId = 'session-live', location = venueLocation): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/qr`,
      headers: { authorization: `Bearer ${token('host-demo')}` },
      payload: { ...location, recordedAt: clock.toISOString() }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().token as string;
  }

  async function checkIn(overrides: {
    userId?: string;
    sessionId?: string;
    qrToken?: string;
    deviceHash?: string;
    latitude?: number;
    longitude?: number;
    accuracyM?: number;
    isMocked?: boolean;
    isEmulator?: boolean;
    isRooted?: boolean;
    isJailbroken?: boolean;
    recordedAt?: string;
  } = {}): Promise<LightMyRequestResponse> {
    const userId = overrides.userId ?? 'participant-a';
    const sessionId = overrides.sessionId ?? 'session-live';
    const qrToken = overrides.qrToken ?? await issueQr(sessionId);
    const deviceHash = overrides.deviceHash ?? 'a'.repeat(64);
    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrity/challenge',
      headers: { authorization: `Bearer ${token(userId)}` },
      payload: { sessionId, installationIdHash: deviceHash, platform: 'web-demo' }
    });
    expect(challengeResponse.statusCode, challengeResponse.body).toBe(200);
    const challenge = challengeResponse.json().challenge as string;
    return app.inject({
      method: 'POST',
      url: '/api/v1/attendance/check-in',
      headers: { authorization: `Bearer ${token(userId)}` },
      payload: {
        qrToken,
        location: {
          latitude: overrides.latitude ?? venueLocation.latitude,
          longitude: overrides.longitude ?? venueLocation.longitude,
          accuracyM: overrides.accuracyM ?? venueLocation.accuracyM,
          recordedAt: overrides.recordedAt ?? clock.toISOString(),
          isMocked: overrides.isMocked ?? false
        },
        device: {
          installationIdHash: deviceHash,
          platform: 'web-demo',
          isEmulator: overrides.isEmulator ?? false,
          isRooted: overrides.isRooted ?? false,
          isJailbroken: overrides.isJailbroken ?? false
        },
        integrity: { provider: 'demo', challenge, token: `DEMO_VALID:${challenge}` }
      }
    });
  }

  it('accepts an honest participant in one scan', async () => {
    const response = await checkIn();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().attendance.status).toBe('accepted');
    expect(response.json().attendance.riskScore).toBe(0);
  });

  it('keeps one immutable attendance for repeated scans', async () => {
    const qrToken = await issueQr();
    const first = await checkIn({ qrToken });
    const second = await checkIn({ qrToken });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().attendance.id).toBe(first.json().attendance.id);
    expect(second.json().attendance.idempotent).toBe(true);
    const count = db.sqlite.prepare('SELECT COUNT(*) AS total FROM attendances').get() as { total: number };
    expect(Number(count.total)).toBe(1);
  });

  it('rejects a screenshot after 15 seconds and journals the failed attempt', async () => {
    const qrToken = await issueQr();
    clock = new Date(clock.getTime() + 16_000);
    const response = await checkIn({ qrToken });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('QR_EXPIRED');
    const attempt = db.sqlite.prepare('SELECT status, reasons_json FROM attendance_attempts ORDER BY server_received_at DESC LIMIT 1').get() as { status: string; reasons_json: string };
    expect(attempt.status).toBe('rejected');
    expect(attempt.reasons_json).toContain('QR_EXPIRED');
  });

  it('rejects mock location and does not create attendance', async () => {
    const response = await checkIn({ isMocked: true });
    expect(response.json().result.status).toBe('rejected');
    expect(response.json().result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MOCK_LOCATION' })]));
    const count = db.sqlite.prepare('SELECT COUNT(*) AS total FROM attendances').get() as { total: number };
    expect(Number(count.total)).toBe(0);
  });

  it('rejects an emulator', async () => {
    const response = await checkIn({ isEmulator: true });
    expect(response.json().result.status).toBe('rejected');
    expect(response.json().result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'EMULATOR_DETECTED' })]));
  });

  it('sends weak indoor GPS to review instead of falsely rejecting it', async () => {
    const response = await checkIn({ accuracyM: 140 });
    expect(response.json().attendance.status).toBe('suspicious');
    expect(response.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LOW_GPS_ACCURACY' })]));
  });

  it('sends rooted devices to review', async () => {
    const response = await checkIn({ isRooted: true });
    expect(response.json().attendance.status).toBe('suspicious');
    expect(response.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DEVICE_COMPROMISED' })]));
  });

  it('sends jailbroken devices to review', async () => {
    const response = await checkIn({ isJailbroken: true });
    expect(response.json().attendance.status).toBe('suspicious');
    expect(response.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DEVICE_COMPROMISED' })]));
  });

  it('rejects a stale participant location', async () => {
    const response = await checkIn({ recordedAt: new Date(clock.getTime() - 121_000).toISOString() });
    expect(response.json().result.status).toBe('rejected');
    expect(response.json().result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LOCATION_STALE' })]));
  });

  it('sends a modest radius overrun to review instead of a hard reject', async () => {
    const response = await checkIn({ latitude: 43.2398 });
    expect(response.json().attendance.status).toBe('suspicious');
    expect(response.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OUTSIDE_VENUE_RADIUS' })]));
  });

  it('rejects a participant far from both venue and host', async () => {
    const response = await checkIn({ latitude: 43.35, longitude: 76.70 });
    expect(response.json().result.status).toBe('rejected');
    expect(response.json().result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FAR_FROM_VENUE' }),
      expect.objectContaining({ code: 'FAR_FROM_HOST' })
    ]));
  });

  it('does not issue QR outside the server-side schedule window', async () => {
    db.sqlite.prepare('UPDATE sessions SET starts_at = ?, ends_at = ? WHERE id = ?').run(
      new Date(clock.getTime() - 3 * 3600_000).toISOString(),
      new Date(clock.getTime() - 2 * 3600_000).toISOString(),
      'session-live'
    );
    const response = await app.inject({
      method: 'POST', url: '/api/v1/sessions/session-live/qr',
      headers: { authorization: `Bearer ${token('host-demo')}` },
      payload: { ...venueLocation, recordedAt: clock.toISOString() }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_NOT_IN_CHECKIN_WINDOW');
  });

  it('does not issue QR from a mocked host location', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/sessions/session-live/qr',
      headers: { authorization: `Bearer ${token('host-demo')}` },
      payload: { ...venueLocation, isMocked: true, recordedAt: clock.toISOString() }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('HOST_MOCK_LOCATION');
  });

  it('does not issue QR when the host is clearly far from the venue', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/sessions/session-live/qr',
      headers: { authorization: `Bearer ${token('host-demo')}` },
      payload: { ...venueLocation, latitude: 43.35, longitude: 76.70, recordedAt: clock.toISOString() }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('HOST_FAR_FROM_VENUE');
  });

  it('does not let an unenrolled participant request an integrity challenge', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/integrity/challenge',
      headers: { authorization: `Bearer ${token('participant-other')}` },
      payload: { sessionId: 'session-live', installationIdHash: 'e'.repeat(64), platform: 'web-demo' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PARTICIPANT_NOT_ENROLLED');
  });

  it('flags one installation shared across unrelated groups', async () => {
    const shared = 'b'.repeat(64);
    const first = await checkIn({ deviceHash: shared });
    expect(first.json().attendance.status).toBe('accepted');
    db.sqlite.prepare(`
      INSERT INTO sessions (id, title, venue_id, host_id, group_id, starts_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-other', 'Занятие другой группы', 'venue-main', 'host-demo', 'group-other',
      new Date(clock.getTime() - 10 * 60_000).toISOString(), new Date(clock.getTime() + 60 * 60_000).toISOString());
    const qrToken = await issueQr('session-other');
    const second = await checkIn({ userId: 'participant-other', sessionId: 'session-other', qrToken, deviceHash: shared });
    expect(second.json().attendance.status).toBe('suspicious');
    expect(second.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DEVICE_SHARED_ACROSS_GROUPS' })]));
  });

  it('flags an impossible jump between two valid venues', async () => {
    const first = await checkIn();
    expect(first.json().attendance.status).toBe('accepted');
    const far = { latitude: 51.1282, longitude: 71.4304, accuracyM: 8, isMocked: false };
    db.sqlite.prepare(`
      INSERT INTO venues (
        id, name, address, latitude, longitude, radius_m, host_radius_m, qr_interval_s, qr_ttl_s,
        checkin_before_min, checkin_after_min, gps_accuracy_warn_m, timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('venue-far', 'Место проведения №2', 'Астана, демонстрационные координаты', far.latitude, far.longitude, 150, 180, 10, 15, 15, 20, 80, 'Asia/Almaty');
    db.sqlite.prepare(`
      INSERT INTO sessions (id, title, venue_id, host_id, group_id, starts_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-far', 'Занятие в другом городе', 'venue-far', 'host-demo', 'group-main',
      new Date(clock.getTime() - 10 * 60_000).toISOString(), new Date(clock.getTime() + 60 * 60_000).toISOString());
    const qrToken = await issueQr('session-far', { ...far, recordedAt: '' });
    const second = await checkIn({ sessionId: 'session-far', qrToken, latitude: far.latitude, longitude: far.longitude });
    expect(second.json().attendance.status).toBe('suspicious');
    expect(second.json().attendance.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'IMPOSSIBLE_LOCATION_JUMP' })]));
  });

  it('lets a host review a suspicious mark and preserves append-only history', async () => {
    const response = await checkIn({ accuracyM: 140 });
    const attendanceId = response.json().attendance.id as string;
    const review = await app.inject({
      method: 'PATCH', url: `/api/v1/review/${attendanceId}`,
      headers: { authorization: `Bearer ${token('host-demo')}` },
      payload: { decision: 'accept', note: 'Участник подтверждён ведущим на месте' }
    });
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().status).toBe('accepted');
    expect(review.json().originalStatus).toBe('suspicious');
    const history = await app.inject({
      method: 'GET', url: `/api/v1/review/${attendanceId}/history`,
      headers: { authorization: `Bearer ${token('host-demo')}` }
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({ from_status: 'suspicious', to_status: 'accepted', reviewer_name: 'Ведущий демо' })
    ]);
  });

  it('updates per-venue QR, radius and check-in settings with an audit event', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/venues/venue-main',
      headers: { authorization: `Bearer ${token('reviewer-demo')}` },
      payload: {
        name: 'Место проведения №1', address: 'Алматы, демонстрационные координаты',
        latitude: venueLocation.latitude, longitude: venueLocation.longitude,
        radiusM: 140, hostRadiusM: 180, qrIntervalS: 8, qrTtlS: 15,
        checkinBeforeMin: 20, checkinAfterMin: 25, gpsAccuracyWarnM: 90, timezone: 'Asia/Almaty'
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().radius_m).toBe(140);
    const audit = db.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'VENUE_RULES_UPDATED'").get() as { action: string };
    expect(audit.action).toBe('VENUE_RULES_UPDATED');
  });

  it('never exposes the admin queue to a participant', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/review/queue',
      headers: { authorization: `Bearer ${token('participant-a')}` }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ROLE_FORBIDDEN');
  });
});
