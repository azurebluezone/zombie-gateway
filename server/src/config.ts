/**
 * Environment-driven provider registry.
 *
 * Grammar: CP_<ID>_<FIELD>
 *   BASE_URL | KIND | TRANSPORT | SOCKET | API_KEY | MODELS | CAPS | TIMEOUT_MS | HEADERS
 *
 * The <ID> segment is normalized into the public provider id and is stable for the
 * lifetime of the process. It is the namespace used for model ids ("<provider>/<model>"),
 * for the SQLite catalog and for the session log.
 */

import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SanitizeMode } from "./core/sanitize.ts";
import type { PolicyMode } from "./core/policy.ts";

/**
 * Package root, not the process working directory. Relative paths in the
 * environment resolve here, so `node dist/index.js` behaves the same when it is
 * started from /, from server/, or from a systemd unit with no WorkingDirectory.
 */
const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type ProviderKind = "ollama" | "llamacpp" | "openai" | "opencode";
export type TransportKind = "http" | "https" | "uds" | "ws";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  transport: TransportKind;
  socketPath: string | null;
  /** Resolved secret, never persisted. */
  apiKey: string | null;
  /** Name of the environment variable that holds the secret. Persisted. */
  apiKeyEnv: string | null;
  headers: Record<string, string>;
  models: string[];
  caps: string[];
  timeoutMs: number;
  enabled: boolean;
  /** Where the row came from: environment seed or admin API. */
  source: "env" | "admin";
  notes: string | null;
  /** Free-form provider metadata, stored as JSON so the table never grows. */
  extra: Record<string, unknown>;
}

export interface GatewayConfig {
  host: string;
  /** TCP port from GATEWAY_PORT; null when only a Unix socket is configured. */
  port: number | null;
  /**
   * Path of an additional Unix domain socket (or Windows named pipe). Empty
   * means TCP only. Node has no cross-platform "named pipe" path, so the value
   * is used verbatim and validated at listen time.
   */
  socketPath: string;
  /** Permission bits for the socket file (ignored on Windows). */
  socketMode: number;
  dbPath: string;
  logPath: string;
  /** Per-request audit trail (one JSON line per HTTP request, success or failure). */
  accessLogPath: string;
  syncIntervalMs: number;
  bodyLimitBytes: number;
  logPrompts: boolean;
  /** When false the admin surface is open even if a token is configured. */
  adminAuth: boolean;
  adminToken: string | null;
  /** Empty array means wildcard. Use "null" for a file:// page origin. */
  adminOrigins: string[];
  identityHeaders: boolean;
  identityFile: string;
  /** Prompt hygiene: strip carriers, report only, or leave untouched. */
  sanitize: SanitizeMode;
  /** Refuse requests that cannot fit the model's context window. */
  contextEnforce: boolean;
  /** Fixed output reserve; null derives it from the model window. */
  outputReserve: number | null;
  /** Behaviour layer: on, off, or auto (on only when the file exists). */
  policy: PolicyMode;
  /** Empty means the bundled server/policy.md. */
  policyFile: string;
  providers: ProviderConfig[];
}

const FIELD_RE = /_(BASE_URL|KIND|TRANSPORT|SOCKET|API_KEY|MODELS|CAPS|TIMEOUT_MS|HEADERS)$/;
const PREFIX = "CP_";

const KIND_ALIASES: Array<{ prefix: string; kind: ProviderKind }> = [
  { prefix: "LLAMA_CPP", kind: "llamacpp" },
  { prefix: "LLAMACPP", kind: "llamacpp" },
  { prefix: "OLLAMA", kind: "ollama" },
  { prefix: "OPENCODE", kind: "opencode" },
];

export function normalizeProviderId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeModelId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[/:]+/g, "-");
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CP_*_HEADERS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CP_*_HEADERS must be a JSON object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function readKind(raw: string | undefined, id: string, baseUrl: string): ProviderKind {
  if (raw) {
    const kind = raw.trim().toLowerCase();
    if (kind === "ollama" || kind === "llamacpp" || kind === "openai" || kind === "opencode") {
      return kind;
    }
    throw new Error(`Unknown CP_*_KIND for provider "${id}": ${raw}`);
  }
  const alias = KIND_ALIASES.find((entry) => entry.prefix === id.replace(/-/g, "_").toUpperCase());
  if (alias) return alias.kind;
  if (baseUrl.includes(":11434")) return "ollama";
  if (baseUrl.includes(":8080")) return "llamacpp";
  return "openai";
}

