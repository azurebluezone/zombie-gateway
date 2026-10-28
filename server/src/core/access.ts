/**
 * Append-only access log: one JSON line per HTTP request, success or failure.
 *
 * Why a second file: gateway.jsonl carries lifecycle events (boot, catalog sync,
 * chat completion). Mixing a line per request into it buries those events. The
 * access log is the audit trail — method, path, status, duration, bytes, peer —
 * and it is written for 4xx/5xx too, which is the part a success-only log hides.
 *
 * Rotation is size-based and cheap: the size is cached and re-read every
 * ROTATE_CHECK writes instead of stat() on every request.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ROTATE_CHECK = 100;

let accessPath: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;
let writes = 0;
let knownSize = 0;

export function initAccessLog(path: string, limitBytes = DEFAULT_MAX_BYTES): void {
  accessPath = path ? resolve(path) : null;
  maxBytes = limitBytes > 0 ? limitBytes : DEFAULT_MAX_BYTES;
  writes = 0;
  knownSize = 0;
  if (!accessPath) return;
  mkdirSync(dirname(accessPath), { recursive: true });
  try {
    knownSize = statSync(accessPath).size;
  } catch {
    knownSize = 0;
  }
}

export function accessLogPath(): string | null {
  return accessPath;
}

function rotateIfNeeded(): void {
  if (!accessPath) return;
  writes += 1;
  if (writes % ROTATE_CHECK !== 0 && knownSize < maxBytes) return;
  try {
    knownSize = statSync(accessPath).size;
  } catch {
    knownSize = 0;
  }
  if (knownSize < maxBytes) return;
  try {
    renameSync(accessPath, `${accessPath}.1`);
    knownSize = 0;
  } catch {
    // A failed rotation must never drop the request line itself.
  }
}

/**
 * Write one access record. Never throws: a logging failure cannot be allowed to
 * turn a served request into a 500.
 */
export function logAccess(entry: Record<string, unknown>): void {
  if (!accessPath) return;
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), event: "http.request", detail: "unserializable" });
  }
  rotateIfNeeded();
  try {
    appendFileSync(accessPath, `${line}\n`);
    knownSize += Buffer.byteLength(line) + 1;
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", event: "access.write_failed", error: String(error) }),
    );
  }
}
