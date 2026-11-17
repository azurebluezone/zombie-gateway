/**
 * MCP over HTTP.
 *
 * Two transports, one tool registry:
 *
 *   Streamable HTTP   POST /mcp   JSON-RPC in, JSON-RPC out (SSE on GET /mcp)
 *                     GET  /mcp   server-initiated event stream for one session
 *                     DELETE /mcp terminate the session
 *   Legacy HTTP+SSE   GET  /sse      event stream, first frame is `endpoint`
 *                     POST /messages reply channel named by that endpoint
 *
 * Versions: `2025-11-25` is the newest revision this gateway implements, and
 * the older revisions below are negotiated down when a client asks for one.
 * A client that asks for an unknown revision gets the newest one; the spec
 * lets the client disconnect if it cannot speak that version.
 *
 * Headers make the transport usable from browsers and non-browser clients:
 * `Mcp-Session-Id`, `MCP-Protocol-Version`, plus the global wildcard CORS and
 * the expose list in core/respond.ts. No cookie or origin lock is used, so a
 * local tool, a browser page and curl all take the same path.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../core/chat.ts";
import { logEvent } from "../core/logger.ts";
import { beginSse, writeNamedEvent } from "../core/stream.ts";
import { createTools, SERVER_INFO, toolResult } from "../../scripts/mcp-tools.mjs";

/** Newest first: initialize echoes the client's choice when it is supported. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
export const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];
const LEGACY_PROTOCOL = "2024-11-05";
const SESSION_TTL_MS = 30 * 60_000;
const HEARTBEAT_MS = 25_000;
const TOOL_TIMEOUT_MS = 120_000;

type Transport = "http" | "sse";

interface McpClient {
  name: string;
  version: string;
  title: string | null;
}

interface McpSession {
  id: string;
  protocol: string;
  transport: Transport;
  initialized: boolean;
  /** Created to answer a request that did not initialize first. */
  implicit: boolean;
  createdAt: number;
  lastSeen: number;
  requests: number;
  lastMethod: string | null;
  client: McpClient | null;
  /** Legacy SSE reply channel; null for Streamable HTTP sessions. */
  stream: ServerResponse | null;
}

const sessions = new Map<string, McpSession>();

function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen >= cutoff) continue;
    closeSession(session, "expired");
  }
}

/**
 * One row per handshake. Client-supplied fields are truncated before they are
 * stored, so a client cannot push an unbounded string into the admin response.
 */
function clientFrom(params: Record<string, unknown>): McpClient | null {
  const info = isObject(params["clientInfo"]) ? params["clientInfo"] : null;
  if (!info) return null;
  const name = typeof info["name"] === "string" ? info["name"].slice(0, 120) : "";
  const version = typeof info["version"] === "string" ? info["version"].slice(0, 60) : "";
  const title = typeof info["title"] === "string" ? info["title"].slice(0, 160) : null;
  if (name.length === 0 && version.length === 0) return null;
  return { name: name || "unknown", version: version || "unknown", title };
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL;
}

function newSession(
  transport: Transport,
  protocol: string,
  client: McpClient | null = null,
  implicit = false,
): McpSession {
  const now = Date.now();
  const session: McpSession = {
    id: randomUUID(),
    protocol,
    transport,
    initialized: false,
    implicit,
    createdAt: now,
    lastSeen: now,
    requests: 0,
    lastMethod: null,
    client,
    stream: null,
  };
  sessions.set(session.id, session);
  logEvent("info", "mcp.session.open", {
    session: session.id,
    transport,
    protocol,
    implicit,
    client: client?.name ?? null,
    client_version: client?.version ?? null,
  });
  return session;
}

function closeSession(session: McpSession, reason: string): void {
  if (!sessions.delete(session.id)) return;
  try {
    session.stream?.end();
  } catch {
    // The peer is already gone; deleting the row is the only cleanup needed.
  }
  logEvent("info", "mcp.session.close", {
    session: session.id,
    reason,
    client: session.client?.name ?? null,
    requests: session.requests,
  });
}

export interface McpSessionView {
  id: string;
  protocol: string;
  transport: Transport;
  initialized: boolean;
  implicit: boolean;
  client: McpClient | null;
  created_at: string;
  last_seen: string;
  requests: number;
  last_method: string | null;
}

