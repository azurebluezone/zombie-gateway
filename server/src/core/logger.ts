/**
 * Structured JSONL logging.
 *
 * One line per event, written to stdout and to GATEWAY_LOG. Credentials and
 * prompt bodies never reach the log unless GATEWAY_LOG_PROMPTS=1, and even then
 * the prompt is stored on the request_logs row, not in the JSONL stream.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEYS = new Set([
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "cookie",
  "set-cookie",
  "token",
  "access_token",
]);

let logPath: string | null = null;
let echoToStdout = true;

export function initLogger(path: string, echo = true): void {
  logPath = path ? resolve(path) : null;
  echoToStdout = echo;
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const record = {
    ts: nowIso(),
    level,
    event,
    ...(redact(fields) as Record<string, unknown>),
  };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, event, detail: "unserializable fields" });
  }

  if (echoToStdout) {
    if (level === "error") console.error(line);
    else console.log(line);
  }
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "log.write_failed", error: String(error) }));
  }
}