function readTransport(raw: string | undefined, baseUrl: string): TransportKind {
  if (!raw) return baseUrl.startsWith("https://") ? "https" : "http";
  const transport = raw.trim().toLowerCase();
  if (transport === "http" || transport === "https" || transport === "uds" || transport === "ws") {
    return transport;
  }
  throw new Error(`Unknown CP_*_TRANSPORT: ${raw}`);
}

function readTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number.parseInt(raw, 10);
  // A silent fallback here is the same trap as GATEWAY_SANITIZE=offf: the
  // operator believes a 1 s timeout is in force while the socket waits 5 min.
  if (!Number.isFinite(value) || value < 1_000) {
    throw new Error(`CP_*_TIMEOUT_MS must be an integer >= 1000 (got "${raw}")`);
  }
  return value;
}

/**
 * Collects every CP_<ID>_* group from the environment.
 * A group exists only when BASE_URL is present, which prevents half-configured
 * providers from silently entering the catalog.
 */
export function readProviderConfigs(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const groups = new Map<string, Record<string, string>>();

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || typeof value !== "string") continue;
    const rest = key.slice(PREFIX.length);
    const match = FIELD_RE.exec(rest);
    if (!match) continue;
    const rawId = rest.slice(0, match.index);
    if (!rawId) continue;
    const field = match[1] as string;
    const bucket = groups.get(rawId) ?? {};
    bucket[field] = value;
    groups.set(rawId, bucket);
  }

  const providers: ProviderConfig[] = [];
  const seen = new Map<string, string>();

  for (const [rawId, fields] of groups) {
    const baseUrl = fields["BASE_URL"];
    if (!baseUrl) continue;
    const id = normalizeProviderId(rawId);
    if (!id) throw new Error(`Provider id "${rawId}" normalizes to an empty string`);

    const duplicate = seen.get(id);
    if (duplicate) {
      throw new Error(
        `Provider id collision: "${duplicate}" and "${rawId}" both normalize to "${id}"`,
      );
    }
    seen.set(id, rawId);

    const transport = readTransport(fields["TRANSPORT"], baseUrl);
    const socketPath = fields["SOCKET"] ?? null;
    if (transport === "uds" && !socketPath) {
      throw new Error(`Provider "${id}" uses uds transport without CP_${rawId}_SOCKET`);
    }

    providers.push({
      id,
      kind: readKind(fields["KIND"], id, baseUrl),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      transport,
      socketPath,
      apiKey: fields["API_KEY"] ? fields["API_KEY"] : null,
      apiKeyEnv: fields["API_KEY"] ? `${PREFIX}${rawId}_API_KEY` : null,
      headers: parseHeaders(fields["HEADERS"]),
      models: splitList(fields["MODELS"]),
      caps: splitList(fields["CAPS"]),
      timeoutMs: readTimeout(fields["TIMEOUT_MS"]),
      enabled: true,
      source: "env",
      notes: null,
      extra: {},
    });
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  return providers;
}

function readInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Ports come from the environment and nowhere else. There is deliberately no
 * default: a gateway that silently picks 5252 when GATEWAY_PORT is missing can
 * collide with an unrelated service, and the operator never sees why.
 *
 * An empty value means "no TCP listener" (socket-only deployments). Anything
 * else must be a whole number in 1..65535; `readInt`'s tolerant fallback would
 * turn a typo like `GATEWAY_PORT=52x2` into a random port, so this reads
 * strictly and throws.
 */
function readPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`GATEWAY_PORT must be an integer 1..65535, got "${raw}"`);
  }
  const port = Number(text);
  if (port < 1 || port > 65_535) {
    throw new Error(`GATEWAY_PORT must be an integer 1..65535, got "${raw}"`);
  }
  return port;
}

/**
 * The one directory default: everything the gateway writes lives under it
 * unless GATEWAY_DB / GATEWAY_LOG say otherwise. Relative values in the
 * environment resolve against the package root, never the process cwd, so
 * `node dist/index.js` from / and `npm start` from server/ share one database.
 */
function dataDirFrom(env: NodeJS.ProcessEnv): string {
  const raw = (env["GATEWAY_DATA_DIR"] || "").trim();
  if (raw === "") return join(SERVER_ROOT, "data");
  return isAbsolute(raw) ? raw : resolve(SERVER_ROOT, raw);
}

function resolveConfiguredPath(
  env: NodeJS.ProcessEnv,
  raw: string | undefined,
  fallbackName: string,
): string {
  const value = (raw || "").trim();
  if (value === "") return join(dataDirFrom(env), fallbackName);
  return isAbsolute(value) ? value : resolve(SERVER_ROOT, value);
}

