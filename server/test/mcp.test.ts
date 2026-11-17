/**
 * MCP transports over the real listener.
 *
 * What these prove: the gateway process itself answers the two HTTP transports
 * and the TLS listener, not a handler called in isolation — initialize,
 * tools/list, tools/call and DELETE on /mcp; the legacy /sse endpoint event and
 * its /messages reply channel; protocol-version echo and rejection.
 *
 * What they do not prove: any engine's answer quality. The tools are wrappers
 * over the public API, and their answers are checked here only for the health
 * shape (`status: ok`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { SERVER_DIR, freePort, startFixture, startGateway } from "./fixture.ts";

const CERT = join(SERVER_DIR, "test/fixtures/localhost-cert.pem");
const KEY = join(SERVER_DIR, "test/fixtures/localhost-key.pem");

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/**
 * The TLS listener uses the repository's self-signed test certificate, so the
 * helper accepts it explicitly instead of switching TLS verification off for
 * the whole test process.
 */
function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const target = new URL(url);
  const options: https.RequestOptions = {
    method: init.method ?? "GET",
    headers: init.headers,
    rejectUnauthorized: false,
    servername: "localhost",
  };
  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    };
    const outgoing =
      target.protocol === "https:"
        ? https.request(target, options, onResponse)
        : http.request(target, options, onResponse);
    outgoing.setTimeout(20_000, () => outgoing.destroy(new Error(`timeout: ${init.method ?? "GET"} ${url}`)));
    outgoing.on("error", reject);
    if (init.body !== undefined) outgoing.write(init.body);
    outgoing.end();
  });
}

