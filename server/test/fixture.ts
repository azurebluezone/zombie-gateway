/**
 * Test harness: a fixture upstream and a spawned gateway.
 *
 * The fixture exists because a real provider will not return 500 on demand,
 * stall past a timeout, or drop a socket mid-stream. It is a test double for
 * failure injection only; every claim about Ollama or llama.cpp lives in
 * docs/STEPS.md with its own commands and outputs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cp-${prefix}-`));
}

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function waitForHealth(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway did not become healthy at ${base}`);
}

export interface Gateway {
  base: string;
  port: number;
  dir: string;
  stop: () => Promise<void>;
}

/**
 * Starts the real entry point. Environment is inherited minus every CP_* group
 * so a developer's own providers cannot leak into a test run.
 */
export async function startGateway(extraEnv: Record<string, string>): Promise<Gateway> {
  const port = await freePort();
  const dir = tempDir("gw");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("CP_") && key !== "GATEWAY_POLICY") env[key] = value;
  }
  Object.assign(env, {
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(port),
    GATEWAY_DB: join(dir, "gateway.db"),
    GATEWAY_LOG: join(dir, "gateway.jsonl"),
    GATEWAY_ADMIN_AUTH: "0",
    ...extraEnv,
  });

  const child: ChildProcess = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    base,
    port,
    dir,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        // A watchdog, not the expected path: the gateway's own force-close runs
        // at 3 s, so the outer limit sits above it instead of racing it.
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 6000).unref();
      }),
  };
}

export interface Fixture {
  base: string;
  /** Resolves when the gateway tears down an upstream connection mid-stream. */
  aborted: Promise<string>;
  close: () => Promise<void>;
}

/**
 * Upstream behaviour is chosen by a marker inside the user message, so the
 * gateway needs no test-only code path:
 *   MODE:500 | MODE:SLOW | MODE:ABORT | MODE:PREMATURE
 */
export async function startFixture(): Promise<Fixture> {
  let reportAbort: (reason: string) => void = () => undefined;
  const aborted = new Promise<string>((resolve) => {
    reportAbort = resolve;
  });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "fixture-1", owned_by: "fixture", context_length: 2048 }],
        }),
      );
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        stream?: boolean;
        messages?: Array<{ content?: unknown }>;
      };
      const text = (body.messages ?? [])
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      const stream = body.stream === true;

      // Non-stream premature death: half a JSON body, then the socket is gone.
      // A parser can only report "unexpected end of input"; the gateway should
      // report that the provider left, with a status the client can act on.
      if (text.includes("MODE:PREMATURE") && !stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"id":"fixture-completion","choices":[');
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }

      if (text.includes("MODE:500")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture exploded" } }));
        return;
      }

      if (text.includes("MODE:SLOW")) {
        setTimeout(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(completion("slow")));
        }, 1500);
        return;
      }

      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (text.includes("MODE:PREMATURE")) {
          res.write(`data: ${JSON.stringify(chunk("half"))}\n\n`);
          setTimeout(() => res.socket?.destroy(), 50);
          return;
        }
        res.write(`data: ${JSON.stringify(chunk("fixture "))}\n\n`);
        if (text.includes("MODE:ABORT")) {
          res.on("close", () => reportAbort("gateway closed the upstream stream"));
          return;
        }
        res.write(`data: ${JSON.stringify(chunk("ok"))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk("", "stop", { prompt_tokens: 20, completion_tokens: 2 }))}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion("fixture ok")));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}/v1`,
    aborted,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function completion(content: string): unknown {
  return {
    id: "fixture-completion",
    object: "chat.completion",
    created: 1,
    model: "fixture-1",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  };
}

function chunk(
  content: string,
  finish: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number },
): unknown {
  const payload: Record<string, unknown> = {
    id: "fixture-chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-1",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
  };
  if (usage) payload["usage"] = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
  return payload;
}
