#!/usr/bin/env node
/**
 * MCP HTTP client (no dependencies).
 *
 * Speaks both HTTP transports this gateway serves:
 *
 *   --url http://127.0.0.1:5010/mcp   Streamable HTTP (POST + Mcp-Session-Id)
 *   --url http://127.0.0.1:5010/sse   legacy HTTP+SSE (endpoint event + POST)
 *
 * Default flow: initialize -> notifications/initialized -> tools/list, then
 * optionally one tools/call. `--insecure` accepts the self-signed certificate
 * from server/test/fixtures (for local HTTPS checks only).
 *
 * Usage:
 *   node server/scripts/mcp-http-client.mjs --url http://127.0.0.1:5010/mcp \
 *     --call gateway_health
 *
 *   node server/scripts/mcp-http-client.mjs --url https://127.0.0.1:5011/mcp \
 *     --insecure --json
 */

const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const URL_VALUE = option("--url", process.env.GATEWAY_MCP_URL || "http://127.0.0.1:5010/mcp");
const INSECURE = argv.includes("--insecure");
const CALL_TOOL = option("--call", "");
const CALL_ARGS = option("--args", "{}");
const PROTOCOL = option("--protocol", "");
const JSON_OUT = argv.includes("--json");
const TIMEOUT_MS = Number(option("--timeout", "60000"));

