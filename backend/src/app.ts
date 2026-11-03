import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import QRCode from 'qrcode';
import { z, type ZodType } from 'zod';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './db.js';
import { AppError } from './errors.js';
import { conservativeDistance, distanceMeters } from './domain/geo.js';
import { evaluateRisk } from './domain/risk-engine.js';
import { authenticate, issueAuthToken } from './security/auth.js';
import { AttestationService, type IntegrityInput } from './security/attestation.js';
import { issueQrToken, unsafeTokenId, verifyQrToken } from './security/qr.js';
import type {
  AttendanceStatus, DeviceEvidence, LocationEvidence, RiskReason, SessionRow, VenueRow
} from './types.js';

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(10_000),
  recordedAt: z.iso.datetime({ offset: true }),
  isMocked: z.boolean()
}).strict();

const deviceSchema = z.object({
  installationIdHash: z.string().min(32).max(256),
  platform: z.enum(['android', 'ios', 'web-demo']),
  isEmulator: z.boolean(),
  isRooted: z.boolean(),
  isJailbroken: z.boolean()
}).strict();

const integritySchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('demo'), challenge: z.string().min(20), token: z.string().min(20) }).strict(),
  z.object({ provider: z.literal('play_integrity'), challenge: z.string().min(20), token: z.string().min(20) }).strict(),
  z.object({
    provider: z.literal('app_attest'), challenge: z.string().min(20), keyId: z.string().min(20),
    assertion: z.string().min(20), clientData: z.string().min(20)
  }).strict()
]);

const checkInSchema = z.object({
  qrToken: z.string().min(30).max(10_000),
  location: locationSchema,
  device: deviceSchema,
  integrity: integritySchema
}).strict();

interface AttendanceRow {
  id: string;
  session_id: string;
  participant_id: string;
  status: AttendanceStatus;
  original_status: AttendanceStatus;
  reasons_json: string;
  risk_score: number;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  marked_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Проверьте данные запроса', result.error.flatten());
  return result.data;
}

function session(db: AppDatabase, id: string): SessionRow {
  const row = db.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  if (!row) throw new AppError(404, 'SESSION_NOT_FOUND', 'Занятие не найдено');
  return row;
}

function venue(db: AppDatabase, id: string): VenueRow {
  const row = db.sqlite.prepare('SELECT * FROM venues WHERE id = ?').get(id) as unknown as VenueRow | undefined;
  if (!row) throw new AppError(404, 'VENUE_NOT_FOUND', 'Место проведения не найдено');
  return row;
}

function serializeAttendance(row: AttendanceRow, idempotent = false) {
  return {
    id: row.id,
    sessionId: row.session_id,
    participantId: row.participant_id,
    status: row.status,
    originalStatus: row.original_status,
    reasons: JSON.parse(row.reasons_json) as RiskReason[],
    riskScore: row.risk_score,
    location: { latitude: row.latitude, longitude: row.longitude, accuracyM: row.accuracy_m },
    markedAt: row.marked_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    idempotent
  };
}

