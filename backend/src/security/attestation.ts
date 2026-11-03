import { createHash, randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { verifyAssertion, verifyAttestation } from 'node-app-attest';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db.js';
import { AppError } from '../errors.js';
import type { Actor, DeviceEvidence, IntegrityVerdict, LocationEvidence, Platform } from '../types.js';

export type IntegrityInput =
  | { provider: 'demo'; challenge: string; token: string }
  | { provider: 'play_integrity'; challenge: string; token: string }
  | { provider: 'app_attest'; challenge: string; keyId: string; assertion: string; clientData: string };

interface ChallengeRow {
  id: string;
  participant_id: string;
  session_id: string;
  device_hash: string;
  platform: Platform;
  expires_at: string;
  used_at: string | null;
}

interface AppleKeyRow {
  key_id: string;
  participant_id: string;
  device_hash: string;
  public_key: string;
  sign_count: number;
}

interface GooglePayload {
  requestDetails?: { requestPackageName?: string; nonce?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  accountDetails?: { appLicensingVerdict?: string };
}

export interface CheckInBinding {
  qrToken: string;
  location: LocationEvidence;
  device: DeviceEvidence;
}

export class AttestationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly now: () => Date
  ) {}

  createChallenge(actor: Actor, sessionId: string, deviceHash: string, platform: Platform): { challenge: string; expiresAt: string } {
    const challenge = randomBytes(32).toString('base64url');
    const at = this.now();
    const expiresAt = new Date(at.getTime() + 90_000);
    this.db.sqlite.prepare(`
      INSERT INTO integrity_challenges (
        id, challenge, participant_id, session_id, device_hash, platform, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), challenge, actor.id, sessionId, deviceHash, platform, expiresAt.toISOString(), at.toISOString());
    return { challenge, expiresAt: expiresAt.toISOString() };
  }

  static canonicalClientData(challenge: string, binding: CheckInBinding): string {
    return JSON.stringify({
      challenge,
      qrToken: binding.qrToken,
      location: {
        latitude: binding.location.latitude.toFixed(6),
        longitude: binding.location.longitude.toFixed(6),
        accuracyM: binding.location.accuracyM.toFixed(2),
        recordedAt: binding.location.recordedAt,
        isMocked: binding.location.isMocked
      },
      device: {
        installationIdHash: binding.device.installationIdHash,
        platform: binding.device.platform
      }
    });
  }

  static playNonce(challenge: string, binding: CheckInBinding): string {
    return createHash('sha256').update(AttestationService.canonicalClientData(challenge, binding)).digest('base64url');
  }

  async verify(actor: Actor, sessionId: string, device: DeviceEvidence, input: IntegrityInput, binding: CheckInBinding): Promise<IntegrityVerdict> {
    const challenge = this.challenge(input.challenge, actor, sessionId, device);
    let verdict: IntegrityVerdict;
    if (input.provider === 'demo') {
      const demoAttestationForbidden = this.config.nodeEnv === 'production'
        && this.config.deploymentPurpose !== 'public-demo';
      if (!this.config.allowDemoAttestation || demoAttestationForbidden || device.platform !== 'web-demo') {
        throw new AppError(403, 'DEMO_ATTESTATION_DISABLED', 'Демонстрационная attestation отключена');
      }
      const valid = input.token === `DEMO_VALID:${input.challenge}`;
      verdict = { valid, provider: 'demo', verdict: valid ? 'DEMO_VALID' : 'DEMO_INVALID', hardFailure: !valid, details: { developmentOnly: true } };
    } else if (input.provider === 'play_integrity') {
      if (device.platform !== 'android' || challenge.platform !== 'android') throw new AppError(422, 'INTEGRITY_PLATFORM_MISMATCH', 'Ожидался Android');
      verdict = await this.verifyPlayIntegrity(input.token, AttestationService.playNonce(input.challenge, binding));
    } else {
      if (device.platform !== 'ios' || challenge.platform !== 'ios') throw new AppError(422, 'INTEGRITY_PLATFORM_MISMATCH', 'Ожидался iOS');
      verdict = this.verifyAppleAssertion(actor, device, input, binding);
    }
    if (verdict.valid) this.consume(challenge.id);
    return verdict;
  }

  registerAppleKey(input: {
    actor: Actor;
    sessionId: string;
    deviceHash: string;
    challenge: string;
    keyId: string;
    attestation: string;
  }): void {
    if (!this.config.appleTeamId || !this.config.appleBundleId) throw new AppError(503, 'APP_ATTEST_NOT_CONFIGURED', 'App Attest не настроен');
    const challenge = this.challenge(input.challenge, input.actor, input.sessionId, {
      installationIdHash: input.deviceHash,
      platform: 'ios'
    });
    let publicKey: string;
    try {
      const result = verifyAttestation({
        attestation: Buffer.from(input.attestation, 'base64'),
        challenge: input.challenge,
        keyId: input.keyId,
        bundleIdentifier: this.config.appleBundleId,
        teamIdentifier: this.config.appleTeamId,
        allowDevelopmentEnvironment: this.config.appleAllowDevelopment
      });
      publicKey = result.publicKey;
    } catch {
      throw new AppError(422, 'APP_ATTEST_INVALID', 'Apple attestation не прошла проверку');
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.sqlite.prepare(`
        INSERT INTO app_attest_keys (key_id, participant_id, device_hash, public_key, sign_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET
          participant_id = excluded.participant_id, device_hash = excluded.device_hash,
          public_key = excluded.public_key, sign_count = 0, updated_at = excluded.updated_at
      `).run(input.keyId, input.actor.id, input.deviceHash, publicKey, at.toISOString(), at.toISOString());
      this.consume(challenge.id);
      this.db.audit(input.actor.id, 'APP_ATTEST_KEY_REGISTERED', 'device', input.deviceHash, { keyId: input.keyId }, at);
    });
  }

  private challenge(value: string, actor: Actor, sessionId: string, device: Pick<DeviceEvidence, 'installationIdHash' | 'platform'>): ChallengeRow {
    const row = this.db.sqlite.prepare(`
      SELECT id, participant_id, session_id, device_hash, platform, expires_at, used_at
      FROM integrity_challenges WHERE challenge = ?
    `).get(value) as unknown as ChallengeRow | undefined;
    if (!row || row.participant_id !== actor.id || row.session_id !== sessionId
      || row.device_hash !== device.installationIdHash || row.platform !== device.platform) {
      throw new AppError(422, 'INTEGRITY_CHALLENGE_INVALID', 'Challenge не соответствует запросу');
    }
    if (row.used_at) throw new AppError(409, 'INTEGRITY_CHALLENGE_USED', 'Challenge уже использован');
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) throw new AppError(422, 'INTEGRITY_CHALLENGE_EXPIRED', 'Challenge истёк');
    return row;
  }

  private consume(id: string): void {
    const result = this.db.sqlite.prepare('UPDATE integrity_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(this.now().toISOString(), id);
    if (Number(result.changes) !== 1) throw new AppError(409, 'INTEGRITY_CHALLENGE_USED', 'Challenge уже использован');
  }

  private async verifyPlayIntegrity(token: string, expectedNonce: string): Promise<IntegrityVerdict> {
    if (!this.config.googlePlayPackageName) throw new AppError(503, 'PLAY_INTEGRITY_NOT_CONFIGURED', 'Play Integrity не настроен');
    let payload: GooglePayload;
    try {
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/playintegrity'] });
      const client = await auth.getClient();
      const response = await client.request<{ tokenPayloadExternal?: GooglePayload }>({
        url: `https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.config.googlePlayPackageName)}:decodeIntegrityToken`,
        method: 'POST',
        data: { integrityToken: token }
      });
      payload = response.data.tokenPayloadExternal ?? {};
    } catch {
      throw new AppError(503, 'PLAY_INTEGRITY_UNAVAILABLE', 'Google Play Integrity временно недоступен');
    }
    const request = payload.requestDetails;
    const timestamp = Number(request?.timestampMillis ?? 0);
    const fresh = Math.abs(this.now().getTime() - timestamp) <= 120_000;
    const packageMatches = request?.requestPackageName === this.config.googlePlayPackageName;
    const nonceMatches = request?.nonce === expectedNonce || request?.requestHash === expectedNonce;
    const recognized = payload.appIntegrity?.appRecognitionVerdict === 'PLAY_RECOGNIZED';
    const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const deviceTrusted = deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY');
    const licensed = !payload.accountDetails?.appLicensingVerdict || payload.accountDetails.appLicensingVerdict === 'LICENSED';
    const valid = fresh && packageMatches && nonceMatches && recognized && deviceTrusted && licensed;
    return {
      valid,
      provider: 'play_integrity',
      verdict: valid ? 'MEETS_DEVICE_INTEGRITY' : 'INTEGRITY_FAILED',
      hardFailure: !valid,
      details: { fresh, packageMatches, nonceMatches, recognized, deviceTrusted, licensed, deviceVerdicts }
    };
  }

  private verifyAppleAssertion(
    actor: Actor,
    device: DeviceEvidence,
    input: Extract<IntegrityInput, { provider: 'app_attest' }>,
    binding: CheckInBinding
  ): IntegrityVerdict {
    if (!this.config.appleTeamId || !this.config.appleBundleId) throw new AppError(503, 'APP_ATTEST_NOT_CONFIGURED', 'App Attest не настроен');
    const key = this.db.sqlite.prepare(`
      SELECT key_id, participant_id, device_hash, public_key, sign_count FROM app_attest_keys WHERE key_id = ?
    `).get(input.keyId) as unknown as AppleKeyRow | undefined;
    if (!key || key.participant_id !== actor.id || key.device_hash !== device.installationIdHash) {
      return { valid: false, provider: 'app_attest', verdict: 'KEY_NOT_REGISTERED', hardFailure: true, details: {} };
    }
    const expected = AttestationService.canonicalClientData(input.challenge, binding);
    if (input.clientData !== expected) return { valid: false, provider: 'app_attest', verdict: 'PAYLOAD_MISMATCH', hardFailure: true, details: {} };
    try {
      const result = verifyAssertion({
        assertion: Buffer.from(input.assertion, 'base64'),
        payload: input.clientData,
        publicKey: key.public_key,
        bundleIdentifier: this.config.appleBundleId,
        teamIdentifier: this.config.appleTeamId,
        signCount: key.sign_count
      });
      const updated = this.db.sqlite.prepare(`
        UPDATE app_attest_keys SET sign_count = ?, updated_at = ? WHERE key_id = ? AND sign_count = ?
      `).run(result.signCount, this.now().toISOString(), key.key_id, key.sign_count);
      if (Number(updated.changes) !== 1) return { valid: false, provider: 'app_attest', verdict: 'SIGN_COUNT_REPLAY', hardFailure: true, details: {} };
      return { valid: true, provider: 'app_attest', verdict: 'ASSERTION_VALID', hardFailure: false, details: { signCount: result.signCount } };
    } catch {
      return { valid: false, provider: 'app_attest', verdict: 'ASSERTION_INVALID', hardFailure: true, details: {} };
    }
  }
}
