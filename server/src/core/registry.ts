/**
 * Provider registry.
 *
 * Storage model:
 *  - core connection fields live in their own columns (queryable, indexable);
 *  - everything provider-specific lives in `config_json`, so adding a field to a
 *    custom provider never becomes an ALTER TABLE.
 *
 * Source of truth:
 *  - the database is the runtime truth;
 *  - the environment is a seed floor: an env provider is inserted once and then
 *    kept in sync for connection fields, but the admin `enabled` flag is never
 *    overwritten by a restart.
 *
 * Secrets:
 *  - only the environment variable *name* is persisted (`api_key_ref`);
 *  - the value is resolved into memory at load time and never written to disk.
 */

import type { ProviderConfig, ProviderKind, TransportKind } from "../config.ts";
import { normalizeProviderId } from "../config.ts";
import { execute, queryAll, queryOne } from "./db.ts";
import { GatewayError } from "./errors.ts";
import { nowIso } from "./logger.ts";

const KINDS: ProviderKind[] = ["ollama", "llamacpp", "openai", "opencode"];
const TRANSPORTS: TransportKind[] = ["http", "https", "uds", "ws"];
const MAX_EXTRA_BYTES = 64 * 1024;

export interface ProviderInput {
  id?: string;
  kind: string;
  base_url: string;
  transport?: string;
  socket_path?: string | null;
  api_key_env?: string | null;
  headers?: Record<string, string>;
  models?: string[];
  caps?: string[];
  timeout_ms?: number;
  enabled?: boolean;
  notes?: string | null;
  extra?: Record<string, unknown>;
}

interface ProviderRow {
  id: string;
  kind: string;
  base_url: string;
  transport: string;
  socket_path: string | null;
  api_key_ref: string | null;
  enabled: number;
  declared_caps: string;
  discovered_caps: string;
  server_version: string | null;
  last_probe_at: string | null;
  last_error: string | null;
  created_at: string;
  config_json: string;
}

function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function stringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asObject(raw))) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function toKind(raw: string): ProviderKind {
  const kind = raw as ProviderKind;
  if (!KINDS.includes(kind)) {
    throw new GatewayError({
      message: `Unknown provider kind "${raw}". Allowed: ${KINDS.join(", ")}`,
      status: 400,
      code: "invalid_request_error",
      param: "kind",
    });
  }
  return kind;
}

function toConfig(row: ProviderRow): ProviderConfig {
  const extra = parseJson(row.config_json);
  const apiKeyEnv = row.api_key_ref;
  return {
    id: row.id,
    kind: toKind(row.kind),
    baseUrl: row.base_url,
    transport: row.transport as TransportKind,
    socketPath: row.socket_path,
    apiKey: apiKeyEnv ? process.env[apiKeyEnv] ?? null : null,
    apiKeyEnv,
    headers: stringRecord(extra["headers"]),
    models: asStringArray(extra["models"]),
    caps: declaredCaps(row),
    timeoutMs: typeof extra["timeout_ms"] === "number" ? extra["timeout_ms"] : 300_000,
    enabled: row.enabled === 1,
    source: extra["source"] === "admin" ? "admin" : "env",
    notes: typeof extra["notes"] === "string" ? extra["notes"] : null,
    extra: asObject(extra["extra"]),
  };
}

function declaredCaps(row: ProviderRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.declared_caps);
    return asStringArray(parsed);
  } catch {
    return [];
  }
}

function configJson(config: ProviderConfig): string {
  return JSON.stringify({
    headers: config.headers,
    models: config.models,
    timeout_ms: config.timeoutMs,
    source: config.source,
    notes: config.notes,
    extra: config.extra,
  });
}

