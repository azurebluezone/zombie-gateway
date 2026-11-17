/**
 * Minimal WebSocket client for the admin metrics socket.
 *
 * Only what the tests need: the handshake, and reading unmasked server frames
 * (text, ping, close). A full client would be a dependency; this is 60 lines and
 * exists so "shutdown closes the panel cleanly" can be asserted instead of
 * assumed.
 */

import net from "node:net";
import { randomBytes } from "node:crypto";

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

export interface WsClient {
  readFrame: (timeoutMs?: number) => Promise<WsFrame>;
  destroy: () => void;
}

export async function openMetricsSocket(
  port: number,
  token?: string,
): Promise<WsClient> {
  const socket = net.connect(port, "127.0.0.1");
  const key = randomBytes(16).toString("base64");
  let buffer = Buffer.alloc(0);
  let pending: { resolve: (frame: WsFrame) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;

  const pump = (): void => {
    if (pending === null) return;
    const frame = takeFrame();
    if (!frame) return;
    const waiter = pending;
    pending = null;
    waiter.resolve(frame);
  };

  const takeFrame = (): WsFrame | null => {
    if (buffer.length < 2) return null;
    const first = buffer[0] as number;
    const second = buffer[1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (masked) throw new Error("server frames must not be masked");
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (buffer.length < offset + length) return null;
    const payload = buffer.subarray(offset, offset + length);
    buffer = buffer.subarray(offset + length);
    return { opcode, payload: Buffer.from(payload) };
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      pump();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  });
  socket.on("error", (error) => {
    failure = error;
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      const path = token ? `/admin/metrics/ws?token=${encodeURIComponent(token)}` : "/admin/metrics/ws";
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `host: 127.0.0.1:${port}\r\n` +
          "upgrade: websocket\r\n" +
          "connection: Upgrade\r\n" +
          `sec-websocket-key: ${key}\r\n` +
          "sec-websocket-version: 13\r\n\r\n",
      );
      resolve();
    });
    socket.once("error", reject);
  });

  // Consume the HTTP response head; anything after it is frame bytes.
  const deadline = Date.now() + 5000;
  while (buffer.indexOf("\r\n\r\n") === -1) {
    if (Date.now() > deadline) throw new Error("websocket handshake timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const headEnd = buffer.indexOf("\r\n\r\n") + 4;
  const head = buffer.subarray(0, headEnd).toString("utf8");
  if (!head.startsWith("HTTP/1.1 101")) {
    socket.destroy();
    throw new Error(`websocket upgrade failed: ${head.split("\r\n")[0]}`);
  }
  buffer = buffer.subarray(headEnd);

  return {
    readFrame: (timeoutMs = 4000) =>
      new Promise<WsFrame>((resolve, reject) => {
        if (failure) return reject(failure);
        pending = { resolve, reject };
        pump();
        setTimeout(() => {
          if (pending === null) return;
          pending = null;
          reject(new Error(`no websocket frame within ${timeoutMs} ms`));
        }, timeoutMs).unref();
      }),
    destroy: () => socket.destroy(),
  };
}
