/**
 * HTTP surface.
 *
 * Public (OpenAI-compatible):
 *   GET  /health
 *   GET  /v1/models
 *   GET  /v1/providers
 *   POST /v1/chat/completions
 *   POST /v1/embeddings
 *
 * Public (Anthropic-compatible, stateless translation):
 *   POST /v1/messages
 *   POST /v1/messages/count_tokens
 *
 * Admin (JSON only, terminal-first): everything under /admin, described by
 * GET /admin/routes. The one HTML page is GET /admin/ui — the dashboard that
 * consumes those same routes from the same origin.
 */

import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleAdmin } from "./admin/api.ts";
import { attachAdminSocket } from "./admin/ws.ts";
import { handleClientPage } from "./client/page.ts";
import { listPublicModels } from "./core/catalog.ts";
import { logAccess } from "./core/access.ts";
import { handleChatCompletions, type AppContext } from "./core/chat.ts";
import { handleEmbeddings } from "./core/embeddings.ts";
import { handleMcp } from "./mcp/http.ts";
import { handleCountTokens, handleMessages } from "./core/messages.ts";
import { GatewayError, toEnvelope } from "./core/errors.ts";
import { logEvent } from "./core/logger.ts";
import { cors, json, readJson } from "./core/respond.ts";
import { identityHeaders } from "./identity.ts";
import { queryOne } from "./core/db.ts";
import { estimateTokens } from "./core/tokens.ts";

const startedAt = Date.now();

/**
 * The dashboard is a static file on disk, not a template: it reads the admin
 * API from the browser. It is read per request (a page load, not a hot path) so
 * an edit to public/admin.html never needs a restart to show up.
 */
const ADMIN_UI_FILE = fileURLToPath(new URL("../public/admin.html", import.meta.url));
function adminUi(): string {
  return readFileSync(ADMIN_UI_FILE, "utf8");
}

function sendHtml(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createRequestListener(
  ctx: AppContext,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    // Every request leaves one line in the access log, success or failure. The
    // line is written on 'finish', so the status and byte count are final.
    const startedNs = process.hrtime.bigint();
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    let failure: { code: string; message: string } | null = null;

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      logAccess({
        event: "http.request",
        method: req.method ?? null,
        path: queryAt === -1 ? rawUrl || "/" : rawUrl.slice(0, queryAt) || "/",
        query: queryAt === -1 ? null : rawUrl.slice(queryAt + 1),
        status: res.statusCode,
        outcome: res.statusCode >= 400 ? "failure" : "success",
        duration_ms: Math.round(durationMs * 1000) / 1000,
        bytes: res.getHeader("content-length") ?? null,
        remote: req.socket.remoteAddress ?? null,
        user_agent: req.headers["user-agent"] ?? null,
        session_id: req.headers["x-session-id"] ?? null,
        request_id: (res.getHeader("x-request-id") as string | undefined) ?? null,
        error_code: failure?.code ?? ((res.getHeader("x-error-code") as string | undefined) ?? null),
        error_message: failure?.message ?? null,
      });
    });

    if (ctx.config.identityHeaders) {
      for (const [name, value] of Object.entries(identityHeaders(ctx.identity))) {
        res.setHeader(name, value);
      }
    }

    void route(ctx, req, res).catch((error: unknown) => {
      const envelope = toEnvelope(error);
      failure = { code: envelope.body.error.code, message: envelope.body.error.message };
      logEvent("error", "http.unhandled", {
        message: envelope.body.error.message,
        code: envelope.body.error.code,
        path: req.url ?? null,
      });
      if (!res.headersSent) json(res, envelope.status, envelope.body);
      else res.end();
    });
  };
}

export function createServer(ctx: AppContext): http.Server {
  const server = http.createServer(createRequestListener(ctx));

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  // Realtime metrics ride the same port as HTTP: one origin, one auth switch,
  // one TLS decision in front. No second listener means no second exposure.
  attachAdminSocket(server, ctx);

  return server;
}