function validate(raw: ProviderInput, fallbackId?: string): ProviderConfig {
  const kind = toKind(String(raw.kind ?? "").trim().toLowerCase());

  const baseUrl = String(raw.base_url ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new GatewayError({
      message: "Field 'base_url' is required",
      status: 400,
      code: "invalid_request_error",
      param: "base_url",
    });
  }

  const transportRaw = raw.transport === undefined || raw.transport === null
    ? baseUrl.startsWith("https://")
      ? "https"
      : "http"
    : String(raw.transport).trim().toLowerCase();
  if (!TRANSPORTS.includes(transportRaw as TransportKind)) {
    throw new GatewayError({
      message: `Unknown transport "${transportRaw}". Allowed: ${TRANSPORTS.join(", ")}`,
      status: 400,
      code: "invalid_request_error",
      param: "transport",
    });
  }
  const transport = transportRaw as TransportKind;
  if (transport === "ws") {
    throw new GatewayError({
      message: "WebSocket is not an inference transport in this gateway; use http or uds",
      status: 501,
      code: "unsupported_transport",
      param: "transport",
    });
  }

  if (transport === "uds") {
    if (!raw.socket_path) {
      throw new GatewayError({
        message: "transport 'uds' requires 'socket_path'",
        status: 400,
        code: "invalid_request_error",
        param: "socket_path",
      });
    }
  } else {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new GatewayError({
        message: `base_url "${baseUrl}" is not a valid URL`,
        status: 400,
        code: "invalid_request_error",
        param: "base_url",
      });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new GatewayError({
        message: `base_url must use http or https, got "${parsed.protocol}"`,
        status: 400,
        code: "invalid_request_error",
        param: "base_url",
      });
    }
  }

  const rawId = (raw.id ?? fallbackId ?? "").trim();
  let id = normalizeProviderId(rawId);
  if (!id) {
    const parsed = transport === "uds" ? null : new URL(baseUrl);
    const host = parsed?.hostname.replace(/[^a-z0-9]+/gi, "-") ?? "socket";
    const port = parsed?.port || (transport === "uds" ? "uds" : "80");
    id = normalizeProviderId(`${kind}-${host}-${port}`);
  }
  if (!id) {
    throw new GatewayError({
      message: "Provider id normalizes to an empty string",
      status: 400,
      code: "invalid_request_error",
      param: "id",
    });
  }

  const apiKeyEnv = raw.api_key_env ? String(raw.api_key_env).trim() : null;
  if (apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
    throw new GatewayError({
      message: "api_key_env must be an environment variable NAME (A-Z, 0-9, _), never the secret itself",
      status: 400,
      code: "invalid_request_error",
      param: "api_key_env",
    });
  }

  const timeoutMs = raw.timeout_ms === undefined ? 300_000 : Number(raw.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new GatewayError({
      message: "timeout_ms must be an integer >= 1000",
      status: 400,
      code: "invalid_request_error",
      param: "timeout_ms",
    });
  }

  const extra = asObject(raw.extra);
  if (Buffer.byteLength(JSON.stringify(extra)) > MAX_EXTRA_BYTES) {
    throw new GatewayError({
      message: `extra exceeds ${MAX_EXTRA_BYTES} bytes`,
      status: 400,
      code: "invalid_request_error",
      param: "extra",
    });
  }

  const headers = stringRecord(raw.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || /[\r\n]/.test(value)) {
      throw new GatewayError({
        message: `Invalid header "${key}"`,
        status: 400,
        code: "invalid_request_error",
        param: "headers",
      });
    }
  }

  return {
    id,
    kind,
    baseUrl,
    transport,
    socketPath: raw.socket_path ? String(raw.socket_path) : null,
    apiKey: apiKeyEnv ? process.env[apiKeyEnv] ?? null : null,
    apiKeyEnv,
    headers,
    models: asStringArray(raw.models),
    caps: asStringArray(raw.caps),
    timeoutMs,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    source: "admin",
    notes: raw.notes ? String(raw.notes) : null,
    extra,
  };
}

export class ProviderRegistry {
  /** Mutated in place so chat handlers always see the current set. */
  readonly map = new Map<string, ProviderConfig>();

  load(): void {
    this.map.clear();
    const rows = queryAll<ProviderRow>("SELECT * FROM providers ORDER BY id");
    for (const row of rows) {
      const config = toConfig(row);
      this.map.set(config.id, config);
    }
  }

