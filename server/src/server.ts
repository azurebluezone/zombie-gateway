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
 * GET /admin/routes. No HTML is rendered by this process.
 */

import http from "node:http";
import { handleAdmin } from "./admin/api.ts";
import { attachAdminSocket } from "./admin/ws.ts";
import { listPublicModels } from "./core/catalog.ts";
import { handleChatCompletions, type AppContext } from "./core/chat.ts";
import { handleEmbeddings } from "./core/embeddings.ts";
import { handleCountTokens, handleMessages } from "./core/messages.ts";
import { GatewayError, toEnvelope } from "./core/errors.ts";
import { logEvent } from "./core/logger.ts";
import { cors, json, readJson } from "./core/respond.ts";
import { identityHeaders } from "./identity.ts";

const startedAt = Date.now();

export function createServer(ctx: AppContext): http.Server {
  const server = http.createServer((req, res) => {
    if (ctx.config.identityHeaders) {
      for (const [name, value] of Object.entries(identityHeaders(ctx.identity))) {
        res.setHeader(name, value);
      }
    }

    void route(ctx, req, res).catch((error: unknown) => {
      const envelope = toEnvelope(error);
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
