/**
 * JSON response helpers shared by the public and admin surfaces.
 *
 * Every response carries the system identity headers, so ownership travels with
 * the bytes instead of living in a README nobody reads.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayError } from "./errors.ts";

export function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function cors(req: IncomingMessage, res: ServerResponse, origins: string[] = []): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;

  if (origins.length === 0) {
    // Wildcard is safe for bearer-token auth: no cookies are accepted, so a
    // foreign page cannot borrow a session. It also covers file:// pages, whose
    // Origin header is the literal string "null".
    res.setHeader("access-control-allow-origin", "*");
  } else {
    const candidate = origin ?? "null";
    if (origins.includes("*") || origins.includes(candidate)) {
      res.setHeader("access-control-allow-origin", candidate);
      res.setHeader("vary", "origin");
    }
  }

  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-session-id, x-client-id, x-admin-token",
  );
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-max-age", "600");
}

export async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limit) {
      throw new GatewayError({
        message: `Request body exceeds ${limit} bytes`,
        status: 413,
        code: "invalid_request_error",
      });
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GatewayError({
      message: `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
      status: 400,
      code: "invalid_request_error",
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError({
      message: "Body must be a JSON object",
      status: 400,
      code: "invalid_request_error",
    });
  }
  return parsed as Record<string, unknown>;
}
