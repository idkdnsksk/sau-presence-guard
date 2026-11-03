import type { AppDatabase } from '../db.js';
import type {
  Actor, AttendanceStatus, DeviceEvidence, IntegrityVerdict, LocationEvidence,
  RiskReason, SessionRow, VenueRow
} from '../types.js';
import { conservativeDistance, distanceMeters } from './geo.js';

interface QrIssueLocation {
  host_latitude: number;
  host_longitude: number;
  host_accuracy_m: number;
  host_recorded_at: string;
  host_is_mocked: number;
}

export interface RiskDecision {
  status: AttendanceStatus;
  riskScore: number;
  reasons: RiskReason[];
  distanceVenueM: number;
  distanceHostM: number;
}

function reason(code: string, severity: RiskReason['severity'], title: string, detail: string, evidence?: Record<string, unknown>): RiskReason {
  return evidence ? { code, severity, title, detail, evidence } : { code, severity, title, detail };
}

export function evaluateRisk(input: {
  db: AppDatabase;
  actor: Actor;
  session: SessionRow;
  venue: VenueRow;
  qrIssue: QrIssueLocation;
  location: LocationEvidence;
  device: DeviceEvidence;
  integrity: IntegrityVerdict;
  now: Date;
}): RiskDecision {
  const reasons: RiskReason[] = [];
  let score = 0;
  const measuredVenue = distanceMeters(input.location, input.venue);
  const measuredHost = distanceMeters(input.location, {
    latitude: input.qrIssue.host_latitude,
    longitude: input.qrIssue.host_longitude
  });
  const venueLowerBound = conservativeDistance(measuredVenue, input.location.accuracyM);
  const hostCombinedAccuracy = input.location.accuracyM + input.qrIssue.host_accuracy_m;
  const hostLowerBound = conservativeDistance(measuredHost, hostCombinedAccuracy);
  const add = (value: RiskReason, points: number) => { reasons.push(value); score += points; };

  if (!input.integrity.valid) add(reason('DEVICE_INTEGRITY_FAILED', 'rejected', 'Устройство не прошло проверку',
    'Сервер не подтвердил подлинность приложения или устройства.', { verdict: input.integrity.verdict }), 100);
  if (input.location.isMocked) add(reason('MOCK_LOCATION', 'rejected', 'Обнаружена подмена геолокации',
    'Операционная система пометила координаты как тестовые.'), 100);
  if (input.device.isEmulator) add(reason('EMULATOR_DETECTED', 'rejected', 'Эмулятор не допускается',
    'Отметка должна выполняться с физического устройства.'), 100);
  if (input.qrIssue.host_is_mocked) add(reason('HOST_MOCK_LOCATION', 'rejected', 'Геолокация ведущего недостоверна',
    'QR был создан при mock location у ведущего.'), 100);

  const locationAgeMs = input.now.getTime() - new Date(input.location.recordedAt).getTime();
  if (!Number.isFinite(locationAgeMs) || locationAgeMs < -15_000 || locationAgeMs > 120_000) {
    add(reason('LOCATION_STALE', 'rejected', 'Координаты устарели',
      'Нужно получить геолокацию непосредственно во время отметки.', { ageSeconds: Math.round(locationAgeMs / 1000) }), 100);
  }
  const hostAgeMs = input.now.getTime() - new Date(input.qrIssue.host_recorded_at).getTime();
  if (!Number.isFinite(hostAgeMs) || hostAgeMs < -15_000 || hostAgeMs > 120_000) {
    add(reason('HOST_LOCATION_STALE', 'warning', 'Позиция ведущего устарела',
      'Отметку нужно проверить вручную.', { ageSeconds: Math.round(hostAgeMs / 1000) }), 30);
  }
  if (input.device.isRooted || input.device.isJailbroken) add(reason('DEVICE_COMPROMISED', 'warning',
    'Ненадёжное устройство', 'Обнаружены признаки root или jailbreak.'), 50);
  if (input.location.accuracyM > input.venue.gps_accuracy_warn_m) add(reason('LOW_GPS_ACCURACY', 'warning',
    'Низкая точность GPS', 'Отметка не отклонена автоматически из-за слабого сигнала в помещении.',
    { accuracyM: input.location.accuracyM, thresholdM: input.venue.gps_accuracy_warn_m }), 25);

  const venueHardLimit = Math.max(input.venue.radius_m * 3, 500);
  if (venueLowerBound > venueHardLimit) add(reason('FAR_FROM_VENUE', 'rejected', 'Участник далеко от места проведения',
    'Координаты не соответствуют месту занятия.', { distanceM: Math.round(measuredVenue), allowedRadiusM: input.venue.radius_m }), 100);
  else if (venueLowerBound > input.venue.radius_m) add(reason('OUTSIDE_VENUE_RADIUS', 'warning', 'За пределами геозоны',
    'Участник немного дальше настроенного радиуса места проведения.', { distanceM: Math.round(measuredVenue) }), 40);

  const hostHardLimit = Math.max(input.venue.host_radius_m * 3, 500);
  if (hostLowerBound > hostHardLimit) add(reason('FAR_FROM_HOST', 'rejected', 'Участник далеко от ведущего',
    'Одновременная близость к месту проведения и ведущему не подтверждена.', { distanceM: Math.round(measuredHost) }), 100);
  else if (hostLowerBound > input.venue.host_radius_m) add(reason('OUTSIDE_HOST_RADIUS', 'warning', 'Далеко от ведущего',
    'Позиции участника и ведущего требуют проверки.', { distanceM: Math.round(measuredHost) }), 35);

  const scheduleStart = new Date(input.session.starts_at).getTime() - input.venue.checkin_before_min * 60_000;
  const scheduleEnd = new Date(input.session.ends_at).getTime() + input.venue.checkin_after_min * 60_000;
  if (input.now.getTime() < scheduleStart || input.now.getTime() > scheduleEnd) add(reason('OUTSIDE_SCHEDULE', 'rejected',
    'Занятие сейчас не идёт', 'Окно отметки вычислено по серверному времени.'), 100);

  const since = new Date(input.now.getTime() - 24 * 60 * 60_000).toISOString();
  const shared = input.db.sqlite.prepare(`
    SELECT DISTINCT a.participant_id, s.group_id
    FROM attendance_attempts a JOIN sessions s ON s.id = a.session_id
    WHERE a.device_hash = ? AND a.server_received_at >= ? AND a.participant_id <> ?
  `).all(input.device.installationIdHash, since, input.actor.id) as unknown as Array<{ participant_id: string; group_id: string }>;
  if (shared.some((row) => row.group_id !== input.session.group_id)) add(reason('DEVICE_SHARED_ACROSS_GROUPS', 'warning',
    'Одно устройство у несвязанных участников', 'Найдены отметки участников из разных групп с одной установки.',
    { relatedAttempts: shared.length }), 55);

  const previous = input.db.sqlite.prepare(`
    SELECT latitude, longitude, server_received_at FROM attendance_attempts
    WHERE participant_id = ? AND status IN ('accepted','suspicious')
    ORDER BY server_received_at DESC LIMIT 1
  `).get(input.actor.id) as unknown as { latitude: number; longitude: number; server_received_at: string } | undefined;
  if (previous) {
    const seconds = Math.max(1, (input.now.getTime() - new Date(previous.server_received_at).getTime()) / 1000);
    const jumpM = distanceMeters(input.location, previous);
    const speedKmh = jumpM / seconds * 3.6;
    if (jumpM > 3_000 && speedKmh > 180) add(reason('IMPOSSIBLE_LOCATION_JUMP', 'warning', 'Резкий скачок координат',
      'Перемещение между недавними отметками физически маловероятно.',
      { distanceM: Math.round(jumpM), speedKmh: Math.round(speedKmh) }), 60);
  }

  const rejected = reasons.some((item) => item.severity === 'rejected');
  return {
    status: rejected ? 'rejected' : reasons.length ? 'suspicious' : 'accepted',
    riskScore: Math.min(100, score),
    reasons,
    distanceVenueM: measuredVenue,
    distanceHostM: measuredHost
  };
}
