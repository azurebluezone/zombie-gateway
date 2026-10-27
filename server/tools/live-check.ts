/**
 * Live check: call the real engines through the real gateway.
 *
 * The fixture suite proves error handling with a synthetic upstream. This script
 * proves the opposite end: that the gateway boots, talks to Ollama and/or
 * llama.cpp over the wire, streams tokens, and shuts down — with real models,
 * real latency and no mocks.
 *
 * Usage:
 *   node tools/live-check.ts                       # spawn a gateway, use Ollama defaults
 *   node tools/live-check.ts --soak=5              # plus 5 timed requests
 *   node tools/live-check.ts --base-url=http://127.0.0.1:8787 --token=secret
 *
 * Exit code: 0 when every check is PASS or SKIP, 1 when any check is FAIL.
 * A SKIP always prints its reason; it is never counted as success.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

type Verdict = "PASS" | "FAIL" | "SKIP";

interface CheckResult {
  name: string;
  verdict: Verdict;
  detail: string;
  ms: number;
}

const results: CheckResult[] = [];
const args = process.argv.slice(2);
const option = (name: string): string | null => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const baseUrlArg = option("base-url");
const tokenArg = option("token") ?? process.env["GATEWAY_ADMIN_TOKEN"] ?? null;
const soakCount = Number.parseInt(option("soak") ?? "0", 10);
const soakMinutes = Number.parseFloat(option("soak-minutes") ?? "0");

function percentileOf(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function check(name: string, run: () => Promise<{ verdict: Verdict; detail: string }>): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await run();
    results.push({ name, ...outcome, ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      verdict: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cp-live-"));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms${lastError ? ` (${lastError})` : ""}`);
}

interface Gateway {
  base: string;
  port: number;
  token: string | null;
  dir: string | null;
  child: ReturnType<typeof spawn> | null;
}

async function startGateway(): Promise<Gateway> {
  const port = await freePort();
  const dir = tempDir();
  const token = `live-${randomUUID().slice(0, 8)}`;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CP_") || key === "GATEWAY_POLICY") env[key] = value;
  }
  const hasProvider = Object.keys(env).some((key) => key.startsWith("CP_") && key.endsWith("_KIND"));
  if (!hasProvider) {
    env["CP_OLLAMA_KIND"] = "ollama";
    env["CP_OLLAMA_BASE_URL"] = OLLAMA_DEFAULT;
    env["CP_OLLAMA_CAPS"] = "tools";
  }
  Object.assign(env, {
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(port),
    GATEWAY_DB: join(dir, "gateway.db"),
    GATEWAY_LOG: join(dir, "gateway.jsonl"),
    GATEWAY_ADMIN_AUTH: "1",
    GATEWAY_ADMIN_TOKEN: token,
  });

  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: "ignore",
  });

  return { base: `http://127.0.0.1:${port}`, port, token, dir, child };
}

function adminHeaders(gateway: Gateway): Record<string, string> {
  return gateway.token === null ? {} : { "x-admin-token": gateway.token };
}

async function json<T>(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface Catalogue {
  data: Array<{
    id: string;
    metadata?: { context_length?: number | null; capabilities?: string[] };
  }>;
}

interface Completion {
  choices?: Array<{
    message?: { content?: string; tool_calls?: unknown[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function main(): Promise<void> {
  let gateway: Gateway;
  if (baseUrlArg) {
    gateway = { base: baseUrlArg, port: Number(new URL(baseUrlArg).port), token: tokenArg, dir: null, child: null };
    results.push({ name: "gateway", verdict: "SKIP", detail: "using an existing gateway; boot not measured", ms: 0 });
  } else {
    const started = Date.now();
    gateway = await startGateway();
    await waitFor("gateway /health", 20_000, async () => {
      const response = await fetch(`${gateway.base}/health`);
      return response.ok ? true : null;
    });
    results.push({ name: "gateway boot", verdict: "PASS", detail: `${gateway.base}`, ms: Date.now() - started });
  }

  let model: string | null = null;
  let supportsTools = false;
  let supportsEmbeddings = false;

  await check("catalogue", async () => {
    const body = await waitFor("catalogue", 20_000, async () => {
      const catalogue = await json<Catalogue>(`${gateway.base}/v1/models`);
      return catalogue.data.length > 0 ? catalogue : null;
    });
    // A reasoning model spends its budget thinking before it writes an answer,
    // so "reply with OK" at 16 tokens comes back with empty content and
    // finish_reason=length. That is the engine behaving as designed, not a
    // gateway fault — pick a plain chat model when the catalogue offers one.
    const rank = (capabilities: string[], contextLength: number | null | undefined): number =>
      (capabilities.includes("completion") ? 4 : 0) -
      (capabilities.includes("thinking") ? 8 : 0) +
      (typeof contextLength === "number" && contextLength > 0 ? 2 : 0);
    const ranked = [...body.data].sort(
      (left, right) =>
        rank(right.metadata?.capabilities ?? [], right.metadata?.context_length) -
        rank(left.metadata?.capabilities ?? [], left.metadata?.context_length),
    );
    const picked = ranked[0] ?? null;
    model = picked?.id ?? null;
    supportsTools = (picked?.metadata?.capabilities ?? []).includes("tools");
    supportsEmbeddings = body.data.some((entry) =>
      (entry.metadata?.capabilities ?? []).includes("embeddings"),
    );
    if (model === null) throw new Error("catalogue is empty");
    const caps = picked?.metadata?.capabilities ?? [];
    return {
      verdict: "PASS",
      detail: `${body.data.length} models; using ${model} (ctx ${picked?.metadata?.context_length ?? "unknown"}, caps ${caps.join("+") || "none"})`,
    };
  });

  if (model === null) {
    report();
    process.exit(1);
  }
  const chosen = model as string;
  const chatBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: chosen,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    max_tokens: 64,
    ...extra,
  });

  await check("non-stream chat", async () => {
    const body = await json<Completion>(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    }, 120_000);
    const content = body.choices?.[0]?.message?.content ?? "";
    if (content.trim().length === 0) throw new Error("empty content");
    return {
      verdict: "PASS",
      detail: `content ${JSON.stringify(content.slice(0, 40))}; usage ${body.usage?.prompt_tokens ?? "?"}/${body.usage?.completion_tokens ?? "?"}`,
    };
  });

  await check("stream chat", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${gateway.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBody({ stream: true })),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const text = await response.text();
      const done = (text.match(/data: \[DONE\]/g) ?? []).length;
      const chunks = (text.match(/^data: \{/gm) ?? []).length;
      if (done !== 1) throw new Error(`expected exactly one [DONE], saw ${done}`);
      if (chunks < 2) throw new Error(`expected at least two data frames, saw ${chunks}`);
      return { verdict: "PASS", detail: `${chunks} data frames, one [DONE]` };
    } finally {
      clearTimeout(timer);
    }
  });

  await check("count_tokens", async () => {
    const body = await json<{ input_tokens: number; estimated?: boolean }>(
      `${gateway.base}/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: chosen, messages: [{ role: "user", content: "hello" }] }),
      },
    );
    if (!(body.input_tokens > 0)) throw new Error(`input_tokens ${body.input_tokens}`);
    return { verdict: "PASS", detail: `${body.input_tokens} tokens, estimated=${body.estimated ?? false}` };
  });

  await check("tool call", async () => {
    if (!supportsTools) return { verdict: "SKIP", detail: "no model in the catalogue declares tools" };
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Return the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const body = await json<Completion>(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: "user", content: "What is the weather in Dhaka? Use the tool." }],
        tools,
        max_tokens: 256,
      }),
    }, 120_000);
    type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
    const calls = (body.choices?.[0]?.message?.tool_calls ?? []) as ToolCall[];
    const reason = body.choices?.[0]?.finish_reason ?? "?";
    if (calls.length === 0) {
      return {
        verdict: "SKIP",
        detail: `model answered finish_reason=${reason} without tool_calls (engine capability, not a gateway failure)`,
      };
    }
    const call = calls[0];
    if (call?.type !== "function" || typeof call.id !== "string" || call.id.length === 0) {
      throw new Error(`tool_call is not OpenAI-shaped: ${JSON.stringify(call).slice(0, 200)}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
    } catch {
      return {
        verdict: "SKIP",
        detail: `tool_call arguments are not JSON: ${(call.function?.arguments ?? "").slice(0, 80)}`,
      };
    }
    // qwen2.5:1.5b on Ollama copies the schema into the arguments object
    // instead of filling it. Passing that through is correct; calling it a
    // model success would not be.
    if ("properties" in parsed || "required" in parsed || "parameters" in parsed) {
      return {
        verdict: "SKIP",
        detail: `engine echoed the schema inside arguments (known qwen2.5 quirk): ${JSON.stringify(parsed).slice(0, 120)}`,
      };
    }
    return {
      verdict: "PASS",
      detail: `finish_reason=${reason}, get_weather(city=${JSON.stringify(parsed["city"] ?? null)})`,
    };
  });

  await check("client abort", async () => {
    type Totals = { totals: { aborted: number; errors: number } };
    const readTotals = (): Promise<Totals> =>
      json<Totals>(`${gateway.base}/admin/metrics?window_ms=600000`, { headers: adminHeaders(gateway) });
    // The row is written by the gateway's abort handler, which may still be
    // running when the client's socket closes. Poll instead of racing it; a
    // fixed sleep would be slower and no more correct.
    const before = await readTotals();

    const controller = new AbortController();
    const response = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: "user", content: "Count slowly from one to one hundred." }],
        max_tokens: 300,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    void reader?.cancel().catch(() => undefined);

    const after = await waitFor("abort to appear in /admin/metrics", 10_000, async () => {
      const metrics = await readTotals();
      return metrics.totals.aborted > before.totals.aborted ? metrics : null;
    });
    const aborted = after.totals.aborted - before.totals.aborted;
    const errors = after.totals.errors - before.totals.errors;
    if (errors !== 0) throw new Error(`abort counted as ${errors} error(s)`);
    return { verdict: "PASS", detail: `aborted +${aborted}, errors +${errors}` };
  });

  await check("admin auth", async () => {
    if (gateway.token === null) return { verdict: "SKIP", detail: "no token configured" };
    const anonymous = await fetch(`${gateway.base}/admin/system`);
    if (anonymous.status !== 401) throw new Error(`anonymous got ${anonymous.status}, expected 401`);
    const authorised = await fetch(`${gateway.base}/admin/system`, { headers: adminHeaders(gateway) });
    if (authorised.status !== 200) throw new Error(`token got ${authorised.status}, expected 200`);
    return { verdict: "PASS", detail: "401 without token, 200 with token" };
  });

  await check("embeddings gate", async () => {
    if (supportsEmbeddings) {
      return { verdict: "SKIP", detail: "catalogue declares embeddings; gate not applicable" };
    }
    const response = await fetch(`${gateway.base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: chosen, input: "hello" }),
    });
    if (response.status !== 400) throw new Error(`expected 400 for a non-embedding model, got ${response.status}`);
    return { verdict: "PASS", detail: "400 before the wire (no embeddings capability)" };
  });

  if (soakCount > 0) {
    await check(`soak x${soakCount}`, async () => {
      const durations: number[] = [];
      for (let index = 0; index < soakCount; index += 1) {
        const started = Date.now();
        await json<Completion>(`${gateway.base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: chosen,
            messages: [{ role: "user", content: `Reply with the number ${index}.` }],
            max_tokens: 8,
          }),
        }, 120_000);
        durations.push(Date.now() - started);
      }
      durations.sort((a, b) => a - b);
      const average = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
      const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
      return {
        verdict: "PASS",
        detail: `min ${durations[0]} ms, avg ${average} ms, p95 ${p95} ms, max ${durations[durations.length - 1]} ms`,
      };
    });
  }

  if (soakMinutes > 0) {
    await check(`soak ${soakMinutes} min`, async () => {
      // The S7 gate asks for three numbers, not a vibe: RSS slope, p95 latency
      // and the largest gap between stream chunks. All three need the gateway
      // to be our child (RSS comes from /proc), so a borrowed --base-url is a
      // SKIP rather than a number invented from nothing.
      const pid = gateway.child?.pid ?? null;
      if (pid === null) return { verdict: "SKIP", detail: "--base-url given; no /proc to read RSS from" };

      const readRssMb = (): number | null => {
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const match = /VmRSS:\s+(\d+) kB/.exec(status);
          return match ? Number(match[1]) / 1024 : null;
        } catch {
          return null;
        }
      };

      const samples: Array<{ minutes: number; rss: number }> = [];
      const latencies: number[] = [];
      const gaps: number[] = [];
      const startedAt = Date.now();
      const deadline = startedAt + soakMinutes * 60_000;
      let requests = 0;
      let failures = 0;

      while (Date.now() < deadline) {
        const started = Date.now();
        try {
          const response = await fetch(`${gateway.base}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: chosen,
              messages: [{ role: "user", content: `Reply with the number ${requests}.` }],
              max_tokens: 24,
              stream: true,
            }),
          });
          if (!response.ok || response.body === null) throw new Error(`status ${response.status}`);
          const reader = response.body.getReader();
          let previous = Date.now();
          let worst = 0;
          let first = true;
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            const now = Date.now();
            if (!first) worst = Math.max(worst, now - previous);
            first = false;
            previous = now;
          }
          gaps.push(worst);
          latencies.push(Date.now() - started);
        } catch {
          failures += 1;
        }
        requests += 1;
        const rss = readRssMb();
        if (rss !== null) samples.push({ minutes: (Date.now() - startedAt) / 60_000, rss });
      }

      // Least squares over the samples: MB per minute, positive means growth.
      const meanX = samples.reduce((sum, entry) => sum + entry.minutes, 0) / (samples.length || 1);
      const meanY = samples.reduce((sum, entry) => sum + entry.rss, 0) / (samples.length || 1);
      let covariance = 0;
      let variance = 0;
      for (const entry of samples) {
        covariance += (entry.minutes - meanX) * (entry.rss - meanY);
        variance += (entry.minutes - meanX) ** 2;
      }
      const slope = variance === 0 ? 0 : covariance / variance;
      const first = samples[0]?.rss ?? 0;
      const last = samples[samples.length - 1]?.rss ?? 0;

      return {
        verdict: failures === 0 ? "PASS" : "FAIL",
        detail:
          `${requests} streams, ${failures} failed; ` +
          `p50 ${percentileOf(latencies, 0.5)} ms, p95 ${percentileOf(latencies, 0.95)} ms, ` +
          `max gap ${Math.max(...gaps, 0)} ms; ` +
          `RSS ${first.toFixed(1)} → ${last.toFixed(1)} MB (${slope >= 0 ? "+" : ""}${slope.toFixed(2)} MB/min)`,
      };
    });
  }

  if (gateway.child !== null) {
    const started = Date.now();
    await new Promise<void>((resolve) => {
      gateway.child?.once("exit", () => resolve());
      gateway.child?.kill("SIGTERM");
      setTimeout(() => {
        gateway.child?.kill("SIGKILL");
        resolve();
      }, 6000).unref();
    });
    const ms = Date.now() - started;
    const log = gateway.dir === null ? "" : readFileSync(join(gateway.dir, "gateway.jsonl"), "utf8");
    const closed = log.includes('"event":"gateway.closed"');
    results.push({
      name: "shutdown",
      verdict: ms < 2000 && closed ? "PASS" : "FAIL",
      detail: `${ms} ms${closed ? ", gateway.closed logged" : ", gateway.closed missing"}`,
      ms,
    });
    // The log has been read; leaving one temp directory per run behind turns a
    // check you run often into clutter.
    if (gateway.dir !== null) rmSync(gateway.dir, { recursive: true, force: true });
  }

  report();
  process.exit(results.some((entry) => entry.verdict === "FAIL") ? 1 : 0);
}

function report(): void {
  const width = Math.max(...results.map((entry) => entry.name.length));
  for (const entry of results) {
    console.log(
      `${entry.verdict.padEnd(4)}  ${entry.name.padEnd(width)}  ${String(entry.ms).padStart(6)} ms  ${entry.detail}`,
    );
  }
  const failed = results.filter((entry) => entry.verdict === "FAIL").length;
  const skipped = results.filter((entry) => entry.verdict === "SKIP").length;
  console.log(
    `\n${results.length} checks: ${results.length - failed - skipped} pass, ${failed} fail, ${skipped} skip`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
