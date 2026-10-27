/**
 * Realtime metrics over a minimal WebSocket server.
 *
 * Why hand-rolled: the runtime has zero dependencies, and the protocol needed
 * here is three frames (text, ping, close). RFC 6455 handshake + framing is
 * ~150 lines, which is cheaper than a dependency that owns the HTTP upgrade path.
 *
 * Lifecycle: a successful handshake creates an `admin_sessions` row, then the
 * socket receives a compact metrics snapshot every `interval_ms`. The client may
 * ask for a different window or interval; the server clamps both.
 *
 * Auth: the browser WebSocket API cannot set an Authorization header, so the
 * token may arrive as `?token=`, `x-admin-token`, or a bearer header (non-browser
 * clients). When admin auth is off, the socket is open — same switch as HTTP.
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AppContext } from "../core/chat.ts";
import { execute, queryAll } from "../core/db.ts";
import { logEvent, nowIso } from "../core/logger.ts";
import { collectMetrics } from "../core/metrics.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 1_048_576;
const MIN_INTERVAL = 500;
const MAX_INTERVAL = 60_000;
const DEFAULT_INTERVAL = 2_000;
const MIN_WINDOW = 60_000;
const MAX_WINDOW = 7 * 24 * 60 * 60 * 1000;

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

function reject(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { message, type: "invalid_request_error", code } });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
      "content-type: application/json\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}

function tokenFrom(req: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get("token");
  if (query) return query;
  const direct = req.headers["x-admin-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

function closeFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(payload, 0x8);
}

function decodeFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer; error: string | null } {
  const frames: Frame[] = [];
  let offset = 0;

  while (true) {
    if (buffer.length - offset < 2) break;

    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length < cursor + 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length < cursor + 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    if (length > MAX_PAYLOAD) return { frames, rest: buffer.subarray(offset), error: "frame_too_large" };
    if (!masked) return { frames, rest: buffer.subarray(offset), error: "unmasked_client_frame" };

    if (buffer.length < cursor + 4) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;

    if (buffer.length < cursor + length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] as number) ^ (mask[index % 4] as number);
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset), error: null };
}

interface Counters {
  frames: number;
  lastSentAt: string | null;
}

/**
 * Sockets that can be closed with a proper frame. Shutdown uses this so a
 * panel sees "going away" (1001) instead of an abnormal closure it has to
 * guess about; the DB row for each session is closed by the same `close()`.
 */
const liveClosers = new Set<(code: number, reason: string) => void>();

export function closeAdminSockets(reason = "server shutting down"): number {
  const closers = [...liveClosers];
  liveClosers.clear();
  for (const close of closers) close(1001, reason);
  return closers.length;
}