/** Same rule for optional files (identity, policy): empty stays empty. */
function resolveOptionalPath(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (value === "") return "";
  return isAbsolute(value) ? value : resolve(SERVER_ROOT, value);
}

/**
 * Socket permission bits, written as octal ("660" or "0o660"). A socket that is
 * world-writable would let any local user spend the API budget; a mode that is
 * not a file mode is a boot error rather than a silent 0660.
 */
function readSocketMode(raw: string | undefined): number {
  if (!raw || raw.trim() === "") return 0o660;
  const value = Number.parseInt(raw.trim().replace(/^0o/i, ""), 8);
  if (!Number.isFinite(value) || value < 0o600 || value > 0o777) {
    throw new Error(`GATEWAY_SOCKET_MODE must be octal 600..777, got "${raw}"`);
  }
  return value;
}

function readBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function readOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A typo must fail at boot, not silently keep stripping. "off" is the dangerous
 * value here: if someone writes "offf" and it falls back to "strip", the
 * operator believes carriers are untouched while the gateway removes them.
 */
function readSanitizeMode(raw: string | undefined): SanitizeMode {
  if (raw === undefined || raw.trim() === "") return "strip";
  const value = raw.trim().toLowerCase();
  if (value === "off" || value === "report" || value === "strip") return value;
  throw new Error(`Unknown GATEWAY_SANITIZE mode "${raw}" (expected off, report or strip)`);
}

function readOutputReserve(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Same rule as GATEWAY_SANITIZE: a typo fails at boot. "auto" is the default so
 * a checkout without server/policy.md still starts, and the log says why the
 * layer is off instead of pretending it is on.
 */
function readPolicyMode(raw: string | undefined): PolicyMode {
  if (raw === undefined || raw.trim() === "") return "auto";
  const value = raw.trim().toLowerCase();
  if (value === "on" || value === "off" || value === "auto") return value;
  throw new Error(`Unknown GATEWAY_POLICY mode "${raw}" (expected on, off or auto)`);
}

export function readGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const adminToken = env["GATEWAY_ADMIN_TOKEN"] || null;
  const explicitAuth = readBoolean(env["GATEWAY_ADMIN_AUTH"]);
  // Default keeps the previous behaviour: a configured token means enforcement.
  const adminAuth = explicitAuth === null ? adminToken !== null : explicitAuth;

  if (adminAuth && !adminToken) {
    throw new Error("GATEWAY_ADMIN_AUTH is enabled but GATEWAY_ADMIN_TOKEN is empty");
  }

  const port = readPort(env["GATEWAY_PORT"]);
  const socketPath = (env["GATEWAY_SOCKET"] || "").trim();
  if (port === null && socketPath === "") {
    throw new Error(
      "No listener configured: set GATEWAY_PORT (TCP) and/or GATEWAY_SOCKET (Unix socket). " +
        "`npm run setup` writes server/.env from .env.example.",
    );
  }

  return {
    host: env["GATEWAY_HOST"] || "127.0.0.1",
    port,
    socketPath,
    socketMode: readSocketMode(env["GATEWAY_SOCKET_MODE"]),
    dbPath: resolveConfiguredPath(env, env["GATEWAY_DB"], "gateway.db"),
    logPath: resolveConfiguredPath(env, env["GATEWAY_LOG"], "gateway.jsonl"),
    accessLogPath: resolveConfiguredPath(env, env["GATEWAY_ACCESS_LOG"], "access.jsonl"),
    syncIntervalMs: readInt(env["GATEWAY_SYNC_INTERVAL_MS"], 300_000),
    bodyLimitBytes: readInt(env["GATEWAY_BODY_LIMIT_BYTES"], 33_554_432),
    logPrompts: env["GATEWAY_LOG_PROMPTS"] === "1",
    adminAuth,
    adminToken,
    adminOrigins: readOrigins(env["GATEWAY_ADMIN_ORIGINS"]),
    identityHeaders: env["GATEWAY_IDENTITY_HEADERS"] !== "0",
    identityFile: resolveOptionalPath(env["GATEWAY_IDENTITY_FILE"]),
    // Default strip: a carrier that reaches the engine has already done its job.
    sanitize: readSanitizeMode(env["GATEWAY_SANITIZE"]),
    contextEnforce: readBoolean(env["GATEWAY_CONTEXT_ENFORCE"]) ?? true,
    outputReserve: readOutputReserve(env["GATEWAY_OUTPUT_RESERVE"]),
    policy: readPolicyMode(env["GATEWAY_POLICY"]),
    policyFile: resolveOptionalPath(env["GATEWAY_POLICY_FILE"]),
    providers: readProviderConfigs(env),
  };
}