/** Live registry for GET /admin/mcp/sessions; expired rows are swept first. */
export function snapshotMcpSessions(): McpSessionView[] {
  sweepSessions();
  return [...sessions.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((session) => ({
      id: session.id,
      protocol: session.protocol,
      transport: session.transport,
      initialized: session.initialized,
      implicit: session.implicit,
      client: session.client,
      created_at: new Date(session.createdAt).toISOString(),
      last_seen: new Date(session.lastSeen).toISOString(),
      requests: session.requests,
      last_method: session.lastMethod,
    }));
}

function sessionHeaders(session: McpSession | null): Record<string, string> {
  return {
    "mcp-protocol-version": session?.protocol ?? MCP_LATEST_PROTOCOL,
    ...(session ? { "mcp-session-id": session.id } : {}),
  };
}

function requestSession(req: IncomingMessage): McpSession | null {
  const raw = req.headers["mcp-session-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || id.length === 0) return null;
  const session = sessions.get(id);
  if (session) session.lastSeen = Date.now();
  return session ?? null;
}

function headerProtocol(req: IncomingMessage): string | null {
  const raw = req.headers["mcp-protocol-version"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function sendJsonRpc(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return null;
  return JSON.parse(raw);
}

/**
 * The tools call the public HTTP API over loopback, exactly like the stdio
 * server does. The handler already has the listener's port, so no second code
 * path and no duplicated health/catalog logic are introduced.
 */
function gatewayBase(ctx: AppContext): string | null {
  const override = (process.env.GATEWAY_MCP_BASE_URL || "").trim();
  if (override) return override.replace(/\/+$/, "");
  if (ctx.config.port === null) return null;
  const host =
    ctx.config.host === "0.0.0.0" || ctx.config.host === "::" || ctx.config.host === "[::]"
      ? "127.0.0.1"
      : ctx.config.host;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${ctx.config.port}`;
}

function gatewayCaller(ctx: AppContext) {
  const base = gatewayBase(ctx);
  const token = ctx.config.adminToken ?? "";
  return async (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; request_id: string | null; body: unknown }> => {
    if (base === null) {
      throw new Error("MCP HTTP tools need a TCP listener; set GATEWAY_PORT or GATEWAY_MCP_BASE_URL");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
    try {
      const response = await fetch(base + path, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!response.ok) {
        const record = isObject(body) ? body : null;
        const nested = record && isObject(record.error) ? record.error : null;
        const message =
          (nested && typeof nested.message === "string" && nested.message) ||
          (record && typeof record.message === "string" && record.message) ||
          text.slice(0, 300) ||
          `HTTP ${response.status}`;
        throw new Error(`HTTP ${response.status}: ${message}`);
      }
      return { status: response.status, request_id: response.headers.get("x-request-id"), body };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`timed out after ${TOOL_TIMEOUT_MS} ms waiting for ${base}${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function checkMcpEnabled(call: ReturnType<typeof gatewayCaller>): Promise<void> {
  const status = await call("/admin/mcp");
  if (isObject(status.body) && status.body.enabled === false) {
    throw new Error("MCP access is disabled in the gateway admin settings");
  }
}

async function reportMcpCall(
  call: ReturnType<typeof gatewayCaller>,
  tool: string,
  status: "success" | "error",
  durationMs: number,
): Promise<void> {
  try {
    await call("/admin/mcp/calls", {
      method: "POST",
      body: JSON.stringify({ tool, status, duration_ms: durationMs }),
    });
  } catch (error) {
    logEvent("warn", "mcp.call_log_failed", {
      tool,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dispatch(
  ctx: AppContext,
  message: unknown,
  session: McpSession | null,
): Promise<Record<string, unknown> | null> {
  if (!isObject(message)) return rpcError(null, -32600, "Invalid request");
  const { id, method } = message;
  const params = isObject(message.params) ? message.params : {};

  if (typeof method !== "string" || method.length === 0) {
    return rpcError(id, -32600, "Invalid request: method must be a string");
  }

  if (session) {
    session.requests += 1;
    session.lastMethod = method;
    session.lastSeen = Date.now();
  }

  if (method === "initialize") {
    const protocol = negotiate(params.protocolVersion);
    if (session) {
      session.protocol = protocol;
      session.implicit = false;
      const client = clientFrom(params);
      if (client) session.client = client;
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: protocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Gateway observability over MCP. Start with gateway_health, then gateway_model_stats for per-model latency and gateway_logs for the files under server/logs.",
      },
    };
  }

  if (method === "notifications/initialized") {
    if (session) {
      session.initialized = true;
      logEvent("info", "mcp.session.ready", {
        session: session.id,
        transport: session.transport,
        protocol: session.protocol,
        client: session.client?.name ?? null,
        client_version: session.client?.version ?? null,
      });
    }
    return null;
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    const tools = createTools(gatewayCaller(ctx));
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    };
  }

  if (method === "tools/call") {
    if (!session) return rpcError(id, -32600, "initialize first: no MCP session");
    const name = typeof params.name === "string" ? params.name : "";
    const args = isObject(params.arguments) ? params.arguments : {};
    const call = gatewayCaller(ctx);
    const tool = createTools(call).find((entry) => entry.name === name);
    if (!tool) return { jsonrpc: "2.0", id, result: toolResult(`Unknown tool "${name}"`, true) };
    const started = Date.now();
    try {
      await checkMcpEnabled(call);
      const value = await tool.handler(args);
      await reportMcpCall(call, tool.name, "success", Date.now() - started);
      return { jsonrpc: "2.0", id, result: toolResult(value) };
    } catch (error) {
      await reportMcpCall(call, tool.name, "error", Date.now() - started);
      return {
        jsonrpc: "2.0",
        id,
        result: toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true),
      };
    }
  }

  // Notifications (no id) never get a response, even for an unknown method.
  if (id === undefined) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function protocolHeaderAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  const declared = headerProtocol(req);
  if (declared === null || (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(declared)) return true;
  sendJsonRpc(
    res,
    400,
    rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${declared}`),
    sessionHeaders(null),
  );
  return false;
}

async function handlePostMcp(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sweepSessions();
  if (!protocolHeaderAllowed(req, res)) return;

  let parsed: unknown;
  try {
    parsed = await readBody(req, ctx.config.bodyLimitBytes);
  } catch (error) {
    const status = (error as { status?: number }).status === 413 ? 413 : 400;
    sendJsonRpc(res, status, rpcError(null, -32700, "Parse error"), sessionHeaders(null));
    return;
  }
  if (parsed === null) {
    sendJsonRpc(res, 400, rpcError(null, -32700, "Parse error: empty body"), sessionHeaders(null));
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    sendJsonRpc(res, 400, rpcError(null, -32600, "Invalid request: empty batch"), sessionHeaders(null));
    return;
  }

  let session = requestSession(req);
  if (session === null) {
    const requested = messages
      .map((message) => (isObject(message) && isObject(message.params) ? message.params.protocolVersion : null))
      .find((value) => typeof value === "string");
    // Stateless-friendly: a client that skips initialize still gets a working
    // session instead of a -32600, and the response carries Mcp-Session-Id so
    // the next call can continue the same row.
    session = newSession("http", negotiate(requested ?? headerProtocol(req)), null, true);
  }

  const responses: unknown[] = [];
  for (const message of messages) {
    if (!isObject(message)) {
      responses.push(rpcError(null, -32600, "Invalid request"));
      continue;
    }
    const response = await dispatch(ctx, message, session);
    if (response !== null) responses.push(response);
  }
  if (session) session.lastSeen = Date.now();

  if (responses.length === 0) {
    res.writeHead(202, { ...sessionHeaders(session), "content-length": "0" });
    res.end();
    return;
  }
  sendJsonRpc(res, 200, messages.length === 1 ? responses[0] : responses, sessionHeaders(session));
}

function handleGetMcp(req: IncomingMessage, res: ServerResponse): void {
  sweepSessions();
  let session = requestSession(req);
  if (!session) {
    // A bare GET /mcp is a valid introspection stream request; give it a session
    // instead of refusing it, and announce the id in the response header.
    session = newSession("http", headerProtocol(req) ?? MCP_LATEST_PROTOCOL, null, true);
  }
  if (session.stream !== null && !session.stream.writableEnded) {
    sendJsonRpc(res, 409, rpcError(null, -32600, "An event stream is already open for this session"), sessionHeaders(session));
    return;
  }

  beginSse(res, sessionHeaders(session));
  session.stream = res;
  res.write(": mcp stream open\n\n");
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, HEARTBEAT_MS);
  timer.unref();
  res.on("close", () => {
    clearInterval(timer);
    session.stream = null;
    session.lastSeen = Date.now();
  });
}

function handleDeleteMcp(req: IncomingMessage, res: ServerResponse): void {
  const session = requestSession(req);
  if (!session) {
    sendJsonRpc(res, 404, rpcError(null, -32600, "Unknown MCP session"), sessionHeaders(null));
    return;
  }
  closeSession(session, "client delete");
  res.writeHead(204, sessionHeaders(session));
  res.end();
}

function handleLegacySse(req: IncomingMessage, res: ServerResponse): void {
  sweepSessions();
  const session = newSession("sse", LEGACY_PROTOCOL);
  beginSse(res, sessionHeaders(session));
  session.stream = res;
  // The legacy transport sends a plain URI, not a JSON string: the official
  // client resolves this value against the /sse URL.
  res.write(`event: endpoint\ndata: /messages?sessionId=${session.id}\n\n`);
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, HEARTBEAT_MS);
  timer.unref();
  res.on("close", () => {
    clearInterval(timer);
    session.stream = null;
    closeSession(session, "sse stream closed");
  });
}

async function handleLegacyMessages(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const session = sessions.get(sessionId);
  if (!session || session.transport !== "sse") {
    sendJsonRpc(res, 404, rpcError(null, -32600, "Unknown or expired MCP session"), sessionHeaders(null));
    return;
  }
  session.lastSeen = Date.now();

  let parsed: unknown;
  try {
    parsed = await readBody(req, ctx.config.bodyLimitBytes);
  } catch {
    sendJsonRpc(res, 400, rpcError(null, -32700, "Parse error"), sessionHeaders(session));
    return;
  }
  if (parsed === null) {
    sendJsonRpc(res, 400, rpcError(null, -32700, "Parse error: empty body"), sessionHeaders(session));
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];

  // The legacy transport replies with 202 first; the JSON-RPC answer arrives on
  // the SSE stream. Writing after the status keeps slow tools from blocking the
  // POST response.
  res.writeHead(202, { ...sessionHeaders(session), "content-length": "0" });
  res.end();

  void (async () => {
    for (const message of messages) {
      const response = await dispatch(ctx, message, session);
      if (response !== null && session.stream && !session.stream.writableEnded) {
        await writeNamedEvent(session.stream, "message", response);
      }
    }
  })().catch((error: unknown) => {
    logEvent("error", "mcp.legacy_dispatch_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Returns true when the path belongs to MCP, so the router never falls through
 * to the OpenAI 404 for /mcp, /sse or /messages.
 */
export async function handleMcp(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
  if (path === "/mcp") {
    if (req.method === "POST") {
      await handlePostMcp(ctx, req, res);
      return true;
    }
    if (req.method === "GET") {
      handleGetMcp(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleDeleteMcp(req, res);
      return true;
    }
    sendJsonRpc(res, 405, rpcError(null, -32600, "Method not allowed"), {
      ...sessionHeaders(null),
      allow: "GET, POST, DELETE, OPTIONS",
    });
    return true;
  }

  if (path === "/sse") {
    if (req.method !== "GET") {
      sendJsonRpc(res, 405, rpcError(null, -32600, "Method not allowed"), {
        ...sessionHeaders(null),
        allow: "GET, OPTIONS",
      });
      return true;
    }
    handleLegacySse(req, res);
    return true;
  }

  if (path === "/messages") {
    if (req.method !== "POST") {
      sendJsonRpc(res, 405, rpcError(null, -32600, "Method not allowed"), {
        ...sessionHeaders(null),
        allow: "POST, OPTIONS",
      });
      return true;
    }
    await handleLegacyMessages(ctx, req, res, url);
    return true;
  }

  return false;
}