function insertAttempt(db: AppDatabase, input: {
  id: string;
  sessionId: string | null;
  participantId: string;
  tokenId: string | null;
  device: DeviceEvidence;
  location: LocationEvidence;
  status: AttendanceStatus;
  reasons: RiskReason[];
  riskScore: number;
  receivedAt: Date;
  distanceVenueM: number | null;
  distanceHostM: number | null;
  integrityProvider: string | null;
  integrityVerdict: string | null;
  signals: unknown;
}): void {
  db.sqlite.prepare(`
    INSERT INTO attendance_attempts (
      id, session_id, participant_id, qr_token_id, device_hash, platform, status, reasons_json, risk_score,
      latitude, longitude, accuracy_m, client_recorded_at, server_received_at,
      distance_venue_m, distance_host_m, integrity_provider, integrity_verdict, signals_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.sessionId, input.participantId, input.tokenId, input.device.installationIdHash,
    input.device.platform, input.status, JSON.stringify(input.reasons), input.riskScore,
    input.location.latitude, input.location.longitude, input.location.accuracyM, input.location.recordedAt,
    input.receivedAt.toISOString(), input.distanceVenueM, input.distanceHostM,
    input.integrityProvider, input.integrityVerdict, JSON.stringify(input.signals)
  );
}

export async function buildApp(options: {
  config: AppConfig;
  db: AppDatabase;
  now?: () => Date;
  serveUi?: boolean;
}): Promise<FastifyInstance> {
  const { config, db } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: config.nodeEnv !== 'test', trustProxy: true, bodyLimit: 256 * 1024 });
  const attestation = new AttestationService(db, config, now);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      try {
        const parsed = new URL(origin);
        if (['localhost', '127.0.0.1'].includes(parsed.hostname)) return callback(null, true);
        if (config.deploymentPurpose === 'public-demo' && parsed.hostname.endsWith('.vercel.app')) {
          return callback(null, true);
        }
      } catch { /* invalid origin */ }
      callback(new Error('Origin is not allowed'), false);
    },
    credentials: false
  });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: 'SAU Presence Guard API', version: '1.0.0', description: 'Модуль защищённой отметки посещаемости' },
      tags: [
        { name: 'attendance', description: 'Secure check-in flow' },
        { name: 'host', description: 'QR ведущего' },
        { name: 'review', description: 'Suspicious attendance review' },
        { name: 'admin', description: 'Venue rules and audit' }
      ]
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервера');
    if (!(error instanceof AppError)) app.log.error(error);
    void reply.code(appError.statusCode).send({
      error: { code: appError.code, message: appError.message, details: appError.details ?? null }
    });
  });

  app.get('/api/v1/health', { schema: { hide: true } }, async () => ({ status: 'ok', serverTime: now().toISOString() }));
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.post('/api/v1/demo/token', { schema: { hide: true } }, async (request) => {
    const demoRouteForbidden = config.nodeEnv === 'production' && config.deploymentPurpose !== 'public-demo';
    if (!config.demoMode || demoRouteForbidden) throw new AppError(404, 'NOT_FOUND', 'Маршрут недоступен');
    const body = parse(z.object({ userId: z.enum([
      'host-demo', 'participant-a', 'participant-b', 'participant-other', 'reviewer-demo',
      'demo-honest', 'demo-accuracy', 'demo-mock', 'demo-far', 'demo-emulator', 'demo-root'
    ]) }).strict(), request.body);
    const actor = db.actor(body.userId);
    if (!actor) throw new AppError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    return { token: issueAuthToken(actor.id, config.authSecret, now().getTime(), 8 * 3600), user: actor };
  });

  app.get('/api/v1/bootstrap', async (request) => {
    const actor = authenticate(request, db, config, ['participant', 'host', 'admin'], now().getTime());
    let rows: unknown[];
    if (actor.role === 'participant') {
      rows = db.sqlite.prepare(`
        SELECT s.*, v.name AS venue_name, v.address FROM sessions s JOIN venues v ON v.id = s.venue_id
        WHERE s.group_id = ? ORDER BY s.starts_at
      `).all(actor.groupId) as unknown[];
    } else if (actor.role === 'host') {
      rows = db.sqlite.prepare(`
        SELECT s.*, v.name AS venue_name, v.address FROM sessions s JOIN venues v ON v.id = s.venue_id
        WHERE s.host_id = ? ORDER BY s.starts_at
      `).all(actor.id) as unknown[];
    } else {
      rows = db.sqlite.prepare(`
        SELECT s.*, v.name AS venue_name, v.address FROM sessions s JOIN venues v ON v.id = s.venue_id ORDER BY s.starts_at
      `).all() as unknown[];
    }
    return { user: actor, sessions: rows, serverTime: now().toISOString() };
  });

  app.post('/api/v1/sessions/:sessionId/qr', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['host'], summary: 'Issue a signed rotating QR from fresh host location' }
  }, async (request) => {
    const actor = authenticate(request, db, config, ['host'], now().getTime());
    const params = parse(z.object({ sessionId: z.string().min(1).max(100) }), request.params);
    const hostLocation = parse(locationSchema, request.body);
    const at = now();
    const currentSession = session(db, params.sessionId);
    if (currentSession.host_id !== actor.id) throw new AppError(403, 'HOST_NOT_ASSIGNED', 'Ведущий не назначен на это занятие');
    const currentVenue = venue(db, currentSession.venue_id);
    const opensAt = new Date(currentSession.starts_at).getTime() - currentVenue.checkin_before_min * 60_000;
    const closesAt = new Date(currentSession.ends_at).getTime() + currentVenue.checkin_after_min * 60_000;
    if (at.getTime() < opensAt || at.getTime() > closesAt) throw new AppError(409, 'SESSION_NOT_IN_CHECKIN_WINDOW', 'Занятие вне окна отметки');
    const age = at.getTime() - new Date(hostLocation.recordedAt).getTime();
    if (age < -15_000 || age > 120_000) throw new AppError(422, 'HOST_LOCATION_STALE', 'Обновите геолокацию ведущего');
    if (hostLocation.isMocked) throw new AppError(422, 'HOST_MOCK_LOCATION', 'Нельзя создать QR с подменённой геолокацией');
    const measured = distanceMeters(hostLocation, currentVenue);
    const lowerBound = conservativeDistance(measured, hostLocation.accuracyM);
    if (lowerBound > Math.max(currentVenue.host_radius_m * 3, 500)) {
      throw new AppError(422, 'HOST_FAR_FROM_VENUE', 'Ведущий находится далеко от места проведения', { distanceM: Math.round(measured) });
    }
    const issued = issueQrToken({
      sessionId: currentSession.id,
      hostId: actor.id,
      ttlSeconds: currentVenue.qr_ttl_s,
      secret: config.qrSigningSecret,
      keyId: config.qrSigningKeyId,
      nowMs: at.getTime()
    });
    const expiresAt = new Date(issued.claims.expiresAt * 1000);
    db.transaction(() => {
      db.sqlite.prepare(`
        INSERT INTO qr_issues (
          id, token_id, session_id, host_id, issued_at, expires_at,
          host_latitude, host_longitude, host_accuracy_m, host_recorded_at, host_is_mocked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), issued.claims.tokenId, currentSession.id, actor.id, at.toISOString(), expiresAt.toISOString(),
        hostLocation.latitude, hostLocation.longitude, hostLocation.accuracyM, hostLocation.recordedAt, 0
      );
      db.audit(actor.id, 'QR_ISSUED', 'session', currentSession.id, {
        tokenId: issued.claims.tokenId,
        expiresAt: expiresAt.toISOString(),
        hostLocation,
        distanceVenueM: measured
      }, at);
    });
    const qrSvg = await QRCode.toString(issued.token, { type: 'svg', margin: 1, width: 360, color: { dark: '#101828', light: '#ffffff' } });
    return {
      token: issued.token,
      qrSvg,
      issuedAt: at.toISOString(),
      expiresAt: expiresAt.toISOString(),
      refreshAt: new Date(at.getTime() + currentVenue.qr_interval_s * 1000).toISOString(),
      intervalSeconds: currentVenue.qr_interval_s,
      serverTime: at.toISOString()
    };
  });

  app.post('/api/v1/integrity/challenge', {
    schema: { tags: ['attendance'], summary: 'Issue a one-use attestation challenge' }
  }, async (request) => {
    const actor = authenticate(request, db, config, ['participant'], now().getTime());
    const body = parse(z.object({
      sessionId: z.string().min(1).max(100),
      installationIdHash: z.string().min(32).max(256),
      platform: z.enum(['android', 'ios', 'web-demo'])
    }).strict(), request.body);
    const currentSession = session(db, body.sessionId);
    if (actor.groupId !== currentSession.group_id) throw new AppError(403, 'PARTICIPANT_NOT_ENROLLED', 'Участник не состоит в группе занятия');
    return attestation.createChallenge(actor, currentSession.id, body.installationIdHash, body.platform);
  });

  app.post('/api/v1/integrity/apple/register', {
    schema: { tags: ['attendance'], summary: 'Register an Apple App Attest key' }
  }, async (request, reply) => {
    const actor = authenticate(request, db, config, ['participant'], now().getTime());
    const body = parse(z.object({
      sessionId: z.string().min(1).max(100),
      installationIdHash: z.string().min(32).max(256),
      challenge: z.string().min(20).max(256),
      keyId: z.string().min(20).max(512),
      attestation: z.string().min(100)
    }).strict(), request.body);
    const currentSession = session(db, body.sessionId);
    if (actor.groupId !== currentSession.group_id) throw new AppError(403, 'PARTICIPANT_NOT_ENROLLED', 'Участник не состоит в группе занятия');
    attestation.registerAppleKey({ actor, ...body, deviceHash: body.installationIdHash });
    return reply.code(201).send({ registered: true, keyId: body.keyId });
  });

  app.post('/api/v1/attendance/check-in', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['attendance'], summary: 'Verify QR, schedule, foreground location and device integrity' }
  }, async (request, reply) => {
    const at = now();
    const actor = authenticate(request, db, config, ['participant'], at.getTime());
    const body = parse(checkInSchema, request.body);
    let claims;
    try {
      claims = verifyQrToken(body.qrToken, config.qrSigningSecret, config.qrSigningKeyId, at.getTime());
    } catch (error) {
      const qrError = error instanceof AppError ? error : new AppError(422, 'QR_INVALID', 'QR-код недействителен');
      const reasons: RiskReason[] = [{
        code: qrError.code, severity: 'rejected', title: 'QR-код не принят', detail: qrError.message
      }];
      insertAttempt(db, {
        id: crypto.randomUUID(), sessionId: null, participantId: actor.id, tokenId: unsafeTokenId(body.qrToken),
        device: body.device, location: body.location, status: 'rejected', reasons, riskScore: 100,
        receivedAt: at, distanceVenueM: null, distanceHostM: null,
        integrityProvider: body.integrity.provider, integrityVerdict: 'NOT_CHECKED',
        signals: { device: body.device, location: body.location }
      });
      throw new AppError(qrError.statusCode, qrError.code, qrError.message, { status: 'rejected', reasons });
    }
    const currentSession = session(db, claims.sessionId);
    if (claims.hostId !== currentSession.host_id) throw new AppError(422, 'QR_HOST_MISMATCH', 'QR принадлежит другому ведущему');
    if (actor.groupId !== currentSession.group_id) throw new AppError(403, 'PARTICIPANT_NOT_ENROLLED', 'Участник не состоит в группе занятия');
    const qrIssue = db.sqlite.prepare(`
      SELECT host_latitude, host_longitude, host_accuracy_m, host_recorded_at, host_is_mocked
      FROM qr_issues WHERE token_id = ? AND session_id = ?
    `).get(claims.tokenId, currentSession.id) as unknown as {
      host_latitude: number; host_longitude: number; host_accuracy_m: number; host_recorded_at: string; host_is_mocked: number;
    } | undefined;
    if (!qrIssue) throw new AppError(422, 'QR_NOT_ISSUED_HERE', 'QR не найден в журнале выдачи');

    const existing = db.sqlite.prepare('SELECT * FROM attendances WHERE session_id = ? AND participant_id = ?')
      .get(currentSession.id, actor.id) as unknown as AttendanceRow | undefined;
    if (existing) return { attendance: serializeAttendance(existing, true), serverTime: at.toISOString() };

    const integrity = await attestation.verify(
      actor,
      currentSession.id,
      body.device,
      body.integrity as IntegrityInput,
      { qrToken: body.qrToken, location: body.location, device: body.device }
    );
    const currentVenue = venue(db, currentSession.venue_id);
    const decision = evaluateRisk({
      db, actor, session: currentSession, venue: currentVenue, qrIssue,
      location: body.location, device: body.device, integrity, now: at
    });
    const attemptId = crypto.randomUUID();
    const attendanceId = crypto.randomUUID();
    let attendance: AttendanceRow | null = null;
    let idempotent = false;
    db.transaction(() => {
      insertAttempt(db, {
        id: attemptId, sessionId: currentSession.id, participantId: actor.id, tokenId: claims.tokenId,
        device: body.device, location: body.location, status: decision.status, reasons: decision.reasons,
        riskScore: decision.riskScore, receivedAt: at, distanceVenueM: decision.distanceVenueM,
        distanceHostM: decision.distanceHostM, integrityProvider: integrity.provider,
        integrityVerdict: integrity.verdict,
        signals: { device: body.device, location: body.location, integrity: integrity.details }
      });
      if (decision.status !== 'rejected') {
        const inserted = db.sqlite.prepare(`
          INSERT OR IGNORE INTO attendances (
            id, session_id, participant_id, attempt_id, device_hash, status, original_status,
            reasons_json, risk_score, latitude, longitude, accuracy_m, marked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attendanceId, currentSession.id, actor.id, attemptId, body.device.installationIdHash,
          decision.status, decision.status, JSON.stringify(decision.reasons), decision.riskScore,
          body.location.latitude, body.location.longitude, body.location.accuracyM, at.toISOString()
        );
        idempotent = Number(inserted.changes) === 0;
        attendance = db.sqlite.prepare('SELECT * FROM attendances WHERE session_id = ? AND participant_id = ?')
          .get(currentSession.id, actor.id) as unknown as AttendanceRow;
      }
      db.audit(actor.id, 'ATTENDANCE_EVALUATED', 'session', currentSession.id, {
        attemptId, attendanceId: attendance?.id ?? null, status: decision.status,
        riskScore: decision.riskScore, reasons: decision.reasons.map((item) => item.code),
        tokenId: claims.tokenId, integrity: { provider: integrity.provider, verdict: integrity.verdict }
      }, at);
    });
    if (decision.status === 'rejected') {
      return reply.code(200).send({
        attendance: null,
        result: { status: 'rejected', reasons: decision.reasons, riskScore: decision.riskScore, attemptId },
        serverTime: at.toISOString()
      });
    }
    return { attendance: serializeAttendance(attendance as unknown as AttendanceRow, idempotent), serverTime: at.toISOString() };
  });

  app.get('/api/v1/review/queue', {
    schema: { tags: ['review'], summary: 'List suspicious marks visible to host/admin' }
  }, async (request) => {
    const actor = authenticate(request, db, config, ['host', 'admin'], now().getTime());
    const filter = actor.role === 'host' ? 'AND s.host_id = ?' : '';
    const params = actor.role === 'host' ? [actor.id] : [];
    const rows = db.sqlite.prepare(`
      SELECT a.*, u.name AS participant_name, s.title AS session_title, v.name AS venue_name
      FROM attendances a
      JOIN users u ON u.id = a.participant_id
      JOIN sessions s ON s.id = a.session_id
      JOIN venues v ON v.id = s.venue_id
      WHERE a.status = 'suspicious' ${filter}
      ORDER BY a.marked_at DESC
    `).all(...params) as unknown[];
    return { items: rows.map((raw) => {
      const row = raw as AttendanceRow & Record<string, unknown>;
      return { ...row, reasons: JSON.parse(row.reasons_json) as RiskReason[] };
    }) };
  });

  app.patch('/api/v1/review/:attendanceId', {
    schema: { tags: ['review'], summary: 'Accept or reject a suspicious mark and append history' }
  }, async (request) => {
    const actor = authenticate(request, db, config, ['host', 'admin'], now().getTime());
    const params = parse(z.object({ attendanceId: z.string().uuid() }), request.params);
    const body = parse(z.object({ decision: z.enum(['accept', 'reject']), note: z.string().trim().min(5).max(500) }).strict(), request.body);
    const row = db.sqlite.prepare(`
      SELECT a.*, s.host_id FROM attendances a JOIN sessions s ON s.id = a.session_id WHERE a.id = ?
    `).get(params.attendanceId) as unknown as (AttendanceRow & { host_id: string }) | undefined;
    if (!row) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Отметка не найдена');
    if (actor.role === 'host' && row.host_id !== actor.id) throw new AppError(403, 'REVIEW_FORBIDDEN', 'Эта отметка относится к другому ведущему');
    if (row.status !== 'suspicious') throw new AppError(409, 'ATTENDANCE_NOT_SUSPICIOUS', 'Отметка уже разобрана');
    const target: AttendanceStatus = body.decision === 'accept' ? 'accepted' : 'rejected';
    const at = now();
    db.transaction(() => {
      db.sqlite.prepare(`
        UPDATE attendances SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'suspicious'
      `).run(target, actor.id, at.toISOString(), body.note, row.id);
      db.sqlite.prepare(`
        INSERT INTO review_history (id, attendance_id, reviewer_id, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), row.id, actor.id, 'suspicious', target, body.note, at.toISOString());
      db.audit(actor.id, 'ATTENDANCE_REVIEWED', 'attendance', row.id, { from: 'suspicious', to: target, note: body.note }, at);
    });
    const updated = db.sqlite.prepare('SELECT * FROM attendances WHERE id = ?').get(row.id) as unknown as AttendanceRow;
    return serializeAttendance(updated);
  });

  app.get('/api/v1/review/:attendanceId/history', async (request) => {
    const actor = authenticate(request, db, config, ['host', 'admin'], now().getTime());
    const params = parse(z.object({ attendanceId: z.string().uuid() }), request.params);
    const attendance = db.sqlite.prepare(`
      SELECT a.id, s.host_id FROM attendances a JOIN sessions s ON s.id = a.session_id WHERE a.id = ?
    `).get(params.attendanceId) as unknown as { id: string; host_id: string } | undefined;
    if (!attendance) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Отметка не найдена');
    if (actor.role === 'host' && attendance.host_id !== actor.id) throw new AppError(403, 'REVIEW_FORBIDDEN', 'Нет доступа');
    return { items: db.sqlite.prepare(`
      SELECT h.*, u.name AS reviewer_name FROM review_history h JOIN users u ON u.id = h.reviewer_id
      WHERE h.attendance_id = ? ORDER BY h.created_at
    `).all(attendance.id) };
  });

  app.get('/api/v1/admin/overview', async (request) => {
    authenticate(request, db, config, ['admin'], now().getTime());
    const counts = db.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM attendances WHERE status = 'accepted') AS accepted,
        (SELECT COUNT(*) FROM attendances WHERE status = 'suspicious') AS suspicious,
        (SELECT COUNT(*) FROM attendance_attempts WHERE status = 'rejected') AS rejected,
        (SELECT COUNT(*) FROM attendance_attempts) AS attempts,
        (SELECT COUNT(*) FROM qr_issues) AS qr_issued
    `).get();
    const recent = db.sqlite.prepare(`
      SELECT a.status, a.risk_score, a.marked_at, u.name AS participant_name, s.title AS session_title
      FROM attendances a JOIN users u ON u.id = a.participant_id JOIN sessions s ON s.id = a.session_id
      ORDER BY a.marked_at DESC LIMIT 8
    `).all();
    return { counts, recent };
  });

  app.get('/api/v1/admin/venues', async (request) => {
    authenticate(request, db, config, ['admin'], now().getTime());
    return { items: db.sqlite.prepare('SELECT * FROM venues ORDER BY name').all() };
  });

  app.patch('/api/v1/admin/venues/:venueId', {
    schema: { tags: ['admin'], summary: 'Update per-venue QR, radius and schedule-window rules' }
  }, async (request) => {
    const actor = authenticate(request, db, config, ['admin'], now().getTime());
    const params = parse(z.object({ venueId: z.string().min(1).max(100) }), request.params);
    const body = parse(z.object({
      name: z.string().trim().min(2).max(120),
      address: z.string().trim().min(2).max(200),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusM: z.number().int().min(20).max(5_000),
      hostRadiusM: z.number().int().min(20).max(5_000),
      qrIntervalS: z.number().int().min(3).max(60),
      qrTtlS: z.number().int().min(5).max(120),
      checkinBeforeMin: z.number().int().min(0).max(180),
      checkinAfterMin: z.number().int().min(0).max(180),
      gpsAccuracyWarnM: z.number().int().min(10).max(1_000),
      timezone: z.string().min(3).max(80)
    }).strict().superRefine((value, context) => {
      if (value.qrTtlS < value.qrIntervalS) context.addIssue({ code: 'custom', path: ['qrTtlS'], message: 'TTL должен быть не меньше интервала обновления' });
    }), request.body);
    venue(db, params.venueId);
    const at = now();
    db.transaction(() => {
      db.sqlite.prepare(`
        UPDATE venues SET name = ?, address = ?, latitude = ?, longitude = ?, radius_m = ?, host_radius_m = ?,
          qr_interval_s = ?, qr_ttl_s = ?, checkin_before_min = ?, checkin_after_min = ?,
          gps_accuracy_warn_m = ?, timezone = ? WHERE id = ?
      `).run(
        body.name, body.address, body.latitude, body.longitude, body.radiusM, body.hostRadiusM,
        body.qrIntervalS, body.qrTtlS, body.checkinBeforeMin, body.checkinAfterMin,
        body.gpsAccuracyWarnM, body.timezone, params.venueId
      );
      db.audit(actor.id, 'VENUE_RULES_UPDATED', 'venue', params.venueId, body, at);
    });
    return venue(db, params.venueId);
  });

  app.get('/api/v1/admin/audit', async (request) => {
    authenticate(request, db, config, ['admin'], now().getTime());
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query);
    return { items: db.sqlite.prepare(`
      SELECT l.*, u.name AS actor_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
      ORDER BY l.created_at DESC LIMIT ?
    `).all(query.limit) };
  });

  if (options.serveUi !== false) {
    const publicRoot = process.cwd().endsWith('backend')
      ? resolve(process.cwd(), 'src/public')
      : resolve(process.cwd(), 'backend/src/public');
    const sendAsset = async (reply: FastifyReply, file: string, type: string) => {
      const bundledAsset = file === 'index.html'
        ? new URL('./public/index.html', import.meta.url)
        : file === 'styles.css'
          ? new URL('./public/styles.css', import.meta.url)
          : file === 'app.js'
            ? new URL('./public/app.js', import.meta.url)
            : new URL('./public/icons.svg', import.meta.url);
      let content: Buffer;
      try {
        // Literal URLs let Vercel's file tracer include the UI in the Function bundle.
        content = await readFile(bundledAsset);
      } catch {
        // The compiled Docker build keeps the source assets next to backend/dist.
        content = await readFile(resolve(publicRoot, file));
      }
      return reply.type(type).send(content);
    };
    app.get('/', { schema: { hide: true } }, async (_request, reply) => sendAsset(reply, 'index.html', 'text/html; charset=utf-8'));
    app.get('/admin', { schema: { hide: true } }, async (_request, reply) => sendAsset(reply, 'index.html', 'text/html; charset=utf-8'));
    app.get('/styles.css', { schema: { hide: true } }, async (_request, reply) => sendAsset(reply, 'styles.css', 'text/css; charset=utf-8'));
    app.get('/app.js', { schema: { hide: true } }, async (_request, reply) => sendAsset(reply, 'app.js', 'text/javascript; charset=utf-8'));
    app.get('/icons.svg', { schema: { hide: true } }, async (_request, reply) => sendAsset(reply, 'icons.svg', 'image/svg+xml'));
    app.get('/favicon.ico', { schema: { hide: true } }, async (_request, reply) => reply.code(204).send());
  }

  await app.ready();
  return app;
}
