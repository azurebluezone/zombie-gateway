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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../core/chat.ts";
import { fullModelId, listPublicModels, resolveModel, syncProvider } from "../core/catalog.ts";
import { queryAll, queryOne } from "../core/db.ts";
import { GatewayError } from "../core/errors.ts";
import { logEvent } from "../core/logger.ts";
import { collectMetrics, recentRequests } from "../core/metrics.ts";
import type { ProviderConfig } from "../config.ts";
import { json, readJson } from "../core/respond.ts";
import { providerSchema } from "./schema.ts";
import { openUpstream, probeJson, readBody } from "../transport/request.ts";

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
  { method: "POST", path: "/admin/models/load", purpose: "Warm a model into RAM (ollama only).", body: { model: "provider/model", keep_alive: "30m" } },
  { method: "POST", path: "/admin/models/unload", purpose: "Drop a model from RAM (ollama only).", body: { model: "provider/model" } },
  { method: "GET", path: "/admin/runtime", purpose: "Live reachability and loaded models per provider." },
  { method: "GET", path: "/admin/metrics", purpose: "Window aggregates: totals, per provider, per model, per minute.", query: { window_ms: "3600000" } },
  { method: "GET", path: "/admin/requests", purpose: "Most recent request log rows.", query: { limit: "20", provider: "id" } },
  { method: "GET", path: "/admin/sessions", purpose: "Admin panel sessions (one row per WebSocket handshake), newest first.", query: { limit: "50", open: "1" } },
  { method: "GET", path: "/admin/metrics/ws", purpose: "Realtime metrics over WebSocket (also /admin/ws). Text frames only; first frame is a snapshot." },
];

function authorized(ctx: AppContext, req: IncomingMessage): boolean {
  if (!ctx.config.adminAuth) return true;
  const token = ctx.config.adminToken;
  if (!token) return false;
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
  const direct = req.headers["x-admin-token"];
  const supplied = bearer ?? (typeof direct === "string" ? direct : null);
  return supplied !== null && supplied === token;
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
        model_path: propsBody["model_path"] ?? null,
        n_ctx: asRecord(propsBody["default_generation_settings"])["n_ctx"] ?? null,
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
      admin_auth: ctx.config.adminAuth,
      admin_token_configured: ctx.config.adminToken !== null,
      admin_token_required: ctx.config.adminAuth && ctx.config.adminToken !== null,
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
    });
    return true;
  }

  if (method === "GET" && path === "/admin/providers/schema") {
    json(res, 200, providerSchema());
    return true;
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
        parameter_size: model.parameterSize,
        quantization: model.quantization,
        family: model.family,
        size_bytes: model.sizeBytes,
        source: model.source,
        last_seen_at: model.lastSeenAt,
        provider_enabled: ctx.registry.get(model.providerId)?.enabled ?? false,
      })),
    });
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

  if (method === "GET" && path === "/admin/metrics") {
    const windowMs = intParam(url.searchParams.get("window_ms"), 60 * 60 * 1000);
    json(res, 200, { object: "metrics", ...collectMetrics(windowMs) });
    return true;
  }

  if (method === "GET" && path === "/admin/requests") {
    const limit = intParam(url.searchParams.get("limit"), 20);
    const provider = url.searchParams.get("provider") ?? undefined;
    json(res, 200, { object: "list", data: recentRequests(limit, provider) });
    return true;
  }

  if (method === "GET" && path === "/admin/sessions") {
    const limit = Math.min(Math.max(intParam(url.searchParams.get("limit"), 50), 1), 500);
    const openOnly = url.searchParams.get("open") === "1";
    const data = queryAll<Record<string, unknown>>(
      `SELECT id, kind, remote_addr, user_agent, interval_ms, frames,
              opened_at, last_sent_at, closed_at, meta
       FROM admin_sessions
       ${openOnly ? "WHERE closed_at IS NULL" : ""}
       ORDER BY opened_at DESC LIMIT ?`,
      limit,
    );
    json(res, 200, { object: "list", count: data.length, open_only: openOnly, data });
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