if (!/^https?:\/\//i.test(URL_VALUE)) throw new Error(`--url must start with http:// or https://, got ${URL_VALUE}`);
if (INSECURE) {
  // Only for the local test certificate. A process-wide switch is the one way
  // to make Node's fetch accept a self-signed cert without adding undici as a
  // dependency; the warning goes to stderr, never stdout.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  process.stderr.write("[mcp-http-client] TLS verification disabled by --insecure\n");
}

let parsedArgs;
try {
  parsedArgs = CALL_ARGS.trim() ? JSON.parse(CALL_ARGS) : {};
} catch (error) {
  throw new Error(`--args is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
  throw new Error("--args must be a JSON object");
}

function isLegacy(url) {
  return new URL(url).pathname.replace(/\/+$/, "").endsWith("/sse");
}

function headersFor(session, protocol) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session } : {}),
    ...(protocol ? { "mcp-protocol-version": protocol } : {}),
  };
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function parseSseText(text) {
  const frames = [];
  for (const block of text.split("\n\n")) {
    const frame = { event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "data") frame.data += (frame.data ? "\n" : "") + value;
    }
    if (frame.data) frames.push(frame);
  }
  return frames;
}

async function parseSseBody(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const [frame] = parseSseText(block + "\n\n");
      if (frame && frame.data) onFrame(frame);
    }
  }
}

async function rpcHttp(url, payload, state) {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: headersFor(state.session, state.protocol),
      body: JSON.stringify(payload),
      signal,
    });
    const text = await response.text();
    const type = String(response.headers.get("content-type") || "");
    let json = null;
    if (type.includes("text/event-stream")) {
      const frames = parseSseText(text);
      legacyLoop: for (const frame of frames) {
        try {
          const candidate = JSON.parse(frame.data);
          if (Array.isArray(candidate) || candidate.id === payload.id) {
            json = Array.isArray(candidate) ? candidate[0] : candidate;
            break legacyLoop;
          }
        } catch {
          // Keep looking: an SSE stream can carry unrelated frames first.
        }
      }
    } else if (text.trim()) {
      json = JSON.parse(text);
    }
    return { status: response.status, headers: response.headers, text, json };
  });
}

function assertRpc(response, label) {
  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  if (!response.json) throw new Error(`${label}: empty JSON-RPC response`);
  if (response.json.error) throw new Error(`${label}: ${response.json.error.message}`);
  return response.json.result;
}

async function streamableFlow(url) {
  const protocol = PROTOCOL || "2025-11-25";
  const state = { session: null, protocol };
  const init = await rpcHttp(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "zombie-mcp-http-client", version: "0.1.0" },
    },
  }, state);
  const initResult = assertRpc(init, "initialize");
  state.protocol = initResult.protocolVersion;
  state.session = init.headers.get("mcp-session-id");
  if (!state.session) throw new Error("initialize: server did not return Mcp-Session-Id");

  await rpcHttp(url, { jsonrpc: "2.0", method: "notifications/initialized" }, state);
  const list = assertRpc(await rpcHttp(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, state), "tools/list");
  const tools = list.tools ?? [];
  let callStatus = null;
  if (CALL_TOOL) {
    const call = assertRpc(await rpcHttp(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: CALL_TOOL, arguments: parsedArgs },
    }, state), "tools/call");
    if (call.isError) throw new Error(`tools/call ${CALL_TOOL}: ${call.content?.[0]?.text ?? "error"}`);
    callStatus = statusFrom(call.content?.[0]?.text);
  }
  const close = await withTimeout((signal) => fetch(url, {
    method: "DELETE",
    headers: headersFor(state.session, state.protocol),
    signal,
  })).catch(() => null);
  return {
    transport: "streamable-http",
    server: initResult.serverInfo,
    protocol: initResult.protocolVersion,
    session: state.session,
    tools,
    callStatus,
    closed: close ? close.status : null,
  };
}

async function legacyFlow(url) {
  const protocol = PROTOCOL || "2024-11-05";
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  if (!String(response.headers.get("content-type") || "").includes("text/event-stream")) {
    throw new Error(`GET ${url}: not an event stream (${response.headers.get("content-type")})`);
  }

  const frames = [];
  const waiters = [];
  void parseSseBody(response, (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) {
      let matched = false;
      try {
        matched = waiter.match(frame);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }).catch((error) => {
    if (error?.name === "AbortError") return;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  const wait = (match) => {
    const existing = frames.find((frame) => {
      try {
        return match(frame);
      } catch {
        return false;
      }
    });
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an SSE frame")), TIMEOUT_MS);
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };

  try {
    const endpointFrame = await wait((frame) => frame.event === "endpoint");
    const endpoint = new URL(endpointFrame.data.trim(), url);
    const sessionId = endpoint.searchParams.get("sessionId") || endpointFrame.data.trim();

    const post = async (payload) => {
      const sent = await withTimeout((signal) => fetch(endpoint, {
        method: "POST",
        headers: headersFor(sessionId, protocol),
        body: JSON.stringify(payload),
        signal,
      }));
      if (sent.status !== 202) throw new Error(`POST ${endpoint.pathname}: HTTP ${sent.status}`);
    };
    const request = async (payload) => {
      const reply = wait((frame) => {
        if (frame.event !== "message") return false;
        return JSON.parse(frame.data).id === payload.id;
      });
      await post(payload);
      return JSON.parse((await reply).data);
    };

    const init = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "zombie-mcp-http-client", version: "0.1.0" },
      },
    });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    const negotiated = init.result.protocolVersion;

    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (list.error) throw new Error(`tools/list: ${list.error.message}`);
    const tools = list.result.tools ?? [];
    let callStatus = null;
    if (CALL_TOOL) {
      const call = await request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: CALL_TOOL, arguments: parsedArgs },
      });
      if (call.error) throw new Error(`tools/call: ${call.error.message}`);
      const result = call.result;
      if (result.isError) throw new Error(`tools/call ${CALL_TOOL}: ${result.content?.[0]?.text ?? "error"}`);
      callStatus = statusFrom(result.content?.[0]?.text);
    }
    return {
      transport: "legacy-sse",
      server: init.result.serverInfo,
      protocol: negotiated,
      session: sessionId,
      tools,
      callStatus,
      closed: null,
    };
  } finally {
    controller.abort();
  }
}

function statusFrom(text) {
  if (typeof text !== "string") return "ok";
  try {
    const value = JSON.parse(text);
    return typeof value.status === "string" ? value.status : "ok";
  } catch {
    return "ok";
  }
}

async function main() {
  const legacy = isLegacy(URL_VALUE);
  const result = legacy ? await legacyFlow(URL_VALUE) : await streamableFlow(URL_VALUE);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      url: URL_VALUE,
      transport: result.transport,
      server: result.server?.name,
      protocol: result.protocol,
      session: result.session,
      tools: result.tools.length,
      tool: CALL_TOOL || null,
      status: result.callStatus,
    }, null, 2));
  } else {
    console.log(`url=${URL_VALUE}`);
    console.log(`transport=${result.transport}`);
    console.log(`server=${result.server?.name} protocol=${result.protocol} session=${result.session}`);
    console.log(`tools=${result.tools.length}`);
    if (CALL_TOOL) console.log(`tool=${CALL_TOOL} status=${result.callStatus}`);
    console.log("OK");
  }
}

main().catch((error) => {
  process.stderr.write(`[mcp-http-client] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