interface RpcResult {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

/**
 * The fixture's waitForHealth uses fetch, which refuses the self-signed test
 * certificate; the TLS listener needs this helper's explicit opt-in instead.
 */
async function waitForTlsHealth(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await request(`${base}/health`);
      if (response.status === 200) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TLS listener did not become healthy at ${base} (${last})`);
}

function rpc(
  base: string,
  payload: Record<string, unknown>,
  session?: string | null,
  protocol?: string | null,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  if (protocol) headers["mcp-protocol-version"] = protocol;
  return request(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
}

function parseJson(text: string, label: string): RpcResult {
  try {
    return JSON.parse(text) as RpcResult;
  } catch {
    throw new Error(`${label}: not JSON: ${text.slice(0, 200)}`);
  }
}

interface SseFrame {
  event: string;
  data: string;
}

interface SseStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  wait: (match: (frame: SseFrame) => boolean, label: string) => Promise<SseFrame>;
  close: () => void;
}

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { event: "message", data: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") frame.event = value;
    else if (field === "data") frame.data += (frame.data === "" ? "" : "\n") + value;
  }
  return frame;
}

async function openSse(url: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  const frames: SseFrame[] = [];
  const waiters: Array<{
    match: (frame: SseFrame) => boolean;
    resolve: (frame: SseFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const emit = (frame: SseFrame): void => {
    frames.push(frame);
    for (const waiter of [...waiters]) {
      let matched = false;
      try {
        matched = waiter.match(frame);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  };

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`GET ${url}: no body`);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseFrame(raw);
        if (frame.data !== "" || frame.event !== "message") emit(frame);
      }
    }
  })().catch(() => {
    // The stream is torn down by the test's close(); no frame is expected after.
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    wait: (match, label) => {
      const existing = frames.find((frame) => {
        try {
          return match(frame);
        } catch {
          return false;
        }
      });
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`timed out waiting for ${label}`));
          }, 20_000),
        };
        waiters.push(waiter);
      });
    },
    close: () => controller.abort(),
  };
}

function rpcId(frame: SseFrame, id: unknown): boolean {
  if (frame.event !== "message") return false;
  try {
    return parseJson(frame.data, "sse frame").id === id;
  } catch {
    return false;
  }
}

test("MCP routes answer over HTTP, HTTPS and legacy SSE", async (t) => {
  const fixture = await startFixture();
  const tlsPort = await freePort();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    GATEWAY_TLS_PORT: String(tlsPort),
    GATEWAY_TLS_CERT: CERT,
    GATEWAY_TLS_KEY: KEY,
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const tlsBase = `https://127.0.0.1:${tlsPort}`;
  await waitForTlsHealth(tlsBase);

  await t.test("initialize issues a session and echoes a supported revision", async () => {
    const response = await rpc(
      gateway.base,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-test", version: "1.0.0" },
        },
      },
      null,
      null,
    );

    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    const body = parseJson(response.text, "initialize");
    assert.equal(body.result?.["serverInfo"]?.["name"], "zombie-gateway");
    assert.equal(body.result?.["protocolVersion"], "2025-06-18");
    assert.equal(response.headers["mcp-protocol-version"], "2025-06-18");
    const session = response.headers["mcp-session-id"];
    assert.equal(typeof session, "string");
    assert.ok(typeof session === "string" && session.length >= 8, "missing Mcp-Session-Id");
    assert.equal(response.headers["access-control-allow-origin"], "*");
    const expose = String(response.headers["access-control-expose-headers"] ?? "").toLowerCase();
    assert.ok(expose.includes("mcp-session-id"));
    assert.ok(expose.includes("mcp-protocol-version"));
  });

  await t.test("tools/list and tools/call work on that session", async () => {
    const init = await rpc(gateway.base, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-test", version: "1.0.0" },
      },
    });
    const session = String(init.headers["mcp-session-id"]);
    const protocol = String(init.headers["mcp-protocol-version"]);

    const note = await rpc(
      gateway.base,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session,
      protocol,
    );
    assert.equal(note.status, 202);

    const list = await rpc(gateway.base, { jsonrpc: "2.0", id: 11, method: "tools/list" }, session, protocol);
    assert.equal(list.status, 200);
    const tools = (parseJson(list.text, "tools/list").result?.["tools"] ?? []) as Array<{ name: string }>;
    assert.equal(tools.length, 8);
    assert.ok(tools.some((tool) => tool.name === "gateway_mcp_sessions"));
    assert.ok(tools.some((tool) => tool.name === "gateway_health"));

    const call = await rpc(
      gateway.base,
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "gateway_health", arguments: {} } },
      session,
      protocol,
    );
    assert.equal(call.status, 200);
    const result = parseJson(call.text, "tools/call").result;
    assert.notEqual(result?.["isError"], true);
    const health = JSON.parse(String(result?.["content"]?.[0]?.["text"] ?? "{}")) as { status?: string };
    assert.equal(health.status, "ok");

    const removed = await request(`${gateway.base}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": session, "mcp-protocol-version": protocol },
    });
    assert.equal(removed.status, 204);

    // A deleted session id is stale. The gateway now opens a fresh implicit
    // session instead of dead-ending the client with `-32600`.
    const revived = await rpc(gateway.base, { jsonrpc: "2.0", id: 13, method: "tools/list" }, session, protocol);
    assert.equal(revived.status, 200);
    const revivedSession = revived.headers["mcp-session-id"];
    assert.ok(typeof revivedSession === "string" && revivedSession.length >= 8, "missing revived Mcp-Session-Id");
    assert.notEqual(revivedSession, session);
    const revivedTools = (parseJson(revived.text, "revived tools/list").result?.["tools"] ?? []) as Array<{ name: string }>;
    assert.equal(revivedTools.length, 8);
  });

  await t.test("an unsupported protocol header is rejected", async () => {
    const response = await request(`${gateway.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "1999-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 400);
    assert.match(parseJson(response.text, "protocol rejection").error?.message ?? "", /Unsupported MCP-Protocol-Version/);
  });

  await t.test("legacy /sse sends an endpoint and answers on the stream", async () => {
    const stream = await openSse(`${gateway.base}/sse`);
    try {
      assert.equal(stream.status, 200);
      assert.match(String(stream.headers["content-type"]), /text\/event-stream/);
      const endpointFrame = await stream.wait((frame) => frame.event === "endpoint", "endpoint event");
      const endpoint = endpointFrame.data.trim();
      assert.ok(endpoint.startsWith("/messages?sessionId="), `endpoint ${endpoint}`);

      const reply = stream.wait((frame) => rpcId(frame, 21), "initialize reply");
      const sent = await request(new URL(endpoint, gateway.base).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mcp-test", version: "1.0.0" },
          },
        }),
      });
      assert.equal(sent.status, 202);
      const body = parseJson((await reply).data, "legacy initialize");
      assert.equal(body.result?.["serverInfo"]?.["name"], "zombie-gateway");
      assert.equal(body.result?.["protocolVersion"], "2024-11-05");
    } finally {
      stream.close();
    }
  });

  await t.test("the TLS listener answers initialize", async () => {
    const response = await rpc(
      tlsBase,
      {
        jsonrpc: "2.0",
        id: 30,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mcp-test", version: "1.0.0" },
        },
      },
      null,
      null,
    );
    assert.equal(response.status, 200);
    const body = parseJson(response.text, "https initialize");
    assert.equal(body.result?.["serverInfo"]?.["name"], "zombie-gateway");
    assert.equal(body.result?.["protocolVersion"], "2025-11-25");
    assert.equal(typeof response.headers["mcp-session-id"], "string");
  });
});