export function attachAdminSocket(server: Server, ctx: AppContext): void {
  // Sessions are rows, not memory: a restart cannot know which sockets are
  // still alive, so any row left open at boot belongs to a dead process.
  const orphaned = queryAll<{ id: string }>(
    "SELECT id FROM admin_sessions WHERE closed_at IS NULL",
  ).length;
  if (orphaned > 0) {
    execute("UPDATE admin_sessions SET closed_at = ? WHERE closed_at IS NULL", nowIso());
    logEvent("warn", "admin.sessions_orphaned", { count: orphaned });
  }

  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname !== "/admin/metrics/ws" && url.pathname !== "/admin/ws") {
        reject(socket, 404, "invalid_request_error", `Unknown websocket path ${url.pathname}`);
        return;
      }

      if (
        req.headers.upgrade?.toLowerCase() !== "websocket" ||
        typeof req.headers["sec-websocket-key"] !== "string"
      ) {
        reject(socket, 400, "invalid_request_error", "Expected a WebSocket upgrade");
        return;
      }

      if (ctx.config.adminAuth) {
        const supplied = tokenFrom(req, url);
        if (!supplied || supplied !== ctx.config.adminToken) {
          reject(socket, 401, "unauthorized", "Admin token required (?token= or x-admin-token)");
          return;
        }
      }

      if (ctx.config.adminOrigins.length > 0) {
        const origin = req.headers.origin ?? "null";
        if (!ctx.config.adminOrigins.includes("*") && !ctx.config.adminOrigins.includes(origin)) {
          reject(socket, 403, "invalid_request_error", `Origin ${origin} is not allowed`);
          return;
        }
      }

      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "upgrade: websocket\r\n" +
          "connection: Upgrade\r\n" +
          `sec-websocket-accept: ${accept}\r\n\r\n`,
      );
      // `upgrade` hands over a net.Socket but the type is the wider Duplex.
      (socket as unknown as import("node:net").Socket).setNoDelay(true);

      const sessionId = randomUUID();
      const remote = req.socket.remoteAddress ?? null;
      const agent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

      let intervalMs = DEFAULT_INTERVAL;
      let windowMs = 60 * 60 * 1000;
      let seq = 0;
      let closed = false;
      let timer: NodeJS.Timeout | null = null;
      const counters: Counters = { frames: 0, lastSentAt: null };

      execute(
        `INSERT INTO admin_sessions (id, kind, remote_addr, user_agent, interval_ms, frames, opened_at, meta)
         VALUES (?, 'ws', ?, ?, ?, 0, ?, ?)`,
        sessionId,
        remote,
        agent,
        intervalMs,
        nowIso(),
        JSON.stringify({ window_ms: windowMs, path: url.pathname }),
      );

      const send = (payload: unknown): void => {
        if (closed || socket.destroyed) return;
        const text = JSON.stringify(payload);
        socket.write(encodeFrame(Buffer.from(text, "utf8")));
        counters.frames += 1;
        counters.lastSentAt = nowIso();
        if (counters.frames % 15 === 0) {
          execute(
            "UPDATE admin_sessions SET frames = ?, last_sent_at = ?, interval_ms = ? WHERE id = ?",
            counters.frames,
            counters.lastSentAt,
            intervalMs,
            sessionId,
          );
        }
      };

      const pushMetrics = (): void => {
        seq += 1;
        send({
          type: "metrics",
          session_id: sessionId,
          seq,
          ts: nowIso(),
          interval_ms: intervalMs,
          window_ms: windowMs,
          data: collectMetrics(windowMs),
        });
      };

      const schedule = (): void => {
        if (timer) clearInterval(timer);
        timer = setInterval(pushMetrics, intervalMs);
        timer.unref();
      };

      const close = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        liveClosers.delete(close);
        if (timer) clearInterval(timer);

        // The peer may already be gone (client destroyed the socket right after
        // the 101, or a killed process). Writes are guarded so the bookkeeping
        // below always lands; otherwise /admin/sessions accumulates zombie rows.
        if (!socket.destroyed) {
          try {
            socket.write(closeFrame(code, reason));
            socket.end();
          } catch {
            socket.destroy();
          }
        }

        try {
          execute(
            `UPDATE admin_sessions
             SET frames = ?, last_sent_at = ?, interval_ms = ?, meta = ?, closed_at = ?
             WHERE id = ?`,
            counters.frames,
            counters.lastSentAt,
            intervalMs,
            JSON.stringify({ window_ms: windowMs, path: url.pathname }),
            nowIso(),
            sessionId,
          );
        } catch {
          // A closing database must not turn a socket teardown into a crash.
        }

        logEvent("info", "admin.ws_closed", {
          session: sessionId,
          code,
          reason,
          frames: counters.frames,
          remote,
        });
      };

      liveClosers.add(close);

      const handleText = (text: string): void => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          send({ type: "error", message: "Messages must be JSON objects" });
          return;
        }

        const type = typeof message["type"] === "string" ? message["type"] : "";

        if (type === "ping") {
          send({ type: "pong", ts: nowIso(), session_id: sessionId });
          return;
        }

        if (type === "set_interval") {
          const requested = Number(message["interval_ms"]);
          intervalMs = Number.isFinite(requested)
            ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(requested)))
            : intervalMs;
          execute(
            "UPDATE admin_sessions SET interval_ms = ? WHERE id = ?",
            intervalMs,
            sessionId,
          );
          schedule();
          send({ type: "interval", interval_ms: intervalMs, session_id: sessionId });
          return;
        }

        if (type === "set_window") {
          const requested = Number(message["window_ms"]);
          windowMs = Number.isFinite(requested)
            ? Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(requested)))
            : windowMs;
          execute(
            "UPDATE admin_sessions SET meta = ? WHERE id = ?",
            JSON.stringify({ window_ms: windowMs, path: url.pathname }),
            sessionId,
          );
          pushMetrics();
          return;
        }

        if (type === "snapshot" || type === "metrics") {
          pushMetrics();
          return;
        }

        send({ type: "error", message: `Unknown message type "${type}"` });
      };

      let buffer: Buffer = Buffer.alloc(0);
      let pendingOpcode: number | null = null;
      let pending: Buffer[] = [];

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer);
        buffer = decoded.rest;

        if (decoded.error === "frame_too_large") {
          close(1009, "frame too large");
          return;
        }
        if (decoded.error === "unmasked_client_frame") {
          close(1002, "client frames must be masked");
          return;
        }

        for (const frame of decoded.frames) {
          if (frame.opcode === 0x8) {
            close(1000, "client closed");
            return;
          }
          if (frame.opcode === 0x9) {
            if (!socket.destroyed) socket.write(encodeFrame(frame.payload, 0xa));
            continue;
          }
          if (frame.opcode === 0xa) continue;
          if (frame.opcode === 0x2) {
            close(1003, "binary frames are not supported");
            return;
          }

          if (frame.opcode === 0x0) {
            if (pendingOpcode === null) {
              close(1002, "unexpected continuation");
              return;
            }
            pending.push(frame.payload);
          } else if (frame.opcode === 0x1) {
            if (pendingOpcode !== null) {
              close(1002, "new text frame before continuation finished");
              return;
            }
            pendingOpcode = 0x1;
            pending = [frame.payload];
          } else {
            close(1002, `unsupported opcode ${frame.opcode}`);
            return;
          }

          if (frame.fin) {
            const text = Buffer.concat(pending).toString("utf8");
            pendingOpcode = null;
            pending = [];
            handleText(text);
          }
        }
      });

      socket.on("error", () => {
        if (!closed) close(1011, "socket error");
      });

      // http.Server creates sockets with allowHalfOpen, so a peer FIN arrives as
      // 'end' and never becomes 'close' until we end our side. Without this
      // handler a client that vanishes leaves an open row in admin_sessions.
      socket.on("end", () => {
        if (!closed) close(1000, "client ended");
      });

      socket.on("close", () => {
        if (!closed) close(1001, "gone");
      });

      schedule();
      pushMetrics();
    } catch (error) {
      reject(socket, 500, "internal_error", error instanceof Error ? error.message : "upgrade failed");
    }
  });
}

export const WS_PATHS = ["/admin/metrics/ws", "/admin/ws"] as const;
