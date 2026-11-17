/**
 * Admin API.
 *
 * Rules of this surface:
 *  - JSON only. No HTML, no websocket, no server-rendered form: every operation
 *    is one HTTP call that a terminal can issue with curl.
 *  - Self-describing. GET /admin/routes and GET /admin/providers/schema are the
 *    contract, so an external panel (any host, any language) needs no code from
 *    this repository to build its own form.
 *  - Read models from the DB, not from a second in-memory copy: the metrics are
 *    the request log, so they cannot drift from reality.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../core/chat.ts";
import { fullModelId, listPublicModels, resolveModel, syncProvider } from "../core/catalog.ts";
import { execute, queryAll, queryOne } from "../core/db.ts";
import { GatewayError } from "../core/errors.ts";
import { logEvent } from "../core/logger.ts";
import { collectMetrics, modelRuntimeStats, recentRequests } from "../core/metrics.ts";
import type { ProviderConfig } from "../config.ts";
import { json, readJson } from "../core/respond.ts";
import { providerSchema } from "./schema.ts";
import { openUpstream, probeJson, readBody } from "../transport/request.ts";
import { snapshotMcpSessions } from "../mcp/http.ts";
import { TOOL_NAMES } from "../../scripts/mcp-tools.mjs";

const ADMIN_BODY_LIMIT = 1024 * 1024;
const startedAt = Date.now();
let syncInFlight = false;

interface RouteDoc {
  method: string;
  path: string;
  purpose: string;
  body?: Record<string, string>;
  query?: Record<string, string>;
}

const ROUTES: RouteDoc[] = [
  { method: "GET", path: "/health", purpose: "Gateway liveness and current provider/model counts." },
  { method: "GET", path: "/healthz", purpose: "Health-check alias." },
  { method: "GET", path: "/", purpose: "Redirect to the admin dashboard." },
  { method: "GET", path: "/admin/ui", purpose: "Admin dashboard HTML." },
  { method: "GET", path: "/dashboard", purpose: "Admin dashboard alias." },
  { method: "GET", path: "/v1/models", purpose: "OpenAI model catalogue; ids are provider/model." },
  { method: "GET", path: "/v1/providers", purpose: "Enabled provider catalogue." },
  { method: "POST", path: "/v1/chat/completions", purpose: "OpenAI chat completions; set stream=true for SSE.", body: { model: "provider/model", messages: "[{role:user,content:Hello}]", stream: "false" } },
  { method: "POST", path: "/v1/messages", purpose: "Anthropic Messages API translated to the selected provider.", body: { model: "provider/model", max_tokens: "256", messages: "[{role:user,content:Hello}]" } },
  { method: "POST", path: "/v1/messages/count_tokens", purpose: "Estimate input tokens without an upstream request.", body: { model: "provider/model", messages: "[{role:user,content:Hello}]" } },
  { method: "POST", path: "/v1/embeddings", purpose: "OpenAI embeddings passthrough; provider must declare embeddings.", body: { model: "provider/model", input: "text to embed" } },
  { method: "POST", path: "/chat/completions", purpose: "OpenAI chat completions alias.", body: { model: "provider/model", messages: "[{role:user,content:Hello}]", stream: "false" } },
  { method: "POST", path: "/messages", purpose: "Anthropic Messages API alias.", body: { model: "provider/model", max_tokens: "256", messages: "[{role:user,content:Hello}]" } },
  { method: "POST", path: "/messages/count_tokens", purpose: "Anthropic token estimate alias.", body: { model: "provider/model", messages: "[{role:user,content:Hello}]" } },
  { method: "POST", path: "/embeddings", purpose: "OpenAI embeddings alias.", body: { model: "provider/model", input: "text to embed" } },
  { method: "GET", path: "/admin/routes", purpose: "This index: every admin operation and its payload." },
  { method: "GET", path: "/admin/system", purpose: "Identity, database path, uptime, counts, identity hash." },
  { method: "GET", path: "/admin/providers", purpose: "All providers, including disabled ones.", query: { enabled: "1|0" } },
  { method: "GET", path: "/admin/providers/schema", purpose: "Field spec + curl-ready examples for provider creation." },
  { method: "POST", path: "/admin/providers", purpose: "Create a provider (DB row + live registry).", body: { kind: "enum", base_url: "url", id: "optional" } },
  { method: "GET", path: "/admin/providers/:id", purpose: "One provider with probe state and model count." },
  { method: "PATCH", path: "/admin/providers/:id", purpose: "Partial update; omitted fields keep their value." },
  { method: "DELETE", path: "/admin/providers/:id", purpose: "Disable (default) or purge with ?purge=1.", query: { purge: "1" } },
  { method: "POST", path: "/admin/providers/:id/enable", purpose: "Re-enable a disabled provider." },
  { method: "POST", path: "/admin/providers/:id/disable", purpose: "Hide its models without deleting rows." },
  { method: "POST", path: "/admin/providers/:id/sync", purpose: "Discover that provider's models now." },
  { method: "POST", path: "/admin/sync", purpose: "Discover every enabled provider." },
  { method: "GET", path: "/admin/models", purpose: "Catalogue with provider state.", query: { provider: "id", include_disabled: "1" } },
  { method: "GET", path: "/admin/users", purpose: "List issued gateway users and quota usage." },
  { method: "POST", path: "/admin/users", purpose: "Create a user and issue an API key (returned once).", body: { username: "name", starts_at: "ISO date", expires_at: "ISO date|null", context_limit: "tokens|null", token_limit: "tokens|null", role: "inference|read_only" } },
  { method: "GET", path: "/admin/users/:id", purpose: "Usage detail for one API user." },
  { method: "DELETE", path: "/admin/users/:id", purpose: "Permanently delete a user and revoke its key." },
  { method: "GET", path: "/admin/auth", purpose: "Admin auth switch and registered key metadata." },
  { method: "POST", path: "/admin/auth", purpose: "Toggle optional DB-backed admin-key enforcement.", body: { enabled: "boolean" } },
  { method: "GET", path: "/admin/admin-keys", purpose: "List admin keys (hashes/secrets never returned)." },
  { method: "POST", path: "/admin/admin-keys", purpose: "Create or import an admin API key; returned once.", body: { name: "label", api_key: "optional existing secret" } },
  { method: "DELETE", path: "/admin/admin-keys/:id", purpose: "Revoke an admin API key." },
  { method: "PATCH", path: "/admin/models/context", purpose: "Set or clear a model context window (tokens).", body: { model: "provider/model", context_length: "integer|null" } },
  { method: "PATCH", path: "/admin/models/status", purpose: "Enable or disable a catalogue model.", body: { model: "provider/model", enabled: "boolean" } },
  { method: "POST", path: "/admin/models/load", purpose: "Warm a model into RAM (ollama only).", body: { model: "provider/model", keep_alive: "30m" } },
  { method: "POST", path: "/admin/models/unload", purpose: "Drop a model from RAM (ollama only).", body: { model: "provider/model" } },
  { method: "GET", path: "/admin/runtime", purpose: "Live reachability and loaded models per provider." },
  { method: "GET", path: "/admin/metrics", purpose: "Window aggregates: totals, per provider, per model, per minute.", query: { window_ms: "3600000" } },
  { method: "GET", path: "/admin/requests", purpose: "Most recent request log rows.", query: { limit: "20", provider: "id" } },
  { method: "GET", path: "/admin/sessions", purpose: "Admin panel sessions (one row per WebSocket handshake), newest first.", query: { limit: "50", open: "1" } },
  { method: "GET", path: "/admin/model-stats", purpose: "Per-model runtime: calls, errors, avg/max latency, tokens, last request.", query: { window_ms: "3600000" } },
  { method: "GET", path: "/admin/mcp", purpose: "MCP enabled state and tool-call totals." },
  { method: "GET", path: "/admin/mcp/sessions", purpose: "Connected MCP clients, protocol, transport and request counts." },
  { method: "POST", path: "/admin/mcp", purpose: "Enable/disable MCP tool calls.", body: { enabled: "boolean" } },
  { method: "POST", path: "/admin/mcp/calls", purpose: "Record a completed MCP tool call.", body: { tool: "tool-name", status: "success|error", duration_ms: "integer" } },
  { method: "GET", path: "/admin/logs", purpose: "Tail one server log file. Whitelisted names only.", query: { file: "access|gateway|llama-server|llama-model", limit: "200" } },
  { method: "GET", path: "/admin/metrics/ws", purpose: "Realtime metrics over WebSocket (also /admin/ws). Text frames only; first frame is a snapshot." },
];

function authorized(ctx: AppContext, req: IncomingMessage): boolean {
  const setting = queryOne<{ value: string }>("SELECT value FROM gateway_settings WHERE key = 'admin_auth_enabled'");
  const required = ctx.config.adminAuth || setting?.value === "true";
  if (!required) return true;
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
  const direct = req.headers["x-admin-token"];
  const supplied = bearer ?? (typeof direct === "string" ? direct : null);
  if (!supplied) return false;
  if (ctx.config.adminToken && supplied === ctx.config.adminToken) return true;
  const hash = createHash("sha256").update(supplied).digest("hex");
  const key = queryOne<{ id: string }>("SELECT id FROM admin_api_keys WHERE key_hash = ? AND enabled = 1", hash);
  if (!key) return false;
  execute("UPDATE admin_api_keys SET last_used_at = ? WHERE id = ?", new Date().toISOString(), key.id);
  return true;
}

function intParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function providerView(ctx: AppContext, provider: ProviderConfig): Record<string, unknown> {
  const row = queryOne<{
    last_error: string | null;
    last_probe_at: string | null;
    server_version: string | null;
  }>("SELECT last_error, last_probe_at, server_version FROM providers WHERE id = ?", provider.id);

  const count = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM models WHERE provider_id = ? AND active = 1",
    provider.id,
  );
  const configured = ctx.providers.has(provider.id);

  return {
    id: provider.id,
    kind: provider.kind,
    transport: provider.transport,
    base_url: provider.baseUrl,
    socket_path: provider.socketPath,
    api_key_env: provider.apiKeyEnv,
    default_context_length: provider.defaultContextLength,
    authenticated: provider.apiKey !== null,
    enabled: provider.enabled,
    source: provider.source,
    caps: provider.caps,
    declared_models: provider.models,
    headers: provider.headers,
    timeout_ms: provider.timeoutMs,
    notes: provider.notes,
    extra: provider.extra,
    active_models: count?.n ?? 0,
    loaded: configured,
    last_error: row?.last_error ?? null,
    last_probe_at: row?.last_probe_at ?? null,
    server_version: row?.server_version ?? null,
  };
}

function providerById(ctx: AppContext, id: string): ProviderConfig {
  const provider = ctx.registry.require(id);
  return provider;
}

async function warm(
  ctx: AppContext,
  modelRef: string,
  action: "load" | "unload",
  keepAlive: string,
): Promise<Record<string, unknown>> {
  const resolved = resolveModel(modelRef);
  const provider = ctx.registry.require(resolved.providerId);

  if (provider.kind !== "ollama") {
    throw new GatewayError({
      message:
        `Residency control needs the native /api/generate endpoint of kind=ollama. ` +
        `Provider "${provider.id}" is kind=${provider.kind} and only exposes its own API root, ` +
        `so load/unload is not available through this gateway.`,
      status: 501,
      code: "unsupported",
      providerId: provider.id,
    });
  }

  const body = JSON.stringify({
    model: resolved.upstreamId,
    keep_alive: action === "load" ? keepAlive : 0,
  });

  const upstream = await openUpstream(provider, {
    method: "POST",
    path: "/api/generate",
    body,
    accept: "application/json",
  });
  const raw = await readBody(upstream.body, 1024 * 1024);

  if (upstream.status >= 400) {
    throw new GatewayError({
      message: `Provider "${provider.id}" rejected ${action}: HTTP ${upstream.status} ${raw.slice(0, 200)}`,
      status: 502,
      code: "provider_error",
      providerId: provider.id,
    });
  }

  return {
    action,
    model: fullModelId(resolved.providerId, resolved.modelId),
    upstream_model: resolved.upstreamId,
    keep_alive: action === "load" ? keepAlive : 0,
    provider_status: upstream.status,
  };
}

/**
 * Tail a log file without loading an 8 MiB file into memory: read at most the
 * last 512 KiB, then keep the last `limit` complete lines. Only files named in
 * the whitelist reach this function, so a query string cannot walk the disk.
 */