  /** Environment is a seed floor, not an override of admin intent. */
  seed(configs: ProviderConfig[]): void {
    for (const config of configs) {
      execute(
        `INSERT INTO providers (
           id, kind, base_url, transport, socket_path, api_key_ref, enabled,
           declared_caps, created_at, config_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           base_url = excluded.base_url,
           transport = excluded.transport,
           socket_path = excluded.socket_path,
           api_key_ref = excluded.api_key_ref,
           declared_caps = excluded.declared_caps,
           config_json = excluded.config_json
         WHERE providers.config_json = '{}' OR providers.config_json LIKE '%"source":"env"%'`,
        config.id,
        config.kind,
        config.baseUrl,
        config.transport,
        config.socketPath,
        config.apiKeyEnv,
        1,
        JSON.stringify(config.caps),
        nowIso(),
        configJson(config),
      );
    }
    this.load();
  }

  list(includeDisabled = false): ProviderConfig[] {
    const all = [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
    return includeDisabled ? all : all.filter((provider) => provider.enabled);
  }

  get(id: string): ProviderConfig | undefined {
    return this.map.get(id);
  }

  require(id: string): ProviderConfig {
    const provider = this.map.get(id);
    if (!provider) {
      throw new GatewayError({
        message: `Provider "${id}" is not registered`,
        status: 404,
        code: "provider_not_found",
        param: "provider",
      });
    }
    return provider;
  }

  create(raw: ProviderInput): ProviderConfig {
    const config = validate(raw);
    if (queryOne<{ id: string }>("SELECT id FROM providers WHERE id = ?", config.id)) {
      throw new GatewayError({
        message: `Provider "${config.id}" already exists; use PATCH /admin/providers/${config.id}`,
        status: 409,
        code: "provider_exists",
        param: "id",
      });
    }
    this.persist(config);
    this.map.set(config.id, config);
    return config;
  }

  update(id: string, patch: Partial<ProviderInput>): ProviderConfig {
    const current = this.require(id);
    const merged: ProviderInput = {
      id: current.id,
      kind: patch.kind ?? current.kind,
      base_url: patch.base_url ?? current.baseUrl,
      transport: patch.transport ?? current.transport,
      socket_path: patch.socket_path === undefined ? current.socketPath : patch.socket_path,
      api_key_env:
        patch.api_key_env === undefined ? current.apiKeyEnv : patch.api_key_env,
      headers: patch.headers ?? current.headers,
      models: patch.models ?? current.models,
      caps: patch.caps ?? current.caps,
      timeout_ms: patch.timeout_ms ?? current.timeoutMs,
      enabled: patch.enabled ?? current.enabled,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      extra: patch.extra ?? current.extra,
    };
    const config = validate(merged, id);
    config.source = current.source;
    this.persist(config);
    this.map.set(config.id, config);
    return config;
  }

  setEnabled(id: string, enabled: boolean): ProviderConfig {
    const current = this.require(id);
    execute("UPDATE providers SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
    const next: ProviderConfig = { ...current, enabled };
    this.map.set(id, next);
    return next;
  }

  remove(id: string, purge: boolean): void {
    this.require(id);
    if (purge) {
      execute("DELETE FROM providers WHERE id = ?", id);
    } else {
      execute("UPDATE providers SET enabled = 0 WHERE id = ?", id);
    }
    this.map.delete(id);
  }

  private persist(config: ProviderConfig): void {
    execute(
      `INSERT INTO providers (
         id, kind, base_url, transport, socket_path, api_key_ref, enabled,
         declared_caps, created_at, config_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         base_url = excluded.base_url,
         transport = excluded.transport,
         socket_path = excluded.socket_path,
         api_key_ref = excluded.api_key_ref,
         enabled = excluded.enabled,
         declared_caps = excluded.declared_caps,
         config_json = excluded.config_json`,
      config.id,
      config.kind,
      config.baseUrl,
      config.transport,
      config.socketPath,
      config.apiKeyEnv,
      config.enabled ? 1 : 0,
      JSON.stringify(config.caps),
      nowIso(),
      configJson(config),
    );
  }
}
