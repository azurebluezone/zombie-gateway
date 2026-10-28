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
 * Environment:
 *   GATEWAY_BASE_URL        default http://127.0.0.1:5252
 *   GATEWAY_ADMIN_TOKEN     optional bearer token for /admin routes
 *   GATEWAY_MCP_TIMEOUT_MS  default 120000 (local 1B CPU inference is slow)
 *
 * No dependencies: node:readline + global fetch (Node 18+).
 */

import { createInterface } from "node:readline";

const BASE = (process.env.GATEWAY_BASE_URL || "http://127.0.0.1:5252").replace(/\/+$/, "");
const TOKEN = process.env.GATEWAY_ADMIN_TOKEN || "";
const TIMEOUT_MS = Number(process.env.GATEWAY_MCP_TIMEOUT_MS || 120_000);
const SERVER_INFO = { name: "zombie-gateway", version: "0.1.0" };
const FALLBACK_PROTOCOL = "2025-06-18";

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

const TOOLS = [
  {
    name: "gateway_health",
    description: "Gateway health: status, uptime, provider and model counts. Use this first when a call fails.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => (await http("/health")).body,
  },
  {
    name: "gateway_models",
    description: "Public model ids the gateway serves, in <provider>/<model> form.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => (await http("/v1/models")).body,
  },
  {
    name: "gateway_runtime",
    description:
      "Live runtime per provider: reachable, loaded models, and for llama.cpp the alias, quantization, ctx size and slot count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => (await http("/admin/runtime")).body,
  },
  {
    name: "gateway_model_stats",
    description:
      "Per-model request counts, errors, average and max latency, tokens and last request time, read from request_logs. This is the 'which model answered and how slow' answer.",
    inputSchema: {
      type: "object",
      properties: {
        window_ms: {
          type: "integer",
          minimum: 60_000,
          maximum: 604_800_000,
          description: "Lookback window in milliseconds. Default 3600000 (1 hour).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const windowMs = Number(args.window_ms || 3_600_000);
      return (await http(`/admin/model-stats?window_ms=${encodeURIComponent(windowMs)}`)).body;
    },
  },
  {
    name: "gateway_logs",
    description:
      "Tail one server log file. Returns the absolute path plus the last N lines, so the answer includes where the log actually lives.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["access", "gateway", "llama-server", "llama-model"],
          description: "Whitelisted log file. Default access.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Lines to return. Default 50." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const file = String(args.file || "access");
      const limit = Math.min(Math.max(Number(args.limit || 50), 1), 500);
      return (await http(`/admin/logs?file=${encodeURIComponent(file)}&limit=${encodeURIComponent(limit)}`)).body;
    },
  },
  {
    name: "gateway_requests",
    description: "Most recent request_logs rows: status, provider, model, duration, tokens and request id.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Rows to return. Default 20." },
        provider: { type: "string", description: "Optional provider id filter." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit || 20), 1), 200);
      const provider = args.provider ? `&provider=${encodeURIComponent(String(args.provider))}` : "";
      return (await http(`/admin/requests?limit=${encodeURIComponent(limit)}${provider}`)).body;
    },
  },
  {
    name: "gateway_chat",
    description:
      "Send one non-streaming chat completion through the gateway and return the answer with model, usage and latency. This consumes local CPU; keep max_tokens small.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Public id, e.g. llamacpp/llama-3.2-1b-abliterated." },
        prompt: { type: "string", description: "Single user message." },
        messages: {
          type: "array",
          description: "Full message list instead of prompt (OpenAI shape).",
          items: { type: "object" },
        },
        max_tokens: { type: "integer", minimum: 1, maximum: 4096, description: "Default 256." },
        temperature: { type: "number", minimum: 0, maximum: 2, description: "Default 0.7." },
      },
      required: ["model"],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!args.model) throw new Error("model is required");
      const messages = Array.isArray(args.messages)
        ? args.messages
        : [{ role: "user", content: String(args.prompt || "") }];
      if (!Array.isArray(args.messages) && !args.prompt) throw new Error("prompt or messages is required");
      const started = Date.now();
      const result = await http("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: args.model,
          messages,
          max_tokens: Math.min(Math.max(Number(args.max_tokens || 256), 1), 4096),
          temperature: Math.min(Math.max(Number(args.temperature ?? 0.7), 0), 2),
        }),
      });
      return {
        request_id: result.request_id,
        duration_ms: Date.now() - started,
        status: result.status,
        ...result.body,
      };
    },
  },
];

function toolResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

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
    try {
      const value = await tool.handler(params?.arguments || {});
      return { jsonrpc: "2.0", id, result: toolResult(value) };
    } catch (error) {
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
