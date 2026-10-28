#!/usr/bin/env node
/**
 * Transport conformance check: HTTP, SSE and UDS against the official shapes.
 *
 * Each check sends one real request through the gateway, validates the response
 * against the documented OpenAI / Anthropic format, then looks for the same
 * x-request-id in logs/access.jsonl. A response that never reached the log is
 * not proven, so it counts as a failure.
 *
 * Exit 0 = every check passed; 1 = at least one failed.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GATEWAY_PORT ?? 5252);
const SOCKET = process.env.GATEWAY_SOCKET ?? "/tmp/gateway.sock";
const MODEL = process.env.CHECK_MODEL ?? "llamacpp/llama-3.2-1b-abliterated";
const ACCESS_LOG = path.join(SERVER_DIR, "logs", "access.jsonl");
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 180000);

function request({ socketPath, urlPath, method = "GET", body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = {
      method,
      path: urlPath,
      headers: {
        accept: "application/json",
        ...(payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {}),
        ...headers,
      },
      ...(socketPath ? { socketPath } : { host: HOST, port: PORT }),
    };
    const started = process.hrtime.bigint();
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
          ms: Number(process.hrtime.bigint() - started) / 1e6,
        }),
      );
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSse(text) {
  const events = [];
  let done = false;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;
    let name = null;
    const data = [];
    for (const line of lines) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      else if (line.startsWith(":")) continue;
      else throw new Error(`unexpected SSE line: ${line.slice(0, 80)}`);
    }
    const joined = data.join("\n");
    if (joined === "[DONE]") {
      done = true;
      continue;
    }
    events.push({ name, data: joined ? JSON.parse(joined) : null });
  }
  return { events, done };
}

const results = [];
const isInt = (v) => Number.isInteger(v) && v >= 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openaiNonStream(socketPath, label) {
  const res = await request({
    socketPath,
    urlPath: "/v1/chat/completions",
    method: "POST",
    body: {
      model: MODEL,
      messages: [{ role: "user", content: "Reply with one short word." }],
      max_tokens: 6,
    },
  });
  assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const body = JSON.parse(res.text);
  assert(body.object === "chat.completion", `object=${body.object}`);
  assert(typeof body.id === "string" && body.id.length > 0, "missing id");
  assert(typeof body.created === "number", "missing created");
  assert(body.model === MODEL, `model=${body.model}`);
  assert(Array.isArray(body.choices) && body.choices.length === 1, "choices shape");
  const choice = body.choices[0];
  assert(choice.index === 0, "choice.index");
  assert(choice.message?.role === "assistant", "message.role");
  assert(typeof choice.message?.content === "string", "message.content");
  assert(["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason), `finish_reason=${choice.finish_reason}`);
  const usage = body.usage ?? {};
  assert(isInt(usage.prompt_tokens) && isInt(usage.completion_tokens), "usage counters");
  assert(usage.total_tokens === usage.prompt_tokens + usage.completion_tokens, "usage total");
  return {
    transport: label,
    request_id: res.headers["x-request-id"] ?? null,
    content: choice.message.content.slice(0, 40),
    tokens: usage.total_tokens,
    ms: Math.round(res.ms),
  };
}

async function openaiStream(socketPath, label) {
  const res = await request({
    socketPath,
    urlPath: "/v1/chat/completions",
    method: "POST",
    body: {
      model: MODEL,
      messages: [{ role: "user", content: "Count one two three." }],
      max_tokens: 8,
      stream: true,
    },
  });
  assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  assert((res.headers["content-type"] ?? "").includes("text/event-stream"), `content-type=${res.headers["content-type"]}`);
  const { events, done } = parseSse(res.text);
  assert(done, "stream did not end with data: [DONE]");
  assert(events.length >= 3, `only ${events.length} events`);
  assert(events.every((e) => e.data?.object === "chat.completion.chunk"), "chunk object");
  assert(events[0].data.choices?.[0]?.delta?.role === "assistant", "first delta role");
  const deltas = events.flatMap((e) => e.data.choices ?? []).map((c) => c.delta ?? {});
  assert(deltas.every((d) => d.content === undefined || typeof d.content === "string"), "delta.content must be a string when present");
  assert(deltas.every((d) => d.role === undefined || typeof d.role === "string"), "delta.role must be a string when present");
  const text = events.flatMap((e) => e.data.choices ?? []).map((c) => c.delta?.content).filter((v) => typeof v === "string").join("");
  assert(text.length > 0, "no delta content");
  const finish = events.flatMap((e) => e.data.choices ?? []).map((c) => c.finish_reason).filter(Boolean);
  assert(finish.includes("stop") || finish.includes("length"), `finish_reason=${finish.join(",")}`);
  return {
    transport: label,
    events: events.length,
    request_id: res.headers["x-request-id"] ?? null,
    text: text.slice(0, 40),
    done,
    ms: Math.round(res.ms),
  };
}

async function anthropicNonStream(socketPath, label) {
  const res = await request({
    socketPath,
    urlPath: "/v1/messages",
    method: "POST",
    body: {
      model: MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with one short word." }],
    },
  });
  assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const body = JSON.parse(res.text);
  assert(body.type === "message", `type=${body.type}`);
  assert(body.role === "assistant", `role=${body.role}`);
  assert(typeof body.id === "string" && body.id.startsWith("msg_"), `id=${body.id}`);
  assert(Array.isArray(body.content) && body.content.length > 0, "content array");
  assert(body.content[0].type === "text" && typeof body.content[0].text === "string", "text block");
  assert(["end_turn", "max_tokens", "stop_sequence", "tool_use"].includes(body.stop_reason), `stop_reason=${body.stop_reason}`);
  assert(isInt(body.usage?.input_tokens) && isInt(body.usage?.output_tokens), "usage counters");
  return {
    transport: label,
    request_id: res.headers["x-request-id"] ?? null,
    text: body.content[0].text.slice(0, 40),
    stop_reason: body.stop_reason,
    ms: Math.round(res.ms),
  };
}

async function anthropicStream(socketPath, label) {
  const res = await request({
    socketPath,
    urlPath: "/v1/messages",
    method: "POST",
    body: {
      model: MODEL,
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "Count one two three." }],
    },
  });
  assert(res.status === 200, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  assert((res.headers["content-type"] ?? "").includes("text/event-stream"), `content-type=${res.headers["content-type"]}`);
  const { events } = parseSse(res.text);
  const names = events.map((e) => e.name);
  for (const required of ["message_start", "content_block_start", "content_block_delta", "message_stop"]) {
    assert(names.includes(required), `missing event: ${required} (got ${names.slice(0, 6).join(",")})`);
  }
  const typed = events.filter((e) => e.name);
  assert(typed.every((e) => e.data?.type === e.name), "event name and data.type disagree");
  const text = events
    .filter((e) => e.name === "content_block_delta")
    .map((e) => e.data?.delta?.text)
    .filter((v) => typeof v === "string")
    .join("");
  assert(text.length > 0, "no content_block_delta text");
  return {
    transport: label,
    events: events.length,
    request_id: res.headers["x-request-id"] ?? null,
    text: text.slice(0, 40),
    ms: Math.round(res.ms),
  };
}

const CASES = [
  ["openai.nonstream.http", () => openaiNonStream(undefined, "http")],
  ["openai.stream.http", () => openaiStream(undefined, "http")],
  ["openai.nonstream.uds", () => openaiNonStream(SOCKET, "uds")],
  ["openai.stream.uds", () => openaiStream(SOCKET, "uds")],
  ["anthropic.nonstream.http", () => anthropicNonStream(undefined, "http")],
  ["anthropic.stream.http", () => anthropicStream(undefined, "http")],
  ["anthropic.stream.uds", () => anthropicStream(SOCKET, "uds")],
];

for (const [name, fn] of CASES) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS  ${name}  ${JSON.stringify(detail)}`);
  } catch (error) {
    const message = String(error?.message ?? error);
    results.push({ check: name, ok: false, ms: Date.now() - started, error: message });
    console.log(`FAIL  ${name}  ${message}`);
  }
}

// The access line is written on the server's 'finish' event, which can land a
// few milliseconds after the client has read the last byte. Poll instead of
// asserting on a single read, otherwise the check reports a race as a failure.
const ids = results.map((r) => r.detail?.request_id).filter(Boolean);
const seen = new Set();
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  let text = "";
  try {
    text = readFileSync(ACCESS_LOG, "utf8");
  } catch (error) {
    results.push({ check: "access-log.readable", ok: false, error: String(error.message) });
    console.log(`FAIL  access-log.readable  ${error.message}`);
    break;
  }
  for (const id of ids) {
    if (text.includes(`"request_id":"${id}"`)) seen.add(id);
  }
  if (seen.size === ids.length) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
for (const id of ids) {
  const found = seen.has(id);
  results.push({ check: `access-log.${id.slice(0, 8)}`, ok: found });
  console.log(`${found ? "PASS" : "FAIL"}  access-log  ${id}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
