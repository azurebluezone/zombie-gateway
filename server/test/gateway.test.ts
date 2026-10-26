/**
 * End-to-end tests against a fixture upstream.
 *
 * What these prove: routing, the error envelope, timeout mapping, client-abort
 * propagation, body limits, the admin auth switch and one admin mutation cycle.
 * What they do not prove: any real engine's answer quality. That evidence lives
 * in docs/STEPS.md and docs/LLAMACPP-LIVE.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startFixture, startGateway } from "./fixture.ts";

const MODEL = "fix/fixture-1";

function chatBody(content: string, stream = false): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: "user", content }],
    max_tokens: 32,
    stream,
  };
}

test("health reports identity and counts", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/health`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body["status"], "ok");
  assert.equal(response.headers.get("x-system-identity"), "Compatible Providers");
  assert.ok(response.headers.get("x-powered-by"));
});

test("catalogue qualifies the model id and keeps the engine's context length", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    CP_FIX_CAPS: "tools",
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/models`);
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const model = body.data[0] as {
    id: string;
    metadata: { context_length: number; capabilities: string[] };
  };

  assert.equal(response.status, 200);
  assert.equal(model.id, MODEL);
  assert.equal(model.metadata.context_length, 2048);
  assert.deepEqual(model.metadata.capabilities, ["completion", "tools"]);
});

test("non-stream chat returns the completion and the ledger headers", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("hello")),
  });
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.choices[0]?.message.content, "fixture ok");
  assert.equal(body.usage.prompt_tokens, 20);
  assert.equal(response.headers.get("x-context-limit"), "2048");
  assert.match(response.headers.get("x-policy") ?? "", /^(applied;tokens=\d+|present|off|disabled)$/);
});

test("stream chat forwards SSE frames and one terminator", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("hello", true)),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
  assert.match(text, /fixture /);
  assert.match(text, /"prompt_tokens":20/);
});

test("an upstream 500 keeps the status, the code and the upstream message", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("MODE:500")),
  });
  const body = (await response.json()) as { error: { code: string; message: string } };

  assert.equal(response.status, 500);
  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "fixture exploded");
});

test("socket inactivity is a 504 provider_timeout", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    CP_FIX_TIMEOUT_MS: "1000",
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("MODE:SLOW")),
  });
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 504);
  assert.equal(body.error.code, "provider_timeout");
});

test("an unreachable provider is a 502 provider_unreachable", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_DEAD_KIND: "openai", CP_DEAD_BASE_URL: fixture.base });
  await fixture.close();
  t.after(() => gateway.stop());

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...chatBody("hello"), model: "dead/fixture-1" }),
  });
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 502);
  assert.equal(body.error.code, "provider_unreachable");
});

test("a client abort tears down the upstream stream", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const controller = new AbortController();
  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("MODE:ABORT", true)),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);

  const reader = response.body?.getReader();
  await reader?.read();
  // Abort the reader without awaiting cancel(): cancellation settles when the
  // socket tears down, and that is exactly the gap this test is measuring.
  controller.abort();
  void reader?.cancel().catch(() => undefined);

  const reason = await Promise.race([
    fixture.aborted,
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 4000)),
  ]);
  assert.equal(reason, "gateway closed the upstream stream");
});

test("a body over the limit is a 413, not a silent truncation", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    GATEWAY_BODY_LIMIT_BYTES: "512",
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const response = await fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody("x".repeat(2000))),
  });
  const body = (await response.json()) as { error: { message: string } };

  assert.equal(response.status, 413);
  assert.match(body.error.message, /exceeds 512 bytes/);
});

test("shutdown is prompt even with an idle keep-alive connection", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({ CP_FIX_KIND: "openai", CP_FIX_BASE_URL: fixture.base });

  // Consume a response and leave the socket idle: this is the state a browser
  // or SDK keeps between calls, and the state that made `server.close` wait.
  await (await fetch(`${gateway.base}/health`)).json();

  const started = Date.now();
  await gateway.stop();
  const elapsed = Date.now() - started;
  await fixture.close();

  assert.ok(elapsed < 1500, `shutdown took ${elapsed}ms; idle sockets are not being closed`);
});

test("admin auth is one switch: 401 without the token, 200 with it", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    GATEWAY_ADMIN_AUTH: "1",
    GATEWAY_ADMIN_TOKEN: "test-token",
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const anonymous = await fetch(`${gateway.base}/admin/system`);
  assert.equal(anonymous.status, 401);

  const authorised = await fetch(`${gateway.base}/admin/system`, {
    headers: { "x-admin-token": "test-token" },
  });
  const body = (await authorised.json()) as { policy: { enabled: boolean } };

  assert.equal(authorised.status, 200);
  assert.equal(typeof body.policy.enabled, "boolean");
});

test("admin can create, toggle and purge a provider without a restart", async (t) => {
  const fixture = await startFixture();
  const gateway = await startGateway({
    CP_FIX_KIND: "openai",
    CP_FIX_BASE_URL: fixture.base,
    GATEWAY_ADMIN_AUTH: "0",
  });
  t.after(async () => {
    await gateway.stop();
    await fixture.close();
  });

  const headers = { "content-type": "application/json" };
  const created = await fetch(`${gateway.base}/admin/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: "extra",
      kind: "openai",
      base_url: "https://example.invalid/v1",
    }),
  });
  assert.equal(created.status, 201);

  const disabled = await fetch(`${gateway.base}/admin/providers/extra/disable`, { method: "POST" });
  assert.equal(disabled.status, 200);

  const list = (await (await fetch(`${gateway.base}/admin/providers?enabled=0`)).json()) as {
    data: Array<{ id: string; enabled: boolean }>;
  };
  assert.ok(list.data.some((provider) => provider.id === "extra" && provider.enabled === false));

  const purged = await fetch(`${gateway.base}/admin/providers/extra?purge=1`, { method: "DELETE" });
  assert.equal(purged.status, 200);

  const after = (await (await fetch(`${gateway.base}/admin/providers`)).json()) as {
    data: Array<{ id: string }>;
  };
  assert.ok(!after.data.some((provider) => provider.id === "extra"));
});
