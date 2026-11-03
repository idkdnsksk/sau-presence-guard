export type Role = 'participant' | 'host' | 'admin';
export type AttendanceStatus = 'accepted' | 'suspicious' | 'rejected';
export type Platform = 'android' | 'ios' | 'web-demo';

export interface Actor {
  id: string;
  name: string;
  role: Role;
  groupId: string | null;
}

export interface LocationEvidence {
  latitude: number;
  longitude: number;
  accuracyM: number;
  recordedAt: string;
  isMocked: boolean;
}

export interface DeviceEvidence {
  installationIdHash: string;
  platform: Platform;
  isEmulator: boolean;
  isRooted: boolean;
  isJailbroken: boolean;
}

export interface RiskReason {
  code: string;
  severity: 'warning' | 'rejected';
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface IntegrityVerdict {
  valid: boolean;
  provider: 'play_integrity' | 'app_attest' | 'demo';
  verdict: string;
  hardFailure: boolean;
  details: Record<string, unknown>;
}

export interface VenueRow {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  host_radius_m: number;
  qr_interval_s: number;
  qr_ttl_s: number;
  checkin_before_min: number;
  checkin_after_min: number;
  gps_accuracy_warn_m: number;
  timezone: string;
}

export interface SessionRow {
  id: string;
  title: string;
  venue_id: string;
  host_id: string;
  group_id: string;
  starts_at: string;
  ends_at: string;
}

export interface QrClaims {
  version: 1;
  tokenId: string;
  sessionId: string;
  hostId: string;
  issuedAt: number;
  expiresAt: number;
}
