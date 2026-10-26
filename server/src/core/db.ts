/**
 * SQLite storage (node:sqlite, no native dependency).
 *
 * Rules enforced here:
 *  - WAL journal, foreign keys on.
 *  - One migration list, applied by PRAGMA user_version.
 *  - Secrets never persisted. Only a key reference is stored on the provider row.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type SqlValue = string | number | bigint | null | Uint8Array;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE providers (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    transport       TEXT NOT NULL,
    socket_path     TEXT,
    api_key_ref     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    declared_caps   TEXT NOT NULL DEFAULT '[]',
    discovered_caps TEXT NOT NULL DEFAULT '[]',
    server_version  TEXT,
    last_probe_at   TEXT,
    last_error      TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE models (
    provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model_id        TEXT NOT NULL,
    upstream_id     TEXT NOT NULL,
    display_name    TEXT,
    caps            TEXT NOT NULL DEFAULT '[]',
    context_length  INTEGER,
    parameter_size  TEXT,
    quantization    TEXT,
    family          TEXT,
    size_bytes      INTEGER,
    source          TEXT NOT NULL,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    missing_scans   INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    raw             TEXT,
    PRIMARY KEY (provider_id, model_id)
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    client_id   TEXT,
    client_sig  TEXT,
    user_agent  TEXT,
    remote_addr TEXT,
    last_model  TEXT,
    turn_count  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    meta        TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL DEFAULT '',
    name         TEXT,
    tool_call_id TEXT,
    tool_calls   TEXT,
    model        TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE request_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id        TEXT NOT NULL,
    ts                TEXT NOT NULL,
    session_id        TEXT,
    client_sig        TEXT,
    provider_id       TEXT,
    model_id          TEXT,
    stream            INTEGER NOT NULL,
    status            INTEGER NOT NULL,
    error_code        TEXT,
    upstream_status   INTEGER,
    duration_ms       INTEGER NOT NULL,
    ttfb_ms           INTEGER,
    chunk_count       INTEGER,
    prompt_bytes      INTEGER,
    prompt_hash       TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    detail            TEXT
  );

  CREATE INDEX idx_models_active ON models(provider_id, active);
  CREATE INDEX idx_messages_session ON messages(session_id, id);
  CREATE INDEX idx_logs_ts ON request_logs(ts);
  `,
  `
  ALTER TABLE models ADD COLUMN capabilities_source TEXT;
  `,
  `
  ALTER TABLE providers ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX idx_logs_provider_model ON request_logs(provider_id, model_id);
  `,
  `
  CREATE TABLE admin_sessions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    remote_addr TEXT,
    user_agent  TEXT,
    interval_ms INTEGER NOT NULL,
    frames      INTEGER NOT NULL DEFAULT 0,
    opened_at   TEXT NOT NULL,
    last_sent_at TEXT,
    closed_at   TEXT,
    meta        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_admin_sessions_opened ON admin_sessions(opened_at);
  `,
];

let instance: DatabaseSync | null = null;

export function openDatabase(path: string): DatabaseSync {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });

  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");

  migrate(db);
  instance = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
      ?.user_version ?? 0,
  );

  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const sql = MIGRATIONS[index];
    if (!sql) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function database(): DatabaseSync {
  if (!instance) throw new Error("Database is not open");
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function queryAll<T>(sql: string, ...params: SqlValue[]): T[] {
  return database().prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(sql: string, ...params: SqlValue[]): T | undefined {
  const row = database().prepare(sql).get(...params) as unknown as T | undefined;
  return row;
}

export function execute(sql: string, ...params: SqlValue[]): void {
  database().prepare(sql).run(...params);
}
