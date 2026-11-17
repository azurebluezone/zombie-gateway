/**
 * The one MCP tool registry.
 *
 * Both transports import this module: the stdio server (scripts/gateway-mcp.mjs)
 * and the in-process HTTP transports (src/mcp/http.ts). Every tool is still one
 * HTTP call to the gateway's public API; `http` is injected so the caller owns
 * the base URL, auth token and timeout.
 *
 * Keeping the list here means adding a tool once makes it visible on stdio,
 * Streamable HTTP (/mcp) and legacy SSE (/sse) at the same time.
 */

export const SERVER_INFO = { name: "zombie-gateway", version: "0.1.0" };

/** Version used when a client does not ask for one. */
export const FALLBACK_PROTOCOL = "2025-06-18";

export function toolResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/**
 * @param {(path: string, init?: { method?: string, body?: string, headers?: Record<string, string> }) => Promise<{ status: number, request_id: string | null, body: unknown }>} http
 */
export function createTools(http) {
  return [
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
      name: "gateway_mcp_sessions",
      description:
        "Connected MCP clients and the full tool list: session id, client name/version, transport, negotiated protocol, request count and last method. Use this to answer who is connected and how many tools exist.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => (await http("/admin/mcp/sessions")).body,
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
}

/**
 * Tool names in registry order. Handlers are never invoked here, so a stub
 * caller is enough and the admin API gets the same list MCP publishes.
 */
export const TOOL_NAMES = createTools(() => {
  throw new Error("tool names do not call handlers");
}).map((tool) => tool.name);
