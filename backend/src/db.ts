import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Actor } from './types.js';

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.sqlite.exec('COMMIT');
      return value;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  audit(actorId: string | null, action: string, entityType: string, entityId: string, payload: unknown, at: Date): void {
    this.sqlite.prepare(`
      INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(payload), at.toISOString());
  }

  actor(id: string): Actor | undefined {
    const row = this.sqlite.prepare('SELECT id, name, role, group_id FROM users WHERE id = ?').get(id) as unknown as {
      id: string; name: string; role: Actor['role']; group_id: string | null;
    } | undefined;
    return row ? { id: row.id, name: row.name, role: row.role, groupId: row.group_id } : undefined;
  }

  seed(now: Date): void {
    const count = this.sqlite.prepare('SELECT COUNT(*) AS total FROM users').get() as unknown as { total: number };
    if (Number(count.total) > 0) return;
    const start = new Date(now.getTime() - 20 * 60_000).toISOString();
    const end = new Date(now.getTime() + 70 * 60_000).toISOString();
    this.transaction(() => {
      const insertUser = this.sqlite.prepare('INSERT INTO users (id, name, role, group_id) VALUES (?, ?, ?, ?)');
      insertUser.run('host-demo', 'Ведущий демо', 'host', null);
      insertUser.run('participant-a', 'Участник А', 'participant', 'group-main');
      insertUser.run('participant-b', 'Участник Б', 'participant', 'group-main');
      insertUser.run('participant-other', 'Участник другой группы', 'participant', 'group-other');
      insertUser.run('demo-honest', 'Участник 01', 'participant', 'group-main');
      insertUser.run('demo-accuracy', 'Участник 02', 'participant', 'group-main');
      insertUser.run('demo-mock', 'Участник 03', 'participant', 'group-main');
      insertUser.run('demo-far', 'Участник 04', 'participant', 'group-main');
      insertUser.run('demo-emulator', 'Участник 05', 'participant', 'group-main');
      insertUser.run('demo-root', 'Участник 06', 'participant', 'group-main');
      insertUser.run('reviewer-demo', 'Администратор демо', 'admin', null);
      this.sqlite.prepare(`
        INSERT INTO venues (
          id, name, address, latitude, longitude, radius_m, host_radius_m, qr_interval_s,
          qr_ttl_s, checkin_before_min, checkin_after_min, gps_accuracy_warn_m, timezone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('venue-main', 'Место проведения №1', 'Алматы, демонстрационные координаты', 43.238293, 76.945465,
        120, 160, 10, 15, 15, 20, 80, 'Asia/Almaty');
      this.sqlite.prepare(`
        INSERT INTO sessions (id, title, venue_id, host_id, group_id, starts_at, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('session-live', 'Групповое занятие №24', 'venue-main', 'host-demo', 'group-main', start, end);
    });
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('participant','host','admin')),
        group_id TEXT
      );
      CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL,
        radius_m INTEGER NOT NULL, host_radius_m INTEGER NOT NULL,
        qr_interval_s INTEGER NOT NULL, qr_ttl_s INTEGER NOT NULL,
        checkin_before_min INTEGER NOT NULL, checkin_after_min INTEGER NOT NULL,
        gps_accuracy_warn_m INTEGER NOT NULL, timezone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, venue_id TEXT NOT NULL REFERENCES venues(id),
        host_id TEXT NOT NULL REFERENCES users(id), group_id TEXT NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qr_issues (
        id TEXT PRIMARY KEY, token_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
        host_id TEXT NOT NULL REFERENCES users(id), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        host_latitude REAL NOT NULL, host_longitude REAL NOT NULL, host_accuracy_m REAL NOT NULL,
        host_recorded_at TEXT NOT NULL, host_is_mocked INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integrity_challenges (
        id TEXT PRIMARY KEY, challenge TEXT NOT NULL UNIQUE, participant_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL REFERENCES sessions(id), device_hash TEXT NOT NULL, platform TEXT NOT NULL,
        expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_attest_keys (
        key_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES users(id), device_hash TEXT NOT NULL,
        public_key TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attendance_attempts (
        id TEXT PRIMARY KEY, session_id TEXT, participant_id TEXT NOT NULL REFERENCES users(id), qr_token_id TEXT,
        device_hash TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL,
        reasons_json TEXT NOT NULL, risk_score INTEGER NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy_m REAL NOT NULL,
        client_recorded_at TEXT NOT NULL, server_received_at TEXT NOT NULL,
        distance_venue_m REAL, distance_host_m REAL,
        integrity_provider TEXT, integrity_verdict TEXT, signals_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempt_participant_time ON attendance_attempts(participant_id, server_received_at);
      CREATE INDEX IF NOT EXISTS idx_attempt_device_time ON attendance_attempts(device_hash, server_received_at);
      CREATE TABLE IF NOT EXISTS attendances (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), participant_id TEXT NOT NULL REFERENCES users(id),
        attempt_id TEXT NOT NULL REFERENCES attendance_attempts(id), device_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted','suspicious','rejected')),
        original_status TEXT NOT NULL, reasons_json TEXT NOT NULL, risk_score INTEGER NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy_m REAL NOT NULL, marked_at TEXT NOT NULL,
        reviewed_by TEXT, reviewed_at TEXT, review_note TEXT,
        UNIQUE(session_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS review_history (
        id TEXT PRIMARY KEY, attendance_id TEXT NOT NULL REFERENCES attendances(id), reviewer_id TEXT NOT NULL REFERENCES users(id),
        from_status TEXT NOT NULL, to_status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }
}
