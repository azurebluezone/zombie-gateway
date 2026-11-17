#!/usr/bin/env node
/**
 * Zombie gateway MCP server (stdio).
 *
 * One job: expose the gateway's own observability surface to an MCP client
 * (OpenCode) so an agent can answer "which model answered, how slow, where is
 * the log" without shelling out. Every tool is a thin wrapper over the public
 * HTTP API — no second code path, no cached copy, no sample data.
 *
 * Transport: MCP stdio, newline-delimited JSON-RPC 2.0. stdout carries protocol
 * frames only; diagnostics go to stderr, because one stray print on stdout
 * breaks the client's parser.
 *
 * The tool list itself lives in scripts/mcp-tools.mjs, shared with the /mcp and
 * /sse HTTP transports, so a tool is added once and appears on every transport.
 *
 * Environment:
 *   GATEWAY_BASE_URL        default http://127.0.0.1:5010
 *   GATEWAY_ADMIN_TOKEN     optional bearer token for /admin routes
 *   GATEWAY_MCP_TIMEOUT_MS  default 120000 (local 1B CPU inference is slow)
 *
 * No dependencies: node:readline + global fetch (Node 18+).
 */

import { createInterface } from "node:readline";
import { createTools, FALLBACK_PROTOCOL, SERVER_INFO, toolResult } from "./mcp-tools.mjs";

const BASE = (process.env.GATEWAY_BASE_URL || "http://127.0.0.1:5010").replace(/\/+$/, "");
const TOKEN = process.env.GATEWAY_ADMIN_TOKEN || "";
const TIMEOUT_MS = Number(process.env.GATEWAY_MCP_TIMEOUT_MS || 120_000);

function log(message) {
  process.stderr.write(`[gateway-mcp] ${message}\n`);
}

async function http(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BASE + path, {
      ...init,
      headers: {
        accept: "application/json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || text.slice(0, 300) || `HTTP ${response.status}`;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return { status: response.status, request_id: response.headers.get("x-request-id"), body };
  } catch (error) {
    // An AbortError without a reason reads like a gateway bug; name the budget
    // instead so the caller knows whether to raise GATEWAY_MCP_TIMEOUT_MS.
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${BASE}${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function checkMcpEnabled() {
  const status = (await http("/admin/mcp")).body;
  if (status?.enabled === false) throw new Error("MCP access is disabled in the gateway admin settings");
}

async function reportMcpCall(tool, status, durationMs) {
  try {
    await http("/admin/mcp/calls", { method: "POST", body: JSON.stringify({ tool, status, duration_ms: durationMs }) });
  } catch (error) {
    log(`could not record MCP call metrics: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const TOOLS = createTools(http);

async function handle(message) {
  const { id, method, params } = message;
  if (typeof method !== "string") {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid request" } };
  }

  if (method === "initialize") {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only view of a local OpenAI/Anthropic compatible gateway. Start with gateway_health, then gateway_model_stats for per-model latency and gateway_logs for the files under server/logs.",
      },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) {
      return { jsonrpc: "2.0", id, result: toolResult(`Unknown tool "${name}"`, true) };
    }
    const started = Date.now();
    try {
      await checkMcpEnabled();
      const value = await tool.handler(params?.arguments || {});
      await reportMcpCall(tool.name, "success", Date.now() - started);
      return { jsonrpc: "2.0", id, result: toolResult(value) };
    } catch (error) {
      await reportMcpCall(tool.name, "error", Date.now() - started);
      return {
        jsonrpc: "2.0",
        id,
        result: toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true),
      };
    }
  }

  // Notifications carry no id and get no response.
  if (id === undefined) return null;

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
log(`ready · base=${BASE} · admin_auth=${TOKEN ? "bearer" : "none"} · tools=${TOOLS.length}`);

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log("dropped a line that was not JSON");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
    return;
  }
  try {
    const response = await handle(message);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  } catch (error) {
    log(`handler failed: ${error instanceof Error ? error.message : String(error)}`);
    if (message && message.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } }) + "\n",
      );
    }
  }
});
