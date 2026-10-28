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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleAdmin } from "./admin/api.ts";
import { attachAdminSocket } from "./admin/ws.ts";
import { listPublicModels } from "./core/catalog.ts";
import { logAccess } from "./core/access.ts";
import { handleChatCompletions, type AppContext } from "./core/chat.ts";
import { handleEmbeddings } from "./core/embeddings.ts";
import { handleCountTokens, handleMessages } from "./core/messages.ts";
import { GatewayError, toEnvelope } from "./core/errors.ts";
import { logEvent } from "./core/logger.ts";
import { cors, json, readJson } from "./core/respond.ts";
import { identityHeaders } from "./identity.ts";

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

export function createServer(ctx: AppContext): http.Server {
  const server = http.createServer((req, res) => {
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
  });

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

  if (await handleAdmin(ctx, req, res, path, url)) return;

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
        metadata: {
          upstream_id: model.upstreamId,
          display_name: model.displayName,
          capabilities: model.caps,
          context_length: model.contextLength,
          parameter_size: model.parameterSize,
          quantization: model.quantization,
          family: model.family,
          size_bytes: model.sizeBytes,
          source: model.source,
        },
      })),
    });
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    await handleChatCompletions(ctx, req, res, body);
    return;
  }

  if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    await handleMessages(ctx, req, res, body);
    return;
  }

  if (
    req.method === "POST" &&
    (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")
  ) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    await handleCountTokens(ctx, req, res, body);
    return;
  }

  if (req.method === "POST" && (path === "/v1/embeddings" || path === "/embeddings")) {
    const body = await readJson(req, ctx.config.bodyLimitBytes);
    await handleEmbeddings(ctx, req, res, body);
    return;
  }

  throw new GatewayError({
    message: `Unknown route ${req.method ?? "GET"} ${path}`,
    status: 404,
    code: "invalid_request_error",
  });
}