function tailLog(file: string, name: string, limit: number): Record<string, unknown> {
  const WINDOW = 512 * 1024;
  let size = 0;
  let mtime: string | null = null;
  try {
    const stat = statSync(file);
    size = stat.size;
    mtime = stat.mtime.toISOString();
  } catch {
    return { object: "log.tail", file: name, path: file, bytes: 0, mtime: null, lines: [], missing: true };
  }
  const start = Math.max(0, size - WINDOW);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (start > 0) lines.shift(); // a partial first line is not a record
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return {
    object: "log.tail",
    file: name,
    path: file,
    bytes: size,
    mtime,
    total_window_bytes: length,
    lines: lines.slice(-limit),
  };
}

async function runtimeFor(provider: ProviderConfig): Promise<Record<string, unknown>> {
  const base = { id: provider.id, kind: provider.kind, enabled: provider.enabled, transport: provider.transport };

  try {
    if (provider.kind === "ollama") {
      const ps = await probeJson(provider, "/api/ps");
      const models = asArray(asRecord(ps.json)["models"]).map((entry) => {
        const record = asRecord(entry);
        return {
          model: record["model"] ?? record["name"] ?? null,
          size_bytes: record["size"] ?? null,
          expires_at: record["expires_at"] ?? null,
        };
      });
      return { ...base, reachable: ps.status === 200, status: ps.status, loaded_models: models };
    }

    if (provider.kind === "llamacpp") {
      const health = await probeJson(provider, "/health");
      const props = health.status === 200 ? await probeJson(provider, "/props") : null;
      const propsBody = asRecord(props?.json);
      return {
        ...base,
        reachable: health.status === 200,
        status: health.status,
        // The alias is what the gateway publishes; model_path is a filesystem
        // detail (a HF cache symlink here) and is not a model identifier.
        model_alias: propsBody["model_alias"] ?? null,
        model_path: propsBody["model_path"] ?? null,
        quantization: propsBody["model_ftype"] ?? null,
        n_ctx: asRecord(propsBody["default_generation_settings"])["n_ctx"] ?? null,
        n_slots: propsBody["total_slots"] ?? null,
        build_info: propsBody["build_info"] ?? null,
      };
    }

    const models = await probeJson(provider, "/models");
    const count = asArray(asRecord(models.json)["data"]).length;
    return { ...base, reachable: models.status === 200, status: models.status, model_count: count };
  } catch (error) {
    return {
      ...base,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleAdmin(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
  if (path !== "/admin" && !path.startsWith("/admin/")) return false;

  if (!authorized(ctx, req)) {
    json(res, 401, {
      error: {
        message: "Admin token required: send Authorization: Bearer <GATEWAY_ADMIN_TOKEN>",
        type: "authentication_error",
        code: "unauthorized",
      },
    });
    return true;
  }

  const method = req.method ?? "GET";
  const segments = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/admin/routes") {
    json(res, 200, { object: "list", data: ROUTES });
    return true;
  }

  if (method === "GET" && path === "/admin/system") {
    const dbAuth = queryOne<{ value: string }>("SELECT value FROM gateway_settings WHERE key='admin_auth_enabled'");
    json(res, 200, {
      object: "system",
      identity: ctx.identity.identity,
      identity_file: ctx.identity.source,
      identity_sha256: ctx.identity.sha256,
      identity_valid: ctx.identity.valid,
      identity_headers: ctx.config.identityHeaders,
      host: ctx.config.host,
      port: ctx.config.port,
      database: ctx.config.dbPath,
      uptime_ms: Date.now() - startedAt,
      providers: ctx.registry.list(true).length,
      providers_enabled: ctx.registry.list().length,
      models: listPublicModels().length,
      admin_auth: ctx.config.adminAuth || dbAuth?.value === "true",
      admin_token_configured: ctx.config.adminToken !== null,
      admin_token_required: ctx.config.adminAuth || dbAuth?.value === "true",
      user_auth: ctx.config.userAuth,
      admin_origins: ctx.config.adminOrigins,
      sanitize: ctx.config.sanitize,
      context_enforce: ctx.config.contextEnforce,
      output_reserve: ctx.config.outputReserve,
      policy: {
        enabled: ctx.policy.enabled,
        mode: ctx.config.policy,
        file: ctx.policy.source,
        sha256: ctx.policy.sha256 || null,
        tokens: ctx.policy.tokens,
        reason: ctx.policy.reason,
        language: "en",
      },
      token_estimator: "chars/4 ascii, chars/2 non-ascii; never exact",
      metrics_ws: "/admin/metrics/ws",
      logs: {
        dir: dirname(ctx.config.logPath),
        gateway: ctx.config.logPath,
        access: ctx.config.accessLogPath,
        llama_server: join(dirname(ctx.config.logPath), "llama-server.jsonl"),
        llama_model: join(dirname(ctx.config.logPath), "llama-model.log"),
      },
    });
    return true;
  }

  if (method === "GET" && path === "/admin/providers/schema") {
    json(res, 200, providerSchema());
    return true;
  }

  if (path === "/admin/auth" && method === "GET") {
    const row = queryOne<{ value: string }>("SELECT value FROM gateway_settings WHERE key='admin_auth_enabled'");
    const keys = queryAll<Record<string, unknown>>("SELECT id,name,key_prefix,enabled,created_at,last_used_at FROM admin_api_keys ORDER BY created_at DESC");
    json(res, 200, { enabled: ctx.config.adminAuth || row?.value === "true", env_enforced: ctx.config.adminAuth, keys }); return true;
  }
  if (path === "/admin/auth" && method === "POST") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    if (typeof body.enabled !== "boolean") throw new GatewayError({ message: "enabled must be boolean", status: 400, code: "invalid_request_error", param: "enabled" });
    if (ctx.config.adminAuth && body.enabled === false) throw new GatewayError({ message: "Admin auth is enforced by GATEWAY_ADMIN_AUTH and cannot be disabled in the UI", status: 409, code: "invalid_request_error" });
    execute(`INSERT INTO gateway_settings(key,value,updated_at) VALUES('admin_auth_enabled',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, String(body.enabled), new Date().toISOString());
    json(res, 200, { object: "admin.auth", enabled: body.enabled || ctx.config.adminAuth, env_enforced: ctx.config.adminAuth }); return true;
  }
  if (path === "/admin/admin-keys" && method === "GET") {
    json(res, 200, { object: "list", data: queryAll("SELECT id,name,key_prefix,enabled,created_at,last_used_at FROM admin_api_keys ORDER BY created_at DESC") }); return true;
  }
  if (path === "/admin/admin-keys" && method === "POST") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const apiKey = typeof body.api_key === "string" && body.api_key ? body.api_key : `zga_${randomBytes(32).toString("base64url")}`;
    if (!name || apiKey.length < 20) throw new GatewayError({ message: "name is required and api_key must be at least 20 characters", status: 400, code: "invalid_request_error" });
    const id = randomUUID();
    execute("INSERT INTO admin_api_keys(id,name,key_hash,key_prefix,created_at) VALUES(?,?,?,?,?)", id, name, createHash("sha256").update(apiKey).digest("hex"), apiKey.slice(0,12), new Date().toISOString());
    json(res, 201, { object: "admin_api_key", id, name, api_key: apiKey, key_prefix: apiKey.slice(0,12), note: "Save this key now; it cannot be retrieved again." }); return true;
  }
  if (segments[1] === "admin-keys" && segments[2] && segments.length === 3 && method === "DELETE") {
    execute("DELETE FROM admin_api_keys WHERE id=?", decodeURIComponent(segments[2])); json(res, 200, { object: "admin_api_key.revoked", id: decodeURIComponent(segments[2]) }); return true;
  }

  if (path === "/admin/users" && method === "GET") {
    const data = queryAll<Record<string, unknown> & { id: string }>(`SELECT u.id,u.username,u.role,u.api_key_prefix,u.starts_at,u.expires_at,u.context_limit,u.token_limit,u.enabled,u.created_at,
      COALESCE(SUM(COALESCE(l.prompt_tokens,0)+COALESCE(l.completion_tokens,0)),0) AS tokens_used, COUNT(l.id) AS requests
      FROM gateway_users u LEFT JOIN request_logs l ON l.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`);
    json(res, 200, { object: "list", data }); return true;
  }
  if (segments[1] === "users" && segments[2] && segments.length === 3 && method === "GET") {
    const id = decodeURIComponent(segments[2]);
    const user = queryOne<Record<string, unknown>>("SELECT id,username,role,api_key_prefix,starts_at,expires_at,context_limit,token_limit,enabled,created_at FROM gateway_users WHERE id=?", id);
    if (!user) throw new GatewayError({ message: "User not found", status: 404, code: "invalid_request_error" });
    const providers = queryAll(`SELECT provider_id,COUNT(*) requests,SUM(CASE WHEN status<400 THEN 1 ELSE 0 END) successful,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) failed,SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) tokens FROM request_logs WHERE user_id=? AND provider_id IS NOT NULL GROUP BY provider_id ORDER BY requests DESC`, id);
    const models = queryAll(`SELECT provider_id,model_id,COUNT(*) requests,SUM(CASE WHEN status<400 THEN 1 ELSE 0 END) successful,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) failed,SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) tokens FROM request_logs WHERE user_id=? AND provider_id IS NOT NULL GROUP BY provider_id,model_id ORDER BY requests DESC`, id);
    const recent = recentRequests(50, { userId: id });
    json(res, 200, { object: "gateway_user.detail", user, providers, models, recent_requests: recent }); return true;
  }
  if (path === "/admin/users" && method === "POST") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const startsAt = typeof body.starts_at === "string" ? body.starts_at : new Date().toISOString();
    const expiresAt = typeof body.expires_at === "string" ? body.expires_at : null;
    const contextLimit = body.context_limit == null ? null : Number(body.context_limit);
    const tokenLimit = body.token_limit == null ? null : Number(body.token_limit);
    const role = body.role === "read_only" ? "read_only" : "inference";
    if (!username || !Number.isFinite(Date.parse(startsAt)) || (expiresAt && !Number.isFinite(Date.parse(expiresAt))) || [contextLimit, tokenLimit].some(v => v !== null && (!Number.isInteger(v) || v < 1))) throw new GatewayError({ message: "Provide username, valid dates, and positive integer quotas", status: 400, code: "invalid_request_error" });
    const apiKey = "zgk_" + randomBytes(32).toString("base64url");
    const id = randomUUID();
    execute(`INSERT INTO gateway_users(id,username,role,api_key_hash,api_key_prefix,starts_at,expires_at,context_limit,token_limit,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)`, id, username, role, createHash("sha256").update(apiKey).digest("hex"), apiKey.slice(0,12), startsAt, expiresAt, contextLimit, tokenLimit, new Date().toISOString());
    json(res, 201, { object: "gateway_user", id, username, role, api_key: apiKey, starts_at: startsAt, expires_at: expiresAt, context_limit: contextLimit, token_limit: tokenLimit, note: "Save this key now; it cannot be retrieved again." }); return true;
  }
  if (segments[1] === "users" && segments[2] && segments.length === 3 && method === "DELETE") {
    const result = queryOne<{ id: string }>("SELECT id FROM gateway_users WHERE id=?", decodeURIComponent(segments[2]));
    if (!result) throw new GatewayError({ message: "User not found", status: 404, code: "invalid_request_error" });
    execute("DELETE FROM gateway_users WHERE id=?", result.id); json(res, 200, { object: "gateway_user.deleted", id: result.id, deleted: true }); return true;
  }

  if (path === "/admin/providers") {
    if (method === "GET") {
      const filter = url.searchParams.get("enabled");
      const all = ctx.registry.list(true);
      const filtered =
        filter === null ? all : all.filter((provider) => provider.enabled === (filter !== "0"));
      json(res, 200, {
        object: "list",
        count: filtered.length,
        data: filtered.map((provider) => providerView(ctx, provider)),
      });
      return true;
    }

    if (method === "POST") {
      const body = await readJson(req, ADMIN_BODY_LIMIT);
      const created = ctx.registry.create(body as never);
      logEvent("info", "admin.provider_created", { provider: created.id, kind: created.kind });
      json(res, 201, { object: "provider", ...providerView(ctx, created) });
      return true;
    }
  }

  if (segments[1] === "providers" && segments[2] && segments.length >= 3 && segments.length <= 4) {
    const id = decodeURIComponent(segments[2]);

    if (segments.length === 3) {
      if (method === "GET") {
        json(res, 200, { object: "provider", ...providerView(ctx, providerById(ctx, id)) });
        return true;
      }
      if (method === "PATCH") {
        const patch = await readJson(req, ADMIN_BODY_LIMIT);
        const updated = ctx.registry.update(id, patch as never);
        logEvent("info", "admin.provider_updated", { provider: id, fields: Object.keys(patch) });
        json(res, 200, { object: "provider", ...providerView(ctx, updated) });
        return true;
      }
      if (method === "DELETE") {
        const purge = url.searchParams.get("purge") === "1";
        ctx.registry.remove(id, purge);
        logEvent("info", purge ? "admin.provider_purged" : "admin.provider_disabled", { provider: id });
        json(res, 200, { object: "provider.deleted", id, purge });
        return true;
      }
    }

    if (segments.length === 4) {
      const action = segments[3];

      if (method === "POST" && (action === "enable" || action === "disable")) {
        const updated = ctx.registry.setEnabled(id, action === "enable");
        logEvent("info", "admin.provider_toggled", { provider: id, enabled: updated.enabled });
        json(res, 200, { object: "provider", ...providerView(ctx, updated) });
        return true;
      }

      if (method === "POST" && action === "sync") {
        const provider = providerById(ctx, id);
        const report = await syncProvider(provider);
        json(res, report.ok ? 200 : 502, {
          object: "sync.report",
          ...report,
          active_models: providerView(ctx, provider).active_models,
        });
        return true;
      }
    }
  }

  if (method === "POST" && path === "/admin/sync") {
    if (syncInFlight) {
      throw new GatewayError({
        message: "A sync is already running",
        status: 409,
        code: "sync_in_progress",
      });
    }
    syncInFlight = true;
    try {
      const reports = [];
      for (const provider of ctx.registry.list()) {
        reports.push(await syncProvider(provider));
      }
      logEvent("info", "admin.sync_all", { providers: reports.length });
      json(res, 200, { object: "sync.reports", data: reports, models: listPublicModels().length });
    } finally {
      syncInFlight = false;
    }
    return true;
  }

  if (method === "GET" && path === "/admin/models") {
    const provider = url.searchParams.get("provider") ?? undefined;
    const includeDisabled = url.searchParams.get("include_disabled") === "1";
    const models = listPublicModels(provider, includeDisabled);
    const usage = queryAll<{ provider_id: string; model_id: string; requests: number; successes: number; failures: number; tokens: number }>(`SELECT provider_id,model_id,COUNT(*) requests,SUM(CASE WHEN status<400 THEN 1 ELSE 0 END) successes,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) failures,SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) tokens FROM request_logs WHERE provider_id IS NOT NULL AND model_id IS NOT NULL GROUP BY provider_id,model_id`);
    const usageByModel = new Map(usage.map((row) => [`${row.provider_id}/${row.model_id}`, row]));
    json(res, 200, {
      object: "list",
      count: models.length,
      data: models.map((model) => ({
        provider_id: model.providerId,
        model_id: model.modelId,
        full_id: model.fullId,
        upstream_id: model.upstreamId,
        display_name: model.displayName,
        caps: model.caps,
        context_length: model.contextLength,
        context_length_source: model.contextLengthSource,
        enabled: model.enabled,
        usage: usageByModel.get(model.fullId) ?? { requests: 0, successes: 0, failures: 0, tokens: 0 },
        parameter_size: model.parameterSize,
        quantization: model.quantization,
        family: model.family,
        size_bytes: model.sizeBytes,
        source: model.source,
        last_seen_at: model.lastSeenAt,
        first_seen_at: model.firstSeenAt,
        provider_enabled: ctx.registry.get(model.providerId)?.enabled ?? false,
      })),
    });
    return true;
  }

  if (method === "PATCH" && path === "/admin/models/status") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const modelRef = typeof body.model === "string" ? body.model : "";
    if (typeof body.enabled !== "boolean") throw new GatewayError({ message: "enabled must be boolean", status: 400, code: "invalid_request_error", param: "enabled" });
    const slash = modelRef.indexOf("/");
    if (slash < 1) throw new GatewayError({ message: "Use a qualified model id provider/model", status: 400, code: "invalid_request_error", param: "model" });
    const providerId = modelRef.slice(0, slash), modelId = modelRef.slice(slash + 1).toLowerCase();
    const exists = queryOne<{ model_id: string }>("SELECT model_id FROM models WHERE provider_id=? AND model_id=?", providerId, modelId);
    if (!exists) throw new GatewayError({ message: "Model not found", status: 404, code: "model_not_found" });
    execute("UPDATE models SET enabled=? WHERE provider_id=? AND model_id=?", body.enabled ? 1 : 0, providerId, modelId);
    json(res, 200, { object: "model.status", model: modelRef, enabled: body.enabled }); return true;
  }

  if (method === "PATCH" && path === "/admin/models/context") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const ref = typeof body.model === "string" ? body.model : "";
    const model = resolveModel(ref);
    const value = body.context_length === null ? null : Number(body.context_length);
    if (value !== null && (!Number.isInteger(value) || value < 1)) throw new GatewayError({ message: "context_length must be a positive integer or null", status: 400, code: "invalid_request_error", param: "context_length" });
    const exists = queryOne<{ model_id: string }>("SELECT model_id FROM models WHERE provider_id = ? AND model_id = ?", model.providerId, model.modelId);
    if (!exists) throw new GatewayError({ message: "Model not found", status: 404, code: "model_not_found" });
    execute("UPDATE models SET context_length = ?, context_length_source = ? WHERE provider_id = ? AND model_id = ?", value, value === null ? "provider" : "manual", model.providerId, model.modelId);
    json(res, 200, { object: "model.context", model: ref, context_length: value, source: "manual" });
    return true;
  }

  if (method === "POST" && (path === "/admin/models/load" || path === "/admin/models/unload")) {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const model = typeof body["model"] === "string" ? body["model"] : "";
    if (!model) {
      throw new GatewayError({
        message: "Field 'model' is required",
        status: 400,
        code: "invalid_request_error",
        param: "model",
      });
    }
    const keepAlive = typeof body["keep_alive"] === "string" ? body["keep_alive"] : "30m";
    const result = await warm(ctx, model, path.endsWith("load") ? "load" : "unload", keepAlive);
    json(res, 200, { object: "model.residency", ...result });
    return true;
  }

  if (method === "GET" && path === "/admin/runtime") {
    const providers = ctx.registry.list(true);
    const data = await Promise.all(providers.map((provider) => runtimeFor(provider)));
    json(res, 200, { object: "list", data });
    return true;
  }

  if (method === "GET" && path === "/admin/model-stats") {
    const windowMs = intParam(url.searchParams.get("window_ms"), 60 * 60 * 1000);
    const stats = modelRuntimeStats(windowMs);
    json(res, 200, {
      object: "list",
      window_ms: windowMs,
      count: stats.length,
      data: stats.map((row) => ({
        ...row,
        full_id: fullModelId(row.provider_id, row.model_id),
        avg_ms: row.avg_ms === null ? null : Math.round(row.avg_ms * 10) / 10,
      })),
    });
    return true;
  }

  if (method === "GET" && path === "/admin/logs") {
    const name = url.searchParams.get("file") ?? "access";
    const limit = Math.min(Math.max(intParam(url.searchParams.get("limit"), 200), 1), 2000);
    const logDir = dirname(ctx.config.logPath);
    const files: Record<string, string> = {
      access: ctx.config.accessLogPath,
      gateway: ctx.config.logPath,
      "llama-server": join(logDir, "llama-server.jsonl"),
      "llama-model": join(logDir, "llama-model.log"),
    };
    const file = files[name];
    if (!file) {
      throw new GatewayError({
        message: `Unknown log file "${name}". Use one of: ${Object.keys(files).join(", ")}`,
        status: 400,
        code: "invalid_request_error",
        param: "file",
      });
    }
    json(res, 200, tailLog(file, name, limit));
    return true;
  }

  if (method === "GET" && path === "/admin/metrics") {
    const windowMs = intParam(url.searchParams.get("window_ms"), 60 * 60 * 1000);
    json(res, 200, { object: "metrics", ...collectMetrics(windowMs) });
    return true;
  }

  if (path === "/admin/mcp" && method === "GET") {
    const setting = queryOne<{ value: string }>("SELECT value FROM gateway_settings WHERE key='mcp_enabled'");
    const calls = queryOne<{ count: number; failed: number }>("SELECT COUNT(*) count,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failed FROM mcp_call_logs");
    const tools = queryAll("SELECT tool_name,COUNT(*) calls,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failed,MAX(ts) last_call FROM mcp_call_logs GROUP BY tool_name ORDER BY calls DESC");
    const sessions = snapshotMcpSessions();
    json(res, 200, {
      object: "mcp.status",
      enabled: setting?.value !== "false",
      calls: calls?.count ?? 0,
      failed: calls?.failed ?? 0,
      tools,
      tools_total: TOOL_NAMES.length,
      tool_names: TOOL_NAMES,
      session_count: sessions.length,
      sessions,
    });
    return true;
  }
  if (path === "/admin/mcp/sessions" && method === "GET") {
    const sessions = snapshotMcpSessions();
    json(res, 200, {
      object: "mcp.sessions",
      count: sessions.length,
      tools_total: TOOL_NAMES.length,
      tools: TOOL_NAMES,
      sessions,
    });
    return true;
  }
  if (path === "/admin/mcp" && method === "POST") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    if (typeof body.enabled !== "boolean") throw new GatewayError({ message: "enabled must be boolean", status: 400, code: "invalid_request_error", param: "enabled" });
    execute(`INSERT INTO gateway_settings(key,value,updated_at) VALUES('mcp_enabled',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, String(body.enabled), new Date().toISOString());
    json(res, 200, { object: "mcp.status", enabled: body.enabled }); return true;
  }
  if (path === "/admin/mcp/calls" && method === "POST") {
    const body = await readJson(req, ADMIN_BODY_LIMIT);
    const tool = typeof body.tool === "string" ? body.tool.slice(0,120) : "";
    const status = body.status === "error" ? "error" : "success";
    const duration = Number(body.duration_ms);
    if (!tool || !Number.isInteger(duration) || duration < 0) throw new GatewayError({ message: "tool and non-negative duration_ms are required", status: 400, code: "invalid_request_error" });
    execute("INSERT INTO mcp_call_logs(tool_name,status,duration_ms,ts) VALUES(?,?,?,?)", tool,status,duration,new Date().toISOString());
    json(res, 201, { object: "mcp.call", tool, status }); return true;
  }

  if (method === "GET" && path === "/admin/requests") {
    const limit = intParam(url.searchParams.get("limit"), 20);
    const provider = url.searchParams.get("provider") ?? undefined;
    const userId = url.searchParams.get("user_id") ?? undefined;
    const statusParam = url.searchParams.get("status");
    const status = statusParam === "success" || statusParam === "error" ? statusParam : undefined;
    json(res, 200, { object: "list", data: recentRequests(limit, { providerId: provider, userId, status }) });
    return true;
  }

  if (method === "GET" && path === "/admin/sessions") {
    const limit = Math.min(Math.max(intParam(url.searchParams.get("limit"), 50), 1), 500);
    const openOnly = url.searchParams.get("open") === "1";
    const userId = url.searchParams.get("user_id");
    const search = url.searchParams.get("search")?.toLowerCase() ?? "";
    const adminRows = queryAll<Record<string, unknown>>(
      `SELECT id, kind, remote_addr, user_agent, interval_ms, frames,
              opened_at, last_sent_at, closed_at, meta, NULL AS user_id, 0 AS requests
       FROM admin_sessions
       ${openOnly ? "WHERE closed_at IS NULL" : ""}
       ORDER BY opened_at DESC LIMIT ?`, limit,
    );
    const inferenceRows = queryAll<Record<string, unknown>>(`SELECT s.id,'inference' kind,s.remote_addr,s.user_agent,NULL interval_ms,0 frames,s.created_at opened_at,s.updated_at last_sent_at,NULL closed_at,'{}' meta,
      (SELECT l.user_id FROM request_logs l WHERE l.session_id=s.id AND l.user_id IS NOT NULL ORDER BY l.id DESC LIMIT 1) user_id,
      (SELECT COUNT(*) FROM request_logs l WHERE l.session_id=s.id) requests
      FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`, limit);
    let data = [...adminRows, ...inferenceRows].sort((a,b)=>String(b.opened_at).localeCompare(String(a.opened_at)));
    if (userId) data = data.filter((row) => row.user_id === userId);
    if (search) data = data.filter((row) => String(row.id).toLowerCase().includes(search) || String(row.user_id ?? "").toLowerCase().includes(search));
    json(res, 200, { object: "list", count: data.length, open_only: openOnly, data: data.slice(0, limit) });
    return true;
  }

  if (method === "GET" && (path === "/admin/metrics/ws" || path === "/admin/ws")) {
    // A browser or curl hitting this path as plain HTTP gets a real answer, not
    // a mystery 404: the route only speaks WebSocket.
    throw new GatewayError({
      message:
        "This path is a WebSocket upgrade. Connect with ws://<host>:<port>/admin/metrics/ws" +
        (ctx.config.adminAuth ? "?token=<GATEWAY_ADMIN_TOKEN>" : "") +
        ". The first frame is a full metrics snapshot.",
      status: 426,
      code: "not_implemented",
    });
  }

  throw new GatewayError({
    message: `Unknown admin route ${method} ${path}`,
    status: 404,
    code: "invalid_request_error",
  });
}
