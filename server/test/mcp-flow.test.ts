/**
 * MCP flow and system identity.
 *
 * What these prove:
 *  - a client that never sent initialize still gets a session and can list tools
 *    (the old `-32600 Mcp-Session-Id header is required` dead end is gone);
 *  - initialize records clientInfo, and the registry is visible on the
 *    authenticated /admin/mcp/sessions route and through the gateway_mcp_sessions
 *    tool, together with the full tool list and its count;
 *  - a chat completion reaches the fixture upstream with a system identity block,
 *    without duplicating it when the prompt already carries the marker.
 *
 * What they do not prove: any live provider's answer quality. The upstream is
 * the fixture; live provider evidence lives in docs/STEPS.md and docs/LLAMACPP-LIVE.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startFixture, startGateway } from "./fixture.ts";

const TOKEN = "mcp-flow-token";

interface JsonBody {
  [key: string]: any;
}

async function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? (JSON.parse(text) as JsonBody) : {},
  };
}

function rpc(
  base: string,
  payload: Record<string, unknown>,
  session?: string | null,
  protocol?: string | null,
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  if (protocol) headers["mcp-protocol-version"] = protocol;
  return call(`${base}/mcp`, { method: "POST", headers, body: payload });
}

test("MCP flow: implicit connect, client registry and authenticated sessions", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    GATEWAY_ADMIN_AUTH: "1",
    GATEWAY_ADMIN_TOKEN: TOKEN,
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  let clientSession = "";

  await t.test("tools/list works without a prior initialize and opens a session", async () => {
    const response = await rpc(gateway.base, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(response.status, 200);
    const session = response.headers.get("mcp-session-id");
    assert.ok(typeof session === "string" && session.length > 8, "missing implicit Mcp-Session-Id");
    assert.equal(response.headers.get("mcp-protocol-version"), "2025-11-25");
    const tools = (response.body.result?.tools ?? []) as Array<{ name: string }>;
    assert.equal(tools.length, 8);
    assert.ok(tools.some((tool) => tool.name === "gateway_health"));
    assert.ok(tools.some((tool) => tool.name === "gateway_mcp_sessions"));
  });

  await t.test("initialize records the client and the registry is authenticated", async () => {
    const init = await rpc(gateway.base, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe-client", version: "2.3.4" },
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result?.protocolVersion, "2025-06-18");
    clientSession = String(init.headers.get("mcp-session-id"));
    const protocol = String(init.headers.get("mcp-protocol-version"));

    const note = await rpc(
      gateway.base,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      clientSession,
      protocol,
    );
    assert.equal(note.status, 202);

    const anonymous = await call(`${gateway.base}/admin/mcp/sessions`);
    assert.equal(anonymous.status, 401);

    const registry = await call(`${gateway.base}/admin/mcp/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(registry.status, 200);
    assert.equal(registry.body.object, "mcp.sessions");
    assert.equal(registry.body.tools_total, 8);
    assert.ok((registry.body.tools as string[]).includes("gateway_mcp_sessions"));
    const rows = registry.body.sessions as Array<Record<string, any>>;
    const row = rows.find((entry) => entry.client?.name === "probe-client");
    assert.ok(row, `probe-client missing from ${JSON.stringify(rows)}`);
    assert.equal(row["client"]["version"], "2.3.4");
    assert.equal(row["protocol"], "2025-06-18");
    assert.equal(row["transport"], "http");
    assert.equal(row["initialized"], true);
    assert.ok(Number(row["requests"]) >= 2);
  });

  await t.test("the MCP tools execute against the authenticated admin API", async () => {
    const list = await rpc(
      gateway.base,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gateway_mcp_sessions", arguments: {} } },
      clientSession,
      "2025-06-18",
    );
    assert.equal(list.status, 200);
    const result = list.body.result;
    assert.notEqual(result?.isError, true);
    const sessions = JSON.parse(String(result?.content?.[0]?.text ?? "{}")) as JsonBody;
    assert.equal(sessions["tools_total"], 8);
    assert.ok(
      (sessions["sessions"] as Array<Record<string, any>>).some((row) => row["client"]?.["name"] === "probe-client"),
      "gateway_mcp_sessions did not return the connected client",
    );

    const health = await rpc(
      gateway.base,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gateway_health", arguments: {} } },
      clientSession,
      "2025-06-18",
    );
    assert.equal(health.status, 200);
    const healthBody = JSON.parse(String(health.body.result?.content?.[0]?.text ?? "{}")) as JsonBody;
    assert.equal(healthBody["status"], "ok");

    const removed = await call(`${gateway.base}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": clientSession, "mcp-protocol-version": "2025-06-18" },
    });
    assert.equal(removed.status, 204);
  });

  await t.test("client usage page and admin MCP list are populated", async () => {
    // The admin table must list the registry, not only tools that happened to
    // be called: a fresh gateway would otherwise look empty.
    const admin = await call(`${gateway.base}/admin/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(admin.status, 200);
    assert.equal((admin.body.tools as unknown[]).length, 8);
    const declared = (admin.body.tools as Array<Record<string, any>>).map((row) => row.tool_name);
    assert.ok(declared.includes("gateway_health"));
    assert.ok(declared.includes("gateway_chat"));
    const health = (admin.body.tools as Array<Record<string, any>>).find((row) => row.tool_name === "gateway_health");
    assert.ok(health, "gateway_health missing from the MCP tool table");
    assert.ok(Number(health.calls) >= 1, "gateway_health call was not counted");

    const json = await call(`${gateway.base}/client.json`);
    assert.equal(json.status, 200);
    assert.equal(json.body.object, "mcp.client_usage");
    assert.equal(json.body.tools_total, 8);
    assert.equal((json.body.tools as unknown[]).length, 8);

    const clients = json.body.clients as Array<Record<string, any>>;
    const probe = clients.find((entry) => entry.client?.name === "probe-client");
    assert.ok(probe, `probe-client missing from ${JSON.stringify(clients)}`);
    const used = probe.tools_used as Array<Record<string, any>>;
    assert.ok(
      used.some((use) => use.name === "gateway_health" && Number(use.calls) >= 1),
      `probe-client tools_used lacks gateway_health: ${JSON.stringify(used)}`,
    );

    const recent = json.body.recent_calls as Array<Record<string, any>>;
    assert.ok(
      recent.some((row) => row.client_name === "probe-client" && row.tool === "gateway_health"),
      "recent_calls has no row attributed to probe-client",
    );

    const page = await fetch(`${gateway.base}/client`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get("content-type")), /text\/html/);
    const html = await page.text();
    assert.ok(html.includes("probe-client"), "the page does not name the connected client");
    assert.ok(html.includes("gateway_health"), "the page does not list the used tool");
    assert.ok(!html.includes(clientSession), "the full MCP session id must never be rendered");
  });

  await t.test("gateway_chat executes a real model call through the gateway", async () => {
    // No initialize: the implicit session proves the stateless path again, and
    // gateway_chat proves the MCP tool can reach the model, not only the admin
    // read models. The fixture echoes the prompt, so the identity block is
    // checked on the exact message list the model would have read.
    const response = await rpc(gateway.base, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "gateway_chat",
        arguments: { model: "fix/fixture-1", prompt: "MODE:ECHO_MESSAGES", max_tokens: 64 },
      },
    });
    assert.equal(response.status, 200);
    const result = response.body.result;
    assert.notEqual(result?.isError, true, JSON.stringify(result));
    const answer = JSON.parse(String(result?.content?.[0]?.text ?? "{}")) as JsonBody;
    assert.equal(answer["object"], "chat.completion");
    assert.equal(answer["status"], 200);
    assert.equal(answer["choices"][0]["message"]["role"], "assistant");
    assert.equal(answer["choices"][0]["finish_reason"], "stop");
    assert.ok(Number(answer["usage"]["total_tokens"]) >= 1);
    assert.ok(Number(answer["duration_ms"]) >= 0);
    const echoed = JSON.parse(String(answer["choices"][0]["message"]["content"])) as Array<Record<string, any>>;
    assert.ok(
      echoed.some(
        (message) => message["role"] === "system" && String(message["content"]).includes("[system-identity]"),
      ),
      "the model call did not carry the system identity block",
    );
  });
});

test("identity block reaches the model and is not duplicated", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const completion = await call(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    body: {
      model: "fix/fixture-1",
      messages: [{ role: "user", content: "MODE:ECHO_MESSAGES" }],
      max_tokens: 64,
    },
  });
  assert.equal(completion.status, 200);
  assert.equal(completion.body["object"], "chat.completion");
  assert.equal(completion.body["choices"][0]["finish_reason"], "stop");
  assert.ok(Number(completion.body["usage"]["total_tokens"]) >= 1);

  const health = await call(`${gateway.base}/health`);
  const systemName = health.headers.get("x-system-identity") ?? "";
  assert.ok(systemName.length > 0, "gateway did not publish x-system-identity");

  const echoed = JSON.parse(String(completion.body["choices"][0]["message"]["content"])) as Array<Record<string, any>>;
  const systems = echoed.filter(
    (message) => message["role"] === "system" && String(message["content"]).includes("[system-identity]"),
  );
  assert.equal(systems.length, 1, `expected one identity block, got ${systems.length}`);
  assert.ok(
    String(systems[0]?.["content"]).includes(systemName),
    `identity block does not carry "${systemName}"`,
  );
  assert.ok(echoed.some((message) => message["role"] === "user" && message["content"] === "MODE:ECHO_MESSAGES"));

  const replay = await call(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    body: {
      model: "fix/fixture-1",
      messages: [
        { role: "system", content: "[system-identity] client supplied" },
        { role: "user", content: "MODE:ECHO_MESSAGES" },
      ],
      max_tokens: 64,
    },
  });
  const replayed = JSON.parse(String(replay.body["choices"][0]["message"]["content"])) as Array<Record<string, any>>;
  const marked = replayed.filter(
    (message) => message["role"] === "system" && String(message["content"]).includes("[system-identity]"),
  );
  assert.equal(marked.length, 1, "a replayed marker must not stack a second identity block");
});
