/**
 * Upstream transport.
 *
 * Supported today:
 *   http   - TCP to 127.0.0.1 or a LAN host
 *   https  - TLS with certificate verification (rejectUnauthorized is never disabled)
 *   uds    - AF_UNIX socket, no TCP handshake, permissions enforced by the socket file
 *
 * Not supported for chat completions: ws, grpc, stdio, shared memory.
 * See docs/TRANSPORTS.md for the evidence behind that list.
 */

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config.ts";
import { GatewayError } from "../core/errors.ts";

export interface UpstreamRequest {
  method: "GET" | "POST";
  path: string;
  body?: string;
  accept?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UpstreamStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

const agents = new Map<string, http.Agent>();
const MAX_PROBE_BYTES = 4 * 1024 * 1024;

function agentFor(config: ProviderConfig): http.Agent {
  const key = `${config.id}:${config.transport}`;
  const existing = agents.get(key);
  if (existing) return existing;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15_000 });
  agents.set(key, agent);
  return agent;
}

function buildHeaders(config: ProviderConfig, request: UpstreamRequest): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    accept: request.accept ?? "application/json",
    "x-gateway-request-id": randomUUID(),
    ...config.headers,
  };
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(request.body);
  }
  // Local engines (ollama, llama-server) need no credential. Omit the header
  // entirely instead of sending an empty bearer that some gateways reject.
  if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
  return headers;
}

function optionsFor(
  config: ProviderConfig,
  request: UpstreamRequest,
): { options: http.RequestOptions; secure: boolean } {
  const secure = config.transport === "https" || config.baseUrl.startsWith("https://");
  const headers = buildHeaders(config, request);
  const timeout = request.timeoutMs ?? config.timeoutMs;

  if (config.transport === "uds") {
    if (!config.socketPath) {
      throw new GatewayError({
        message: `Provider "${config.id}" is configured for uds without a socket path`,
        status: 500,
        code: "provider_unreachable",
        providerId: config.id,
      });
    }
    return {
      secure: false,
      options: {
        socketPath: config.socketPath,
        path: request.path,
        method: request.method,
        headers: { ...headers, host: "localhost" },
        timeout,
      },
    };
  }

  const url = new URL(`${config.baseUrl}${request.path}`);
  return {
    secure,
    options: {
      hostname: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      timeout,
      agent: agentFor(config),
    },
  };
}

export function openUpstream(
  config: ProviderConfig,
  request: UpstreamRequest,
): Promise<UpstreamStream> {
  const { options, secure } = optionsFor(config, request);
  const agent = secure ? https : http;

  return new Promise<UpstreamStream>((resolvePromise, rejectPromise) => {
    const req = agent.request(options, (response) => {
      resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
      });
    });

    req.on("timeout", () => {
      req.destroy(
        new GatewayError({
          message: `Provider "${config.id}" exceeded ${request.timeoutMs ?? config.timeoutMs}ms of socket inactivity`,
          status: 504,
          code: "provider_timeout",
          providerId: config.id,
          retryable: true,
        }),
      );
    });

    req.on("error", (error) => {
      if (error instanceof GatewayError) {
        rejectPromise(error);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      rejectPromise(
        new GatewayError({
          message: `Provider "${config.id}" is unreachable (${code})`,
          status: 502,
          code: "provider_unreachable",
          providerId: config.id,
          retryable: true,
          cause: error,
        }),
      );
    });

    if (request.signal) {
      if (request.signal.aborted) {
        req.destroy(new Error("client aborted"));
        return;
      }
      request.signal.addEventListener("abort", () => req.destroy(new Error("client aborted")), {
        once: true,
      });
    }

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

export async function readBody(stream: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) {
      stream.destroy();
      throw new GatewayError({
        message: `Upstream response exceeded ${limit} bytes`,
        status: 502,
        code: "internal_error",
        retryable: false,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface ProbeResult {
  status: number;
  json: unknown;
  text: string;
}

/** Short-lived JSON probe used by the catalog sync. Never streams. */
export async function probeJson(
  config: ProviderConfig,
  path: string,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  const response = await openUpstream(config, {
    method: "GET",
    path,
    accept: "application/json",
    timeoutMs,
  });

  if (response.status >= 400) {
    response.body.resume();
    return { status: response.status, json: null, text: "" };
  }

  const text = await readBody(response.body, MAX_PROBE_BYTES);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

export function closeTransports(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}