async function route(
  ctx: AppContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  cors(req, res, ctx.config.adminOrigins);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // The dashboard is served here, before the /admin JSON router, so a browser
  // gets HTML from the same origin it will call /admin/* on. No CORS, no token
  // in a query string.
  if (req.method === "GET" && (path === "/admin/ui" || path === "/dashboard")) {
    sendHtml(res, adminUi());
    return;
  }

  if (req.method === "GET" && path === "/") {
    res.writeHead(302, { location: "/admin/ui" });
    res.end();
    return;
  }

  // Read-only MCP usage page for humans and scripts. It lives outside /admin
  // because it exposes no secrets: client names are self-declared and session
  // ids are truncated.
  if (handleClientPage(ctx, req, res, path)) return;

  if (await handleAdmin(ctx, req, res, path, url)) return;

  // MCP transports (/mcp, /sse, /messages) share one tool registry with the
  // stdio server; they return false for every other path.
  if (await handleMcp(ctx, req, res, path, url)) return;

  if (["/v1/chat/completions", "/chat/completions", "/v1/messages", "/messages", "/v1/messages/count_tokens", "/messages/count_tokens", "/v1/embeddings", "/embeddings"].includes(path)) {
    const header = req.headers.authorization;
    const key = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const user = key ? queryOne<{id:string;role:string;starts_at:string;expires_at:string|null;context_limit:number|null;token_limit:number|null;enabled:number}>("SELECT id,role,starts_at,expires_at,context_limit,token_limit,enabled FROM gateway_users WHERE api_key_hash=?", createHash("sha256").update(key).digest("hex")) : undefined;
    if (ctx.config.userAuth && !user) { json(res, 401, { error: { message: "A valid gateway API key is required", type: "authentication_error", code: "invalid_api_key" } }); return; }
    if (user) {
      const now = Date.now();
      if (!user.enabled || now < Date.parse(user.starts_at) || (user.expires_at && now >= Date.parse(user.expires_at))) { json(res, 401, { error: { message: "Gateway API key is outside its valid period", type: "authentication_error", code: "key_expired" } }); return; }
      if (req.method === "POST" && user.role === "read_only") { json(res, 403, { error: { message: "This API key is read-only", type: "permission_error", code: "read_only_key" } }); return; }
      const used = queryOne<{tokens:number}>("SELECT COALESCE(SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)),0) AS tokens FROM request_logs WHERE user_id=?", user.id)?.tokens ?? 0;
      if (user.token_limit !== null && used >= user.token_limit) { json(res, 429, { error: { message: "User token quota exhausted", type: "quota_error", code: "token_quota_exceeded" } }); return; }
      (req as http.IncomingMessage & { gatewayUserId?: string }).gatewayUserId = user.id;
      (req as http.IncomingMessage & { gatewayContextLimit?: number | null }).gatewayContextLimit = user.context_limit;
    }
  }

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    json(res, 200, {
      status: "ok",
      uptime_ms: Date.now() - startedAt,
      identity: ctx.identity.identity.name,
      version: ctx.identity.identity.version,
      providers: ctx.registry.list().length,
      providers_total: ctx.registry.list(true).length,
      models: listPublicModels().length,
    });
    return;
  }

  if (req.method === "GET" && path === "/v1/providers") {
    json(
      res,
      200,
      ctx.registry.list(true).map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        transport: provider.transport,
        base_url: provider.baseUrl,
        socket: provider.socketPath,
        declared_caps: provider.caps,
        declared_models: provider.models,
        timeout_ms: provider.timeoutMs,
        enabled: provider.enabled,
        source: provider.source,
        authenticated: provider.apiKey !== null,
      })),
    );
    return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    const models = listPublicModels();
    json(res, 200, {
      object: "list",
      data: models.map((model) => ({
        id: model.fullId,
        object: "model",
        created: Math.floor(new Date(model.lastSeenAt).getTime() / 1000) || 0,
        owned_by: model.providerId,
      })),
    });
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    enforceUserContext(req, body);
    await handleChatCompletions(ctx, req, res, body);
    return;
  }

  if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    enforceUserContext(req, body);
    await handleMessages(ctx, req, res, body);
    return;
  }

  if (
    req.method === "POST" &&
    (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")
  ) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    enforceUserContext(req, body);
    await handleCountTokens(ctx, req, res, body);
    return;
  }

  if (req.method === "POST" && (path === "/v1/embeddings" || path === "/embeddings")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    enforceUserContext(req, body);
    await handleEmbeddings(ctx, req, res, body);
    return;
  }

  throw new GatewayError({
    message: `Unknown route ${req.method ?? "GET"} ${path}`,
    status: 404,
    code: "invalid_request_error",
  });
}

function enforceUserContext(req: http.IncomingMessage, body: Record<string, unknown>): void {
  const limit = (req as http.IncomingMessage & { gatewayContextLimit?: number | null }).gatewayContextLimit;
  if (limit == null) return;
  const prompt = JSON.stringify(body.messages ?? body.input ?? body.prompt ?? "");
  const estimated = estimateTokens(prompt);
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
  if (estimated + (Number.isFinite(output) && output > 0 ? output : 0) > limit) {
    throw new GatewayError({ message: `Request exceeds this user's ${limit}-token context limit`, status: 413, code: "context_length_exceeded", param: "messages" });
  }
}
